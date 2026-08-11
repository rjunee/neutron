#!/usr/bin/env python3
"""Generate landing's raster branding mirrors from the landing/favicon.svg geometry.

Outputs (the file is still named for the .ico because every reference to it is, but
it owns BOTH of landing's raster mirrors — see WHY APPLE-TOUCH-ICON IS HERE below):

    landing/favicon.ico          multi-size browser tab icon
    landing/apple-touch-icon.png 180px iOS home-screen icon for the web app

Why a committed generator instead of a hand-placed binary: both are RASTER MIRRORS
of landing/favicon.svg. If the SVG's geometry or accent changes and they don't, the
tab icon silently disagrees with itself across browsers. Run this whenever
landing/favicon.svg changes:

    python3 scripts/gen-favicon-ico.py

Requires Pillow (dev-only; not a runtime dependency of the server).

WHY APPLE-TOUCH-ICON IS HERE. Until 2026-08-11 it was the LAST hand-placed copy of
the mark, and it still held the drawing the owner rejected on 2026-07-30 — teal #6fe3d4
concentric rings with a satellite dot — while being served as the iOS home-screen
icon from landing/boot-impl.ts and declared in landing/site.webmanifest. The
2026-08-10 pass deleted that artwork from landing/logo.svg and added a guard, but the
guard read SVG TEXT only, so it passed green over a PNG carrying the very drawing it
existed to forbid. It is generated here because this script already owns landing/'s
raster outputs, and it is 180px because that is what iOS asks for. Like icon.png it
is FULL-BLEED and opaque with no baked corners: iOS applies its own mask, and a
transparent home-screen icon renders on black.

Geometry lives in scripts/lib/atom_mark.py (the ONE mirror of the SVG's
0 0 32 32 coordinates, shared with scripts/gen-app-icons.py). Here it is
supersampled 16x and downsampled with LANCZOS so the 16px entry keeps clean
antialiased edges.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from PIL import Image  # noqa: E402

from lib.atom_mark import (  # noqa: E402
    BG,
    CORNER_RADIUS,
    VIEWBOX,
    render_atom,
    render_master,
    verify_raster_invariants,
)

SS = 16  # supersample factor
SIZES = (16, 32, 48, 64, 128, 256)

OUT = ROOT / "landing" / "favicon.ico"
APPLE_TOUCH = ROOT / "landing" / "apple-touch-icon.png"
APPLE_TOUCH_PX = 180


def render():
    """The atom mark at VIEWBOX * SS px, RGBA — the shared renderer, so this
    file and the app icons can never disagree about the geometry."""
    return render_master(VIEWBOX * SS, background=BG, corner_radius=CORNER_RADIUS)


def main() -> None:
    # Measure a real render before writing anything: the constants being
    # self-consistent says nothing about where the rasteriser puts the stroke.
    verify_raster_invariants()

    master = render()
    frames = [master.resize((s, s), Image.LANCZOS) for s in SIZES]
    frames[-1].save(OUT, format="ICO", sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, sizes={list(SIZES)})")

    # Full-bleed and opaque, no baked corners — iOS masks it itself.
    apple = render_atom(APPLE_TOUCH_PX, background=BG).convert("RGB")
    apple.save(APPLE_TOUCH, format="PNG")
    print(f"wrote {APPLE_TOUCH} ({APPLE_TOUCH.stat().st_size} bytes, {APPLE_TOUCH_PX}px)")


if __name__ == "__main__":
    main()
