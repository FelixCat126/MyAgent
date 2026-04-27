#!/usr/bin/env python3
"""无大模型依赖：用 Pillow 绘制的对话气泡风图标（历史样式）。\n品牌默认「原子核」主图标请用：npm run build:icon-default\n"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "resources" / "icon.png"
PUBLIC = ROOT / "public" / "icon.png"

W = H = 512


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def main() -> None:
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = img.load()
    # 对角渐变底色
    c0 = (13, 148, 136)  # teal-600
    c1 = (15, 118, 110)  # teal-800
    for y in range(H):
        for x in range(W):
            t = (x + y) / (W + H - 2)
            r = int(lerp(c0[0], c1[0], t))
            g = int(lerp(c0[1], c1[1], t))
            b = int(lerp(c0[2], c1[2], t))
            px[x, y] = (r, g, b, 255)

    d = ImageDraw.Draw(img)
    pad = 56
    radius = 108
    d.rounded_rectangle([pad, pad, W - pad, H - pad], radius=radius, outline=(255, 255, 255, 55), width=6)

    # 对话气泡（白色半透明叠层）
    bubble = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bubble)
    bx0, bx1 = 110, 402
    by0, by1 = 130, 290
    bd.rounded_rectangle([bx0, by0, bx1, by1], radius=42, fill=(255, 255, 255, 210))
    # 气泡尖角
    bd.polygon([(210, by1), (260, by1), (235, by1 + 46)], fill=(255, 255, 255, 210))
    img.alpha_composite(bubble)

    d = ImageDraw.Draw(img)
    # 抽象「节点」装饰
    nodes = [(340, 200), (380, 260), (320, 300)]
    for nx, ny in nodes:
        d.ellipse([nx - 10, ny - 10, nx + 10, ny + 10], fill=(45, 212, 191, 230))
        d.ellipse([nx - 18, ny - 18, nx + 18, ny + 18], outline=(204, 251, 241, 180), width=3)

    # 轻高光条
    d.arc([80, 80, 200, 200], start=200, end=320, fill=(255, 255, 255, 70), width=10)

    rgb = Image.new("RGB", img.size, (15, 118, 110))
    rgb.paste(img, mask=img.split()[3])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    PUBLIC.parent.mkdir(parents=True, exist_ok=True)
    rgb.save(str(OUT), format="PNG", optimize=True)
    rgb.save(str(PUBLIC), format="PNG", optimize=True)
    print(OUT)
    print(PUBLIC)


if __name__ == "__main__":
    main()
