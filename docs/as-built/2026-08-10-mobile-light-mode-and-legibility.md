## 2026-08-10 — light mode on the phone, an iMessage-blue bubble that carries white text, and the type/contrast fixes on both clients

Four owner requests, one lane, because they all land on the same two files.

> *"I want fucking light mode on the mobile app … And for the chat interface model the colors after iMessage but use our own Neutron blue"*
> *"I want a light/dark/system toggle somewhere in settings"*
> *"And in dark mode, keep the white text in blue bubble for user chat messages it's fine"*

Earlier, next to Telegram: their text is *"brighter and more vivid and easier to
read"*, ours *"more difficult"* — he asked for a larger size and a different colour
for the dark grey used on links.

### What changed

**Two palettes where there was one.** `app/lib/theme.ts` had a single frozen
`THEME`, and ~70 components captured its colours at MODULE LOAD inside
`StyleSheet.create({...})`. A captured colour cannot change, so light mode was not a
palette problem, it was a *threading* problem. There are now `DARK_THEME` /
`LIGHT_THEME` (same shape) and `DARK_PHASE` / `LIGHT_PHASE`, selected by
`resolveTheme(pref, osScheme)` into a `NeutronPalette`, and consumed per render via
`useTheme()` / `usePhase()` / `useThemedStyles(makeStyles)` from the new
`app/lib/theme-context.tsx`.

**`THEME` was DELETED, not aliased.** That is the load-bearing decision. With the
export gone, a component that still captures a fixed palette is a *compile error*
rather than a dark card someone has to notice on a device in one theme. It is what
turned this from "convert the files I can find" into "convert the files the compiler
insists on": 65 files were converted mechanically, then `tsc` produced the exact
list of the 9 it could not — module-scope colour maps, style-picking helpers that
are not components, an exported sheet shared across two modules, and a class
component (`DiagnosticsErrorBoundary`, whose crash screen is now a function
component so it can read a palette).

`app/lib/composer-constants.ts` no longer re-exports a palette either. Six
components imported `THEME` from that barrel and named `lib/theme` nowhere, so a
grep for the theme import missed all six. The barrel is where that was possible, so
the barrel is where it is prevented.

**The blue.** Owner decision: white ink on a blue bubble in BOTH themes. That could
not be done with the existing values — white on `#0a84ff` measures **3.65** and on
light's `#007aff` **4.02**, both under the 4.5 AA floor. Honouring the decision
meant moving the blue, not the ink. `NEUTRON_BLUE = #1064cc` is the value that
satisfies all five constraints at once:

| what it has to do | ratio |
|---|---|
| white ON it (bubble ink, both themes) | **5.65** |
| it ON light `background` `#ffffff` | 5.65 |
| it ON light `surface` `#f5f5f7` | 5.19 |
| it ON light `surface_raised` `#e9e9eb` | **4.66** |
| it ON dark `background` `#101419` (bubble edge, non-text 3:1) | 3.27 |

The fourth row is the one that is easy to miss and the reason this is not `#1069d9`
(a failing 4.28 there): `markdown-render.tsx:398` paints links with `link`, and
markdown renders INSIDE agent bubbles, so a light-theme link lands on the bubble
grey and not just on the page. The last row pulls the opposite way — darken further
and the owner's own bubble stops separating from the dark ground. One hex for both
palettes, because the outgoing bubble is the most recognisable object in the product
and a bubble that changed hue with the theme would read as two blues.

The pale `#6cf` / `#5fb6ff` accents keep their job as dark-mode LINK colours and are
never used as a fill. White on `#6cf` is 1.80, which is the combination the separate
token exists to avoid.

**The toggle.** `app/components/ThemeControl.tsx` — a three-way segmented control in
Settings, above the navigation rows because it changes what all of them look like.
`light | dark | system`, defaulting to `system`, persisted under `neutron-theme`
(the same key the web chat uses). `system` tracks the OS LIVE: `useColorScheme()` is
already a subscription, so flipping the OS theme re-themes a foregrounded app rather
than waiting for a relaunch. `app/app.json`'s long-standing
`"userInterfaceStyle": "automatic"` was a config declaring a mode no code path
entered; it is finally true.

Boot order is now `DiagnosticsErrorBoundary` → `ThemeProvider` → `RootLayoutShell`,
and the boot gate waits on the stored-preference read as well as the server-config
hydrate. That is mobile's equivalent of the web's pre-paint inline script — without
it the first screen paints the OS-resolved theme and snaps to the owner's override a
frame later. The error boundary sits OUTSIDE the provider deliberately: it is the
one screen that must render when theming is what broke, so `useTheme()` answers with
the dark palette outside a provider instead of throwing.

**Type size, both clients.** Mobile `TYPOGRAPHY` moved +2 across the whole ramp
(body 15/22 → 17/25). Web set `html { font-size: 17px }` and converted **147**
absolute `font-size: Npx` declarations to `rem` against the old 15px base — which
preserves every existing size relationship exactly while one number moves the whole
UI. Bumping body alone would have put a 17px body under a 15px `h4` and left every
control reading undersized. Dark also gets more leading than light
(`--body-line` 1.55 vs 1.5): light text on a dark ground reads lighter than it is.

**Contrast.** Fixed, with measured before/after: mobile dark `text_muted`
`#7c848f` → `#8f97a5` (4.89/4.48/**3.91** → 6.28/5.76/5.02 across background /
surface / surface_raised — it was failing AA on two of the three grounds it lands
on); web dark `--faint` `#5f646e` → `#7d838f` (3.27 → 5.11); web light `--muted`
`#8a8a8e` → `#57575b` (3.44 → 7.19), `--faint` `#aeb2ba` → `#6c6c70` (2.13 → 5.23),
`--accent` `#007aff` → `#1064cc` (4.02 → 5.65, which also fixes `--on-accent` and
the link colour), `--warn-fg` / `--phase-fix-fg` `#9a6a00` → `#8a5f00` (4.35 on
surface → 5.19). Light's accent tints were rgba of the OLD accent and are
re-derived. Tokens that already passed were not touched.

### What was measured, and what proves it

`app/__tests__/contrast.test.ts` computes WCAG ratios over FOUR surfaces — mobile
light/dark from the palettes, web light/dark PARSED out of `landing/chat-react.html`
so the two clients cannot drift — against every ground a token can land on,
including `surface_raised`. It asserts ratios, never hex strings: a test that pinned
the new hexes would have zero contrast coverage, because a hex is only equal to
itself and such a test passes against a straight revert.

Mutation-tested rather than assumed. Restoring `text_muted: '#7c848f'` reds it with
`dark text_muted #7c848f on #222834 = 3.91 is below AA 4.5`.
`contrast-gate-selfcheck.test.ts` holds all nine pre-existing failing pairs and
asserts the measurement still calls them failures, plus the two anchors that cannot
be wrong (black-on-white 21:1, a colour on itself 1:1) and that the parser THROWS on
input it cannot read rather than scoring it — a silent 0 would make a failing pair
look bright.

`app/__tests__/theme-preference.test.tsx` presses the real control and reads the
resolved `backgroundColor` a component received. It covers all four behaviours,
including the two that a launch-time-only read passes and a device fails: `system`
following a CHANGED OS scheme, and an explicit choice NOT being shadowed by a later
OS change. It reads `StyleSheet.flatten(...)` rather than `element.style` because
under react-native-web a `StyleSheet.create` style becomes a CSS class, so
`element.style.backgroundColor` is `''` — a test reading it would measure nothing
while looking like it measured something.

`app/__tests__/no-captured-palette.test.ts` is the one-missed-component guard: no
palette export exists, no component imports one, no module-scope stylesheet contains
a colour, and the hex-literal population cannot grow. Mutation-tested — adding one
module-scope coloured sheet reds three independent assertions.

Markdown was CHECKED rather than assumed, because the owner asked. Mobile: all 13
kinds `markdown-grammar.ts` parses have a render case in `markdown-render.tsx` —
exact match, nothing unstyled. Web: every element `.car-md` can receive is styled,
including `ul` (a combined selector at `chat-react.html:538`, which a naive grep for
`.car-md ul {` misses) and the task-list checkbox at `:545`. Nothing to fix; no work
invented.

### What is NOT covered

**~300 raw hex literals remain, in files that never used the palette at all** — the
admin panes (`app/features/admin/*`), the Cores screens
(`app/app/cores/[slug].tsx`, `dtc-analytics.tsx`), and the docs tab
(`app/features/docs/docs-ui.tsx`, 78 of them). **Those surfaces still render dark in
light mode.** They were invisible to this conversion by construction: they never
imported `THEME`, so deleting it produced no compile error pointing at them, and
they were found only by scanning for hex literals after the conversion was already
green. The guard test freezes the count per file — it cannot grow, and a fix can only
lower it — so the gap is finite and visible rather than ambient. Closing it is a
follow-up lane of comparable size, and interleaving it here would have made both
harder to review.

`attention` in light (`#e0a020`, 2.28 on white) is left alone and recorded as the
one documented exemption in the contrast gate. It is a 6px dot whose hue the owner
set himself — FIX #345 rejected a darker amber as *"a muddy brown"* — so
re-deriving it for contrast would silently overturn a decision he made on sight. It
needs his ruling, not a unilateral fix.

Nothing here has been seen on a device. The harness renders react-native-web, so it
cannot see native layout — every visual claim is UNVERIFIED until it runs on a
phone, and iMessage bubble SHAPE in particular (radii, tails, run spacing) is
existing behaviour this change re-themed rather than re-measured.
