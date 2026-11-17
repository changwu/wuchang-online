# 阿昌 · 数字分身

阿昌的数字分身：**打开网页就能直接说话**。
麦克风 → 实时语音识别（ASR）→ 大模型（LLM）→ 克隆音色语音合成（TTS）→ 播放，
一圈下来就是你问我答，头像和波纹跟着声音动。

纯静态，托管在 GitHub Pages 上，没有构建步骤、没有服务端依赖。

- 在线地址：<https://wuchang.me/>
- 许可证：MIT（见 [LICENSE](LICENSE)），来源与改动见 [NOTICE.md](NOTICE.md)

## 在线地址

| 页面 | 地址 | 说明 |
|---|---|---|
| 数字分身主页 | <https://wuchang.me/> | 头像 + 波纹 + 语音对话（就是本仓库的主角） |
| 部署自检 | <https://wuchang.me/diagnostics.html> | 检查资源、OTA、WebSocket 握手 |
| 单文件版 | <https://wuchang.me/standalone/> | 一个自包含 HTML，内置 Opus，可离线分发 |

自定义域名 `wuchang.me` 已指向本项目（`CNAME` 文件）。
项目站点默认地址 `https://changwu.github.io/wuchang-online/` 也能访问，
但自定义域名后 GitHub 会把前者重定向到后者。

## 功能

- **打开就能说话**：页面加载时先把 OTA + WebSocket 建好，点一下按钮只是开麦
- **持续监听**：不用按着说话，也不用唤醒词。浏览器端自己判断"你开口了 / 你说完了"
- **头像 + 波纹**：说话时头像外圈呼吸发光，下方波形实时跟着音量跳
- **最近对话**：最近三轮的识别文字和回答，直接显示在卡片里
- **没有多余按钮**：没有设置面板、没有模型选择、没有摄像头（视频模型接上之前不启用）
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
默认连的是 `https://xiaozhi.xiada.cn/xiaozhi/ota/`。

## 改配置

只有一处配置，在 [`js/twin.js`](js/twin.js) 顶部的 `CONFIG`：

```js
var CONFIG = {
    ota: "https://xiaozhi.xiada.cn/xiaozhi/ota/",   // ← 换成你自己的后端
    appName: "xiaozhi-twin",
    appVersion: "2.0.0"
};
```

本地联调临时换后端不用改文件，加查询参数即可：

```
http://localhost:8080/?ota=http://127.0.0.1:8002/xiaozhi/ota/
```

其它可改的地方：

| 想改什么 | 改哪里 |
|---|---|
| 头像 | 替换 `assets/avatar.png` 和 `assets/avatar@512.png`（正面正方形最好） |
| 名字 / 副标题 | [`index.html`](index.html) 里的 `<h1>` 和「阿昌的数字分身」 |
| 页面标题、分享卡片 | [`index.html`](index.html) 里的 `<title>` / `og:*` |
| 主题色、卡片、动画 | [`css/twin.src.css`](css/twin.src.css)，改完要重新编译（见下） |
| 断句灵敏度 | `js/twin.js` 里的 `vad`（默认按环境噪声自适应，一般不用动） |

## 样式：Tailwind CSS

页面用 Tailwind 写，但**不用 CDN**（国内访问 `cdn.tailwindcss.com` 不稳定，
而且会闪一下无样式）。仓库里提交的是编译产物 `css/twin.css`（约 14KB），
`index.html` 直接引用它，所以线上没有任何外部依赖。

改了 `index.html` 的 class 或 `css/twin.src.css` 之后需要重新编译：

```powershell
# 首次：装依赖（只装一次，node_modules 在 .build/ 下，不入库）
cd .build/tw
npm init -y
npm install tailwindcss@3.4.17

# 之后每次改完样式
cd ../..
pwsh -File tools/build-css.ps1
```

> Windows PowerShell 5.1 直接跑 `& .\tools\build-css.ps1` 也行；
> `pwsh` 是 PowerShell 7 的命令，没装就用 `powershell -File`。

## 本地预览

因为麦克风需要安全上下文，**必须用 HTTP 或 HTTPS 打开，不能双击 `file://`**。

```bash
python3 -m http.server 8080
```

然后访问 <http://localhost:8080/>。`localhost` 算安全上下文，麦克风可用。
（端口被占用或系统保留就换一个，比如 8765。）

## 部署到 GitHub Pages

所有内容都是静态文件，直接发布即可。

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

## 目录里为什么还有 Live2D 那套东西

`/` 现在是数字分身页，**不再用 Live2D**。仓库里仍保留上游 `digital-human`
前端的完整代码和模型（`js/app.js`、`js/live2d/`、`js/core/`、`css/index.css`、
`resources/`），原因有两个：

1. 单文件版 `standalone/` 和「部署自检」页还依赖同源的 `libopus.js`；
2. 想再启用 Live2D 时不用重新找一套模型和渲染代码。

它们不会被首页加载，不影响打开速度。真想瘦身，删掉这些目录也不影响 `/`。

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

## 语音链路里两个关键设计

**1. 用 `mode:"manual"` 让浏览器决定断句**

服务端 ASR 在 `manual` 模式下不跑自己的 VAD，而是缓存客户端推上来的全部
音频、等 `listen stop` 才一次性识别。这样断句权完全在浏览器，不会出现
前后端各判一次、互相打架。

流程：浏览器 VAD 检测到开口 → `listen start(mode:manual)`，开始按 60ms 一帧
推 Opus → VAD 判断说完了 → `listen stop` → 服务端识别 + LLM + TTS → 播完
继续监听。

**2. 播放期间必须停止拾音，否则会自问自答**

TTS 从扬声器放出来的声音会被同一个麦克风收回去；如果继续上传，服务端会把
AI 自己的话当成用户输入，形成死循环。所以从发出 `listen stop` 到本地播放
缓冲排空为止的整段时间都算"忙"：既不上传、也不跑 VAD，并重置 VAD 状态。
忙期间每收到一包下行音频就续一次看门狗，所以后端慢一点也不会中途解锁。

## 出问题先看部署自检

打开 [`diagnostics.html`](diagnostics.html) 点「运行全部检查」，它会：

1. 逐个请求 `index.html` 声明的资源（`css/twin.css`、`js/twin.js`、`libopus.js`、头像…）
2. 检查单文件版是否真的自包含
3. 用真实设备头（`Device-Id` / `Client-Id`）请求 OTA 接口
4. **带 `Origin` 做 WebSocket 握手**

第 4 项最关键：浏览器握手必带 `Origin`，硬件设备不带。如果你的后端做了
Origin 校验，就会出现"设备正常、网页连不上"，这一步能立刻发现。

页面本身也支持调试：加 `?debug=1` 会打开左下角日志面板，并显示「部署自检 / 单文件版」入口。

## 踩过的坑

**1. OTA 接口必须带 `Client-Id` 头**
缺了会返回 `{"success":false,"message":"request error."}`，而后端日志只说
「OTA请求ClientID为空」，从浏览器侧很难看出原因。真设备天然会带。

**2. 浏览器 WebSocket 带 `Origin`，真设备不带**
见上面自检第 4 项。

**3. 麦克风需要 HTTPS 或 localhost**
`http://192.168.x.x:8080` 这种地址浏览器会静默拒绝录音权限。

**4. 上行音频必须实时按节奏发，不能一次性倾倒**
服务端的二进制帧是进队列异步处理的，`listen stop` 却是同步处理的 —— 一次性
把整段音频塞进去，stop 可能"超车"跑到音频前面，ASR 只收到一小段，识别结果
会退化成"嗯"。按 60ms/帧实时发送就没这个问题。

**5. WebCodecs 的 Opus 编码器不能用**
输出固定 20ms 帧，服务端按 60ms 解，帧长不匹配；且输入采样率和配置不一致时
直接报 `Input audio buffer is incompatible with codec parameters`。

**6. Live2D 的 `.cmo3` / `.can3` 是编辑源文件，运行时不需要**
上游含这些约 46MB，删掉不影响功能。运行时真正用的是 `resources/*/runtime/`
下的 `.moc3`、贴图、`.motion3.json`。（首页现在已不用 Live2D。）

**7. 本仓库曾是"只能静态"之前的样子**
早期版本包含 Dockerfile、Caddy 反代示例和 Python 工具脚本，用于自建服务器
部署。既然目标改成 GitHub Pages，这些已移除；构建与自检改为浏览器页面
（`standalone/build.html`、`diagnostics.html`）。如果需要在自有服务器上
反代，配置思路是：静态目录挂到子路径，`/xiaozhi/ota/*` 反代到后端 HTTP
端口（默认 8003，**不能**指向 WebSocket 端口 8000），`/xiaozhi/v1/*`
反代到 8000 并关闭响应缓冲。

## 项目结构

```
.
├── index.html              # 数字分身主页（头像 + 波纹 + 语音对话）
├── diagnostics.html        # 部署自检（纯前端）
├── 404.html                # 自定义 404
├── tailwind.config.js      # Tailwind 配置（只扫 index.html 与 js/twin.js）
├── tools/
│   ├── build-css.ps1       # 编译 css/twin.src.css → css/twin.css
│   └── make-avatar.py      # 从原图生成 assets/avatar*.png
├── css/
│   ├── twin.src.css        # 样式源文件（Tailwind @apply + 自定义动画）
│   ├── twin.css            # 编译产物，线上引用（入库）
│   └── index.css           # 旧 Live2D 版样式（首页已不用）
├── js/
│   ├── twin.js             # 首页全部逻辑：OTA/WS/Opus/VAD/播放/视觉
│   ├── app.js              # 旧 Live2D 版入口（首页已不用）
│   ├── core/ live2d/ ui/ config/   # 旧 Live2D 版模块（首页已不用）
│   └── utils/libopus.js    # Opus 编解码（首页和单文件版都依赖）
├── assets/
│   ├── avatar.png          # 头像 256×256
│   └── avatar@512.png      # 头像 512×512（高分屏）
├── images/                 # 旧版背景图
├── resources/              # Live2D 模型运行时文件（首页已不用）
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

另外 OTA 接口需要允许跨域（本项目实测后端返回
`Access-Control-Allow-Origin: *`，否则浏览器里请求会被拦）。

本项目**不含后端**，也不含任何密钥。

## 致谢

- [xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server) —— 协议与前端来源
- [libopus](https://opus-codec.org/) —— 音频编解码
- [Tailwind CSS](https://tailwindcss.com/) —— 样式
- [Live2D Cubism SDK](https://www.live2d.com/) / [PixiJS](https://pixijs.com/) —— 旧版形象渲染（仍保留在仓库）

## 许可证

[MIT](LICENSE)。上游版权归属 `Copyright (c) 2025 xinnan-tech`，
详见 [NOTICE.md](NOTICE.md)。
