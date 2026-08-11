"""The Neutron ⚛ atom mark, as one renderer.

THE MARK IS `landing/favicon.svg`: a solid core plus three electron-orbit
ellipses at 0°/60°/120°. Everything raster that claims to be the Neutron mark is
a downstream copy of those numbers.

It is the same FAMILY as `AtomMark()` in `landing/chat-react/ChatApp.tsx` (the
rail-header icon), not a copy of it — this docstring used to say "geometry lifted
from AtomMark()", which was never true of the numbers. Scaled into this viewBox
the rail draws rx 13.33 / ry 5.73 / stroke 2.13 / core 2.27; a tile needs a
smaller rx (it has margins to respect) and a heavier stroke (it has a 16px favicon
to survive, where the rail icon renders at 20px+ in a header).

WHY THE RAIL ICON IS STILL A SECOND SET OF NUMBERS. It is not oversight and not
"another lane owns that file" — nothing else is editing it. Unifying the two means
either giving the rail the tile's tab-slot stroke floor, which is 15% heavier than
a header glyph wants, or giving the tile the rail's lighter stroke, which drops the
16px favicon under the floor that `landing/__tests__/favicon-serving.test.ts` sets.
The proportions genuinely differ because the CONSTRAINTS differ, so they are kept
as a documented family rather than forced into one constant. The 2026-08-11 pass
moves the tile CLOSER to the rail on every axis that is not the stroke: ry to 6%
below the rail's (was 8% above), core to within 2%, and the ellipse ASPECT from
1.85 to 2.13 against the rail's 2.33. Only the stroke stays ~15% heavier, and that
is the tab-slot floor talking, not drift.

WHY THIS MODULE EXISTS. It did not, and the copies drifted. `landing/favicon.ico`
had a committed generator pinned to the SVG's coordinates, while the MOBILE app
icon was a completely unrelated drawing — teal concentric rings with a satellite
dot — that no source in this repo produces. Ryan, installing the APK
(2026-07-30): "make the app icon the same as our favicon. What is this weird icon
you made". A mark that exists as N hand-placed binaries is a mark that is N
different marks. So the geometry lives here once, and every generator renders
from it. The last hand-placed copy — `landing/apple-touch-icon.png`, which was
still that rejected teal drawing and still being served as the iOS home-screen
icon — was folded into `gen-favicon-ico.py` on 2026-08-11.

Requires Pillow (dev-only; not a runtime dependency of the server).

Geometry is kept in lockstep with `landing/favicon.svg` BY HAND — the constants
below are that file's `0 0 32 32` coordinates verbatim. If you change the SVG,
change them here and re-run BOTH generators; a full run takes ~20 minutes because
the 1024px assets are supersampled 8x:

    python3 scripts/gen-favicon-ico.py   → favicon.ico, apple-touch-icon.png
    python3 scripts/gen-app-icons.py     → app/assets/images/*.png

ALGEBRA HERE IS NOT EVIDENCE. Every constant below was self-consistent, every
assert passed and all 21 tests were green while the icons that shipped on
2026-08-10 had the exact defect the asserts were written to prevent, because
nothing in the pipeline had ever looked at a pixel. So `verify_raster_invariants()`
MEASURES a render and both generators call it before writing, and
`scripts/__tests__/atom-mark-geometry.test.ts` decodes the committed binaries.
If you change a number here, re-run the generators — the test reads the PNGs and
will fail until you do, which is deliberate.

The SVG's docblock owns the RATIONALE for the proportions (why the nucleus has to
float clear of the orbits, why the orbits are as flat as they are, and what each
costs at 16px). Read it before nudging any number here.
"""

from __future__ import annotations

from PIL import Image, ImageDraw

# --- geometry, in the SVG's 0 0 32 32 coordinate space -------------------
VIEWBOX = 32
BG = (0x0B, 0x0E, 0x14, 0xFF)  # #0b0e14 — the shell's theme-color
ACCENT = (0x4D, 0xA3, 0xFF, 0xFF)  # #4da3ff
WHITE = (0xFF, 0xFF, 0xFF, 0xFF)
CORNER_RADIUS = 7
CORE_RADIUS = 2.3
ORBIT_RX, ORBIT_RY = 11.4, 5.4
ORBIT_STROKE = 2.6
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
#:
#: THIS EXPRESSION IS ONLY TRUE OF THE RASTER BECAUSE `render_master` CENTRES THE
#: STROKE. Pillow strokes an ellipse INSIDE its bounding box, so drawing at the bare
#: (rx, ry) puts the inner edge at `ry - ORBIT_STROKE`, not `ry - ORBIT_STROKE / 2`,
#: and the real gap is a whole half-stroke tighter than this line claims. That is
#: exactly what shipped on 2026-08-10: the algebra said 2.15 units, every generated
#: PNG measured 0.90, and the assert below passed anyway because it never looked at a
#: pixel. `render_master` now grows the bbox by half the stroke so the rasterised
#: edges land where SVG's centred stroke puts them, and `verify_raster_invariants()`
#: MEASURES the render rather than trusting this line.
CORE_ORBIT_GAP = ORBIT_RY - ORBIT_STROKE / 2 - CORE_RADIUS

#: Ellipse eccentricity. Three ellipses at 60° read as ORBITS when they are flat
#: enough to cross in a small central region and as a six-lobed rosette — a flower,
#: or a cog — when they are not. At 1.85 (the 2026-08-10 numbers) the central void
#: was a fat hexagon and the mark read as a flower at 256px+; the rail-header icon
#: this is a family with sits at 2.33.
ORBIT_ASPECT = ORBIT_RX / ORBIT_RY

#: The mark's full painted extent, in viewBox units (widest orbit + its stroke).
#: EXACT, now that `render_master` centres the stroke — it used to be an
#: over-estimate because the raster extent was really `2 * ORBIT_RX`.
MARK_EXTENT = 2 * (ORBIT_RX + ORBIT_STROKE / 2)

#: Half the tile the mark may paint into, leaving a >= 20% margin on the widest axis.
#: A launcher glyph that reaches the tile edge looks like a cropping mistake, and on
#: the rounded favicon tile it collides with the corner radius.
MARK_EXTENT_LIMIT = 0.8 * VIEWBOX

# The invariants above are enforced HERE and not only in the test suite, so a
# generator run cannot produce an asset that violates them — the failure mode this
# guards is a well-meaning tweak to one constant that quietly ruins the mark, and the
# artefact is the thing that ships. Every one of them was violated by a real shipped
# icon. They are ALGEBRA, though; `verify_raster_invariants()` is what checks pixels,
# and the 2026-08-10 blob is the standing proof that algebra alone is not enough.
assert ORBIT_STROKE >= MIN_ORBIT_STROKE, (
    f"orbit stroke {ORBIT_STROKE} resolves to {ORBIT_STROKE * 16 / VIEWBOX:.3f} device px "
    f"in a 16px tab slot; the floor is {MIN_ORBIT_STROKE} units (1.2 px)"
)
assert CORE_ORBIT_GAP >= 1.5, (
    f"only {CORE_ORBIT_GAP:.2f} viewBox units of background between the nucleus and the "
    "orbits — below ~1.5 they fuse and the mark reads as a blob with no nucleus"
)
assert ORBIT_ASPECT >= 2.0, (
    f"orbit aspect {ORBIT_ASPECT:.2f} — below ~2.0 the three ellipses stop reading as "
    "orbits and the mark reads as a six-lobed rosette"
)
assert MARK_EXTENT <= MARK_EXTENT_LIMIT, (
    f"the mark paints {MARK_EXTENT:.2f} of {VIEWBOX} viewBox units across, past the "
    f"{MARK_EXTENT_LIMIT} limit — it will look cropped and will fight the corner radius"
)

#: Android adaptive-icon safe zone: the 108dp layer is masked to 72dp, and only
#: the central 66dp circle is guaranteed visible under EVERY OEM mask shape.
ANDROID_SAFE_FRACTION = 66 / 108

#: Shrink the safe-circle fit by a further 2%, so the mark sits INSIDE the circle
#: rather than tangent to it.
#:
#: WHY THIS CONSTANT HAD TO BE ADDED. `SAFE_SCALE` fits `MARK_EXTENT` to the safe
#: diameter exactly, which puts the widest orbit tips ON the boundary — and an
#: antialiased edge on a boundary lands a few pixels outside it. Until 2026-08-11 that
#: never showed, because the rasteriser strokes inside the bbox and so painted an extent
#: of `2 * ORBIT_RX` where `MARK_EXTENT` predicted `2 * (ORBIT_RX + ORBIT_STROKE / 2)`:
#: the fit had a free half-stroke of slack it was never designed to have. The 2026-08-10
#: entry noticed precisely this and filed it as reassurance — "`SAFE_SCALE` therefore
#: errs toward the safe direction". Centring the stroke removed the accident, and the
#: pixel assertion in scripts/__tests__/atom-mark-geometry.test.ts immediately found 3
#: painted pixels past the line. So the margin is now REQUESTED rather than inherited
#: from a bug.
ANDROID_SAFE_MARGIN = 0.98


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
    `MARK_EXTENT / VIEWBOX` (~0.80) of the canvas — so `1.0` reproduces the SVG's
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
    # SVG centres a stroke on its path; Pillow strokes INSIDE the bounding box. So the
    # bbox is grown by half the stroke, which puts the painted band on
    # [r - ORBIT_STROKE/2, r + ORBIT_STROKE/2] — where SVG puts it, and where
    # CORE_ORBIT_GAP and MARK_EXTENT both assume it is. Without this the raster mark
    # is a half-stroke tighter than the vector one everywhere, which is how the
    # 2026-08-10 icons shipped with a 0.90-unit nucleus gap while every assert and
    # every test agreed it was 2.15.
    grow = ORBIT_STROKE / 2
    for angle in ORBIT_ROTATIONS:
        # Each orbit goes on its own transparent layer, rotated about the centre
        # and composited — PIL's ellipse() takes no transform.
        layer = Image.new("RGBA", (n, n), (0, 0, 0, 0))
        ImageDraw.Draw(layer).ellipse(
            [
                cx - (ORBIT_RX + grow) * unit,
                cy - (ORBIT_RY + grow) * unit,
                cx + (ORBIT_RX + grow) * unit,
                cy + (ORBIT_RY + grow) * unit,
            ],
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


def measure_core_orbit_gap(n: int = 640) -> float:
    """The nucleus→orbit gap ACTUALLY PAINTED, in viewBox units.

    Walks up the vertical centre line of a real render: off the core, across the
    background ring, and onto the nearest orbit. This is the number the eye sees, and
    it is not `CORE_ORBIT_GAP` unless the renderer places its stroke where the algebra
    says — which for eleven days it did not.
    """
    image = render_master(n, background=BG)
    px = image.load()
    cx = cy = n // 2

    def is_accent(y: int) -> bool:
        r, g, b, _ = px[cx, y]
        return abs(r - ACCENT[0]) + abs(g - ACCENT[1]) + abs(b - ACCENT[2]) < 200

    y = cy
    while y > 0 and is_accent(y):  # walk off the nucleus
        y -= 1
    core_edge = y
    while y > 0 and not is_accent(y):  # cross the background ring
        y -= 1
    return (core_edge - y) / (n / VIEWBOX)


def count_background_slivers(n: int = 1024, max_sliver_units: float = 5.0) -> tuple[int, float]:
    """Isolated background islands too small to be a real void — (count, worst area).

    The mark's legitimate holes are the central hexagon and the six voids between the
    petals, all far larger than `max_sliver_units` square viewBox units. A SLIVER is a
    tiny background island where the outer edge of one orbit and the inner edges of the
    other two nearly concur without overlapping, leaving a dark nick a few units across
    sitting inside solid accent. They are invisible below ~100px and obvious on a 1024px
    launcher tile, which is why nothing caught them until someone rendered the icon at
    full size and looked at it.

    They are GEOMETRY, not a compositing artefact — an analytic point-in-band test
    reproduces them exactly, so no change of blend mode or resample filter removes them.
    What removes them is a slightly heavier stroke: at rx 11.4 / ry 5.4 / core 2.3 the
    worst sliver measures 0.039 sq units at stroke 2.45, 0.010 at 2.50, and 0 at 2.60.

    `n` DEFAULTS TO 1024 BECAUSE THE MEASUREMENT NEEDS THE RESOLUTION. At 400 px a
    viewBox unit is 12.5 px, so a real 0.039-unit sliver and a single stray pixel of
    rotation-resampling noise both round to roughly one cell and the check cannot tell
    a defect from the rasteriser breathing. At 1024 px the real slivers measure ~40x the
    noise, and the correct geometry scores exactly zero — which is why this asserts on
    zero rather than on a tolerance.
    """
    from collections import deque

    image = render_master(n, background=BG)
    px = image.load()
    unit = n / VIEWBOX
    is_bg = bytearray(n * n)
    for y in range(n):
        for x in range(n):
            r, g, b, _ = px[x, y]
            if abs(r - BG[0]) + abs(g - BG[1]) + abs(b - BG[2]) < 24:
                is_bg[y * n + x] = 1

    seen = bytearray(n * n)
    count = 0
    worst = 0.0
    for sy in range(n):
        for sx in range(n):
            start = sy * n + sx
            if not is_bg[start] or seen[start]:
                continue
            seen[start] = 1
            queue = deque([(sx, sy)])
            cells = 0
            touches_border = False
            while queue:
                x, y = queue.popleft()
                cells += 1
                if x in (0, n - 1) or y in (0, n - 1):
                    touches_border = True
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < n and 0 <= ny < n:
                        j = ny * n + nx
                        if is_bg[j] and not seen[j]:
                            seen[j] = 1
                            queue.append((nx, ny))
            if touches_border:
                continue  # the tile around the mark, not a hole in it
            area = cells / (unit * unit)
            if area < max_sliver_units:
                count += 1
                worst = max(worst, area)
    return count, worst


def verify_raster_invariants() -> None:
    """Assert the invariants against a RENDER, not against the constants.

    Called by every generator before it writes, because the artefact is what ships and
    the 2026-08-10 icons are the proof that a self-consistent set of constants and a
    green test suite say nothing about the pixels. `scripts/__tests__/
    atom-mark-geometry.test.ts` re-checks the same property on the COMMITTED binaries,
    so this cannot be skipped simply by not running the generator.
    """
    measured = measure_core_orbit_gap()
    assert measured >= 1.5, (
        f"the RENDER shows only {measured:.2f} viewBox units between nucleus and orbits "
        f"(algebra claims {CORE_ORBIT_GAP:.2f}) — the mark rasterises as a blob"
    )
    assert abs(measured - CORE_ORBIT_GAP) <= 0.25, (
        f"raster gap {measured:.2f} disagrees with CORE_ORBIT_GAP {CORE_ORBIT_GAP:.2f} — "
        "the renderer is not placing its stroke where the geometry says it does"
    )
    slivers, worst = count_background_slivers()
    assert slivers == 0, (
        f"{slivers} isolated background sliver(s), worst {worst:.3f} sq units — dark nicks "
        "inside the accent at launcher sizes; nudge ORBIT_STROKE up until they close"
    )
