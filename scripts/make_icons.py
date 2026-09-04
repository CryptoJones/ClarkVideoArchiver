#!/usr/bin/env python3
"""Generate the extension's PNG icons.

Chrome will not accept SVG icons, so the toolbar art is rasterised here rather
than shipped as vector. Rendered at 8x and downsampled for clean edges.
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZES = (16, 32, 48, 128)
SS = 8  # supersample factor
BG = (179, 38, 30, 255)      # deep red, matches the popup accent
FG = (255, 255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "icons"


def render(size: int) -> Image.Image:
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded-square field.
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.22), fill=BG)

    # One downward triangle carries both meanings: it is a play button rotated
    # a quarter turn, and the head of a download arrow. Stacking a separate
    # play glyph above it just smears into a blob at 16px.
    cx = n * 0.5
    shaft_w = n * 0.13
    d.rounded_rectangle(
        [cx - shaft_w / 2, n * 0.17, cx + shaft_w / 2, n * 0.46],
        radius=shaft_w / 2,
        fill=FG,
    )
    d.polygon(
        [(cx - n * 0.24, n * 0.40), (cx + n * 0.24, n * 0.40), (cx, n * 0.75)],
        fill=FG,
    )
    bar_y, bar_h = n * 0.83, n * 0.085
    d.rounded_rectangle(
        [n * 0.24, bar_y, n * 0.76, bar_y + bar_h],
        radius=bar_h / 2,
        fill=FG,
    )

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon-{size}.png"
        render(size).save(path, "PNG", optimize=True)
        print(f"wrote {path.relative_to(OUT.parent)}")


if __name__ == "__main__":
    main()
