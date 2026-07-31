"""The Neutron ⚛ atom mark, as one renderer.

THE MARK IS `landing/favicon.svg`: a solid core plus three electron-orbit
ellipses at 0°/60°/120°, geometry lifted from `AtomMark()` in
`landing/chat-react/ChatApp.tsx` (the rail-header icon). Everything raster that
claims to be the Neutron mark is a downstream copy of those numbers.

WHY THIS MODULE EXISTS. It did not, and the copies drifted. `landing/favicon.ico`
had a committed generator pinned to the SVG's coordinates, while the MOBILE app
icon was a completely unrelated drawing — teal concentric rings with a satellite
dot — that no source in this repo produces. Ryan, installing the APK
(2026-07-30): "make the app icon the same as our favicon. What is this weird icon
you made". A mark that exists as N hand-placed binaries is a mark that is N
different marks. So the geometry lives here once, and every generator renders
from it.

Requires Pillow (dev-only; not a runtime dependency of the server).

Geometry is kept in lockstep with `landing/favicon.svg` BY HAND — the constants
below are that file's `0 0 32 32` coordinates verbatim. If you change the SVG,
change them here and re-run every generator that imports this module:

    python3 scripts/gen-favicon-ico.py
    python3 scripts/gen-app-icons.py
"""

from __future__ import annotations

from PIL import Image, ImageDraw

# --- geometry, in the SVG's 0 0 32 32 coordinate space -------------------
VIEWBOX = 32
BG = (0x0B, 0x0E, 0x14, 0xFF)  # #0b0e14 — the shell's theme-color
ACCENT = (0x4D, 0xA3, 0xFF, 0xFF)  # #4da3ff
WHITE = (0xFF, 0xFF, 0xFF, 0xFF)
CORNER_RADIUS = 7
CORE_RADIUS = 3.2
ORBIT_RX, ORBIT_RY = 11.5, 4.9
ORBIT_STROKE = 2.6
ORBIT_ROTATIONS = (0, 60, 120)

#: The mark's full painted extent, in viewBox units (widest orbit + its stroke).
MARK_EXTENT = 2 * (ORBIT_RX + ORBIT_STROKE / 2)

#: Android adaptive-icon safe zone: the 108dp layer is masked to 72dp, and only
#: the central 66dp circle is guaranteed visible under EVERY OEM mask shape.
ANDROID_SAFE_FRACTION = 66 / 108


def render_master(
    n: int,
    *,
    accent=ACCENT,
    background=None,
    corner_radius: float | None = None,
    mark_scale: float = 1.0,
) -> Image.Image:
    """Draw the mark at `n` px square, with no downsampling.

    `mark_scale` multiplies the natural geometry, whose painted extent is
    `MARK_EXTENT / VIEWBOX` (= 0.8) of the canvas — so `1.0` reproduces the SVG's
    own proportions and anything smaller insets the mark (see
    `ANDROID_SAFE_FRACTION`).

    `background` fills the tile (`None` = transparent, which is what an Android
    adaptive FOREGROUND layer and a splash asset both need — the background is
    someone else's job there). `corner_radius` is in viewBox units and also clips
    the result; pass `None` for a full-bleed square, which is what iOS wants
    (the OS applies its own mask, and baking corners in double-rounds it).
    """
    unit = (n / VIEWBOX) * mark_scale
    canvas = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    if background is not None:
        if corner_radius is None:
            draw.rectangle([0, 0, n - 1, n - 1], fill=background)
        else:
            draw.rounded_rectangle(
                [0, 0, n - 1, n - 1], radius=corner_radius * (n / VIEWBOX), fill=background
            )

    cx = cy = n / 2
    for angle in ORBIT_ROTATIONS:
        # Each orbit goes on its own transparent layer, rotated about the centre
        # and composited — PIL's ellipse() takes no transform.
        layer = Image.new("RGBA", (n, n), (0, 0, 0, 0))
        ImageDraw.Draw(layer).ellipse(
            [cx - ORBIT_RX * unit, cy - ORBIT_RY * unit, cx + ORBIT_RX * unit, cy + ORBIT_RY * unit],
            outline=accent,
            width=max(1, round(ORBIT_STROKE * unit)),
        )
        if angle:
            layer = layer.rotate(-angle, resample=Image.BICUBIC, center=(cx, cy))
        canvas.alpha_composite(layer)

    # Solid core last so it sits above the orbits, as in the SVG's paint order.
    draw.ellipse(
        [cx - CORE_RADIUS * unit, cy - CORE_RADIUS * unit, cx + CORE_RADIUS * unit, cy + CORE_RADIUS * unit],
        fill=accent,
    )

    if corner_radius is not None:
        # Clip back to the rounded tile so rotated orbits can't bleed past the corners.
        mask = Image.new("L", (n, n), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            [0, 0, n - 1, n - 1], radius=corner_radius * (n / VIEWBOX), fill=255
        )
        canvas.putalpha(mask)

    return canvas


def render_atom(size: int, *, supersample: int = 8, **kwargs) -> Image.Image:
    """`render_master` at `size * supersample`, LANCZOS-downsampled to `size`.

    The supersample is what keeps the rotated orbits' edges clean; drawing them
    at final size produces visible staircasing on the diagonals.
    """
    return render_master(size * supersample, **kwargs).resize((size, size), Image.LANCZOS)
