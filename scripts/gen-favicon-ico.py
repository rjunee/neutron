#!/usr/bin/env python3
"""Generate landing/favicon.ico from the landing/favicon.svg atom geometry.

Why a committed generator instead of a hand-placed binary: the .ico is a RASTER
MIRROR of landing/favicon.svg. If the SVG's geometry or accent changes and the
.ico doesn't, the tab icon silently disagrees with itself across browsers. Run
this whenever landing/favicon.svg changes:

    python3 scripts/gen-favicon-ico.py

Requires Pillow (dev-only; not a runtime dependency of the server).

Geometry is kept in lockstep with landing/favicon.svg by hand — the numbers
below are the same 0 0 32 32 coordinates, supersampled 16x and downsampled with
LANCZOS so the 16px entry keeps clean antialiased edges.
"""

from pathlib import Path

from PIL import Image, ImageDraw

# --- geometry, in the SVG's 0 0 32 32 coordinate space -------------------
VIEWBOX = 32
BG = (0x0B, 0x0E, 0x14, 0xFF)  # #0b0e14 — shell theme-color
ACCENT = (0x4D, 0xA3, 0xFF, 0xFF)  # #4da3ff
CORNER_RADIUS = 7
CORE_RADIUS = 3.2
ORBIT_RX, ORBIT_RY = 11.5, 4.9
ORBIT_STROKE = 2.6
ORBIT_ROTATIONS = (0, 60, 120)

SS = 16  # supersample factor
SIZES = (16, 32, 48, 64, 128, 256)

OUT = Path(__file__).resolve().parent.parent / "landing" / "favicon.ico"


def render() -> Image.Image:
    """Render the atom mark at VIEWBOX * SS px, RGBA."""
    n = VIEWBOX * SS
    canvas = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle([0, 0, n - 1, n - 1], radius=CORNER_RADIUS * SS, fill=BG)

    cx = cy = n / 2
    for angle in ORBIT_ROTATIONS:
        # Draw each orbit on its own transparent layer, rotate about the
        # centre, then composite — PIL's ellipse() has no transform argument.
        layer = Image.new("RGBA", (n, n), (0, 0, 0, 0))
        ImageDraw.Draw(layer).ellipse(
            [cx - ORBIT_RX * SS, cy - ORBIT_RY * SS, cx + ORBIT_RX * SS, cy + ORBIT_RY * SS],
            outline=ACCENT,
            width=max(1, round(ORBIT_STROKE * SS)),
        )
        if angle:
            layer = layer.rotate(-angle, resample=Image.BICUBIC, center=(cx, cy))
        canvas.alpha_composite(layer)

    # Solid core last so it sits above the orbits, as in the SVG's paint order.
    draw.ellipse(
        [cx - CORE_RADIUS * SS, cy - CORE_RADIUS * SS, cx + CORE_RADIUS * SS, cy + CORE_RADIUS * SS],
        fill=ACCENT,
    )

    # Clip back to the rounded tile so rotated orbits can't bleed past the corners.
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, n - 1, n - 1], radius=CORNER_RADIUS * SS, fill=255)
    canvas.putalpha(mask)
    return canvas


def main() -> None:
    master = render()
    frames = [master.resize((s, s), Image.LANCZOS) for s in SIZES]
    frames[-1].save(OUT, format="ICO", sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, sizes={list(SIZES)})")


if __name__ == "__main__":
    main()
