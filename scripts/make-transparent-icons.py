#!/usr/bin/env python3
"""
make-transparent-icons.py
--------------------------------------------------------------------
把源 logo 的近白色背景抠成透明，并批量输出扩展 / 网站需要的所有尺寸。
重跑安全：每次都从 SOURCE 重新生成。

Why: ChatGPT 出图默认是不透明白底，sips 不会自动 chroma-key。
    用 Pillow 把 RGB 距离白色 < threshold 的像素 alpha 设 0 就行。
"""

from __future__ import annotations

from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src" / "icons" / "icon-source.png"

# 输出表：(目标路径, 边长 px)
TARGETS: list[tuple[Path, int]] = [
    # Chrome 扩展 4 个尺寸
    (ROOT / "src" / "icons" / "icon16.png", 16),
    (ROOT / "src" / "icons" / "icon32.png", 32),
    (ROOT / "src" / "icons" / "icon48.png", 48),
    (ROOT / "src" / "icons" / "icon128.png", 128),
    # 网站 favicon + apple-touch
    (ROOT / "site" / "assets" / "img" / "favicon-32.png", 32),
    (ROOT / "site" / "assets" / "img" / "favicon-192.png", 192),
    (ROOT / "site" / "assets" / "img" / "apple-touch-icon.png", 180),
]

# 距离白色 < THRESHOLD 的像素视为背景 → alpha=0
THRESHOLD = 18


def make_transparent(img: Image.Image, threshold: int = THRESHOLD) -> Image.Image:
    """近白像素抠成透明。距离 = max(255-R, 255-G, 255-B)，用 max 比 sum 更收敛边缘。"""
    img = img.convert("RGBA")
    pixels = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, _ = pixels[x, y]
            dist = max(255 - r, 255 - g, 255 - b)
            if dist < threshold:
                pixels[x, y] = (255, 255, 255, 0)
    return img


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit(f"未找到母版：{SOURCE}")

    print(f"读取 {SOURCE.relative_to(ROOT)}")
    base = Image.open(SOURCE)
    transparent = make_transparent(base)

    # 保留一份高分辨率透明母版方便以后修
    transparent_master = ROOT / "src" / "icons" / "icon-source-transparent.png"
    transparent.save(transparent_master, "PNG", optimize=True)
    print(f"  → 透明母版 {transparent_master.relative_to(ROOT)}  ({transparent.size[0]}x{transparent.size[1]})")

    # 把非正方形母版包成正方形画布（透明填充），保证缩放后比例不变形
    longest = max(transparent.size)
    canvas = Image.new("RGBA", (longest, longest), (255, 255, 255, 0))
    offset = ((longest - transparent.size[0]) // 2,
              (longest - transparent.size[1]) // 2)
    canvas.paste(transparent, offset, transparent)

    for path, size in TARGETS:
        path.parent.mkdir(parents=True, exist_ok=True)
        out = canvas.resize((size, size), Image.LANCZOS)
        out.save(path, "PNG", optimize=True)
        print(f"  → {path.relative_to(ROOT)}  ({size}x{size})")


if __name__ == "__main__":
    main()
