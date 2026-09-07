#!/usr/bin/env python3
"""Generate PWA icons for POLIS dashboard."""
import os, sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("pip install pillow")

OUT = Path(__file__).parent.parent / "apps/dashboard/public"
OUT.mkdir(parents=True, exist_ok=True)

def make_icon(size: int) -> None:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded square background (indigo gradient sim)
    r = size // 6
    draw.rounded_rectangle([(0,0),(size-1,size-1)], radius=r,
                            fill=(99, 102, 241))   # #6366f1

    # Inner lighter gradient feel
    draw.rounded_rectangle([(size//8, size//8),
                             (size - size//8, size - size//8)],
                            radius=r//2, fill=(129, 140, 248, 60))

    # "P" letter centered
    font_size = int(size * 0.52)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
    except Exception:
        try:
            font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", font_size)
        except Exception:
            font = ImageFont.load_default()

    text = "P"
    bbox = draw.textbbox((0,0), text, font=font)
    tw, th = bbox[2]-bbox[0], bbox[3]-bbox[1]
    x = (size - tw) // 2 - bbox[0]
    y = (size - th) // 2 - bbox[1]
    draw.text((x, y), text, fill=(255, 255, 255), font=font)

    path = OUT / f"icon-{size}.png"
    img.save(path, "PNG")
    print(f"✅ {path}")

make_icon(192)
make_icon(512)
print("PWA icons created!")
