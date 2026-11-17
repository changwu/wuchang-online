#!/usr/bin/env python3
"""把 app.js + libopus.js 打成单个可独立分发的 index.html。

为什么需要 libopus：
    xiaozhi 协议的上行必须 Opus —— core/connection.py 里无条件调用
    _decode_opus_packet(message)，裸 PCM 会被当 Opus 解码失败而丢弃；
    下行同样是 Opus（tts/base.py 硬编码 is_opus=True）。
    所以浏览器端必须有 Opus 编解码器。

为什么可以内联：
    上游的 js/utils/libopus.js 是 asm.js（825KB 纯 JS，不是 .wasm 文件，
    无外部 fetch），可以直接塞进 <script>。拼完约 850KB 的单文件。

用法：
    python3 standalone/build.py
    # 产出 standalone/index.html
"""
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

APP = os.path.join(HERE, "app.js")
OPUS = os.path.join(ROOT, "js", "utils", "libopus.js")
OUT = os.path.join(HERE, "index.html")

TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>小缺 · 单文件语音对话</title>
<style>
  :root {{ --bg:#0f1115; --card:#191c23; --fg:#e6e8ee; --dim:#8b93a7;
          --ok:#3fb950; --warn:#d29922; --err:#f85149; --accent:#4493f8; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; padding:24px; font:14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;
         background:var(--bg); color:var(--fg); }}
  .wrap {{ max-width:720px; margin:0 auto; }}
  h1 {{ font-size:18px; margin:0 0 4px; font-weight:600; }}
  .sub {{ color:var(--dim); font-size:12px; margin-bottom:20px; }}
  .card {{ background:var(--card); border:1px solid #262a33; border-radius:10px;
          padding:16px; margin-bottom:14px; }}
  label {{ display:block; font-size:12px; color:var(--dim); margin-bottom:6px; }}
  input[type=text] {{ width:100%; padding:9px 11px; border-radius:7px;
    border:1px solid #2d323c; background:#11141a; color:var(--fg);
    font:inherit; font-size:13px; }}
  input[type=text]:focus {{ outline:none; border-color:var(--accent); }}
  .row {{ display:flex; gap:9px; margin-top:12px; flex-wrap:wrap; }}
  button {{ padding:9px 16px; border-radius:7px; border:1px solid #2d323c;
    background:#22262f; color:var(--fg); font:inherit; font-size:13px; cursor:pointer; }}
  button:hover:not(:disabled) {{ background:#2a2f39; }}
  button:disabled {{ opacity:.42; cursor:not-allowed; }}
  button.primary {{ background:#1f6feb; border-color:#1f6feb; }}
  button.primary:hover:not(:disabled) {{ background:#2a7aef; }}
  button.danger {{ background:#8b2c2c; border-color:#a33; }}
  .status {{ display:flex; align-items:center; gap:8px; font-size:13px; }}
  .dot {{ width:8px; height:8px; border-radius:50%; background:#555; flex:none; }}
  .dot.on {{ background:var(--ok); box-shadow:0 0 8px var(--ok); }}
  .dot.busy {{ background:var(--warn); }}
  .dot.err {{ background:var(--err); }}
  #log {{ height:240px; overflow-y:auto; background:#0b0d11; border-radius:7px;
    padding:10px; font:12px/1.65 ui-monospace,Consolas,monospace;
    white-space:pre-wrap; word-break:break-all; }}
  #log .t {{ color:#5a6274; }}
  #log .i {{ color:#79c0ff; }}
  #log .w {{ color:var(--warn); }}
  #log .e {{ color:var(--err); }}
  #log .u {{ color:#7ee787; }}
  #log .a {{ color:#d2a8ff; }}
  .meter {{ height:3px; background:#22262f; border-radius:2px; margin-top:10px; overflow:hidden; }}
  .meter > i {{ display:block; height:100%; width:0; background:var(--ok); transition:width .08s linear; }}
  .hint {{ font-size:12px; color:var(--dim); margin-top:10px; line-height:1.7; }}
</style>
</head>
<body>
<div class="wrap">
  <h1>小缺 · 单文件语音对话</h1>
  <div class="sub">单个 .html · 内置 Opus 编解码 · 无任何外部请求</div>

  <div class="card">
    <label for="ota">OTA 服务器地址</label>
    <input type="text" id="ota" value="{ota_url}">
    <div class="row">
      <button class="primary" id="btnConnect">连接</button>
      <button id="btnTalk" disabled>按住说话</button>
      <button class="danger" id="btnClose" disabled>断开</button>
    </div>
    <div class="meter"><i id="lvl"></i></div>
    <div class="hint">
      连上后点「按住说话」（或按住空格）。服务端自己做 VAD 断句，松开不会立刻结束。
      回答会自动播放。
    </div>
  </div>

  <div class="card">
    <div class="status"><span class="dot" id="dot"></span><span id="state">正在初始化 Opus…</span></div>
  </div>

  <div class="card"><div id="log"></div></div>
</div>

<!-- ========== 内联 libopus（asm.js，约 825KB） ========== -->
<script>
{opus}
</script>

<!-- ========== 应用逻辑 ========== -->
<script>
{app}
</script>
</body>
</html>
"""

DEFAULT_OTA = "https://xiaozhi.xiada.cn/xiaozhi/ota/"


def main() -> int:
    for p in (APP, OPUS):
        if not os.path.exists(p):
            print("缺文件: %s" % p, file=sys.stderr)
            return 1

    # 允许通过环境变量覆盖默认 OTA，方便分发时不写死自己的服务器
    ota = os.environ.get("DEFAULT_OTA_URL", DEFAULT_OTA)

    opus_src = io.open(OPUS, encoding="utf-8", errors="replace").read()
    app_src = io.open(APP, encoding="utf-8").read()

    # asm.js 里若含 </script> 会提前闭合标签
    if "</script" in opus_src.lower():
        print("警告: libopus.js 含 </script，做转义", file=sys.stderr)
        opus_src = opus_src.replace("</script", "<\\/script")

    html = TEMPLATE.format(ota_url=ota, opus=opus_src, app=app_src)
    io.open(OUT, "w", encoding="utf-8", newline="\n").write(html)

    size = os.path.getsize(OUT)
    print("生成: %s" % OUT)
    print("  大小: %.2f MB (%d bytes)" % (size / 1024 / 1024, size))
    print("  组成: libopus %.0f KB + app %.0f KB"
          % (len(opus_src) / 1024, len(app_src) / 1024))
    print("  默认 OTA: %s" % ota)
    print()
    print("  ✓ 单文件，可直接分发；麦克风需在 HTTPS 或 localhost 下打开")
    return 0


if __name__ == "__main__":
    sys.exit(main())
