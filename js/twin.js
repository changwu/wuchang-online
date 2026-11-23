/* =====================================================================
 * 阿昌 · 数字分身 —— 页面逻辑
 *
 * 一句话流程：
 *   打开页面 → 后台先把 OTA + WebSocket 建好 → 点「开始对话」开麦
 *   → 浏览器端 VAD 判断"开口 / 说完" → 上行 Opus 给服务端 ASR
 *   → 服务端 LLM 回答、TTS 合成 Opus 回传 → 本地播放（同时驱动波纹）
 *   → 播完继续监听，形成一轮轮对话。
 *
 * ============================================================
 * 协议事实（读 xiaozhi-server 源码确认）
 * ============================================================
 * 上行 —— core/connection.py 无条件按 Opus 解码收到的二进制帧，
 *         所以客户端必须发 Opus：16 kHz 单声道、60 ms/帧 = 960 样本。
 * 下行 —— core/providers/tts/base.py 硬编码 is_opus=True，
 *         60 ms/帧，采样率取 conn.sample_rate（服务端为 24000）。
 *
 * 为什么用 mode:"manual"：
 *   服务端 ASR 在 manual 模式下不跑自己的 VAD，而是缓存客户端推上来的
 *   全部音频，等 listen stop 才一次性识别 —— 断句权完全交给浏览器，
 *   不会出现前后端各判一次、互相打架的情况。
 *
 * 为什么"忙"的时候要停止拾音：
 *   TTS 从扬声器放出来的声音会被同一个麦克风收进去，如果继续上传，
 *   服务端会把 AI 自己的话当成用户输入，出现自问自答的死循环。
 *   所以从发出 listen stop 到本地播放缓冲排空为止的整段时间都算"忙"：
 *   既不上传、也不跑 VAD，并重置 VAD 状态。
 * ===================================================================== */

"use strict";

/* ---------------- 配置（改这里就能指向自己的后端） ---------------- */
var CONFIG = {
    /* 小智服务端的 OTA 地址。本地联调可以加 ?ota=http://127.0.0.1:8002/xiaozhi/ota/ 临时覆盖。 */
    ota: "https://xiaozhi.xiada.cn/xiaozhi/ota/",
    appName: "xiaozhi-twin",
    appVersion: "2.0.0"
};

/* 上行参数 */
var IN_RATE = 16000;           // 上行采样率
var FRAME_SAMPLES = 960;       // 60ms @ 16k
var BLOCK = 1024;              // ScriptProcessor 块大小
/* 下行参数 */
var OUT_RATE = 24000;          // 下行采样率（服务端 conn.sample_rate）
var MAX_DECODE_SAMPLES = 2880; // 解码缓冲上限：24k × 120ms 留余量

/* 时序 */
var VAD_HANGOVER_MS = 700;     // 静音超过这个时长算"说完了"
var MAX_UTTERANCE_MS = 20000;  // 单轮最长录音，防止一直说不停把音频堆爆
var WATCHDOG_MS = 15000;       // 服务端长时间没反应就强制恢复拾音
var CONNECT_TIMEOUT_MS = 12000;
var OTA_TIMEOUT_MS = 10000;
var HELLO_TIMEOUT_MS = 8000;
var RESUME_DELAY_MS = 350;

/* 调试开关：?debug=1 打开左下角日志面板 */
var DEBUG = /(?:^|[?&])debug=1(?:&|$)/.test(location.search) ||
    (function () { try { return localStorage.getItem("xq_debug") === "1"; } catch (e) { return false; } })();

/* 本地联调：?ota=http://127.0.0.1:8002/xiaozhi/ota/ 临时指向别的后端（不落地存储） */
(function () {
    var m = /[?&]ota=([^&]+)/.exec(location.search);
    if (!m) { return; }
    try { CONFIG.ota = decodeURIComponent(m[1]); } catch (e) { CONFIG.ota = m[1]; }
})();

/* =====================================================================
 * DOM
 * =================================================================== */
var $ = function (id) { return document.getElementById(id); };

var el = {
    stage: null, status: null, pillText: null,
    btnMain: null, btnLabel: null, icoMic: null, icoStop: null,
    hint: null, wave: null, transcript: null
};

/* =====================================================================
 * 状态
 * =================================================================== */
var app = {
    state: "offline",     // offline | connecting | ready | listening | hearing | thinking | talking | error
    inCall: false,        // 用户是否已进入对话（麦克风已开）
    starting: false,
    gen: 0,               // 会话世代号：await 期间被取消/挂断就靠它识别

    ws: null,
    connected: false,
    connecting: null,
    helloTimer: null,     // 等服务端 hello 的超时看门狗
    sessionId: "",

    enc: null,            // { m, ptr }
    dec: null,

    audioCtx: null,
    mic: null,            // { stream, source, proc, mute }
    nextPlayTime: 0,
    srcs: [],             // 已排期但还没播完的 AudioBufferSourceNode

    streaming: false,     // 是否正在往服务端推音频
    streamingSince: 0,    // 本轮开始推流的时间（限制单轮最长时长）
    preroll: [],          // 开口前保留的几块原始音频，补上被 VAD 削掉的字头
    busy: false,          // 服务端处理中 / TTS 播放中 —— 忙时禁止拾音
    ttsActive: false,
    busyTimer: null,
    resumeTimer: null,
    pending: new Float32Array(0),

    /* 音量（0~1），micTarget/ttsTarget 是瞬时值，micLevel/ttsLevel 是平滑后的显示值 */
    micTarget: 0, ttsTarget: 0, micLevel: 0, ttsLevel: 0,

    bars: new Float32Array(44),   // 波形柱的平滑高度
    aiRow: null                   // 当前这一轮 AI 回答对应的 DOM 行
};

var vad = {
    calibrated: false,
    calibMs: 0,
    noiseFloor: 0.004,
    speech: false,
    above: 0,
    silenceMs: 0,
    onsetBlocks: 2,      // 连续几块超阈值算"开口"（抗瞬时噪声）
    openFactor: 3.0,     // 开启阈值 = 噪声底 × factor
    closeFactor: 1.7,    // 关闭阈值（迟滞，避免抖动）
    absMin: 0.0035,      // 绝对下限，避免极静环境下过分灵敏
    recalAt: 0           // 上次"听到说话/校准"的时间，长时间没动静就重新校准
};

var LOGS = [];
var debugEl = null;

/* =====================================================================
 * 文案
 * =================================================================== */
var STATE_TEXT = {
    offline: "点下面的按钮，开始和我说话",
    connecting: "正在接通…",
    ready: "连接好了，点「开始对话」",
    listening: "我在听，你直接说就行",
    hearing: "嗯，我在听…",
    thinking: "让我想一下…",
    talking: "我在说…",
    error: "出了点问题"
};
var PILL_TEXT = {
    offline: "未连接",
    connecting: "连接中",
    ready: "已连接",
    listening: "在线",
    hearing: "在线",
    thinking: "在线",
    talking: "在线",
    error: "异常"
};

/* =====================================================================
 * 界面状态
 * =================================================================== */
function setState(name, textOverride) {
    app.state = name;
    document.body.dataset.state = name;
    if (el.status) { el.status.textContent = textOverride || STATE_TEXT[name] || ""; }
    if (el.pillText) { el.pillText.textContent = PILL_TEXT[name] || ""; }
    syncButton();
}

function syncButton() {
    if (!el.btnMain) { return; }
    var inCall = app.inCall;
    el.btnMain.disabled = (app.state === "connecting") || app.starting;
    el.btnMain.classList.toggle("btn-start", !inCall);
    el.btnMain.classList.toggle("btn-end", inCall);
    el.btnMain.setAttribute("aria-pressed", inCall ? "true" : "false");
    el.btnLabel.textContent = inCall
        ? "结束对话"
        : ((app.state === "connecting" || app.starting) ? "连接中…" : "开始对话");
    el.icoMic.classList.toggle("hidden", inCall);
    el.icoStop.classList.toggle("hidden", !inCall);
}

function log(msg) {
    var line = new Date().toLocaleTimeString("zh-CN", { hour12: false }) + "  " + msg;
    LOGS.push(line);
    if (LOGS.length > 300) { LOGS.shift(); }
    if (debugEl) {
        debugEl.textContent = LOGS.join("\n");
        debugEl.scrollTop = debugEl.scrollHeight;
    }
    try { console.log("[阿昌] " + msg); } catch (e) { /* 忽略 */ }
}

/* =====================================================================
 * 对话文字
 * =================================================================== */
function pushRow(role, text) {
    if (!el.transcript) { return null; }
    removePlaceholder();
    var row = document.createElement("div");
    row.className = "t-row flex shrink-0 items-start gap-2";

    var who = document.createElement("span");
    who.className = "mt-0.5 w-8 shrink-0 text-[10px] tracking-widest " +
        (role === "ai" ? "text-sky-300/70" : "text-slate-500");
    who.textContent = role === "ai" ? "阿昌" : "我";

    var body = document.createElement("span");
    body.setAttribute("data-text", "");
    body.className = "wrap-any line-clamp-2 flex-1 " +
        (role === "ai" ? "text-sky-50/90" : "text-slate-400");
    body.textContent = text || "";

    row.appendChild(who);
    row.appendChild(body);
    el.transcript.appendChild(row);

    while (el.transcript.children.length > 3) {
        el.transcript.removeChild(el.transcript.firstChild);
    }
    return row;
}

function appendAi(text) {
    if (!text) { return; }
    if (!app.aiRow) { app.aiRow = pushRow("ai", ""); }
    if (!app.aiRow) { return; }
    var span = app.aiRow.querySelector("[data-text]");
    if (!span) { return; }

    /* 服务端按标点把回答切成若干句，发送 sentence_start 时把句末标点去掉了，
       直接拼会变成"查不到服务好像抽风了"，所以补一个逗号。 */
    var cur = span.textContent || "";
    var add = text;
    if (cur && !/[，。！？、,.!?…—：；\s]$/.test(cur)) { add = "，" + add; }
    span.textContent = cur + add;
}

function clearTranscript() {
    if (!el.transcript) { return; }
    el.transcript.innerHTML = "";
    app.aiRow = null;
    /* 空的时候放一句引导，避免卡片中间空一大块 */
    var hint = document.createElement("div");
    hint.className = "t-placeholder flex items-start gap-2 text-slate-600";
    hint.innerHTML =
        '<span class="mt-0.5 w-8 shrink-0"></span>' +
        '<span class="flex-1">说点什么，从一句「你好」开始</span>';
    el.transcript.appendChild(hint);
}

function removePlaceholder() {
    if (!el.transcript) { return; }
    var ph = el.transcript.querySelector(".t-placeholder");
    if (ph) { el.transcript.removeChild(ph); }
}

/* =====================================================================
 * Opus 编解码
 * =================================================================== */
function opusModule() {
    if (typeof Module === "undefined" || !Module.instance) { return null; }
    return Module.instance;
}

function waitForOpus(timeoutMs) {
    return new Promise(function (resolve, reject) {
        var started = Date.now();
        (function poll() {
            var m = opusModule();
            if (m && typeof m._opus_encoder_get_size === "function") { return resolve(m); }
            if (Date.now() - started > (timeoutMs || 8000)) {
                return reject(new Error("Opus 编解码库加载超时"));
            }
            setTimeout(poll, 100);
        })();
    });
}

function initCodecs() {
    if (app.enc && app.dec) { return Promise.resolve(true); }
    return waitForOpus().then(function (m) {
        if (app.enc && app.dec) { return true; }

        var encPtr = 0;
        var decPtr = 0;
        try {
            var encSize = m._opus_encoder_get_size(1);
            if (!encSize || encSize < 0) { throw new Error("opus_encoder_get_size 失败: " + encSize); }
            encPtr = m._malloc(encSize);
            if (!encPtr) { throw new Error("编码器申请内存失败"); }
            var err = m._opus_encoder_init(encPtr, IN_RATE, 1, 2048); // 2048 = OPUS_APPLICATION_VOIP
            if (err < 0) { throw new Error("opus_encoder_init 失败: " + err); }
            m._opus_encoder_ctl(encPtr, 4002, 24000);   // OPUS_SET_BITRATE
            m._opus_encoder_ctl(encPtr, 4010, 5);       // OPUS_SET_COMPLEXITY

            var decSize = m._opus_decoder_get_size(1);
            if (!decSize || decSize < 0) { throw new Error("opus_decoder_get_size 失败: " + decSize); }
            decPtr = m._malloc(decSize);
            if (!decPtr) { throw new Error("解码器申请内存失败"); }
            err = m._opus_decoder_init(decPtr, OUT_RATE, 1);
            if (err < 0) { throw new Error("opus_decoder_init 失败: " + err); }

            app.enc = { m: m, ptr: encPtr };
            app.dec = { m: m, ptr: decPtr };
            log("Opus 就绪（上行 16k/60ms，下行 24k/60ms）");
            return true;
        } catch (e) {
            /* 初始化到一半失败时把已申请的内存还回去，否则重试会一路泄漏 */
            if (encPtr) { try { m._free(encPtr); } catch (e2) { /* 忽略 */ } }
            if (decPtr) { try { m._free(decPtr); } catch (e2) { /* 忽略 */ } }
            app.enc = null;
            app.dec = null;
            throw e;
        }
    });
}

function encodeFrame(int16) {
    if (!app.enc) { return null; }
    var m = app.enc.m;
    var pcmPtr = m._malloc(FRAME_SAMPLES * 2);
    if (!pcmPtr) { return null; }
    var heap16 = m.HEAP16;
    var base = pcmPtr >> 1;
    for (var i = 0; i < FRAME_SAMPLES; i++) { heap16[base + i] = int16[i]; }

    var outPtr = m._malloc(4000);
    if (!outPtr) { m._free(pcmPtr); return null; }
    var n = m._opus_encode(app.enc.ptr, pcmPtr, FRAME_SAMPLES, outPtr, 4000);
    m._free(pcmPtr);
    if (n < 0) { m._free(outPtr); log("opus_encode 失败: " + n); return null; }

    var out = new Uint8Array(n);
    for (var k = 0; k < n; k++) { out[k] = m.HEAPU8[outPtr + k]; }
    m._free(outPtr);
    return out;
}

function decodePacket(u8) {
    if (!app.dec || !u8 || !u8.length) { return null; }
    var m = app.dec.m;
    var inPtr = m._malloc(u8.length);
    if (!inPtr) { return null; }
    for (var i = 0; i < u8.length; i++) { m.HEAPU8[inPtr + i] = u8[i]; }

    var pcmPtr = m._malloc(MAX_DECODE_SAMPLES * 2);
    if (!pcmPtr) { m._free(inPtr); return null; }
    var n = m._opus_decode(app.dec.ptr, inPtr, u8.length, pcmPtr, MAX_DECODE_SAMPLES, 0);
    m._free(inPtr);
    if (n < 0) { m._free(pcmPtr); return null; }

    var out = new Int16Array(n);
    var base = pcmPtr >> 1;
    var heap16 = m.HEAP16;
    for (var k = 0; k < n; k++) { out[k] = heap16[base + k]; }
    m._free(pcmPtr);
    return out;
}

/* =====================================================================
 * 设备标识（服务端用来区分会话，存 localStorage 保持一致）
 * =================================================================== */
function uuid() {
    if (window.crypto && crypto.randomUUID) { return crypto.randomUUID(); }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        return (c === "x" ? r : (r & 3 | 8)).toString(16);
    });
}

function getMac() {
    var v = null;
    try { v = localStorage.getItem("xq_mac"); } catch (e) { /* 隐私模式忽略 */ }
    if (!v) { try { v = sessionStorage.getItem("xq_mac"); } catch (e) { /* 忽略 */ } }
    if (!v) {
        var a = [];
        for (var i = 0; i < 6; i++) {
            a.push((Math.random() * 256 | 0).toString(16).padStart(2, "0"));
        }
        v = a.join(":");
        try { localStorage.setItem("xq_mac", v); } catch (e) { /* 忽略 */ }
        try { sessionStorage.setItem("xq_mac", v); } catch (e) { /* 忽略 */ }
    }
    return v;
}

function getCid() {
    var v = null;
    try { v = localStorage.getItem("xq_cid"); } catch (e) { /* 忽略 */ }
    if (!v) { try { v = sessionStorage.getItem("xq_cid"); } catch (e) { /* 忽略 */ } }
    if (!v) {
        v = uuid();
        try { localStorage.setItem("xq_cid", v); } catch (e) { /* 忽略 */ }
        try { sessionStorage.setItem("xq_cid", v); } catch (e) { /* 忽略 */ }
    }
    return v;
}

/* =====================================================================
 * 连接：OTA 取 WebSocket 地址 → 建连接 → 发 hello
 * =================================================================== */
function otaLookup() {
    var mac = getMac();
    var cid = getCid();
    log("OTA 请求: " + CONFIG.ota);

    /* 必须给 fetch 设超时：网关吞包时代理会既不回也不断，
       没有超时的话 connect() 的 promise 永远不 settle，页面就"点不动"了。 */
    var ctrl = (typeof AbortController === "function") ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) { ctrl.abort(); } }, OTA_TIMEOUT_MS);

    return fetch(CONFIG.ota, {
        method: "POST",
        signal: ctrl ? ctrl.signal : undefined,
        headers: {
            "Content-Type": "application/json",
            "Device-Id": mac,
            "Client-Id": cid
        },
        body: JSON.stringify({
            version: 0,
            uuid: "",
            application: { name: CONFIG.appName, version: CONFIG.appVersion },
            ota: { label: "web" },
            board: {
                type: "bread-compact-wifi", ssid: "", rssi: 0, channel: 0,
                ip: "", mac: mac
            },
            flash_size: 0,
            minimum_free_heap_size: 0,
            mac_address: mac,
            chip_model_name: "esp32s3",
            chip_info: { model: 0, cores: 0, revision: 0, features: 0 },
            partition_table: [{ label: "", type: 0, subtype: 0, address: 0, size: 0 }]
        })
    }).then(function (r) {
        if (!r.ok) { throw new Error("OTA 返回 HTTP " + r.status); }
        return r.json();
    }).then(function (j) {
        if (!j.websocket || !j.websocket.url) {
            throw new Error("OTA 响应里没有 websocket 地址");
        }
        log("OTA 返回: " + j.websocket.url);
        return j.websocket;
    }).catch(function (e) {
        if (e && e.name === "AbortError") { throw new Error("OTA 请求超时"); }
        throw e;
    }).then(function (v) {
        clearTimeout(timer);
        return v;
    }, function (e) {
        clearTimeout(timer);
        throw e;
    });
}

function openSocket(url) {
    return new Promise(function (resolve, reject) {
        var ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        var settled = false;
        var timer = setTimeout(function () {
            if (settled) { return; }
            settled = true;
            if (app.ws === ws) { app.ws = null; }
            try { ws.close(); } catch (e) { /* 忽略 */ }
            reject(new Error("连接超时"));
        }, CONNECT_TIMEOUT_MS);

        ws.onopen = function () {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            resolve(ws);
        };
        ws.onerror = function () {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            if (app.ws === ws) { app.ws = null; }
            reject(new Error("WebSocket 连接失败"));
        };
        ws.onclose = function (ev) {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                if (app.ws === ws) { app.ws = null; }
                reject(new Error("WebSocket 被关闭 (" + ev.code + ")"));
                return;
            }
            onSocketClosed(ws, ev);
        };
        ws.onmessage = function (ev) {
            if (typeof ev.data === "string") { onJson(ev.data); }
            else { playOpus(new Uint8Array(ev.data)); }
        };
        app.ws = ws;
    });
}

function connect() {
    if (app.connected && app.ws && app.ws.readyState === WebSocket.OPEN) {
        return Promise.resolve(app.ws);
    }
    if (app.connecting) { return app.connecting; }

    app.connecting = initCodecs()
        .then(function () { return otaLookup(); })
        .then(function (info) {
            var u = new URL(info.url);
            if (info.token) {
                u.searchParams.set("authorization",
                    info.token.indexOf("Bearer ") === 0 ? info.token : "Bearer " + info.token);
            }
            u.searchParams.set("device-id", getMac());
            u.searchParams.set("client-id", getCid());
            log("连接 WebSocket…");
            return openSocket(u.toString());
        })
        .then(function (ws) {
            app.connected = true;
            ws.send(JSON.stringify({
                type: "hello",
                version: 1,
                transport: "websocket",
                features: { mcp: false, aec: false },
                audio_params: {
                    format: "opus",
                    sample_rate: IN_RATE,
                    channels: 1,
                    frame_duration: 60
                }
            }));
            log("已连接，已发 hello（opus/16k/60ms）");

            /* 等 hello 回执：有的代理会"握手成功但不转发"，不看回执就会一直显示已连接 */
            if (app.helloTimer) { clearTimeout(app.helloTimer); }
            app.helloTimer = setTimeout(function () {
                app.helloTimer = null;
                if (app.ws === ws && app.sessionId === "") {
                    log("服务端 " + (HELLO_TIMEOUT_MS / 1000) + " 秒没有回 hello，断开重连");
                    try { ws.close(); } catch (e) { /* 忽略 */ }
                }
            }, HELLO_TIMEOUT_MS);
            return ws;
        });

    app.connecting.then(function () { app.connecting = null; },
        function () { app.connecting = null; });
    return app.connecting;
}

function closeSocket() {
    var ws = app.ws;
    app.ws = null;
    app.connected = false;
    app.sessionId = "";
    if (app.helloTimer) { clearTimeout(app.helloTimer); app.helloTimer = null; }
    if (ws) {
        try { ws.onclose = null; ws.close(); } catch (e) { /* 忽略 */ }
    }
}

function onSocketClosed(ws, ev) {
    if (app.ws !== ws) { return; }
    app.ws = null;
    app.connected = false;
    log("WebSocket 断开 code=" + ev.code);
    var wasInCall = app.inCall;
    endSession({ silent: true });
    if (wasInCall) {
        setState("error", "连接断开了，点按钮重新连");
    } else {
        setState("offline");
    }
}

/* =====================================================================
 * 服务端 JSON 消息
 * =================================================================== */
function onJson(text) {
    var m;
    try { m = JSON.parse(text); } catch (e) { return; }
    var t = m.type;

    /* 任何一条服务端消息都说明链路还活着 —— 续看门狗。
       否则 LLM 想很久（>15s）时会被误判成"服务端没动静"而提前开麦。 */
    if (app.busy) { refreshBusyTimer(); }

    if (t === "hello") {
        app.sessionId = m.session_id || "";
        if (app.helloTimer) { clearTimeout(app.helloTimer); app.helloTimer = null; }
        log("会话建立: " + (app.sessionId || "(无)").slice(0, 8));
        if (app.state === "offline" || app.state === "connecting" || app.state === "ready") {
            setState(app.inCall ? "listening" : "ready");
        }
        return;
    }

    if (t === "stt") {
        var stt = (m.text || "").trim();
        if (stt) {
            pushRow("user", stt);
            app.aiRow = null;   // 下一轮 AI 回答单独一行
            log("识别: " + stt);
        }
        return;
    }

    if (t === "llm") {
        /* 文字以 tts 的句子为准（那才是真正要被说出来的），这里只记录 */
        if (DEBUG && m.text) { log("LLM: " + String(m.text).slice(0, 80)); }
        return;
    }

    if (t === "tts") {
        if (m.state === "start") {
            app.ttsActive = true;
            app.aiRow = null;
            vadReset();
            if (app.streaming) { sendListenStop("TTS 开始，收尾本轮"); }
            setBusy(true);
            setState("talking");
        } else if (m.state === "sentence_start") {
            appendAi(m.text || "");
        } else if (m.state === "stop") {
            app.ttsActive = false;
            log("TTS 结束");
            scheduleResume();   // 等本地播放缓冲排空再恢复拾音
        }
        return;
    }

    if (t === "error") {
        log("服务端错误: " + JSON.stringify(m).slice(0, 160));
        setState("error", "服务端报错：" + (m.message || m.code || "未知错误"));
        /* 服务端报错后如果还挂着麦克风，界面会停在 error 而 VAD 闸门不再工作
           （变"聋"）。这里清掉忙状态并在几秒后自动回到监听。 */
        if (app.inCall) {
            if (app.streaming) { app.streaming = false; app.streamingSince = 0; app.pending = new Float32Array(0); }
            setBusy(false);
            vadReset();
            if (app.resumeTimer) { clearTimeout(app.resumeTimer); }
            app.resumeTimer = setTimeout(function () {
                if (app.inCall && app.state === "error") { setState("listening"); }
            }, 3000);
        }
        return;
    }
}

/* =====================================================================
 * 忙 / 闲：从 listen stop 到 TTS 播完都算忙
 * =================================================================== */
function armBusyTimer() {
    if (app.busyTimer) { clearTimeout(app.busyTimer); }
    app.busyTimer = setTimeout(function () {
        app.busyTimer = null;
        /* 本地还在放 TTS 就继续等，不能边放边开麦（会自问自答） */
        if (app.audioCtx && app.nextPlayTime > app.audioCtx.currentTime + 0.15) {
            armBusyTimer();
            return;
        }
        /* error 文案由 error 分支自己的恢复定时器负责，别被看门狗覆盖 */
        if (app.state === "error") {
            app.ttsActive = false;
            app.busy = false;
            return;
        }
        log("服务端 " + (WATCHDOG_MS / 1000) + " 秒没有动静，恢复拾音");
        app.ttsActive = false;
        app.busy = false;
        vadReset();
        if (app.inCall) { setState("listening"); }
    }, WATCHDOG_MS);
}

/* 每收到一包下行音频就续一次看门狗：
 * 慢的时候 LLM+TTS 可能要十几秒，但只要有音频在回来就说明服务端还活着，
 * 不能因为"总时长长"就把麦克风打开（那会把 TTS 的声音收回去自问自答）。 */
function refreshBusyTimer() {
    if (app.busyTimer) { armBusyTimer(); }
}

function setBusy(on) {
    app.busy = !!on;
    if (app.busyTimer) { clearTimeout(app.busyTimer); app.busyTimer = null; }
    if (on) { armBusyTimer(); }
}

function scheduleResume() {
    if (app.resumeTimer) { clearTimeout(app.resumeTimer); }
    app.resumeTimer = setTimeout(function () {
        if (app.ttsActive) { scheduleResume(); return; }
        // 服务端说完了，但本地播放缓冲可能还在放：等它排空
        var draining = app.audioCtx && app.nextPlayTime > app.audioCtx.currentTime + 0.15;
        if (draining) { scheduleResume(); return; }
        setBusy(false);
        vadReset();
        if (app.inCall) { setState("listening"); }
    }, RESUME_DELAY_MS);
}

/* =====================================================================
 * VAD（浏览器端断句）
 * =================================================================== */
function vadReset(full) {
    vad.speech = false;
    vad.above = 0;
    vad.silenceMs = 0;
    vad.recalAt = Date.now();
    app.preroll = [];       // 别把上一轮/播放期间的旧音频补进下一轮
    if (full) {
        vad.calibrated = false;
        vad.calibMs = 0;
        vad.noiseFloor = 0.004;
    }
}

function vadProcess(rms, blockMs) {
    /* 开头先测环境噪声，这部分不当成说话。
       用"取最小值"而不是平均：如果校准这一秒里正好有人在说话，
       平均值会被抬到人声水平，之后阈值高过人声就永远听不见了。
       最小值只会被安静的部分拉低，最多等于环境底噪。 */
    if (!vad.calibrated) {
        if (vad.calibMs <= 0) {
            vad.noiseFloor = rms;
        } else if (rms < vad.noiseFloor) {
            vad.noiseFloor = vad.noiseFloor * 0.6 + rms * 0.4;
        }
        vad.calibMs += blockMs;
        if (vad.calibMs >= 1200) {
            vad.calibrated = true;
            vad.noiseFloor = Math.max(vad.noiseFloor, 0.002);
            log("VAD 校准完成，噪声底 rms=" + vad.noiseFloor.toFixed(5));
        }
        return false;
    }

    /* 噪声底：往下跟得快；往上只在"没在说话"时慢慢跟，否则人声会被学成噪声 */
    if (rms < vad.noiseFloor) {
        vad.noiseFloor = vad.noiseFloor * 0.7 + rms * 0.3;
    } else if (!vad.speech) {
        vad.noiseFloor = vad.noiseFloor * 0.995 + rms * 0.005;
    }

    var open = Math.max(vad.absMin, vad.noiseFloor * vad.openFactor);
    var close = Math.max(vad.absMin * 0.7, vad.noiseFloor * vad.closeFactor);

    if (!vad.speech) {
        if (rms > open) {
            vad.above++;
            if (vad.above >= vad.onsetBlocks) {
                vad.speech = true;
                vad.above = 0;
                vad.silenceMs = 0;
                vad.recalAt = Date.now();
            }
        } else {
            vad.above = 0;
        }
    } else if (rms < close) {
        vad.silenceMs += blockMs;
        if (vad.silenceMs >= VAD_HANGOVER_MS) {
            vad.speech = false;
            vad.silenceMs = 0;
        }
    } else {
        vad.silenceMs = 0;
    }
    return vad.speech;
}

/* =====================================================================
 * listen 消息
 * =================================================================== */
function sendListenStart() {
    if (!app.ws || app.ws.readyState !== WebSocket.OPEN) { return; }
    app.ws.send(JSON.stringify({ type: "listen", state: "start", mode: "manual" }));
    app.streaming = true;
    app.streamingSince = Date.now();
    /* 把开口前缓冲的几块补上，避免 VAD 迟滞把第一个字的字头削掉 */
    app.pending = buildPreroll(true);
    setBusy(false);
    setState("hearing");
    log("检测到开口 → listen start(manual)");
}

function sendListenStop(why) {
    if (!app.ws || app.ws.readyState !== WebSocket.OPEN) { return; }
    app.ws.send(JSON.stringify({ type: "listen", state: "stop" }));
    app.streaming = false;
    app.streamingSince = 0;
    app.pending = new Float32Array(0);
    setBusy(true);          // 从这一刻起禁止拾音，直到 TTS 播完
    setState("thinking");
    log("收尾 → listen stop（" + why + "）");
}

/* =====================================================================
 * 拾音管道
 * =================================================================== */
function computeRms(buf) {
    var s = 0;
    for (var i = 0; i < buf.length; i++) { s += buf[i] * buf[i]; }
    return Math.sqrt(s / buf.length);
}

/* rms → 0~1 的显示音量（-55dB 以下算安静，-10dB 算满） */
function levelFromRms(rms) {
    if (!(rms > 0)) { return 0; }
    var db = 20 * Math.log10(rms);
    return Math.max(0, Math.min(1, (db + 55) / 45));
}

/* ---------------- 开口前的环形缓冲 ---------------- */
var PREROLL_BLOCKS = 5;

function pushPreroll(input) {
    app.preroll.push(new Float32Array(input));
    while (app.preroll.length > PREROLL_BLOCKS) { app.preroll.shift(); }
}

/* skipLast=true 时去掉最后一块（它就是当前这块，之后会正常参与编码） */
function buildPreroll(skipLast) {
    var n = app.preroll.length - (skipLast ? 1 : 0);
    if (n <= 0) { return new Float32Array(0); }
    var total = 0;
    for (var i = 0; i < n; i++) { total += app.preroll[i].length; }
    var out = new Float32Array(total);
    var off = 0;
    for (var j = 0; j < n; j++) {
        out.set(app.preroll[j], off);
        off += app.preroll[j].length;
    }
    return out;
}

function ensureAudioContext() {
    if (app.audioCtx) {
        if (app.audioCtx.state === "suspended") { app.audioCtx.resume(); }
        return app.audioCtx;
    }
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) { throw new Error("浏览器不支持 Web Audio"); }
    var ctx;
    try { ctx = new Ctor({ sampleRate: IN_RATE }); }
    catch (e) { ctx = new Ctor(); }
    app.audioCtx = ctx;
    if (ctx.state === "suspended") { ctx.resume(); }
    if (ctx.sampleRate !== IN_RATE) {
        log("音频上下文 " + ctx.sampleRate + "Hz，采集后将重采样到 16k");
    }
    return ctx;
}

function ensureAudio() {
    ensureAudioContext();
    if (app.mic) { return Promise.resolve(); }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        return Promise.reject(new Error("浏览器不支持麦克风采集"));
    }
    return navigator.mediaDevices.getUserMedia({
        audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        }
    }).then(function (stream) {
        try {
            var ctx = app.audioCtx;
            var source = ctx.createMediaStreamSource(stream);
            var proc = ctx.createScriptProcessor(BLOCK, 1, 1);
            app.pending = new Float32Array(0);
            app.preroll = [];

            proc.onaudioprocess = function (ev) {
                var input = ev.inputBuffer.getChannelData(0);
                onBlock(input, computeRms(input));
            };

            source.connect(proc);
            var mute = ctx.createGain();
            mute.gain.value = 0;
            proc.connect(mute);
            mute.connect(ctx.destination);   // 必须连到 destination 才会持续回调

            app.mic = { stream: stream, source: source, proc: proc, mute: mute };
            log("麦克风已开启");
        } catch (e) {
            /* 建节点失败时别把麦克风句柄漏着（否则浏览器一直显示"正在录音"） */
            try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e2) { /* 忽略 */ }
            app.mic = null;
            throw e;
        }
    });
}

function onBlock(input, rms) {
    /* 显示音量 */
    app.micTarget = Math.max(app.micTarget, levelFromRms(rms));

    pushPreroll(input);

    if (!app.ws || app.ws.readyState !== WebSocket.OPEN || !app.enc) { return; }

    /* 播放中：不上传、也不做 VAD 判定（避免把 TTS 自己的声音收回去） */
    if (app.busy || app.ttsActive) { return; }

    if (app.state === "listening" || app.state === "hearing") {
        var blockMs = BLOCK / app.audioCtx.sampleRate * 1000;

        /* 兜底：长时间一点说话都没听到，就重新校准一次噪声底。
           否则万一第一次校准把噪声估高了（比如刚好有人在聊天），
           会一直卡在"听不见"的状态。 */
        if (!app.streaming && Date.now() - vad.recalAt > 25000) {
            vadReset(true);
            log("25 秒没检测到说话，重新校准环境噪声");
            return;
        }

        var speech = vadProcess(rms, blockMs);
        if (speech && !app.streaming) {
            sendListenStart();
        } else if (!speech && app.streaming) {
            sendListenStop("VAD：说完了");
        } else if (app.streaming && Date.now() - app.streamingSince > MAX_UTTERANCE_MS) {
            sendListenStop("单轮超过 " + (MAX_UTTERANCE_MS / 1000) + " 秒");
        }
    }

    if (!app.streaming) { return; }

    /* 重采样到 16k，按 60ms 一帧编码上传（实时节奏，不攒批） */
    var as16 = resample(input, app.audioCtx.sampleRate, IN_RATE);
    var merged = new Float32Array(app.pending.length + as16.length);
    merged.set(app.pending);
    merged.set(as16, app.pending.length);

    var off = 0;
    while (merged.length - off >= FRAME_SAMPLES) {
        var pkt = encodeFrame(toInt16(merged.subarray(off, off + FRAME_SAMPLES)));
        if (pkt) { app.ws.send(pkt); }
        off += FRAME_SAMPLES;
    }
    app.pending = merged.slice(off);
}

/* 任意采样率 → 16k：区间平均，避免直接抽样把高频混叠成噪声 */
function resample(input, from, to) {
    if (from === to) { return input; }
    var ratio = from / to;
    var outLen = Math.floor(input.length / ratio);
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
        var a = Math.floor(i * ratio);
        var b = Math.min(Math.floor((i + 1) * ratio), input.length);
        var sum = 0;
        var n = b - a;
        for (var j = a; j < b; j++) { sum += input[j]; }
        out[i] = n > 0 ? sum / n : 0;
    }
    return out;
}

function toInt16(f) {
    var out = new Int16Array(f.length);
    for (var i = 0; i < f.length; i++) {
        var s = Math.max(-1, Math.min(1, f[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
}

/* =====================================================================
 * 下行播放
 * =================================================================== */
function playOpus(u8) {
    refreshBusyTimer();
    var pcm = decodePacket(u8);
    if (!pcm || !pcm.length) { return; }
    var ctx = app.audioCtx;
    if (!ctx) { return; }

    /* 播放音量（驱动波纹） */
    var sum = 0;
    for (var i = 0; i < pcm.length; i++) {
        var v = pcm[i] / 32768;
        sum += v * v;
    }
    app.ttsTarget = Math.max(app.ttsTarget, levelFromRms(Math.sqrt(sum / pcm.length)));

    var buf = ctx.createBuffer(1, pcm.length, OUT_RATE);
    var ch = buf.getChannelData(0);
    for (var k = 0; k < pcm.length; k++) { ch[k] = pcm[k] / 32768; }

    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = function () {
        var i = app.srcs.indexOf(src);
        if (i >= 0) { app.srcs.splice(i, 1); }
        try { src.disconnect(); } catch (e) { /* 忽略 */ }
    };
    app.srcs.push(src);

    var now = ctx.currentTime;
    if (app.nextPlayTime < now + 0.02) { app.nextPlayTime = now + 0.02; }
    src.start(app.nextPlayTime);
    app.nextPlayTime += buf.duration;
}

/* =====================================================================
 * 会话开始 / 结束
 * =================================================================== */
function startSession() {
    if (app.starting || app.inCall) { return; }
    app.starting = true;
    var gen = ++app.gen;          // 本次启动的世代号：await 期间被挂断就作废
    setState("connecting");
    clearTranscript();
    syncButton();

    try { ensureAudioContext(); } catch (e) { /* 下面统一报错 */ }

    /* 先要麦克风、再连网络：iOS 的 getUserMedia 很依赖用户手势，
       排在慢网络后面可能已经过了"手势有效期"而直接抛 NotAllowedError。 */
    var micP = null;
    try {
        micP = ensureAudio();
    } catch (e) {
        micP = Promise.reject(e);
    }

    micP.then(function () {
        if (gen !== app.gen) { return Promise.reject(new Error("已取消")); }
        return connect();
    }).then(function () {
        if (gen !== app.gen) { throw new Error("已取消"); }
        if (document.hidden) { throw new Error("页面在后台，无法开始"); }
        if (!app.ws || app.ws.readyState !== WebSocket.OPEN) { throw new Error("连接没有准备好"); }

        app.starting = false;
        app.inCall = true;
        app.ttsActive = false;
        setBusy(false);
        vadReset(true);

        // 通知服务端：会话正式开始（用于触发主动打招呼）
        if (app.ws && app.ws.readyState === WebSocket.OPEN) {
            app.ws.send(JSON.stringify({ type: "event", event: "session_start" }));
        }

        setState("listening", "先安静一下，我在听环境…");
        syncButton();
        log("对话开始：持续监听（mode=manual）");
        setTimeout(function () {
            if (app.inCall && app.state === "listening" && !app.busy) { setState("listening"); }
        }, 1200);
    }).catch(function (e) {
        if (gen !== app.gen) { return; }   // 已经被别处结束了，别再改界面
        app.starting = false;
        var msg = (e && e.message) || String(e);
        log("开始失败: " + msg);
        setState("error", friendlyError(msg));
        syncButton();
    });
}

function endSession(opts) {
    var silent = !!(opts && opts.silent);
    app.gen++;                 // 让还在 await 的 startSession 作废
    app.inCall = false;
    app.streaming = false;
    app.streamingSince = 0;
    app.ttsActive = false;
    if (app.busyTimer) { clearTimeout(app.busyTimer); app.busyTimer = null; }
    if (app.resumeTimer) { clearTimeout(app.resumeTimer); app.resumeTimer = null; }
    if (app.helloTimer) { clearTimeout(app.helloTimer); app.helloTimer = null; }
    app.busy = false;
    app.nextPlayTime = 0;
    app.pending = new Float32Array(0);
    app.preroll = [];

    /* 挂断时把已排期但还没播完的 TTS 一起停掉，
       否则"挂断后声音还在放"，用户马上重开就会把自己的 TTS 录进去。 */
    var srcs = app.srcs;
    app.srcs = [];
    for (var i = 0; i < srcs.length; i++) {
        try {
            srcs[i].onended = null;
            srcs[i].stop();
            srcs[i].disconnect();
        } catch (e) { /* 忽略 */ }
    }

    try {
        if (app.mic) {
            if (app.mic.proc) {
                app.mic.proc.onaudioprocess = null;
                app.mic.proc.disconnect();
            }
            if (app.mic.source) { app.mic.source.disconnect(); }
            if (app.mic.mute) { app.mic.mute.disconnect(); }
            if (app.mic.stream) {
                app.mic.stream.getTracks().forEach(function (t) { t.stop(); });
            }
        }
    } catch (e) { /* 忽略 */ }
    app.mic = null;

    closeSocket();
    if (!silent) {
        setState("offline");
        syncButton();
        log("对话结束");
    }
}

function friendlyError(msg) {
    if (/已取消/.test(msg)) { return "已取消"; }
    if (/NotAllowed|Permission|denied|权限/i.test(msg)) {
        return "麦克风被拒绝了，请在地址栏允许麦克风后重试";
    }
    if (/NotFound|Requested device/i.test(msg)) {
        return "没有找到麦克风设备，插一个麦克风再试";
    }
    if (/不支持 Web Audio|不支持麦克风采集/.test(msg)) {
        return "这个浏览器不支持麦克风采集，换 Chrome / Edge / Safari 再试";
    }
    if (/Opus/i.test(msg)) {
        return "语音编解码库没加载出来，刷新一下页面";
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
        return "连不上服务器（网络或后端不可用），点按钮重试";
    }
    if (/超时/.test(msg)) { return "连接超时，检查网络后点按钮重试"; }
    if (/后台/.test(msg)) { return "页面在后台，回到前台再点一次"; }
    return msg;
}

/* =====================================================================
 * 视觉：波形 + 头像呼吸
 * =================================================================== */
var waveCtx = null;
var waveW = 0, waveH = 0, waveDpr = 1, waveGrad = null;

function resizeWave() {
    if (!el.wave) { return; }
    var rect = el.wave.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    var W = Math.max(1, Math.round(rect.width));
    var H = Math.max(1, Math.round(rect.height));
    el.wave.width = Math.round(W * dpr);
    el.wave.height = Math.round(H * dpr);
    waveCtx = el.wave.getContext("2d");
    waveW = W;
    waveH = H;
    waveDpr = dpr;
    if (!waveCtx) { return; }
    waveGrad = waveCtx.createLinearGradient(0, 0, W, 0);
    waveGrad.addColorStop(0, "rgba(129,140,248,0.35)");
    waveGrad.addColorStop(0.5, "rgba(125,211,252,1)");
    waveGrad.addColorStop(1, "rgba(129,140,248,0.35)");
}

function roundRect(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, r);
        return;
    }
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}

/* 当前应该显示多大的"动感"：AI 说话看下行音量，用户说话看上行音量 */
function displayLevel(now) {
    switch (app.state) {
        case "talking":
            return Math.max(app.ttsLevel, 0.16);
        case "hearing":
            return Math.max(app.micLevel, 0.16);
        case "listening":
            return Math.max(app.micLevel * 0.85, 0.04 + 0.015 * Math.sin(now / 900));
        case "thinking":
            return 0.10 + 0.05 * Math.sin(now / 420);
        case "connecting":
            return 0.08 + 0.04 * Math.sin(now / 260);
        case "ready":
            return 0.05 + 0.02 * Math.sin(now / 1100);
        default:
            return 0.02;
    }
}

function drawWave(now, level) {
    if (!waveCtx || !waveW || !waveH) { return; }
    var ctx = waveCtx;
    var W = waveW;
    var H = waveH;

    ctx.setTransform(waveDpr, 0, 0, waveDpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var n = app.bars.length;
    var gap = W / n;
    var bw = Math.max(1.4, gap * 0.4);

    /* 中间的细线，安静时也有一点呼吸感 */
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(148,163,184,0.18)";
    ctx.fillRect(0, H / 2 - 0.5, W, 1);

    for (var i = 0; i < n; i++) {
        var env = Math.pow(Math.sin(Math.PI * (i + 0.5) / n), 1.15);
        var jitter = 0.74
            + 0.20 * Math.sin(now / 190 + i * 1.7)
            + 0.06 * Math.sin(now / 97 + i * 3.1);
        var target = Math.max(0, level * env * jitter);
        app.bars[i] += (target - app.bars[i]) * 0.24;

        var h = Math.min(H, Math.max(1.6, app.bars[i] * H * 1.55));
        var x = i * gap + (gap - bw) / 2;
        var y = (H - h) / 2;
        ctx.globalAlpha = 0.30 + 0.70 * Math.min(1, level * 2.4);
        ctx.fillStyle = waveGrad || "rgba(125,211,252,0.9)";
        roundRect(ctx, x, y, bw, h, bw / 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

function startVisuals() {
    resizeWave();
    window.addEventListener("resize", resizeWave);

    var last = performance.now();
    function tick(now) {
        var dt = (now - last) / 1000;
        if (!(dt > 0)) { dt = 0.016; }
        dt = Math.min(dt, 0.06);
        last = now;

        /* 瞬时目标值按时间衰减，再平滑跟随 → 不抖、不掉帧 */
        app.micTarget *= Math.exp(-dt / 0.10);
        app.ttsTarget *= Math.exp(-dt / 0.10);
        var k = Math.min(1, dt * 22);
        app.micLevel += (app.micTarget - app.micLevel) * k;
        app.ttsLevel += (app.ttsTarget - app.ttsLevel) * k;

        var level = displayLevel(now);
        if (el.stage) { el.stage.style.setProperty("--level", level.toFixed(3)); }
        drawWave(now, level);
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}

/* =====================================================================
 * 事件
 * =================================================================== */
function onMainClick() {
    if (app.state === "connecting" || app.starting) { return; }
    if (app.inCall) { endSession(); return; }
    try { ensureAudioContext(); } catch (e) { /* startSession 里统一报错 */ }
    startSession();
}

function onKeyDown(e) {
    if (e.repeat || e.isComposing) { return; }
    var tag = (e.target && e.target.tagName) || "";
    /* 输入框、链接、按钮自己会处理空格/回车，别再劫持一次 */
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "A" || tag === "BUTTON") { return; }
    if (e.code === "Space" || e.code === "Enter") {
        e.preventDefault();
        onMainClick();
    }
}

function buildDebugPanel() {
    debugEl = document.createElement("div");
    debugEl.id = "debug-panel";
    debugEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(debugEl);
}

/* =====================================================================
 * 启动
 * =================================================================== */
function boot() {
    el.stage = $("stage");
    el.status = $("status");
    el.pillText = $("pillText");
    el.btnMain = $("btnMain");
    el.btnLabel = $("btnLabel");
    el.icoMic = $("icoMic");
    el.icoStop = $("icoStop");
    el.hint = $("hint");
    el.wave = $("wave");
    el.transcript = $("transcript");

    if (DEBUG) {
        buildDebugPanel();
        /* 调试入口：自检页 / 单文件版（普通访客看不到，保持页面简洁） */
        ["devLinks", "devSep", "devStandalone", "devSep2"].forEach(function (id) {
            var node = $(id);
            if (node) { node.classList.remove("hidden"); }
        });
    }
    log("页面加载 " + location.href + "（" + navigator.userAgent + "）");

    if (location.protocol === "file:") {
        setState("error", "请用 http(s) 打开：麦克风在 file:// 下不可用");
        if (el.hint) { el.hint.textContent = "本地打开请用 python -m http.server 8080 之类的本地服务"; }
        if (el.btnMain) { el.btnMain.disabled = true; }
        return;
    }

    if (!window.isSecureContext) {
        log("警告：当前不是安全上下文，麦克风会被浏览器拒绝（需要 HTTPS 或 localhost）");
        if (el.hint) { el.hint.textContent = "当前地址不是 HTTPS/localhost，浏览器不会给麦克风权限"; }
    }

    startVisuals();
    setState("offline");
    syncButton();
    clearTranscript();

    if (el.btnMain) { el.btnMain.addEventListener("click", onMainClick); }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("visibilitychange", function () {
        if (document.hidden && app.inCall) {
            log("页面进入后台，结束本轮对话");
            endSession({ silent: true });
            setState("offline", "页面在后台时已挂断，回来再点一次");
        }
    });

    /* 预热：先把 OTA + WebSocket 建好，用户点按钮时只剩开麦，握手不占他的时间 */
    connect().then(function () {
        if (!app.inCall) { setState("ready"); }
    }).catch(function (e) {
        log("预热连接失败: " + ((e && e.message) || e));
        if (!app.inCall && app.state !== "error") {
            setState("offline", "没连上服务器，点按钮重试");
        }
    });

    /* 给测试/排障用的只读入口 */
    window.__xq = {
        app: app,
        vad: vad,
        config: CONFIG,
        logs: function () { return LOGS.slice(); },
        state: function () { return app.state; }
    };
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
} else {
    boot();
}
