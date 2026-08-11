## The ⚛ mark refinement — 2026-08-10, corrected and completed 2026-08-11

> Two rounds on one concern, so one document. The 2026-08-10 round is preserved below
> **with inline corrections** rather than rewritten, because three of its claims were
> wrong and one of its footnotes silently invalidated its headline — and that pattern is
> the most useful thing in here. The 2026-08-11 round is immediately below.

---

## 2026-08-11 — what shipped on 08-10 was not what 08-10 described

Four defects — three found by review and by rendering the committed files at full size, and
a fourth uncovered by fixing the first.

### 1. The mark that shipped was never the mark that was designed

`landing/favicon.svg` is the source of truth and every raster is generated from a
hand-mirrored copy of its numbers in `scripts/lib/atom_mark.py`. **SVG centres a stroke
on its path; Pillow strokes INSIDE the bounding box.** Nobody had reconciled the two, so
every generated PNG placed the orbits' inner edge at `ry - stroke` where the vector
source puts it at `ry - stroke/2` — the whole mark a half-stroke tight.

The consequence was the exact defect the 08-10 round existed to fix. Measured on the
committed binaries:

| asset (as committed at `76ffebbb`) | asserted gap | gap AS SHIPPED |
|---|---|---|
| `icon.png` | 2.15u | **0.91u** |
| `splash-icon.png` | 2.15u | **0.91u** |
| `android-icon-foreground.png` | 2.15u | **0.90u** |
| `android-icon-monochrome.png` | 2.15u | **0.90u** |

Measured by decoding the committed blobs out of git, with the Android layers normalised
for their safe-circle inset. `0.90` is exactly `ry - stroke - core` = `6.2 - 2.5 - 2.8`,
which is the signature of an inside-the-bbox stroke and confirms the mechanism rather
than merely correlating with it. (Review reported a spread of 0.88 down to 0.67 across
these files; the spread was an artefact of measuring the inset layers in unscaled
viewBox units. The defect is real and uniform — one cause, one value.)

The `assert CORE_ORBIT_GAP >= 1.5` added that day passed anyway, because it read
constants. So did all 21 tests. A mutation makes the point sharpest — `CORE_RADIUS=4.15`
/ `ORBIT_RY=7.15` / `ORBIT_STROKE=3.0`:

- the guard computes `7.15 - 3.0/2 - 4.15 = 1.50` and passes `>= 1.5` **exactly**
- the renderer draws an inner edge at `7.15 - 3.0 = 4.15`, which is the core radius, so
  the nucleus and the orbits **touch: a gap of 0.00 and a fully fused blob**

One set of constants, a green suite, and an icon worse than the one 08-10 replaced.

Fixed by centring the stroke in `render_master` (grow the bbox by `stroke/2`), which
makes the raster a true mirror of the vector and makes `CORE_ORBIT_GAP` and
`MARK_EXTENT` true statements about pixels rather than about arithmetic.

### 2. It read as a flower, not an atom

Nucleus clearance was necessary and not sufficient. Three ellipses at 0°/60°/120° cross
in a small central region when they are FLAT and pile into a fat hexagonal void when
they are round. At aspect `rx/ry = 1.85` the 08-10 mark had its clearance, was legible
at every size, and read as a **heavy six-lobed rosette** at 256px+.

### 3. Six dark nicks in the artwork, visible only at launcher size

Rendering the committed 1024px `icon.png` and looking at it showed six small **fully
opaque background triangles sitting inside the accent**, near the orbit crossings.

They are geometry, not a rasteriser artefact: an analytic point-in-band test reproduces
them pixel-for-pixel, so no blend mode or resample filter removes them. They occur where
the outer edge of one orbit and the inner edges of the other two nearly concur without
overlapping. A heavier stroke closes them — worst nick **0.039 sq units at stroke 2.45,
0.010 at 2.50, and 0 at 2.60** — and it also buys stroke weight at the 16px tab slot,
so it costs nothing.

### 4. Fixing the stroke removed slack the Android inset had been living on

Found by the new pixel assertion on its first run, which is the best argument for having
written it. `SAFE_SCALE` fits `MARK_EXTENT` to the 66/108 safe diameter **exactly**, so
the widest orbit tips land ON the boundary — and an antialiased edge on a boundary puts
pixels outside it. It had never shown up because the inside-the-bbox stroke painted an
extent of `2 * rx` where `MARK_EXTENT` predicted `2 * (rx + stroke/2)`: the fit had a
free half-stroke of slack **that came from the bug**. Centre the stroke and the slack
disappears; the assertion immediately reported 3 painted pixels past the line.

Now explicit: `ANDROID_SAFE_MARGIN = 0.98`, so the mark is inside the circle rather than
tangent to it.

📌 **A latent bug can be load-bearing.** The 2026-08-10 entry looked straight at this
mechanism and wrote it down as reassurance — *"`SAFE_SCALE` therefore errs toward the
safe direction"* — which was true, and true only because of a defect nobody had noticed
yet. When you fix the defect, every place that was quietly relying on it fails at once,
and the fix looks like it caused a regression it merely exposed.

### The change

| | 2026-08-10 | **2026-08-11** |
|---|---|---|
| core radius | 2.8 | **2.3** |
| orbit rx / ry | 11.5 / 6.2 | **11.4 / 5.4** |
| orbit stroke | 2.5 | **2.6** |
| orbit aspect `rx/ry` | 1.85 | **2.11** |
| core→orbit gap (algebra) | 2.15 | **1.80** |
| core→orbit gap **as shipped** | **0.91** | **1.80** |
| isolated slivers @1024px | 6 | **0** |
| stroke at a 16px tab | 1.25 px | **1.30 px** |
| painted extent | 12.75 of 16 | **12.70 of 16** |

Same three-orbit atom, same rotations, same `#0b0e14` tile and `#4da3ff` accent, no
fifth hue. **Twenty-two candidate geometries** were rendered and compared as real pixels,
not as source, with the small sizes nearest-neighbour magnified so the actual tab-slot
pixels were visible. Two constraints did the rejecting: candidates that read best at
256px (`rx` 12.4) broke the tile-margin limit, and the flattest (`ry` 4.6-5.0) put the
nucleus under one device pixel at 16px. The stroke was then swept 2.45 → 2.70 against the
sliver count, which is what picked 2.60.

### `landing/apple-touch-icon.png` — the rejected artwork was STILL being served

The 08-10 round deleted the rejected teal drawing from `landing/logo.svg` and added a
guard. **The guard read two SVG text files.** It passed green while
`landing/apple-touch-icon.png` — 180×180, dominant `#6fe3d4`, the old `r=48/112/176`
ring geometry, i.e. *literally the drawing Ryan rejected* — was served as the iOS
home-screen icon from `landing/boot-impl.ts` and `landing/server.ts`, declared in
`landing/site.webmanifest`, and asserted present by `landing/__tests__/mobile-route.test.ts`.

It was the last hand-placed copy of the mark in the tree. It is now generated by
`scripts/gen-favicon-ico.py` (which already owned `landing/`'s rasters), full-bleed and
opaque like `icon.png` because iOS masks it itself.

📌 **A guard scoped to the format you happened to be editing is not a guard against the
thing; it is a guard against one spelling of the thing.** The 08-10 entry argued,
correctly, that a rejected design left in the tree gets picked up by mistake — and then
enforced that argument only over SVG.

### What the tests do now

`scripts/__tests__/atom-mark-geometry.test.ts` decodes the committed PNGs (`node:zlib`
plus ~40 lines; no new dependency) and asserts on pixels:

- the nucleus gap MEASURED on `icon.png`, `splash-icon.png` and the Android foreground
- the voids between the petals are open — the property `stroke/ry <= 0.42` claimed to
  measure and could not
- **no committed icon contains a teal-family pixel**, via a structural test (green
  leading blue) that no blend of our accent on our tile can produce
- iOS and apple-touch icons fully opaque with painted corners; both Android layers
  transparent-cornered with every painted pixel inside the 66/108 safe circle;
  monochrome pure white; Expo favicon corner-clipped; Android background flat

And three guards that were broken or absent:

- **the tile-margin assertion was off by exactly 2x and could not fail** — it compared a
  half-extent (12.75) against `0.8 * VIEWBOX` (25.6) while its own comment documented
  12.8. Mutating `ORBIT_RX` to 24 — orbits 58% past the tile edge — passed all 21 tests.
- **`pyNumber` had a silent-wrong path**: half-anchored, so
  `MIN_ORBIT_STROKE = 1.2 / (16 / VIEWBOX)` returned `1.2` instead of the `2.4` it
  evaluates to, and its tuple branch matched the first tuple in the file regardless of
  name. Now anchored at both ends and it THROWS on a derived constant.
- `verify_raster_invariants()` and `count_background_slivers()` in
  `scripts/lib/atom_mark.py` measure a render before either generator writes anything.

**Mutation-tested, which is the only reason to believe any of it.** The suite is 34 tests,
all green on HEAD. Swapping the mark's SOURCES AND BINARIES to an older commit while
keeping today's test file:

| mark under test | result |
|---|---|
| HEAD (this pass) | **34 pass / 0 fail** |
| `76ffebbb` — the 2026-08-10 mark | **22 pass / 12 fail** |
| `origin/main` — the pre-08-10 mark | **14 pass / 20 fail** |

The mutation run also fixed a failure MODE. The pixel block first derived its geometry in
the `describe` body, and `pyNumber` throws on a constant the module does not declare — so
swapping in an older module aborted the whole block: *"1 error, 8 tests never ran"* instead
of *"9 tests failed"*. The derivation is now lazy, inside each `it`. An aborted block is a
strictly worse signal than a failed assertion, and it is only visible if you actually run
the mutation and read the counts rather than the exit code.

And the two guards that did not exist before, each killed by reverting exactly the line
it was written for:

- revert the stroke centring in `render_master` → measured gap 0.50u,
  `verify_raster_invariants()` fires
- set `ORBIT_STROKE` back to 2.45 → 8 slivers, worst 0.039 sq units, that assert fires

### Not covered, deliberately

- **`landing/og/neutron-og.png` still carries the rejected teal.** Verified: 15,412
  teal-family pixels, zero accent-blue, and it does contain the old concentric-ring
  motif. It is NOT fixed here and it is not an oversight. It is a 1200×630 typographic
  marketing card with no generator and no source in the repo, and its teal is the colour
  of the display type ("*Answers only to you*"), not just of the motif — so re-tinting it
  is a brand decision about display colour, which belongs with the colour-TOKEN lane
  that owns `app/lib/theme.ts` and `landing/chat-react.html`, and cannot be done by
  hand-editing a flattened 16-colour PNG. The new pixel guard is therefore scoped to the
  ICON family and names this exclusion explicitly rather than quietly passing over it.
- The colour TOKENS are that other lane's; `app/lib/theme.ts` and
  `landing/chat-react.html` were not touched. If the accent moves, `#4da3ff` moves with it.
- `AtomMark()` in `landing/chat-react/ChatApp.tsx` remains a second, hand-maintained set
  of numbers, and the reason is now recorded truthfully in `scripts/lib/atom_mark.py`:
  the two marks have different stroke constraints. This pass moves the tile CLOSER to
  the rail on ry, core and aspect.
- Unverified on a real device — the app icon is part of the native shell, so it needs a
  rebuild rather than an OTA. Per the done-means-served bar, this closes when the new
  mark is on a home screen.
- **A full regeneration takes ~20 minutes and that is a latent hazard, not a nuisance.**
  `render_atom` supersamples 8x, so a 1024px asset renders at 8192px and holds roughly a
  gigabyte of RGBA buffers across the three rotated layers; the machine goes
  memory-bound. The entire design depends on "re-run the generator whenever the SVG
  changes", and a twenty-minute generator is one people skip — which is precisely how
  hand-placed binaries drift out of agreement in the first place. Dropping the
  supersample to 4x at 1024px would be ~4x faster and is very unlikely to be
  distinguishable after a LANCZOS downsample, but it rewrites every binary again, so it
  was left out of this change rather than bundled into it unmeasured. Worth doing as its
  own small pass, with a before/after pixel diff to justify the number.

---

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
the six outer voids at once; stroke and core barely move. Six candidate geometries
were rendered side by side at 16/32/48/256 px before this one.

> **CORRECTION (2026-08-11).** This paragraph said "eleven candidate geometries…
> across two rounds" while `landing/favicon.svg`'s own comment said six. Six is the
> number that was rendered as candidate strips; "eleven" appears to have counted
> intermediate tweaks. Two docs disagreeing about a number in the same commit is a
> small thing that costs a reviewer real time to adjudicate, so: six.

The rotations were deliberately **not** touched. Tilting the set is the obvious
aesthetic move, but it changes the silhouette's orientation, and `AtomMark()` in
`landing/chat-react/ChatApp.tsx` (the rail-header icon) would then disagree with the
browser tab in a way a viewer can see. ~~That file is owned by another lane.~~

> **CORRECTION (2026-08-11).** The struck sentence was false and was never checked.
> No concurrent lane touches `ChatApp.tsx` — the branch it was presumably referring to
> edits `landing/chat-react.html` and `app/lib/theme.ts`. The decision to leave the
> rail icon alone is fine on its merits, and the real reason is now written into
> `scripts/lib/atom_mark.py`'s docstring: the two marks have different STROKE
> constraints (a 16px tab slot versus a 20px+ header glyph), so unifying them would
> either overweight the header or push the favicon under the floor
> `landing/__tests__/favicon-serving.test.ts` sets. A true reason was available; an
> invented one got written instead.

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
now mirrored into `scripts/lib/atom_mark.py` as `MIN_ORBIT_STROKE`, and
`scripts/__tests__/atom-mark-geometry.test.ts` **reads the device-px number out of the
serving test** instead of hard-coding its own copy, so the two gates cannot drift into
disagreeing about what the floor is.

> **CORRECTION (2026-08-11).** This paragraph said the floor was "derived rather than
> retyped", which overstates it. The literal `1.2` lives in three places — the serving
> test (its home), `MIN_ORBIT_STROKE`, and a `toContain` in the geometry test. Only the
> UNIT CONVERSION (device px → viewBox units) is derived. What the arrangement actually
> buys is that drift is caught in the direction that matters: raise the serving test's
> floor and the geometry test fails until the mark complies. That is worth having, and
> it is not "one number in the repo".

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

> **CORRECTION (2026-08-11).** That paragraph is the single most important thing in
> this document and it was filed as a harmless footnote about `SAFE_SCALE`. The same
> fact — Pillow strokes inside the bbox, SVG centres the stroke — means the orbits'
> INNER edge rasterised at `ry - stroke`, not `ry - stroke/2`. So the nucleus gap that
> this entry headlines as `0.40 → 2.15` was **0.90 in every PNG it shipped**, and the
> `>= 1.5` assert added to guard exactly that passed anyway because it only ever read
> the constants. The paragraph above noticed the mechanism, checked its effect on the
> one consumer it happened to be thinking about, and never asked what else in the file
> assumed a centred stroke. See the 2026-08-11 round below.
>
> 📌 **When you discover that the renderer does not do what the geometry says, that is
> not a footnote about one consumer — it invalidates EVERY number derived from the
> geometry, starting with the one you are most confident about.** The tell was right
> there in the sentence: "the rasterised extent is `rx` rather than `rx + stroke/2`"
> is a statement that the raster disagrees with the algebra by half a stroke
> EVERYWHERE, and `MARK_EXTENT` was not the only thing built on it.

### Test — re-pinned, and mutation-tested

`scripts/__tests__/atom-mark-geometry.test.ts` is 21 tests, and the point of the
re-pin is that **it fails against the old mark**: reverting the three source files to
`origin/main` produces 9 failures, including all three of the new design assertions
(nucleus clearance, stroke/ry ceiling, paint order) and all three `logo.svg` ones. A
geometry test that passed against both marks would pin nothing.

> **CORRECTION (2026-08-11).** This said 8 failures; the mutation run produces 9
> (12 pass / 9 fail). The bar was still met, so the conclusion stands — but a count
> stated to a reviewer has to be the count that was observed, and re-running the
> mutation is the only way to know it.

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
