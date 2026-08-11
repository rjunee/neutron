"""The Neutron ⚛ atom mark, as one renderer.

THE MARK IS `landing/favicon.svg`: a solid core plus three electron-orbit
ellipses at 0°/60°/120°. Everything raster that claims to be the Neutron mark is
a downstream copy of those numbers.

It is the same FAMILY as `AtomMark()` in `landing/chat-react/ChatApp.tsx` (the
rail-header icon), not a copy of it — this docstring used to say "geometry lifted
from AtomMark()", which was never true of the numbers. Scaled into this viewBox
the rail draws rx 13.33 / ry 5.73 / stroke 2.13 / core 2.27; a tile needs a
smaller rx (it has margins to respect) and a heavier stroke (it has a 16px favicon
to survive, where the rail icon renders at 20px+ in a header). The 2026-08-10 pass
narrowed the gap on ry from 15% under the rail to 8% over; the stroke stays ~17%
heavier, and that is the tab-slot floor talking, not drift.

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

The SVG's docblock owns the RATIONALE for the proportions (why the nucleus has to
float clear of the orbits, and what it costs at 16px when it doesn't). Read it
before nudging any number here.
"""

from __future__ import annotations

from PIL import Image, ImageDraw

# --- geometry, in the SVG's 0 0 32 32 coordinate space -------------------
VIEWBOX = 32
BG = (0x0B, 0x0E, 0x14, 0xFF)  # #0b0e14 — the shell's theme-color
ACCENT = (0x4D, 0xA3, 0xFF, 0xFF)  # #4da3ff
WHITE = (0xFF, 0xFF, 0xFF, 0xFF)
CORNER_RADIUS = 7
CORE_RADIUS = 2.8
ORBIT_RX, ORBIT_RY = 11.5, 6.2
ORBIT_STROKE = 2.5
ORBIT_ROTATIONS = (0, 60, 120)

#: Floor on the orbit stroke, in viewBox units, set by the 16px browser tab slot:
#: `landing/__tests__/favicon-serving.test.ts` requires >= 1.2 DEVICE px there, and
#: 16/VIEWBOX = 0.5. The icon that shipped broken on 2026-07-18 drew 1.067 device px
#: on transparency and read as "no favicon", so this is below-the-known-failure
#: territory, not a safety cushion. It caps how light the orbits may go.
MIN_ORBIT_STROKE = 1.2 / (16 / VIEWBOX)

#: Background showing between the nucleus and the orbits' inner edge. This is the
#: proportion the mark lives or dies by: at 0.40 (the pre-2026-08-10 numbers) the
#: core and all three orbits fused into one blob and no nucleus was visible at any
#: size. Asserted by scripts/__tests__/atom-mark-geometry.test.ts so a future tweak
#: to any one of the three constants above cannot quietly close it again.
CORE_ORBIT_GAP = ORBIT_RY - ORBIT_STROKE / 2 - CORE_RADIUS

#: The mark's full painted extent, in viewBox units (widest orbit + its stroke).
#: NOTE Pillow strokes an ellipse INSIDE its bounding box, so the rasterised extent
#: is nearer `2 * ORBIT_RX`; this over-estimate is deliberate, because every consumer
#: uses it to shrink the mark to fit something and erring large errs safe.
MARK_EXTENT = 2 * (ORBIT_RX + ORBIT_STROKE / 2)

# The two invariants above are enforced HERE and not only in the test suite, so a
# generator run cannot produce an asset that violates them — the failure mode this
# guards is a well-meaning tweak to one constant that quietly ruins the mark, and the
# artefact is the thing that ships. Both were violated by real shipped icons.
assert ORBIT_STROKE >= MIN_ORBIT_STROKE, (
    f"orbit stroke {ORBIT_STROKE} resolves to {ORBIT_STROKE * 16 / VIEWBOX:.3f} device px "
    f"in a 16px tab slot; the floor is {MIN_ORBIT_STROKE} units (1.2 px)"
)
assert CORE_ORBIT_GAP >= 1.5, (
    f"only {CORE_ORBIT_GAP:.2f} viewBox units of background between the nucleus and the "
    "orbits — below ~1.5 they fuse and the mark reads as a blob with no nucleus"
)

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
