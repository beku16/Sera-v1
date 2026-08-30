#!/usr/bin/env python3
"""build/icon-builder.py — multi-resolution Windows .ico from icon-512.png.

Electron-builder needs build/icon.ico for the NSIS/portable exe icon and
Explorer metadata. Sizes chosen per Electron docs: 16→256 px.
"""
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "public" / "icons" / "icon-512.png"
OUT = ROOT / "build" / "icon.ico"

SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main() -> int:
    if not SRC.exists():
        print(f"icon-builder: source missing: {SRC}", file=sys.stderr)
        return 1
    src = Image.open(SRC).convert("RGBA")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    frames = [src.resize(size, Image.LANCZOS) for size in SIZES]
    frames[-1].save(OUT, format="ICO", sizes=[(f.width, f.height) for f in frames], append_images=frames[:-1])
    print(f"icon-builder: wrote {OUT} ({OUT.stat().st_size // 1024} KB, {len(SIZES)} sizes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
