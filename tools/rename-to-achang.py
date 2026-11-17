"""把站点上的「小缺 / 吴昌」统一改成「阿昌」（避免真实姓名外泄）。

只做精确字符串替换，全部有断言，任何一处数量不符就报错退出。
用法：
  python tools/rename-to-achang.py
"""
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 文件 -> [(旧, 新, 期望出现次数), ...]
JOBS = {
    "index.html": [
        ("<title>小缺 · 吴昌的数字分身</title>", "<title>阿昌 · 数字分身</title>", 1),
        ("吴昌的数字分身小缺：打开网页就能直接说话", "阿昌的数字分身：打开网页就能直接说话", 1),
        ('<meta property="og:title" content="小缺 · 吴昌的数字分身">',
         '<meta property="og:title" content="阿昌 · 数字分身">', 1),
        ('alt="小缺的头像"', 'alt="阿昌的头像"', 1),
        ('text-slate-50">小缺</h1>', 'text-slate-50">阿昌</h1>', 1),
        ('text-slate-500">吴昌的数字分身</p>', 'text-slate-500">阿昌的数字分身</p>', 1),
    ],
    "js/twin.js": [
        (" * 小缺 · 数字分身 —— 页面逻辑", " * 阿昌 · 数字分身 —— 页面逻辑", 1),
        ('console.log("[小缺] " + msg)', 'console.log("[阿昌] " + msg)', 1),
        ('role === "ai" ? "小缺" : "我"', 'role === "ai" ? "阿昌" : "我"', 1),
    ],
    "css/twin.src.css": [
        (" * 小缺 · 数字分身 —— Tailwind 源样式", " * 阿昌 · 数字分身 —— Tailwind 源样式", 1),
    ],
    "tailwind.config.js": [
        ("/** Tailwind CSS 配置（小缺数字分身页）", "/** Tailwind CSS 配置（阿昌数字分身页）", 1),
    ],
    "README.md": [
        ("# 小缺 · 数字分身", "# 阿昌 · 数字分身", 1),
        ("[吴昌](https://wuchang.me/)的数字分身", "阿昌的数字分身", 1),
        ("「吴昌的数字分身」", "「阿昌的数字分身」", 1),
    ],
    "standalone/app.js": [
        ("/* 小缺 · 单文件语音客户端（应用逻辑）", "/* 阿昌 · 单文件语音客户端（应用逻辑）", 1),
    ],
    "standalone/build.html": [
        ("'<title>小缺 · 单文件语音对话</title>'", "'<title>阿昌 · 单文件语音对话</title>'", 1),
        ("'  <h1>小缺 · 单文件语音对话</h1>'", "'  <h1>阿昌 · 单文件语音对话</h1>'", 1),
    ],
    "standalone/index.html": [
        ("<title>小缺 · 单文件语音对话</title>", "<title>阿昌 · 单文件语音对话</title>", 1),
        ("<h1>小缺 · 单文件语音对话</h1>", "<h1>阿昌 · 单文件语音对话</h1>", 1),
        ("/* 小缺 · 单文件语音客户端（应用逻辑）", "/* 阿昌 · 单文件语音客户端（应用逻辑）", 1),
    ],
}


def main() -> int:
    problems = []
    for rel, edits in JOBS.items():
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            problems.append("%s 不存在" % rel)
            continue
        with io.open(path, encoding="utf-8") as f:
            text = f.read()
        original = text
        for old, new, want in edits:
            got = text.count(old)
            if got != want:
                problems.append("%s: %r 出现 %d 次，期望 %d" % (rel, old, got, want))
                continue
            text = text.replace(old, new)
        if text != original:
            with io.open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            print("改好 %-24s %d 处" % (rel, len(edits)))

    if problems:
        print("\n有 %d 个问题：" % len(problems))
        for p in problems:
            print("  - " + p)
        return 1

    # 收尾检查：站点文本里不该再出现真名
    leftovers = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in
                       {".git", ".build", "node_modules", "resources", "images"}]
        for name in filenames:
            if os.path.splitext(name)[1] not in {".html", ".js", ".css", ".md", ".json"}:
                continue
            p = os.path.join(dirpath, name)
            if os.path.basename(p) in {"libopus.js", "pixi.js", "cubism4.min.js",
                                       "live2dcubismcore.min.js", "rename-to-achang.py"}:
                continue
            with io.open(p, encoding="utf-8", errors="ignore") as f:
                body = f.read()
            for bad in ("小缺", "吴昌"):
                if bad in body:
                    leftovers.append("%s 里还有「%s」" % (os.path.relpath(p, ROOT), bad))
    for line in leftovers:
        print("!! " + line)
    print("ok" if not leftovers else "还有残留")
    return 0 if not leftovers else 1


sys.exit(main())
