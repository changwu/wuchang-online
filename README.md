# wuchang-online

浏览器里直接用的小智（xiaozhi）语音助手前端 —— 不需要 ESP32 硬件。

基于 [xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server)
的 `main/digital-human` 前端独立而来，带 Live2D 虚拟形象。

**纯静态项目，直接托管在 GitHub Pages 上，没有任何构建步骤或服务端依赖。**

- 许可证：MIT（见 [LICENSE](LICENSE)），来源与改动见 [NOTICE.md](NOTICE.md)

## 在线地址

站点地址：

| 页面 | 地址 | 说明 |
|---|---|---|
| 完整版 | <https://wuchang.me/> | Live2D 形象 + 语音对话 + 文字输入 + MCP 调试 |
| 单文件版 | <https://wuchang.me/standalone/> | 一个自包含 HTML，内置 Opus |
| 部署自检 | <https://wuchang.me/diagnostics.html> | 检查资源、OTA、WebSocket |

自定义域名 `wuchang.me` 已指向本项目（`CNAME` 文件）。
项目站点默认地址 `https://changwu.github.io/wuchang-online/` 也能访问，
但自定义域名后 GitHub 会把前者重定向到后者。

## 功能

- **语音对话**：浏览器麦克风 → 后端 ASR → LLM → TTS → 播放
- **文字输入**：不想说话时直接打字
- **Live2D 形象**：hiyori / natori 两套模型，口型与表情联动
- **MCP 工具调试**：调用设备侧工具（音量、屏幕主题、灯等）
- **纯静态**：不需要 Node、不需要构建、不需要服务端

## 它怎么连后端

页面不写死 WebSocket 地址，而是**先请求 OTA 接口拿地址**，
所以和真设备走完全同一条链路：

```
浏览器 ──POST /xiaozhi/ota/──► 后端
       ◄── {"websocket":{"url":"wss://.../xiaozhi/v1/"}}
       ──WS  wss://.../xiaozhi/v1/──► 后端（Opus 16k 上行，Opus 下行）
```

这意味着：**只要后端能服务真设备，本页面就能用**，无需改后端。

> ⚠️ 打开页面后请把「OTA 服务器地址」改成**你自己的**后端。
> 默认值是 `http://localhost:8002/xiaozhi/ota/` —— xiaozhi-server 的默认
> 本地端口，只在你本机跑着后端时有效。本站不提供公共后端。

## 部署到 GitHub Pages

这个仓库的所有内容都是静态文件，直接发布即可。

### 方式一：网页操作

1. 仓库 **Settings → Pages**
2. **Source** 选 `Deploy from a branch`
3. **Branch** 选 `main`，目录选 `/ (root)`
4. 保存，等约 1 分钟后访问

自定义域名由仓库根目录的 `CNAME` 文件决定（当前为 `wuchang.me`）。
换域名时改这个文件即可，DNS 需要对应配置：

- 裸域名 `wuchang.me` → 4 条 A 记录指向 `185.199.108.153`、
  `185.199.109.153`、`185.199.110.153`、`185.199.111.153`
- `www.wuchang.me` → CNAME 指向 `changwu.github.io`

配置好域名后 GitHub 会自动签发 HTTPS 证书，通常几分钟内完成。

### 方式二：命令行

```bash
gh api -X POST repos/<用户名>/wuchang-online/pages \
  -f 'source[branch]=main' -f 'source[path]=/'
```

### 仓库里为什么有 `.nojekyll`

GitHub Pages 默认用 Jekyll 处理站点，会忽略以 `_` 或 `.` 开头的文件/目录。
加一个空的 `.nojekyll` 关掉 Jekyll，避免静态资源被跳过，也省掉一次构建。

## 本地预览

因为麦克风需要安全上下文，**必须用 HTTP 或 HTTPS 打开，不能双击 `file://`**。

```bash
# 任选一种
python3 -m http.server 8080
npx serve .
```

然后访问 `http://localhost:8080/`。`localhost` 算安全上下文，麦克风可用。

## 两个版本

| | 完整版（仓库根目录） | 单文件版（`standalone/`） |
|---|---|---|
| 文件 | 71 个 / 16.6 MB | **1 个 .html / 840 KB** |
| Live2D 形象 | 有 | 无 |
| 文字输入 | 有 | 无 |
| MCP 工具面板 | 有 | 无 |
| 适合 | 长期使用、完整体验 | 单文件分发、快速验证 |

单文件版可以用浏览器打开 [`standalone/build.html`](standalone/build.html)
重新生成：它会读取同源的 `libopus.js` 和 `app.js`，拼装后供下载。
这样构建步骤也在浏览器里完成，不需要 Python/Node —— 保持在纯静态约束内。

## 关于"能不能不要 Opus"

**不能。** 这是协议层的硬约束，不是实现选择。

xiaozhi 服务端上行是无条件按 Opus 解码的（`core/connection.py`）：

```python
elif isinstance(message, bytes):
    pcm_frame = self._decode_opus_packet(message)   # 无条件
    if pcm_frame:
        self.asr_audio_queue.put(pcm_frame)
```

发裸 PCM 会被当 Opus 解码失败，帧被**静默丢弃**。在 hello 里声明
`format:"pcm"` 也改变不了这条路径。

下行 TTS 同样硬编码 `is_opus=True`（`core/providers/tts/base.py`），
不看客户端声明的格式。

所以浏览器端必须有 Opus 编解码器。仓库里那 825KB 的 `libopus.js` 就是它，
而且是 **asm.js 纯 JavaScript**（不是 `.wasm`），所以能被内联进单个 HTML 文件。

也试过 WebCodecs，实测（headless Chrome 157）它的 Opus 编码器输出**固定
20ms 帧**、不可配置，而服务端按 60ms 解，所以不采用。详见
[standalone/README.md](standalone/README.md)。

## 配置 OTA 地址

页面打开后直接在「OTA 服务器地址」框里改，会记在 localStorage。

要改**默认值**（比如分发给别人），改 `index.html` 里这一行的 `value`：

```html
<input type="text" id="otaUrl" value="http://localhost:8002/xiaozhi/ota/">
```

单文件版则在 `standalone/build.html` 里填好再生成。

## 使用步骤

1. 打开页面（HTTPS 或 localhost）
2. 「OTA 服务器地址」填你的后端
3. 点「连接」→ 允许麦克风权限
4. 点「按住说话」或按住空格键

「设备MAC」留空即可，会自动生成随机 MAC 并存 localStorage，
不会和你的真实设备撞 ID。

## 出问题先看部署自检

打开 [`diagnostics.html`](diagnostics.html) 点「运行全部检查」，它会：

1. 逐个请求页面声明的资源（含 Live2D 模型）
2. 检查单文件版是否真的自包含
3. 用真实设备头（`Device-Id` / `Client-Id`）请求 OTA 接口
4. **带 `Origin` 做 WebSocket 握手**

第 4 项最关键：浏览器握手必带 `Origin`，硬件设备不带。如果你的后端做了
Origin 校验，就会出现"设备正常、网页连不上"，这一步能立刻发现。

## 踩过的坑

**1. OTA 接口必须带 `Client-Id` 头**
缺了会返回 `{"success":false,"message":"request error."}`，而后端日志只说
「OTA请求ClientID为空」，从浏览器侧很难看出原因。真设备天然会带。

**2. 浏览器 WebSocket 带 `Origin`，真设备不带**
见上面自检第 4 项。

**3. 麦克风需要 HTTPS 或 localhost**
`http://192.168.x.x:8080` 这种地址浏览器会静默拒绝录音权限。

**4. Live2D 的 `.cmo3` / `.can3` 是编辑源文件，运行时不需要**
上游含这些约 46MB，删掉不影响功能。运行时真正用的是 `resources/*/runtime/`
下的 `.moc3`、贴图、`.motion3.json`。

**5. 本仓库曾是"只能静态"之前的样子**
早期版本包含 Dockerfile、Caddy 反代示例和 Python 工具脚本，用于自建服务器
部署。既然目标改成 GitHub Pages，这些已移除；构建与自检改为浏览器页面
（`standalone/build.html`、`diagnostics.html`）。如果需要在自有服务器上
反代，配置思路是：静态目录挂到子路径，`/xiaozhi/ota/*` 反代到后端 HTTP
端口（默认 8003，**不能**指向 WebSocket 端口 8000），`/xiaozhi/v1/*`
反代到 8000 并关闭响应缓冲。

## 项目结构

```
.
├── index.html              # 完整版入口（Live2D）
├── diagnostics.html        # 部署自检（纯前端）
├── 404.html                # 自定义 404
├── .nojekyll               # 关闭 Jekyll
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
│   └── utils/              # libopus.js 等
├── images/                 # 背景图
├── resources/              # Live2D 模型运行时文件
└── standalone/             # 单文件版
    ├── app.js              #   可读源码
    ├── build.html          #   浏览器内生成器
    ├── index.html          #   产物：自包含 HTML
    └── README.md
```

## 依赖的后端

需要一个兼容 xiaozhi 协议的后端（xiaozhi-server），提供：

- `POST /xiaozhi/ota/` —— 下发 WebSocket 地址
- `WS /xiaozhi/v1/` —— 语音对话（Opus 双向）

本项目**不含后端**，也不含任何密钥。

## 致谢

- [xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server) —— 本前端的来源
- [Live2D Cubism SDK](https://www.live2d.com/) —— 虚拟形象渲染
- [PixiJS](https://pixijs.com/) —— 2D 渲染引擎
- [libopus](https://opus-codec.org/) —— 音频编解码

## 许可证

[MIT](LICENSE)。上游版权归属 `Copyright (c) 2025 xinnan-tech`，
详见 [NOTICE.md](NOTICE.md)。
