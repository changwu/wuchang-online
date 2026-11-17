# standalone —— 真正的单文件版本

`index.html` 是**一个可以独立分发的 .html 文件（约 840KB）**，把 Opus 编解码器
和应用逻辑全部内联，不加载任何外部资源。

## 为什么不能去掉 Opus

我一开始想：能不能让客户端用裸 PCM，省掉 800 多 KB 的编解码器？
读源码后否掉了，这是协议层硬的约束：

**上行必须 Opus** —— `core/connection.py`：

```python
elif isinstance(message, bytes):
    # 入口处直接解码PCM，避免VAD和ASR重复解码
    pcm_frame = self._decode_opus_packet(message)   # 无条件按 Opus 解码
    if pcm_frame:
        self.asr_audio_queue.put(pcm_frame)
```

发给它的裸 PCM 会被当 Opus 解码失败，`_decode_opus_packet` 返回 None，
帧被静默丢弃。客户端在 hello 里声明 `format: "pcm"` 也不会改变这里的行为。

**下行也是 Opus** —— `core/providers/tts/base.py`：

```python
audio_bytes_to_data_stream(
    audio_bytes, file_type=self.audio_file_type,
    is_opus=True,                      # 硬编码，不看 conn.audio_format
    callback=opus_handler, ...)
```

`helloHandle.py` 确实会把客户端声明的 format 存进 `conn.audio_format`，
但只有 `_process_audio_file_stream`（文件播放分支）会检查它，
TTS 主播放路径不看。

所以浏览器端必须有 Opus 编解码器 —— 这是唯一"不纯 HTML"的地方，
除非改服务端代码。

## 为什么可以内联成一个文件

上游的 `js/utils/libopus.js` 是 **asm.js**（825KB 纯 JavaScript），
不是 `.wasm` 文件，也不需要 `fetch` 加载二进制。所以它能直接塞进
`<script>` 标签里，拼完就是一个自包含的 HTML。

## 为什么不用 WebCodecs

我试过，也实测了（headless Chrome 157）：

```
isConfigSupported(opus/16k/1ch): true     ← 可用
chunks: 51, durations: 20000 us 每帧      ← 输出固定 20ms 帧
xiaozhi 需要 60ms -> MISMATCH
```

- WebCodecs 的 Opus 编码器**输出固定 20ms 帧**，不提供帧长配置
- 服务端按 60ms 解（`pcm_to_data_stream` 里 `frame_duration = 60`）
- 而且 Safari / Firefox 对 WebCodecs 的 Opus 支持不完整

asm.js 版本能精确控制成 60ms/960 样本，和官方设备完全一致，所以选它。

## 生成

```bash
python3 standalone/build.py
# 或指定默认后端地址
DEFAULT_OTA_URL=http://localhost:8002/xiaozhi/ota/ python3 standalone/build.py
```

`app.js` 是可读的应用逻辑，`build.py` 把它和 `libopus.js` 拼成 `index.html`。
改逻辑改 `app.js` 再重新生成，不要直接改 `index.html`。

## 怎么用

**必须通过 HTTP(S) 打开，不能双击 file://**

浏览器只在安全上下文里给麦克风权限，`file://` 不算。所以至少要起一个
本地静态服务：

```bash
cd standalone
python3 -m http.server 8080
# 打开 http://localhost:8080/
```

`localhost` 是安全上下文，麦克风可用。部署到线上用 HTTPS 同理。

然后：
1. OTA 地址填你的后端（默认已填作者的）
2. 点「连接」
3. 允许麦克风权限
4. 点「按住说话」或按住空格键

## 验证过的点

用 headless Chrome 157 实测内联的 asm.js 编解码：

| 检查 | 结果 |
|---|---|
| `Module.instance` 可用 | true |
| `_opus_encoder_get_size(1)` | 47816 |
| `_opus_decoder_get_size(1)` | 18156 |
| `_opus_encoder_init(16000, VOIP)` | 0（成功） |
| `_opus_decoder_init(24000)` | 0（成功） |
| `_opus_encode` 960 样本 | 2087 字节 |
| 24k 解码器解出 | **1440 样本 = 60ms@24k**（与服务端下行一致） |
| 16k 解码器解出 | **960 样本 = 60ms@16k**（与服务端上行一致） |
| 波形吻合率 | 661/760（有损编码的正常水平） |

## 和完整版（仓库根目录）的区别

| | standalone/index.html | 根目录完整版 |
|---|---|---|
| 文件数 | **1 个 .html** | 71 个文件 / 16.6MB |
| 依赖 | 无 | 无（但需整目录部署） |
| Live2D 形象 | 无 | 有（hiyori / natori） |
| 文字输入 | 无 | 有 |
| MCP 工具面板 | 无 | 有 |
| 适合 | 快速试用、单文件分发 | 长期使用 |

单文件版足够验证"能不能用"；想要虚拟形象和完整界面用根目录的版本。
