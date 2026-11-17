"""把用户头像处理成站点资源：assets/avatar.png (256) / avatar@512.png

原始附件是一张 256x256 的卡通自画像（浅蓝背景 + 自由女神）。
页面里按圆形裁切展示，所以只做无损/近无损压缩，不做额外裁切。
"""
import os
from PIL import Image

SRC = r"C:\Users\user\.dsh\attachments\v1\objects\a0\a001dc2f239f95a2aa2b143c148673fbaaa7b82a327033b40975548748992cf9"
ROOT = r"C:\Users\user\Documents\wuchang-online"
OUT_DIR = os.path.join(ROOT, "assets")
os.makedirs(OUT_DIR, exist_ok=True)

im = Image.open(SRC)
print("src:", im.size, im.mode)
im = im.convert("RGB")

# 1x：256x256 调色板量化，体积小很多，卡通图几乎看不出差别
p1 = os.path.join(OUT_DIR, "avatar.png")
im.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG).save(p1, optimize=True)

# 2x：Lanczos 放大到 512，供高分屏 / 大屏使用
p2 = os.path.join(OUT_DIR, "avatar@512.png")
im.resize((512, 512), Image.LANCZOS).save(p2, optimize=True)

for p in (p1, p2):
    print(p, os.path.getsize(p))
