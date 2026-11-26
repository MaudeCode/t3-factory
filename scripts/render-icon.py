#!/usr/bin/env python3
"""Render design/Factory.icon into design/icon.png and the web icons.

Needs Xcode (for Icon Composer's ictool) and Pillow. The site's mark
(web/mark.png) is the glyph without its tile: ictool always draws the tile,
so the glyph is rendered on black and on white and its alpha is taken from
the difference between the two.
"""
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "design/Factory.icon"
ICTOOL = "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool"
SIZES = {"favicon.png": 64, "apple-touch-icon.png": 180, "icon-192.png": 192, "icon.png": 512}
MARK_SIZE = 128  # the sign-in image is 40 px, so this covers 3x screens


def render(document: Path, out: Path) -> Image.Image:
    subprocess.run(
        [ICTOOL, str(document), "--export-image", "--output-file", str(out), "--platform", "iOS",
         "--rendition", "Default", "--width", "1024", "--height", "1024", "--scale", "1",
         "--design-generation", "26"],
        check=True, stdout=subprocess.DEVNULL,
    )
    return Image.open(out)


def on_solid(tmp: Path, value: int) -> Image.Image:
    document = tmp / f"on-{value}.icon"
    shutil.copytree(SOURCE, document)
    spec = json.loads((document / "icon.json").read_text())
    spec["fill"] = {"solid": f"extended-srgb:{value},{value},{value},1"}
    (document / "icon.json").write_text(json.dumps(spec))
    return render(document, tmp / f"on-{value}.png").convert("RGB")


def mark(tmp: Path) -> Image.Image:
    black, white = on_solid(tmp, 0), on_solid(tmp, 1)
    out = Image.new("RGBA", black.size)
    b, w, o = black.load(), white.load(), out.load()
    width, height = black.size
    margin = 120  # the tile's rim highlight is drawn on both renders; keep only the glyph inside it
    for y in range(margin, height - margin):
        for x in range(margin, width - margin):
            alpha = 255 - max(0, *(wc - bc for wc, bc in zip(w[x, y], b[x, y])))
            if alpha > 0:
                o[x, y] = (*(min(255, c * 255 // alpha) for c in b[x, y]), alpha)
    out = out.crop(out.getbbox())
    side = max(out.size)
    square = Image.new("RGBA", (side, side))
    square.paste(out, ((side - out.width) // 2, (side - out.height) // 2))
    return square.resize((MARK_SIZE, MARK_SIZE), Image.LANCZOS)


with tempfile.TemporaryDirectory() as tmp:
    tile = render(SOURCE, ROOT / "design/icon.png").convert("RGBA")
    for name, size in SIZES.items():
        tile.resize((size, size), Image.LANCZOS).save(ROOT / "web" / name)
    mark(Path(tmp)).save(ROOT / "web/mark.png")
