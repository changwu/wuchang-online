#!/usr/bin/env python3
"""部署后自检：检查页面声明的所有资源是否可达。

用法：
    python3 scripts/check-assets.py https://your-server.com/test/
    python3 scripts/check-assets.py http://localhost:8000/

检查内容：
    1. index.html 里的 <script src> / <link href>
    2. app.js 里的 ES module 静态 import（from './...'）
    3. Live2D 模型关键文件（.moc3 与贴图）

为什么需要它：
    页面资源全是相对路径，反代如果路径没 strip 对、或者漏了某个目录，
    表现是浏览器里白屏或没有形象，控制台才报 404。这个脚本能在浏览器之外
    提前发现。只用标准库，不装第三方依赖。
"""
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 20


def fetch(url, method="GET"):
    req = urllib.request.Request(url, method=method,
                                 headers={"User-Agent": "wuchang-online-check"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, r.read() if method == "GET" else b""
    except urllib.error.HTTPError as e:
        return e.code, b""
    except Exception as e:  # noqa: BLE001
        return None, str(e).encode()


def head_ok(url):
    code, _ = fetch(url, method="GET")
    return code


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: python3 scripts/check-assets.py <base-url>", file=sys.stderr)
        print("例如: python3 scripts/check-assets.py https://example.com/test/")
        return 2

    base = sys.argv[1]
    if not base.endswith("/"):
        base += "/"

    print("=" * 68)
    print("检查 %s" % base)
    print("=" * 68)

    # ---- 1. index.html ----
    code, body = fetch(base + "index.html")
    if code != 200:
        print("\n✗ index.html 取不到 (code=%s)" % code)
        if body and isinstance(body, bytes) and len(body) < 300:
            print("  " + body.decode("utf-8", "replace"))
        return 1
    html = body.decode("utf-8", "replace")
    print("\n✓ index.html (%d bytes)" % len(body))

    # 顺带报告页面里的 OTA 地址，确认打包的是期望的默认值
    m = re.search(r'id="otaUrl"\s+value="([^"]*)"', html)
    if m:
        print("  OTA 默认地址: %s" % m.group(1))

    failures = 0

    def check(label, rel, base_url=None):
        nonlocal failures
        url = (base_url or base) + rel
        # 去掉 cache-busting 查询串再请求（服务端一般忽略，但保持真实）
        c = head_ok(url)
        if c == 200:
            print("  ✓ %-52s 200" % label)
        else:
            print("  ✗ %-52s %s" % (label, c))
            failures += 1

    # ---- 2. 静态资源 ----
    print("\n--- index.html 声明的资源 ---")
    assets = re.findall(r'(?:src|href)="([^"]+)"', html)
    assets = [a.split("?")[0] for a in assets]
    assets = [a for a in assets
              if not a.startswith(("http://", "https://", "#", "data:", "mailto:"))]
    assets = sorted(set(assets))
    if not assets:
        print("  (未发现相对资源引用)")
    for a in assets:
        check(a, a.lstrip("/"))

    # ---- 3. app.js 的 ES module import ----
    print("\n--- app.js 的动态 import ---")
    code, body = fetch(base + "js/app.js")
    if code == 200:
        js = body.decode("utf-8", "replace")
        imps = re.findall(r'from\s+[\'"](\.[^\'"]+)[\'"]', js)
        imps = sorted(set(i.lstrip("./") for i in imps))
        if not imps:
            print("  (未发现相对 import)")
        for i in imps:
            check("js/" + i, "js/" + i)
    else:
        print("  ✗ js/app.js 取不到 (code=%s)" % code)
        failures += 1

    # ---- 4. Live2D 模型 ----
    print("\n--- Live2D 模型关键文件 ---")
    for rel in [
        "resources/hiyori_pro_zh/runtime/hiyori_pro_t11.moc3",
        "resources/hiyori_pro_zh/runtime/hiyori_pro_t11.2048/texture_00.png",
        "resources/natori_pro_zh/runtime/natori_pro_t06.moc3",
    ]:
        check(rel, rel)

    # ---- 汇总 ----
    print("\n" + "=" * 68)
    if failures == 0:
        print("结论: ✓ 全部资源可用，页面应能正常加载")
        print()
        print("浏览器打开: %s" % base)
        print("提示: 麦克风需要 HTTPS 或 localhost，否则浏览器会拒绝录音权限。")
        return 0
    print("结论: ✗ 有 %d 项失败" % failures)
    print()
    print("常见原因：")
    print("  - 反向代理没有 strip_prefix（资源路径多了/少了前缀）")
    print("  - 静态目录挂载不全（resources/ 或 js/ 没进去）")
    print("  - 子路径反代时 index.html 能取到但相对资源解析错位")
    return 1


if __name__ == "__main__":
    sys.exit(main())
