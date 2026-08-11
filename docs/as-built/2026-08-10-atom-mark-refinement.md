## 2026-08-10 — the ⚛ mark: give the nucleus room, and delete the rejected logo

Ryan: *"I just want the icon looking better, and I gave you a reference inspiration,
don't fucking copy it"* — the reference was an atom motif, and only the SYMBOL was
the reference. Neutron's palette (`#0b0e14` tile, `#4da3ff` accent) and its tile
style are unchanged; no fifth accent hue was introduced.

### What was actually wrong — it was measurable, not a matter of taste

The mark is a nucleus plus three orbits at 0°/60°/120°. Whether it reads as an atom
at all comes down to one quantity: the ring of tile background between the core and
the orbits' inner edge, `ORBIT_RY - ORBIT_STROKE/2 - CORE_RADIUS`.

**It was 0.40 viewBox units.** At a 16px favicon that is 0.2 device px, so the core
and all three orbit strokes fused. The consequence was not subtle and was not
confined to small sizes: at 1024px there was **no nucleus visible at all**, and the
mark read as a fat six-petal asterisk. Rendering `landing/favicon.svg` at
16/32/48/512 px and looking at the output is what surfaced it — the numbers were
each individually plausible and the geometry test was green, because the test only
compared the numbers to each other and never to a design constraint.

Two related quantities were also out of range: `stroke/ry` was 53%, which leaves an
ellipse no ring quality (the orbits were lozenges, not orbits), and the six outer
voids were pinched nearly shut.

### The change

| | old | new |
|---|---|---|
| core radius | 3.2 | **2.8** |
| orbit rx / ry | 11.5 / 4.9 | **11.5 / 6.2** |
| orbit stroke | 2.6 | **2.5** |
| core→orbit gap | 0.40 | **2.15** |
| stroke / ry | 53% | **40%** |
| core dia / stroke | 2.46x | **2.24x** |
| stroke at a 16px tab | 1.30 px | 1.25 px |
| tile margin | 10.0% | 10.2% |

Same three-orbit atom, same rotations, same palette, same tile framing. Almost all
of the gain comes from the minor radius (4.9 → 6.2), which opens the centre ring and
the six outer voids at once; stroke and core barely move. Eleven candidate geometries
were rendered side by side at 16/32/48/256 px across two rounds before this one.

The rotations were deliberately **not** touched. Tilting the set is the obvious
aesthetic move, but it changes the silhouette's orientation, and `AtomMark()` in
`landing/chat-react/ChatApp.tsx` (the rail-header icon) would then disagree with the
browser tab in a way a viewer can see. That file is owned by another lane.

### An existing guard caught the first draft, and it was right

The first version of this pass thinned the stroke to 2.0 units for elegance at large
sizes. `landing/__tests__/favicon-serving.test.ts` failed it: that test requires the
stroke to resolve to **≥ 1.2 device px** in a 16px tab slot, and 2.0 units resolves
to exactly 1.00 px. The icon that shipped broken on 2026-07-18 drew **1.067 px** — so
the draft was not merely below a cautious floor, it was *thinner than the stroke
already known to be invisible* on a dark tab strip.

That floor is the real constraint on this design. It caps how light the orbits can
go, which caps how flat the ellipse can be at a given weight, which is why the final
mark's orbits are rounder than the old ones rather than flatter. The shipped stroke
is 2.5 units = 1.25 px, chosen to sit above the floor with margin rather than exactly
on it.

Two things were changed so the next person does not repeat the mistake: the floor is
now mirrored into `scripts/lib/atom_mark.py` as `MIN_ORBIT_STROKE`, derived rather
than retyped, and `scripts/__tests__/atom-mark-geometry.test.ts` **reads the number
out of the serving test** instead of hard-coding its own copy, so the two gates
cannot drift into disagreeing about what the floor is.

For the record on the rail icon: scaled into the 32 viewBox it draws ry 5.73 /
stroke 2.13. The tile mark's ry went from 15% under that to 8% over it, but its
stroke stays ~17% heavier — and that is the tab-slot floor talking, not drift. A
header icon renders at 20px+ and never faces the 16px slot.

### Two latent inconsistencies found on the way

**The SVG's paint order was the inverse of its own raster mirror's.**
`landing/favicon.svg` declared the core BEFORE the orbit group, so the orbits painted
over the nucleus; `render_master` in `scripts/lib/atom_mark.py` fills the core LAST,
above the orbits — under a comment claiming it matched "the SVG's paint order". It
was invisible only because both are the same flat colour, and it would have become a
real divergence the moment either gained opacity or a second hue. The SVG now
declares the core last, and the test asserts the ordering in both files.

**`scripts/lib/atom_mark.py`'s docstring claimed the geometry was "lifted from
`AtomMark()`".** It never was, numerically — the favicon was retuned for a 16px tile
in July and the docstring was not. Corrected to say same-family-not-copy, with the
actual rail numbers and the reason a tile needs different ones.

### `landing/logo.svg` — the rejected drawing was still live

It still held teal `#6fe3d4` concentric rings with a satellite dot: the drawing Ryan
rejected on installing the APK (2026-07-30, *"make the app icon the same as our
favicon. What is this weird icon you made"*). The app icons were regenerated from the
⚛ mark that day, but this file was left behind — and it is **not dead code**. It is
served as `/logo.svg` by `landing/boot-impl.ts` and worn at 56px by
`landing/onboarding-telegram.html`, so the onboarding page has been showing rejected
artwork in a palette the product does not use for eleven days.

Deleting it would 404 that page, so it is now the canonical mark's drawing verbatim —
same `0 0 32 32` viewBox and the same numbers, only `width`/`height` differ, since
SVG scales and a second set of coordinates has no reason to exist. A test asserts the
two files' painted bodies are byte-identical and that neither contains the rejected
teal or its concentric rings.

Worth stating plainly, because the earlier as-built entry
(`docs/as-built/2026-07-29-mobile-neutron-icon.md`) asserts the opposite: that entry
says *"the real mark already existed as `landing/logo.svg`… teal `#6fe3d4` concentric
orbits"* and generated all six app icons from it. That is the doc that made the wrong
file look canonical. A rejected design left in the tree is not inert; it is the
likeliest thing for the next change to pick up, and it was picked up once already.

### Regenerated

`python3 scripts/gen-app-icons.py` (all six under `app/assets/images/`) and
`python3 scripts/gen-favicon-ico.py` (`landing/favicon.ico`).

Each generated binary was then inspected AS SHIPPED — opening the committed files,
not re-rendering the source — against the constraint its docstring names:
`icon.png` fully opaque with painted corners (iOS rejects alpha and applies its own
mask, so a baked-in radius double-rounds); both Android layers' painted extent inside
the 66/108 safe circle so no OEM mask shape can clip an orbit;
`android-icon-monochrome.png` containing only white pixels for the Android 13+
themed layer.

One observation from that inspection, recorded because it is a property of the
machinery rather than of this change: Pillow strokes an ellipse INSIDE its bounding
box, so the rasterised extent is `rx` rather than `rx + stroke/2`, and the Android
layers land a little smaller than `MARK_EXTENT` predicts. `SAFE_SCALE` therefore errs
toward the safe direction — inside the safe circle, never over it.

### Test — re-pinned, and mutation-tested

`scripts/__tests__/atom-mark-geometry.test.ts` is 21 tests, and the point of the
re-pin is that **it fails against the old mark**: reverting the three source files to
`origin/main` produces 8 failures, including all three of the new design assertions
(nucleus clearance, stroke/ry ceiling, paint order) and all three `logo.svg` ones. A
geometry test that passed against both marks would pin nothing.

The new assertions are deliberately about RATIOS rather than values, because the
2026-08-10 defect was a set of individually-reasonable values in a bad relationship —
which is exactly what a value-only pin cannot see:

- nucleus clearance ≥ 1.5 units (was 0.40)
- `stroke/ry` ≤ 0.42 (was 0.53)
- stroke ≥ the 16px device-px floor, read from `favicon-serving.test.ts`
- painted extent ≤ 80% of the tile
- monochrome layer is `accent=WHITE` with no background

### Not covered

Unverified on a real device — the app icon is part of the native shell, so it needs a
rebuild rather than an OTA, and per the done-means-served bar this closes when the
new mark is on a home screen. The colour TOKENS are another lane's (`app/lib/theme.ts`
and `landing/chat-react.html` were not touched); if the accent moves, `#4da3ff` here
should move with it. `AtomMark()` in `landing/chat-react/ChatApp.tsx` still carries
its own July numbers and remains the one hand-maintained copy of the geometry.
