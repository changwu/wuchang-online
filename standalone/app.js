/* 小缺 · 单文件语音客户端（应用逻辑）
 *
 * 这个文件会被 build.py 内联进 index.html，和 libopus.js 拼成一个
 * 可独立分发的 .html。
 *
 * 协议事实（读 xiaozhi-server 源码确认，不是猜的）：
 *   上行 —— core/connection.py:382 无条件 _decode_opus_packet(message)，
 *           所以客户端必须发 Opus。16kHz 单声道，60ms/帧 = 960 样本。
 *   下行 —— core/providers/tts/base.py:141 硬编码 is_opus=True，
 *           60ms/帧，采样率取 conn.sample_rate（服务端日志为 24000）。
 *   所以编解码两端都需要 Opus，这也是为什么必须内联 libopus。
 *
 * 音频链路：
 *   mic(AudioContext, 通常48k) -> 降采样到16k -> Int16
 *     -> opus encode(960) -> WebSocket 二进制帧
 *   WebSocket 二进制帧 -> opus decode(24k) -> Int16 -> AudioBuffer -> 播放
 */
"use strict";

var $ = function (id) { return document.getElementById(id); };

var IN_RATE = 16000;        // 上行采样率
var FRAME_SAMPLES = 960;    // 60ms @ 16k
var OUT_RATE = 24000;       // 下行采样率（服务端 conn.sample_rate）
var MAX_DECODE_SAMPLES = 2880;  // 解码缓冲上限，24k*120ms 留余量

var ws = null;
var audioCtx = null;
var mediaStream = null;
var sourceNode = null;
var procNode = null;
var talking = false;
var connected = false;
var nextPlayTime = 0;
var enc = null;             // {m, ptr}
var dec = null;             // {m, ptr}
var pending = new Float32Array(0);
var opusReady = false;
var sessionId = "";

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

/* ---------------- Opus 封装 ---------------- */
function opusModule() {
  if (typeof Module === "undefined" || !Module.instance) { return null; }
  return Module.instance;
}

function initCodecs() {
  var m = opusModule();
  if (!m) { log("libopus 未加载", "e"); return false; }

  // 编码器：16k 单声道，VOIP 模式
  var encSize = m._opus_encoder_get_size(1);
  if (!encSize || encSize < 0) { log("get_size 失败: " + encSize, "e"); return false; }
  var encPtr = m._malloc(encSize);
  if (!encPtr) { log("编码器 malloc 失败", "e"); return false; }
  var err = m._opus_encoder_init(encPtr, IN_RATE, 1, 2048);  // 2048 = VOIP
  if (err < 0) { log("编码器 init 失败: " + err, "e"); return false; }
  m._opus_encoder_ctl(encPtr, 4002, 24000);   // SET_BITRATE 24kbps
  m._opus_encoder_ctl(encPtr, 4010, 5);       // SET_COMPLEXITY
  enc = { m: m, ptr: encPtr };

  // 解码器：24k 单声道
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
  if (n < 0) {
    m._free(outPtr);
    log("opus_encode 失败: " + n, "e");
    return null;
  }
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
  if (n < 0) {
    m._free(pcmPtr);
    return null;
  }
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
      "Device-Id": mac,          // 缺了会返回 request error，见 README
      "Client-Id": cid
    },
    body: JSON.stringify({
      version: 0, uuid: "",
      application: { name: "wuchang-online-standalone", version: "1.0.0" },
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
    // 浏览器 WebSocket 不能设自定义 header，凭据走 query（官方也这么做）
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
      setState("已连接，点「按住说话」", "on");
      $("btnTalk").disabled = false;
      $("btnClose").disabled = false;
      ws.send(JSON.stringify({
        type: "hello",
        version: 1,
        transport: "websocket",
        features: { mcp: false, aec: false },
        audio_params: {
          format: "opus",           // 协议事实：服务端只按 opus 解码
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
  if (t === "stt") { log("识别: " + (m.text || ""), "a"); return; }
  if (t === "llm") {
    var s = (m.text || "").trim();
    if (s) { log("LLM: " + s.slice(0, 100), "i"); }
    return;
  }
  if (t === "tts") {
    if (m.state === "sentence_start") { log("说: " + (m.text || ""), "u"); }
    return;
  }
  if (t === "error") {
    log("服务端错误: " + JSON.stringify(m).slice(0, 160), "e");
    return;
  }
}

/* ---------------- 采集 ---------------- */
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

function startTalk() {
  if (talking || !connected || !ws || ws.readyState !== WebSocket.OPEN) { return; }
  if (!opusReady && !initCodecs()) { return; }

  var ctx;
  try { ctx = new AudioContext({ sampleRate: IN_RATE }); }
  catch (e) { ctx = new AudioContext(); }
  audioCtx = ctx;
  if (ctx.state === "suspended") { ctx.resume(); }
  if (ctx.sampleRate !== IN_RATE) {
    log("注意: 上下文 " + ctx.sampleRate + "Hz，将重采样到 16k", "w");
  }

  navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true,
             noiseSuppression: true, autoGainControl: true }
  }).then(function (stream) {
    mediaStream = stream;
    sourceNode = ctx.createMediaStreamSource(stream);
    procNode = ctx.createScriptProcessor(4096, 1, 1);
    pending = new Float32Array(0);

    procNode.onaudioprocess = function (ev) {
      var input = ev.inputBuffer.getChannelData(0);

      var peak = 0;
      for (var i = 0; i < input.length; i++) {
        var a = Math.abs(input[i]);
        if (a > peak) { peak = a; }
      }
      var lv = $("lvl");
      if (lv) { lv.style.width = Math.min(100, peak * 180) + "%"; }

      if (!talking || !ws || ws.readyState !== WebSocket.OPEN || !enc) { return; }

      var as16 = resample(input, ctx.sampleRate, IN_RATE);
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
    };

    sourceNode.connect(procNode);
    // ScriptProcessor 必须连到 destination 才会驱动；用 0 增益避免回授
    var mute = ctx.createGain();
    mute.gain.value = 0;
    procNode.connect(mute);
    mute.connect(ctx.destination);

    talking = true;
    $("btnTalk").textContent = "正在说…（点此停止）";
    setState("录音中，请说话", "on");
    ws.send(JSON.stringify({ type: "listen", state: "start", mode: "auto" }));
    log("开始推流（服务端 VAD 自动断句）", "a");

  }).catch(function (e) {
    log("无法录音: " + e.message, "e");
    log("麦克风需要 HTTPS 或 localhost 环境", "w");
    stopTalk();
  });
}

function stopTalk() {
  talking = false;
  $("btnTalk").textContent = "按住说话";
  try {
    if (procNode) { procNode.disconnect(); procNode.onaudioprocess = null; procNode = null; }
    if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) { t.stop(); });
      mediaStream = null;
    }
  } catch (e) { /* 忽略 */ }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "listen", state: "stop" }));
    setState("已连接，点「按住说话」", "on");
  }
  var lv = $("lvl");
  if (lv) { lv.style.width = "0%"; }
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
  stopTalk();
  connected = false;
  $("btnConnect").disabled = false;
  $("btnTalk").disabled = true;
  $("btnClose").disabled = true;
  nextPlayTime = 0;
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
  // asm.js 初始化是同步的，但给它一点时间
  setTimeout(function () {
    if (initCodecs()) {
      setState("就绪，点「连接」", "");
    } else {
      setState("Opus 初始化失败", "err");
    }
  }, 60);

  $("btnConnect").onclick = connect;
  $("btnClose").onclick = closeAll;

  var tb = $("btnTalk");
  tb.addEventListener("mousedown", function (e) { e.preventDefault(); startTalk(); });
  tb.addEventListener("mouseup", function () { if (talking) { stopTalk(); } });
  tb.addEventListener("mouseleave", function () { if (talking) { stopTalk(); } });
  tb.addEventListener("touchstart", function (e) { e.preventDefault(); startTalk(); });
  tb.addEventListener("touchend", function (e) { e.preventDefault(); if (talking) { stopTalk(); } });

  document.addEventListener("keydown", function (e) {
    if (e.code === "Space" && !e.repeat && !talking && connected) {
      e.preventDefault();
      startTalk();
    }
  });
  document.addEventListener("keyup", function (e) {
    if (e.code === "Space" && talking) { e.preventDefault(); stopTalk(); }
  });

  var saved = localStorage.getItem("xq_ota");
  if (saved) { $("ota").value = saved; }
  $("ota").addEventListener("change", function () {
    localStorage.setItem("xq_ota", $("ota").value.trim());
  });
});
