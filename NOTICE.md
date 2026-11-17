# Attribution / 来源说明

## 上游项目

本项目是 [xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server)
中 `main/digital-human/` 模块的 Web 前端部分，独立出来部署与维护。

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/xinnan-tech/xiaozhi-esp32-server |
| 上游路径 | `main/digital-human/` |
| 上游许可证 | MIT, Copyright (c) 2025 xinnan-tech |
| 取用方式 | `git sparse-checkout`，仅取 `main/digital-human` |

## 本项目所做的修改

改动尽量小，列全如下。

### 对上游文件的修改

1. **`index.html`**（两处）
   - 在 `</body>` 前加了一个固定的站点导航（指向单文件版与部署自检）。
     因为本项目部署在 GitHub Pages 上，需要让同仓库的其它页面可被发现。
   - OTA 服务器地址输入框的默认值：**保持上游等价的值**
     `http://localhost:8002/xiaozhi/ota/`（上游写的是
     `http://127.0.0.1:8002/xiaozhi/ota/`，指向同一地址）。

     中间过程说明：开发期间这里曾填作者自己搭的后端方便联调。站点改为
     公开部署后改回本地默认值，避免任何人打开页面就默认连到作者的服务器。
     本站**不提供**公共后端。

2. **删除的文件**（上游有、本项目不含）
   - `wakeword_runtime/`、`start.py`：本地唤醒词运行时的 Python 服务。
     依赖 sherpa-onnx / sounddevice / pypinyin，只服务"浏览器本地唤醒词"
     这个可选功能，与语音对话无关。上游 `start.py` 自己也写明：
     唤醒词初始化失败时"测试页面仍可正常使用"。
   - `resources/*/*.cmo3`、`resources/*/*.can3`：Live2D 的**编辑源文件**，
     共约 46MB。JS 里没有任何引用，运行时用的是 `runtime/` 下的
     `.moc3` + 贴图 + `.motion3.json`。删除后 62.8MB → 16.6MB。

### 新增的文件

| 文件 | 说明 |
|---|---|
| `README.md`、`LICENSE`、`NOTICE.md` | 项目文档与许可 |
| `.nojekyll` | 关闭 GitHub Pages 的 Jekyll 处理 |
| `404.html` | 自定义 404 |
| `diagnostics.html` | 部署自检：资源、OTA、WebSocket（纯前端实现） |
| `standalone/index.html` | 单文件版产物（内联 Opus） |
| `standalone/app.js` | 单文件版源码 |
| `standalone/build.html` | 浏览器内的单文件生成器 |
| `standalone/README.md` | 单文件版的协议依据与实测记录 |

### 关于"纯静态"

本项目的部署目标是 GitHub Pages，仓库内只有静态文件
（HTML / CSS / JS / 图片 / 字体等），没有需要构建或运行的脚本。

早期版本曾包含 `Dockerfile`、`deploy/`（Caddy 反代示例）和 `scripts/`
（Python 工具：改 OTA 地址、检查资源）。这些用于自建服务器部署，
在改造成 GitHub Pages 项目时已**全部移除**：

- 改 OTA 地址 → 页面上的输入框（存 localStorage），或改 `index.html` 的默认值
- 检查资源 → `diagnostics.html`（浏览器内执行）
- 生成单文件 → `standalone/build.html`（浏览器内执行，用 fetch + Blob）

这样整个工作流都不依赖本地运行时，符合"只能静态文件"的约束。

## 未改动的部分

`css/`、`js/`、`images/`、`resources/`（删除上述源文件后）与上游一致，
未做功能性修改。

## 上游依赖声明

本前端依赖一个兼容 xiaozhi 协议的后端服务（xiaozhi-server），通过
WebSocket 提供 ASR / LLM / TTS 能力。本项目**不包含**后端，也不包含任何
后端密钥。

## 协议说明

页面需要 Opus 编解码能力，这是协议要求而非实现选择：
上行帧由服务端无条件按 Opus 解码（`core/connection.py` 的
`_decode_opus_packet`），下行 TTS 硬编码 `is_opus=True`
（`core/providers/tts/base.py`）。因此 `js/utils/libopus.js`
（上游的 asm.js 版本，825KB）是必需依赖，不可移除。
