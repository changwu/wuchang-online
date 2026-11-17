/* 阿昌 · 单文件语音客户端（应用逻辑）
 *
 * 这个文件会被 build.html 内联进 index.html，和 libopus.js 拼成一个
 * 可独立分发的 .html。
 *
 * ============================================================
 * 协议事实（读 xiaozhi-server 源码确认，不是猜的）
 * ============================================================
 * 上行 —— core/connection.py:382 无条件 _decode_opus_packet(message)，
 *         所以客户端必须发 Opus。16kHz 单声道，60ms/帧 = 960 样本。
 * 下行 —— core/providers/tts/base.py:141 硬编码 is_opus=True，
 *         60ms/帧，采样率取 conn.sample_rate（服务端为 24000）。
 *
 * ============================================================
 * 两种拾音模式
 * ============================================================
 * 1. 按住说话（press-to-talk）
 *      listen start(mode:auto) → 持续推流 → listen stop
 *      服务端自己也跑 Silero VAD，靠静音断句。
 *
 * 2. 持续监听（continuous，本文件新增）
 *      浏览器端用能量 VAD 自己判断"开始说 / 说完了"，
 *      并声明 mode:manual（服务端 asr/base.py 里 manual 模式
 *      直接缓存全部音频、跳过它自己的 VAD），因此断句完全由
 *      客户端控制，不会出现两边判定打架。
 *
 *      流程：
 *        VAD 检测到开口 → listen start(mode:manual)
 *        VAD 说完了     → listen stop   → 服务端立即 ASR
 *        等服务端回 TTS → 播放期间静音（防回声自激）
 *        播放完          → 重新进入监听
 *
 * 回声为什么必须处理：
 *   TTS 从扬声器播出来会被同一个麦克风收进去，若继续上传，
 *   服务端会把 AI 自己的话当成用户输入，形成自问自答的死循环。
 *   所以播放期间不发音频，并重置 VAD 状态。
 */
"use strict";

var $ = function (id) { return document.getElementById(id); };

var IN_RATE = 16000;             // 上行采样率
var FRAME_SAMPLES = 960;         // 60ms @ 16k
var OUT_RATE = 24000;            // 下行采样率（服务端 conn.sample_rate）
var MAX_DECODE_SAMPLES = 2880;   // 解码缓冲上限，24k*120ms 留余量
var BLOCK = 1024;                // ScriptProcessor 块大小

var ws = null;
var audioCtx = null;
var mediaStream = null;
var sourceNode = null;
var procNode = null;
var connected = false;
var nextPlayTime = 0;
var enc = null;
var dec = null;
var pending = new Float32Array(0);
var opusReady = false;
var sessionId = "";

/* ---------------- 模式与状态 ---------------- */
var mode = "idle";        // idle | ptt | continuous
var streaming = false;    // 当前是否在往服务端推音频
var busy = false;         // 服务端在处理 / TTS 播放中，禁止拾音
var ttsActive = false;
var busyTimer = null;     // 看门狗：服务端长时间无响应时自动恢复

/* 进入/退出"忙"状态。
 * 忙的时候既不推流也不跑 VAD —— 否则会出现两个问题：
 *   1. 把 TTS 从扬声器放出来的声音再收回去（回声自激，AI 自问自答）
 *   2. 服务端还没回答，VAD 又开了新的一轮（两轮重叠，回复错乱）
 * 所以从"发完 listen stop"到"TTS 播完"整段都算忙。
 * 万一服务端没响应，看门狗 15s 后强制恢复，不让人一直卡着。
 */
function setBusy(on) {
  busy = !!on;
  if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
  if (on) {
    busyTimer = setTimeout(function () {
      log("服务端 15 秒无响应，恢复拾音", "w");
      ttsActive = false;
      setBusy(false);
      vadReset();
      if (mode === "continuous") { setState("在听，请说话", "on"); }
    }, 15000);
  }
}

/* ---------------- VAD 参数 ---------------- */
var vad = {
  calibrated: false,
  calibBlocks: 0,
  noiseFloor: 0.004,
  speech: false,
  above: 0,             // 连续超阈值的块数
  silenceMs: 0,         // 连续静音时长
  hangoverMs: 700,      // 静音超过这个时长算"说完了"
  onsetBlocks: 2,       // 连续几块超阈值算"开口"（抗瞬时噪声）
  openFactor: 3.0,      // 开启阈值 = 噪声底 × factor
  closeFactor: 1.7,     // 关闭阈值（迟滞，避免抖动）
  absMin: 0.0035,       // 绝对下限，避免极静环境下过分灵敏
  sensitivity: 1.0      // UI 可调：>1 更灵敏
};

function vadReset() {
  vad.speech = false;
  vad.above = 0;
  vad.silenceMs = 0;
}

/* ---------------- 日志 ---------------- */
function log(msg, cls) {
  var box = $("log");
  if (!box) { return; }
  var line = document.createElement("div");
  var t = document.createElement("span");
  t.className = "t";
  t.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false }) + " ";
  var m = document.createElement("span");
  m.className = cls || "i";
  m.textContent = msg;
  line.appendChild(t);
  line.appendChild(m);
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
  while (box.childNodes.length > 300) { box.removeChild(box.firstChild); }
}

function setState(text, kind) {
  var s = $("state");
  if (s) { s.textContent = text; }
  var d = $("dot");
  if (d) { d.className = "dot" + (kind ? " " + kind : ""); }
}

/* ---------------- Opus ---------------- */
function opusModule() {
  if (typeof Module === "undefined" || !Module.instance) { return null; }
  return Module.instance;
}

function initCodecs() {
  var m = opusModule();
  if (!m) { log("libopus 未加载", "e"); return false; }

  var encSize = m._opus_encoder_get_size(1);
  if (!encSize || encSize < 0) { log("encoder get_size 失败: " + encSize, "e"); return false; }
  var encPtr = m._malloc(encSize);
  if (!encPtr) { log("编码器 malloc 失败", "e"); return false; }
  var err = m._opus_encoder_init(encPtr, IN_RATE, 1, 2048);
  if (err < 0) { log("编码器 init 失败: " + err, "e"); return false; }
  m._opus_encoder_ctl(encPtr, 4002, 24000);   // SET_BITRATE
  m._opus_encoder_ctl(encPtr, 4010, 5);       // SET_COMPLEXITY
  enc = { m: m, ptr: encPtr };

  var decSize = m._opus_decoder_get_size(1);
  if (!decSize || decSize < 0) { log("decoder get_size 失败: " + decSize, "e"); return false; }
  var decPtr = m._malloc(decSize);
  if (!decPtr) { log("解码器 malloc 失败", "e"); return false; }
  err = m._opus_decoder_init(decPtr, OUT_RATE, 1);
  if (err < 0) { log("解码器 init 失败: " + err, "e"); return false; }
  dec = { m: m, ptr: decPtr };

  opusReady = true;
  log("Opus 编解码器就绪（上行16k/60ms，下行24k/60ms）", "u");
  return true;
}

function encodeFrame(int16) {
  if (!enc) { return null; }
  var m = enc.m;
  var pcmPtr = m._malloc(FRAME_SAMPLES * 2);
  if (!pcmPtr) { return null; }
  var heap = m.HEAP16;
  var base = pcmPtr >> 1;
  for (var i = 0; i < FRAME_SAMPLES; i++) { heap[base + i] = int16[i]; }
  var outPtr = m._malloc(4000);
  if (!outPtr) { m._free(pcmPtr); return null; }
  var n = m._opus_encode(enc.ptr, pcmPtr, FRAME_SAMPLES, outPtr, 4000);
  m._free(pcmPtr);
  if (n < 0) { m._free(outPtr); log("opus_encode 失败: " + n, "e"); return null; }
  var out = new Uint8Array(n);
  for (var k = 0; k < n; k++) { out[k] = m.HEAPU8[outPtr + k]; }
  m._free(outPtr);
  return out;
}

function decodePacket(u8) {
  if (!dec || !u8 || !u8.length) { return null; }
  var m = dec.m;
  var inPtr = m._malloc(u8.length);
  if (!inPtr) { return null; }
  for (var i = 0; i < u8.length; i++) { m.HEAPU8[inPtr + i] = u8[i]; }
  var pcmPtr = m._malloc(MAX_DECODE_SAMPLES * 2);
  if (!pcmPtr) { m._free(inPtr); return null; }
  var n = m._opus_decode(dec.ptr, inPtr, u8.length, pcmPtr, MAX_DECODE_SAMPLES, 0);
  m._free(inPtr);
  if (n < 0) { m._free(pcmPtr); return null; }
  var out = new Int16Array(n);
  var base = pcmPtr >> 1;
  var heap = m.HEAP16;
  for (var k = 0; k < n; k++) { out[k] = heap[base + k]; }
  m._free(pcmPtr);
  return out;
}

/* ---------------- 设备标识 ---------------- */
function uuid() {
  if (crypto.randomUUID) { return crypto.randomUUID(); }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 3 | 8)).toString(16);
  });
}

function getMac() {
  var v = localStorage.getItem("xq_mac");
  if (!v) {
    var a = [];
    for (var i = 0; i < 6; i++) {
      a.push((Math.random() * 256 | 0).toString(16).padStart(2, "0"));
    }
    v = a.join(":");
    localStorage.setItem("xq_mac", v);
  }
  return v;
}

function getCid() {
  var v = localStorage.getItem("xq_cid");
  if (!v) { v = uuid(); localStorage.setItem("xq_cid", v); }
  return v;
}

/* ---------------- OTA ---------------- */
function otaLookup(url) {
  var mac = getMac();
  var cid = getCid();
  log("OTA 请求: " + url, "i");
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Device-Id": mac,
      "Client-Id": cid
    },
    body: JSON.stringify({
      version: 0, uuid: "",
      application: { name: "wuchang-online-standalone", version: "1.1.0" },
      ota: { label: "standalone" },
      board: { type: "bread-compact-wifi", ssid: "", rssi: 0, channel: 0,
               ip: "", mac: mac },
      flash_size: 0, minimum_free_heap_size: 0,
      mac_address: mac, chip_model_name: "esp32s3",
      chip_info: { model: 0, cores: 0, revision: 0, features: 0 },
      partition_table: [{ label: "", type: 0, subtype: 0, address: 0, size: 0 }]
    })
  }).then(function (r) {
    if (!r.ok) { throw new Error("OTA HTTP " + r.status); }
    return r.json();
  }).then(function (j) {
    if (!j.websocket || !j.websocket.url) {
      throw new Error("OTA 响应缺 websocket: " + JSON.stringify(j).slice(0, 160));
    }
    log("OTA 返回: " + j.websocket.url, "u");
    return j.websocket;
  });
}

/* ---------------- 连接 ---------------- */
function connect() {
  var otaUrl = $("ota").value.trim();
  if (!otaUrl) { log("请填 OTA 地址", "e"); return; }
  if (!opusReady && !initCodecs()) { return; }

  $("btnConnect").disabled = true;
  setState("正在连接…", "busy");

  otaLookup(otaUrl).then(function (info) {
    var u = new URL(info.url);
    if (info.token) {
      u.searchParams.append("authorization",
        info.token.indexOf("Bearer ") === 0 ? info.token : "Bearer " + info.token);
    }
    u.searchParams.append("device-id", getMac());
    u.searchParams.append("client-id", getCid());

    log("连接 WS…", "i");
    ws = new WebSocket(u.toString());
    ws.binaryType = "arraybuffer";

    ws.onopen = function () {
      connected = true;
      setState("已连接", "on");
      $("btnTalk").disabled = false;
      $("btnClose").disabled = false;
      var bc = $("btnContinuous");
      if (bc) { bc.disabled = false; }
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
      log("已发 hello（opus/16k/60ms）", "a");
    };

    ws.onmessage = function (ev) {
      if (typeof ev.data === "string") { onJson(ev.data); }
      else { playOpus(new Uint8Array(ev.data)); }
    };

    ws.onclose = function (ev) {
      log("WS 关闭 code=" + ev.code, "w");
      cleanup();
      setState("已断开", "");
    };

    ws.onerror = function () { log("WS 错误（详见浏览器控制台）", "e"); };

  }).catch(function (e) {
    log("连接失败: " + e.message, "e");
    setState("连接失败", "err");
    $("btnConnect").disabled = false;
  });
}

function onJson(text) {
  var m;
  try { m = JSON.parse(text); } catch (e) { return; }
  var t = m.type;

  if (t === "hello") {
    sessionId = m.session_id || "";
    log("会话建立: " + (sessionId || "(无)").slice(0, 8), "u");
    return;
  }

  if (t === "stt") {
    log("识别: " + (m.text || ""), "a");
    // 服务端已收到音频并在处理，刷新看门狗
    if (busy) { setBusy(true); }
    return;
  }

  if (t === "llm") {
    var s = (m.text || "").trim();
    if (s) { log("LLM: " + s.slice(0, 100), "i"); }
    return;
  }

  if (t === "tts") {
    if (m.state === "start") {
      ttsActive = true;
      vadReset();
      // 若还在推流，先收尾；随后整段播放期都保持 busy
      if (streaming) { sendListenStop("TTS 开始，收尾本轮"); }
      setBusy(true);
      setState("AI 正在回答…", "busy");
    } else if (m.state === "sentence_start") {
      log("说: " + (m.text || ""), "u");
    } else if (m.state === "stop") {
      ttsActive = false;
      log("TTS 结束", "i");
      // 播放缓冲可能还没播完，交给 playOpus 的排水判断
      scheduleResume();
    }
    return;
  }

  if (t === "error") {
    log("服务端错误: " + JSON.stringify(m).slice(0, 160), "e");
    return;
  }
}

/* TTS 停止后，等播放队列排空再恢复拾音 */
var resumeTimer = null;
function scheduleResume() {
  if (resumeTimer) { clearTimeout(resumeTimer); }
  resumeTimer = setTimeout(function () {
    if (ttsActive) { scheduleResume(); return; }
    // 服务端说完了，但本地播放缓冲可能还在放：等它排空
    var draining = audioCtx && nextPlayTime > audioCtx.currentTime + 0.15;
    if (draining) { scheduleResume(); return; }
    setBusy(false);
    vadReset();
    if (mode === "continuous") {
      setState("在听，请说话", "on");
    } else if (mode === "ptt") {
      setState("已连接，点「按住说话」", "on");
    } else {
      setState("已连接", "on");
    }
  }, 350);
}

/* ---------------- 音频格式转换 ---------------- */
/* 把任意采样率降到 16k。用区间平均（不抽样），避免高频混叠成噪声。
 * AudioContext 通常给 48k，直接抽样会丢掉一半能量且音质糟。 */
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

/* Float32 [-1,1] -> Int16 */
function toInt16(f) {
  var out = new Int16Array(f.length);
  for (var i = 0; i < f.length; i++) {
    var s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/* ---------------- 拾音管道（两种模式共用）---------------- */
function computeRms(buf) {
  var s = 0;
  for (var i = 0; i < buf.length; i++) { s += buf[i] * buf[i]; }
  return Math.sqrt(s / buf.length);
}

function ensureAudio() {
  if (audioCtx && mediaStream) { return Promise.resolve(); }
  var ctx;
  try { ctx = new AudioContext({ sampleRate: IN_RATE }); }
  catch (e) { ctx = new AudioContext(); }
  audioCtx = ctx;
  if (ctx.state === "suspended") { ctx.resume(); }
  if (ctx.sampleRate !== IN_RATE) {
    log("注意: 上下文 " + ctx.sampleRate + "Hz，将重采样到 16k", "w");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true,
             noiseSuppression: true, autoGainControl: true }
  }).then(function (stream) {
    mediaStream = stream;
    sourceNode = ctx.createMediaStreamSource(stream);
    procNode = ctx.createScriptProcessor(BLOCK, 1, 1);
    pending = new Float32Array(0);

    procNode.onaudioprocess = function (ev) {
      var input = ev.inputBuffer.getChannelData(0);
      var rms = computeRms(input);
      onBlock(input, rms);
    };

    sourceNode.connect(procNode);
    var mute = ctx.createGain();
    mute.gain.value = 0;
    procNode.connect(mute);
    mute.connect(ctx.destination);
  });
}

function onBlock(input, rms) {
  /* 音量条：对数刻度，安静时也能看出动静 */
  var lv = $("lvl");
  if (lv) {
    var db = 20 * Math.log10(Math.max(rms, 1e-6));
    var pct = Math.max(0, Math.min(100, (db + 70) / 70 * 100));
    lv.style.width = pct + "%";
  }

  if (!ws || ws.readyState !== WebSocket.OPEN || !enc) { return; }

  /* 播放中：既不上传也不做 VAD 判定（避免收进 TTS 自己的声音） */
  if (busy || ttsActive) { return; }

  if (mode === "continuous") {
    var st = vadProcess(rms);
    if (st.speech && !streaming) {
      sendListenStart();
    } else if (!st.speech && streaming) {
      sendListenStop("VAD: 说完了");
    }
  }

  if (!streaming) { return; }

  var as16 = resample(input, audioCtx.sampleRate, IN_RATE);
  var merged = new Float32Array(pending.length + as16.length);
  merged.set(pending);
  merged.set(as16, pending.length);

  var off = 0;
  while (merged.length - off >= FRAME_SAMPLES) {
    var pkt = encodeFrame(toInt16(merged.subarray(off, off + FRAME_SAMPLES)));
    if (pkt) { ws.send(pkt); }
    off += FRAME_SAMPLES;
  }
  pending = merged.slice(off);
}

/* ---------------- VAD 状态机 ---------------- */
function vadProcess(rms) {
  var blockMs = BLOCK / audioCtx.sampleRate * 1000;

  /* 前 ~1 秒先测环境噪声，期间不当成说话 */
  if (!vad.calibrated) {
    vad.noiseFloor = vad.noiseFloor * 0.7 + rms * 0.3;
    vad.calibBlocks++;
    if (vad.calibBlocks * blockMs >= 1000) {
      vad.calibrated = true;
      log("VAD 校准完成，噪声底 rms=" + vad.noiseFloor.toFixed(5), "i");
    }
    return { speech: false, rms: rms };
  }

  /* 噪声底：向下跟得快，向上跟得慢（避免把人声学成噪声） */
  if (rms < vad.noiseFloor) {
    vad.noiseFloor = vad.noiseFloor * 0.7 + rms * 0.3;
  } else {
    vad.noiseFloor = vad.noiseFloor * 0.995 + rms * 0.005;
  }

  var open = Math.max(vad.absMin, vad.noiseFloor * vad.openFactor / vad.sensitivity);
  var close = Math.max(vad.absMin * 0.7, vad.noiseFloor * vad.closeFactor / vad.sensitivity);

  if (!vad.speech) {
    if (rms > open) {
      vad.above++;
      if (vad.above >= vad.onsetBlocks) {
        vad.speech = true;
        vad.above = 0;
        vad.silenceMs = 0;
      }
    } else {
      vad.above = 0;
    }
  } else {
    if (rms < close) {
      vad.silenceMs += blockMs;
      if (vad.silenceMs >= vad.hangoverMs) {
        vad.speech = false;
        vad.silenceMs = 0;
      }
    } else {
      vad.silenceMs = 0;
    }
  }
  return { speech: vad.speech, rms: rms };
}

/* ---------------- listen 消息 ---------------- */
function sendListenStart() {
  if (!ws || ws.readyState !== WebSocket.OPEN) { return; }
  var m = (mode === "continuous") ? "manual" : "auto";
  ws.send(JSON.stringify({ type: "listen", state: "start", mode: m }));
  streaming = true;
  pending = new Float32Array(0);
  setBusy(false);
  if (mode === "continuous") {
    setState("在听，正在识别…", "on");
    log("检测到开口 → listen start(manual)", "a");
  }
}

function sendListenStop(why) {
  if (!ws || ws.readyState !== WebSocket.OPEN) { return; }
  ws.send(JSON.stringify({ type: "listen", state: "stop" }));
  streaming = false;
  pending = new Float32Array(0);
  // 从这一刻起禁止拾音，直到 TTS 播完（或看门狗超时）
  setBusy(true);
  if (mode === "continuous") {
    setState("思考中…", "busy");
    log("收尾 → listen stop（" + why + "）", "a");
  }
}

/* ---------------- 按住说话（保留为备用）---------------- */
function startTalk() {
  if (mode === "continuous") { return; }
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) { return; }
  if (!opusReady && !initCodecs()) { return; }
  mode = "ptt";
  ensureAudio().then(function () {
    vadReset();
    busy = false;
    sendListenStart();
    $("btnTalk").textContent = "正在说…（点此停止）";
    setState("录音中，请说话", "on");
    log("按住说话：开始推流（服务端 VAD 断句）", "a");
  }).catch(function (e) {
    log("无法录音: " + e.message, "e");
    log("麦克风需要 HTTPS 或 localhost 环境", "w");
    mode = "idle";
  });
}

function stopTalk() {
  if (mode === "continuous") { return; }
  if (streaming) { sendListenStop("松手"); }
  if (mode === "ptt") { mode = "idle"; }
  $("btnTalk").textContent = "按住说话";
  if (connected) { setState("已连接，点「按住说话」", "on"); }
}

/* ---------------- 持续监听 ---------------- */
function startContinuous() {
  if (!connected || !ws || ws.readyState !== WebSocket.OPEN) { return; }
  if (!opusReady && !initCodecs()) { return; }
  ensureAudio().then(function () {
    mode = "continuous";
    busy = false;
    ttsActive = false;
    vad.calibrated = false;
    vad.calibBlocks = 0;
    vad.noiseFloor = 0.004;
    vadReset();
    setState("校准环境噪声…", "busy");
    var bc = $("btnContinuous");
    if (bc) { bc.textContent = "停止监听"; bc.classList.add("active"); }
    $("btnTalk").disabled = true;
    log("持续监听已开启：先静一下让它测噪声，然后直接说话", "a");
  }).catch(function (e) {
    log("无法录音: " + e.message, "e");
    log("麦克风需要 HTTPS 或 localhost 环境", "w");
  });
}

function stopContinuous() {
  if (mode !== "continuous") { return; }
  if (streaming) { sendListenStop("关闭持续监听"); }
  mode = "idle";
  setState("已连接", "on");
  var bc = $("btnContinuous");
  if (bc) { bc.textContent = "持续监听"; bc.classList.remove("active"); }
  $("btnTalk").disabled = false;
  log("持续监听已关闭", "w");
}

/* ---------------- 播放 ---------------- */
function playOpus(u8) {
  var pcm = decodePacket(u8);
  if (!pcm || !pcm.length || !audioCtx) { return; }

  var buf = audioCtx.createBuffer(1, pcm.length, OUT_RATE);
  var ch = buf.getChannelData(0);
  for (var i = 0; i < pcm.length; i++) { ch[i] = pcm[i] / 32768; }

  var src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);

  var now = audioCtx.currentTime;
  if (nextPlayTime < now + 0.02) { nextPlayTime = now + 0.02; }
  src.start(nextPlayTime);
  nextPlayTime += buf.duration;
}

/* ---------------- 收尾 ---------------- */
function cleanup() {
  mode = "idle";
  streaming = false;
  busy = false;
  ttsActive = false;
  connected = false;
  if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
  if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
  try {
    if (procNode) { procNode.disconnect(); procNode.onaudioprocess = null; procNode = null; }
    if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) { t.stop(); });
      mediaStream = null;
    }
  } catch (e) { /* 忽略 */ }
  $("btnConnect").disabled = false;
  $("btnTalk").disabled = true;
  $("btnClose").disabled = true;
  $("btnTalk").textContent = "按住说话";
  var bc = $("btnContinuous");
  if (bc) { bc.disabled = true; bc.textContent = "持续监听"; bc.classList.remove("active"); }
  nextPlayTime = 0;
  var lv = $("lvl");
  if (lv) { lv.style.width = "0%"; }
}

function closeAll() {
  if (ws) { try { ws.close(); } catch (e) { /* 忽略 */ } ws = null; }
  cleanup();
  if (audioCtx) { try { audioCtx.close(); } catch (e) { /* 忽略 */ } audioCtx = null; }
  setState("未连接", "");
}

/* ---------------- 启动 ---------------- */
window.addEventListener("load", function () {
  log("页面已加载", "i");
  setTimeout(function () {
    if (initCodecs()) { setState("就绪，点「连接」", ""); }
    else { setState("Opus 初始化失败", "err"); }
  }, 60);

  $("btnConnect").onclick = connect;
  $("btnClose").onclick = closeAll;

  var bc = $("btnContinuous");
  if (bc) {
    bc.onclick = function () {
      if (mode === "continuous") { stopContinuous(); }
      else { startContinuous(); }
    };
  }

  var tb = $("btnTalk");
  tb.addEventListener("mousedown", function (e) { e.preventDefault(); startTalk(); });
  tb.addEventListener("mouseup", function () { if (streaming) { stopTalk(); } });
  tb.addEventListener("mouseleave", function () { if (streaming) { stopTalk(); } });
  tb.addEventListener("touchstart", function (e) { e.preventDefault(); startTalk(); });
  tb.addEventListener("touchend", function (e) { e.preventDefault(); if (streaming) { stopTalk(); } });

  document.addEventListener("keydown", function (e) {
    if (e.code === "Space" && !e.repeat && connected && mode !== "continuous") {
      e.preventDefault();
      startTalk();
    }
  });
  document.addEventListener("keyup", function (e) {
    if (e.code === "Space" && streaming && mode === "ptt") {
      e.preventDefault();
      stopTalk();
    }
  });

  /* 灵敏度滑块：环境吵就调高（更容易触发），太灵敏误触发就调低 */
  var sens = $("sens");
  if (sens) {
    var savedSens = localStorage.getItem("xq_sens");
    if (savedSens) { sens.value = savedSens; }
    vad.sensitivity = parseInt(sens.value, 10) / 100;
    var sv = $("sensVal");
    if (sv) { sv.textContent = vad.sensitivity.toFixed(1) + "×"; }
    sens.addEventListener("input", function () {
      vad.sensitivity = parseInt(sens.value, 10) / 100;
      if (sv) { sv.textContent = vad.sensitivity.toFixed(1) + "×"; }
      localStorage.setItem("xq_sens", sens.value);
    });
  }

  var saved = localStorage.getItem("xq_ota");
  if (saved) { $("ota").value = saved; }
  $("ota").addEventListener("change", function () {
    localStorage.setItem("xq_ota", $("ota").value.trim());
  });
});
