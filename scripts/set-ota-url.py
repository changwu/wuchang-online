#!/usr/bin/env python3
"""改 index.html 里 OTA 服务器地址的默认值。

用法：
    python3 scripts/set-ota-url.py https://your-server.com/xiaozhi/ota/
    python3 scripts/set-ota-url.py                    # 只显示当前值

说明：
    页面不写死 WebSocket 地址，而是先 POST 这个 OTA 接口拿地址。
    改这里等于改"默认连哪个后端"，用户仍可在页面上手动覆盖
    （覆盖值存 localStorage）。
"""
import io
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"

PATTERN = re.compile(r'(id="otaUrl"\s+value=")([^"]*)(")')


def main() -> int:
    src = io.open(INDEX, encoding="utf-8").read()
    m = PATTERN.search(src)
    if not m:
        print("✗ 在 index.html 里找不到 id=\"otaUrl\" 的 value 属性", file=sys.stderr)
        for ln in src.split("\n"):
            if "otaUrl" in ln:
                print("  近似行: " + ln.strip(), file=sys.stderr)
        return 1

    current = m.group(2)

    if len(sys.argv) < 2:
        print("当前 OTA 地址: %s" % current)
        print()
        print("改法: python3 scripts/set-ota-url.py <新的 OTA 地址>")
        return 0

    new = sys.argv[1].strip()
    if not re.match(r"^https?://", new):
        print("✗ 地址必须以 http:// 或 https:// 开头", file=sys.stderr)
        return 2

    out = src[:m.start(2)] + new + src[m.end(2):]
    io.open(INDEX, "w", encoding="utf-8", newline="\n").write(out)

    # 复核
    check = PATTERN.search(io.open(INDEX, encoding="utf-8").read())
    if not check or check.group(2) != new:
        print("✗ 写入校验失败", file=sys.stderr)
        return 3

    print("OTA 地址已修改")
    print("  旧: %s" % current)
    print("  新: %s" % new)
    return 0


if __name__ == "__main__":
    sys.exit(main())
