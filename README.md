# wuchang-online

浏览器里直接用的小智（xiaozhi）语音助手前端 —— 不需要 ESP32 硬件。

基于 [xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server)
的 `main/digital-human` 前端独立而来，带 Live2D 虚拟形象。

- 在线示例（作者自己的实例）：<https://xiaozhi.xiada.cn/test/>
- 许可证：MIT（见 [LICENSE](LICENSE)），来源与改动说明见 [NOTICE.md](NOTICE.md)

## 功能

- **语音对话**：浏览器麦克风录音 → 后端 ASR → LLM → TTS → 播放
- **文字输入**：不想说话时直接打字
- **Live2D 形象**：hiyori / natori 两套模型，口型与表情联动
- **MCP 工具调试**：调用设备侧工具（音量、屏幕主题、灯等）
- **纯静态**：不需要 Node、不需要 Python 运行时、不需要构建步骤

## 它怎么连后端

页面不写死 WebSocket 地址，而是**先请求 OTA 接口拿地址**，所以和真设备
走完全同一条链路：

```
浏览器 ──POST /xiaozhi/ota/──► 后端
       ◄── {"websocket":{"url":"wss://.../xiaozhi/v1/"}}
       ──WS  wss://.../xiaozhi/v1/──► 后端（AudioParams: opus 16k）
```

这意味着：**只要后端能服务真设备，本页面就能用**，无需改后端。

## 想要「纯 HTML」？

`standalone/index.html` 是**一个自包含的 .html 文件**（约 840KB），
把 Opus 编解码器和全部逻辑内联，不加载任何外部资源。

但要说清一个协议层的硬约束：**它不可能做成零依赖的裸 PCM 方案**。
xiaozhi 服务端上行是无条件按 Opus 解码的（`core/connection.py` 里的
`_decode_opus_packet`），下行 TTS 也硬编码 `is_opus=True`。
所以浏览器端必须有 Opus 编解码器 —— 那 825KB 就是它，不是可以省掉的。

```bash
cd standalone
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080/
```

注意：**不能双击用 file:// 打开**。浏览器只在安全上下文（HTTPS 或
localhost）里授予麦克风权限，file:// 不算。

不用 WebCodecs 的原因、以及内联 asm.js 的实测数据，见
[standalone/README.md](standalone/README.md)。

## 快速开始

### 方式一：本地静态服务（最快）

```bash
# 任选一个静态服务器，注意要在项目根目录
python3 -m http.server 8000
# 或
npx serve .
# 或
caddy file-server --root . --listen :8000
```

打开 <http://localhost:8000/>。

> ⚠️ **必须用 `localhost` 或 HTTPS**。浏览器只在安全上下文里允许麦克风权限，
> 用局域网 IP + `http://` 打开会录不到音。

### 方式二：Docker

```bash
docker build -t wuchang-online .
docker run -d --name wuchang-online -p 8000:80 wuchang-online
```

或者直接复用已有镜像，不构建：

```bash
docker run -d --name wuchang-online --restart unless-stopped \
  -p 8000:80 \
  -v "$PWD:/srv:ro" \
  caddy:2-alpine \
  caddy file-server --root /srv --listen :80
```

### 方式三：挂在已有反向代理后面

以 Caddy 为例，挂到子路径 `/test/` 下（本项目全部资源都用相对路径，
`strip_prefix` 后能正确解析）：

```caddyfile
example.com {
    handle /test/* {
        uri strip_prefix /test
        reverse_proxy 127.0.0.1:8000
    }
    handle {
        # ... 你原有的站点
    }
}
```

Nginx 等价配置：

```nginx
location /test/ {
    alias /srv/wuchang-online/;
    try_files $uri $uri/ /test/index.html;
}
```

完整可用的 Caddyfile 见 [`deploy/Caddyfile.example`](deploy/Caddyfile.example)。

## 配置 OTA 地址

打开页面后在「OTA服务器地址」框里填你的后端地址即可，它会记住（存 localStorage）。

要改**默认值**（比如分发给别人用），改 `index.html` 里这一行的 `value`：

```html
<input type="text" id="otaUrl" value="https://xiaozhi.xiada.cn/xiaozhi/ota/"
```

或用附带的脚本：

```bash
python3 scripts/set-ota-url.py https://your-server.com/xiaozhi/ota/
```

## 使用步骤

1. 打开页面
2. 「OTA服务器地址」填后端地址（默认已填作者的实例，**建议改成你自己的**）
3. 点「连接」→ 浏览器询问麦克风权限 → 允许
4. 连上后可直接说话，或在下方的文字框里输入

页面里「设备MAC」留空即可，会自动生成随机 MAC 并存 localStorage，
不会和你的真实设备撞 ID。

## 部署后可自检

```bash
# 检查页面及其所有资源是否可达（含 Live2D 模型）
python3 scripts/check-assets.py https://your-server.com/test/
```

会逐个请求 `index.html` 声明的资源、`app.js` 的动态 import、
以及 Live2D 的 `.moc3` / 贴图，全部 200 才算部署成功。

## 踩过的坑

这些是在真实部署里踩到并验证过的，记下来省时间：

**1. OTA 接口必须带 `Client-Id` 头**
少了会返回 `{"success":false,"message":"request error."}`，
而后端日志只说「OTA请求ClientID为空」，很难排查。真设备天然会带这个头，
自己写客户端时容易漏。

**2. 浏览器 WebSocket 带 `Origin`，真设备不带**
如果你的后端做了 Origin 校验，会出现"设备正常、网页连不上"。本项目的
`scripts/check-assets.py` 之外，可以用这条快速验证：

```bash
python3 - <<'PY'
# 带 Origin 做 WS 握手，看是否 101
import base64, os, socket, ssl
host = "your-server.com"
ctx = ssl.create_default_context(); ctx.verify_mode = ssl.CERT_NONE
s = ctx.wrap_socket(socket.create_connection((host, 443)), server_hostname=host)
k = base64.b64encode(os.urandom(16)).decode()
s.sendall((f"GET /xiaozhi/v1/ HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\n"
           f"Connection: Upgrade\r\nSec-WebSocket-Key: {k}\r\n"
           f"Sec-WebSocket-Version: 13\r\nOrigin: https://{host}\r\n\r\n").encode())
print(s.recv(200).decode(errors="replace").split("\r\n")[0])
PY
```

**3. 麦克风需要 HTTPS 或 localhost**
`http://192.168.x.x:8000` 这种地址浏览器会静默拒绝录音权限。

**4. Live2D 的 `.cmo3` / `.can3` 是编辑源文件，运行时不需要**
上游包含这些文件约 46MB，删掉不影响功能，体积从 62.8MB 降到 16.6MB。
运行时真正需要的是 `resources/*/runtime/` 下的 `.moc3`、贴图、
`.motion3.json`、`.physics3.json`。

## 项目结构

```
.
├── index.html              # 页面入口（含 OTA 地址默认值）
├── css/                    # 样式
├── js/
│   ├── app.js              # 入口逻辑
│   ├── core/
│   │   ├── audio/          # 录音、播放、Opus 编解码
│   │   ├── network/        # OTA 发现 + WebSocket 通信
│   │   └── mcp/            # MCP 工具调用
│   ├── live2d/             # Live2D 渲染（pixi + cubism）
│   ├── ui/                 # 界面控制
│   ├── config/             # 配置管理（localStorage）
│   └── utils/              # 工具库（libopus 等）
├── images/                 # 背景图
├── resources/              # Live2D 模型运行时文件
├── deploy/                 # 部署配置示例
├── scripts/                # 辅助脚本
└── standalone/             # 单文件版本（内联 Opus，可独立分发）
    ├── app.js              #   应用逻辑（可读源码）
    ├── build.py            #   生成器：app.js + libopus.js -> index.html
    ├── index.html          #   产物：自包含 HTML（约 840KB）
    └── README.md
```

## 依赖的后端

需要一个兼容 xiaozhi 协议的后端（xiaozhi-server），提供：

- `POST /xiaozhi/ota/` —— 下发 WebSocket 地址
- `WS /xiaozhi/v1/` —— 语音对话（Opus 16kHz 上行，Opus 下行）

本项目**不含后端**，也不含任何密钥。

## 致谢

- [xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server) —— 本前端的来源
- [Live2D Cubism SDK](https://www.live2d.com/) —— 虚拟形象渲染
- [PixiJS](https://pixijs.com/) —— 2D 渲染引擎
- [libopus](https://opus-codec.org/) —— 音频编解码

## 许可证

[MIT](LICENSE)。上游版权归属 `Copyright (c) 2025 xinnan-tech`，详见 [NOTICE.md](NOTICE.md)。
