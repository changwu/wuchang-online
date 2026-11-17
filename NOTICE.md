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

相对于上游，改动很小，列全如下：

1. **`index.html`**：OTA 服务器地址输入框的默认值
   - 上游：`http://127.0.0.1:8002/xiaozhi/ota/`
   - 本项目：`https://xiaozhi.xiada.cn/xiaozhi/ota/`
   - 可用 `scripts/set-ota-url.py` 改回或改成任意地址

2. **删除的文件**（上游有、本项目不含）
   - `wakeword_runtime/`、`start.py`：本地唤醒词运行时的 Python 服务。
     它依赖 sherpa-onnx / sounddevice / pypinyin，只服务"浏览器本地唤醒词"这个
     可选功能，与本 Web 客户端的语音对话无关。上游 `start.py` 自己也写明：
     唤醒词初始化失败时"测试页面仍可正常使用"。
   - `resources/*/*.cmo3`、`resources/*/*.can3`：Live2D 的**编辑源文件**，
     共约 46MB。JS 里没有任何引用，运行时用的是 `runtime/` 下的
     `.moc3` + 贴图 + `.motion3.json`。删除后 62.8MB → 16.6MB。

3. **新增的文件**
   - `README.md`、`LICENSE`、`NOTICE.md`、`.gitignore`
   - `deploy/`：部署配置（Caddy 路由片段、docker 启动脚本）
   - `scripts/set-ota-url.py`：改 OTA 地址的小工具
   - `scripts/check-assets.py`：部署后自检资源可达性

## 未改动的部分

`css/`、`js/`、`images/`、`resources/`（删除上述源文件后）与上游一致，
未做功能性修改。

## 上游依赖声明

本前端依赖一个兼容 xiaozhi 协议的后端服务（xiaozhi-server），通过
WebSocket 提供 ASR / LLM / TTS 能力。本项目**不包含**后端，也不包含任何
后端密钥。
