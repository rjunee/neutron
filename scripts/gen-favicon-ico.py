#!/usr/bin/env python3
"""Generate landing/favicon.ico from the landing/favicon.svg atom geometry.

Why a committed generator instead of a hand-placed binary: the .ico is a RASTER
MIRROR of landing/favicon.svg. If the SVG's geometry or accent changes and the
.ico doesn't, the tab icon silently disagrees with itself across browsers. Run
this whenever landing/favicon.svg changes:

    python3 scripts/gen-favicon-ico.py

Requires Pillow (dev-only; not a runtime dependency of the server).

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
    render_master,
)

SS = 16  # supersample factor
SIZES = (16, 32, 48, 64, 128, 256)

OUT = ROOT / "landing" / "favicon.ico"


def render():
    """The atom mark at VIEWBOX * SS px, RGBA — the shared renderer, so this
    file and the app icons can never disagree about the geometry."""
    return render_master(VIEWBOX * SS, background=BG, corner_radius=CORNER_RADIUS)


def main() -> None:
    master = render()
    frames = [master.resize((s, s), Image.LANCZOS) for s in SIZES]
    frames[-1].save(OUT, format="ICO", sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, sizes={list(SIZES)})")


if __name__ == "__main__":
    main()
