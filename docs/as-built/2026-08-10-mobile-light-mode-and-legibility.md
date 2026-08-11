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

The contrast gate specifically IS mutation-tested, and only that claim is made here:
restoring `text_muted: '#7c848f'` reds it with
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
a colour, and **no colour literal exists anywhere outside the palette module**. The
per-file budget it originally carried is gone — see the round-2 section below for why
that budget was the worst part of the first pass.

Markdown was CHECKED rather than assumed, because the owner asked. Mobile: all 13
kinds `markdown-grammar.ts` parses have a render case in `markdown-render.tsx` —
exact match, nothing unstyled. Web: every element `.car-md` can receive is styled,
including `ul` (a combined selector at `chat-react.html:538`, which a naive grep for
`.car-md ul {` misses) and the task-list checkbox at `:545`. Nothing to fix; no work
invented.

### What is NOT covered

**RESOLVED in round 2 — see the section below.** This slot originally recorded ~300
remaining hex literals as a deferred lane and asserted that *"those surfaces still
render dark in light mode."* That sentence was **wrong**, and wrong in the direction
that matters: three of the named files were HYBRIDS whose containers were already
themed while their text was not, so the failure mode was not a dark card on a light
page — it was **invisible text on a correctly-themed page**. The docs viewer drew
#f4f4f4 body text on white (1.10:1) and a #fafafa title on it (1.04:1).

That is the aspirational-doc shape `CLAUDE.md` rule 3a warns about, written by me
about my own change: the sentence described the failure I EXPECTED from a
half-converted file rather than the one the code actually produced, and it was
confidently specific enough to read as a diagnosis. Anyone triaging from it would
have gone looking for the wrong symptom.

`attention` in light (`#e0a020`, 2.28 on white) is left alone and recorded as the
one documented exemption in the contrast gate. It is a 6px dot whose hue the owner
set himself — FIX #345 rejected a darker amber as *"a muddy brown"* — so
re-deriving it for contrast would silently overturn a decision he made on sight. It
needs his ruling, not a unilateral fix.

Nothing here has been seen on a device. The harness renders react-native-web, so it
cannot see native layout — every visual claim is UNVERIFIED until it runs on a
phone, and iMessage bubble SHAPE in particular (radii, tails, run spacing) is
existing behaviour this change re-themed rather than re-measured.

---

## Round 2 (2026-08-11) — the deferred lane, closed; and what the deferral cost

Review found two blockers that were really one: light mode shipped with surfaces
whose text was invisible, and the guard test that should have caught them **listed
those exact files as exempt**.

### The budget was the bug

The first pass converted ~70 components and then recorded the remaining ~380
literals as a per-file numeric budget in `app/__tests__/no-captured-palette.test.ts`
— "the number cannot go up, a fix can only lower it". The reasoning sounded like
control and was not, for a reason worth keeping:

> **A ratchet over a defect is a decision to ship the defect.** The exemption list
> named `app/features/docs/docs-ui.tsx` and `app/lib/markdown-render.tsx`, which is
> where the single worst pair in the change lived (1.10:1 body text). The file that
> needs a budget is *by construction* the file with the most colour logic — i.e. the
> one most likely to be wrong — so a per-file budget systematically excuses exactly
> the files a reviewer most wants checked. And because the test stayed green, nothing
> ever forced the follow-up.

All 19 files are converted (~400 literals) and the budget is **deleted**. The
invariant is now absolute: zero colour literals outside `app/lib/theme.ts` and
`app/lib/theme-context.tsx`.

### The matcher could not see a whole syntactic class

The old regex was single-quoted-hex only. It therefore never saw 25 real defects
that had been in the tree the whole time, all of them double-quoted JSX attributes:
`<ActivityIndicator color="#cfcfcf" />` — **1.56:1 on a white page, so every loading
state in light mode was a blank screen** — and `placeholderTextColor="#5a5a5a"`.

The guard now enumerates the four syntactic classes a colour can take and feeds each
one a known positive, asserting it is caught (`the matcher can see every class of
colour literal`). An absence claim is only worth the tool's proven ability to report
a presence; this is that control, made permanent rather than done once by hand.

### New palette tokens

Converting the admin panes, the Cores screens, the docs tab and the backup diff
viewer needed vocabulary the palette did not have, because those files had never
imported it. Added to `NeutronTheme`, both palettes: `success` / `success_surface` /
`success_border`, `danger_surface` / `danger_border` / `danger_fill` / `danger_ink`,
`info` / `info_surface` / `info_border`, `warning_surface` / `warning_border`,
`shadow`, and the two deliberately theme-INVARIANT fills `scrim` / `veil` /
`veil_ink` (a modal dim darkens in both themes; a strip over a thumbnail cannot
follow a palette, because an image is not one of its grounds).

`veil_ink` exists because `button-primitives.tsx` inked a caption on that dark strip
with `text_primary`, which is near-black in light mode — the light theme would have
erased a caption dark mode rendered fine.

### Grounds the gates were not measuring

- **Web gained `--agent-bubble` as a ground.** The mobile gate had always included
  its equivalent (`surface_raised`) with an explicit "this IS the agent bubble"
  rationale; web measured only `--bg` and `--surface`. Adding it went red on six
  pairs that CLEARED AA on both page grounds and failed only inside a bubble: dark
  `--faint` 4.29 and `--danger` 4.41; light `--faint` 4.31, `--danger` 4.44,
  `--success-fg` 4.19, `--phase-merged-fg` 4.19. All six fixed.
- **Each status ink is measured on its OWN WASH.** A wash introduced by the same
  commit as its ink has no "before" in which the pair was wrong, so nothing prompts
  you to measure it. This caught light `success`: the obvious value (`#1a7f37`,
  already in the palette as `usage_nominal`) measures 4.19 on `surface_raised`. It
  is `#146c2e`.
- **`rail_selected` is measured against the two inks actually drawn on it**
  (`text_primary`, `text_secondary` — the docs tree draws its label with the second).
  Deliberately not added to the global ground list: muted, danger, warning and link
  are never drawn on a selected row, and a gate that fails on pairs the product
  cannot render gets weakened rather than fixed.

### The OS subscription is now testable, so it is now tested

Every round-1 theme test injected the OS scheme through the provider's test-only
`osScheme` prop, which means **deleting `useOsColorScheme()` from the provider left
all ten of them green**. They proved the resolution rule and said nothing about
whether the app is subscribed to the device.

`react-native-web` implements no `useColorScheme` at all, which is why the prop
existed. The harness's `react-native` stub now provides one as a real subscription —
the same treatment `Keyboard` already gets there, and for the same reason (RNW's
listeners never fire, so subscribing to the real one is vacuously green). Five new
tests mount with **no `osScheme` prop at all** and drive the production path;
breaking the hook now fails three of them.

### "Wired" is now asserted for the toggle itself

`theme-preference.test.tsx` mounts `ThemeControl` directly, so deleting the
`<ThemeControl />` call site in `app/settings.tsx` left the whole suite green — the
persona-gen shape. `app/__tests__/theme-control-reachable-in-settings.test.tsx`
mounts the REAL Settings route and presses the segmented control through it. Removing
the call site fails it while the direct-mount suite stays 15/15 green, which is the
proof that the two tests cover different things.

### Also fixed

- **Pre-paint resolution.** The preference is now seeded from a SYNCHRONOUS store
  read where the platform has one (`localStorage`), so there is no wrong-theme frame
  at all on web — the mobile counterpart of the pre-paint script at
  `landing/chat-react.html:21-39`. Native keeps the boot gate, because AsyncStorage
  is a bridge round-trip. `app.json` gains a `splash.dark` variant so the pre-JS
  frame is no longer unconditionally black. **Stated limit:** the native splash
  renders before any JS exists to consult, so it follows the OS and cannot follow a
  stored override.
- **Native system chrome.** `expo-status-bar` is now wired to the RESOLVED scheme.
  `userInterfaceStyle: "automatic"` left icon styling to the OS, so an explicit Light
  choice on a dark-OS phone gave a light app with light-on-dark status-bar icons.
- **Chat leading.** `.car-md p` / `.car-text` pinned `line-height: 1.4`, overriding
  `--body-line` on the one surface the owner was complaining about — so the type work
  raised leading everywhere EXCEPT the transcript. Now `--chat-line` (1.5 dark / 1.45
  light): tighter than prose, looser than the old pin.
- **Code sizes.** Web inline code `.9em` → `.95em`, `pre code` `.85em` → `.9em`;
  mobile `inlineCode` was a literal `fontSize: 14` against a 17px body and now takes
  `TYPOGRAPHY.mono.fontSize`. Keeping `.9em` while the body grew carried the old
  problem forward.
- **`h5` / `h6` / `del` are styled on web.** `remark-gfm` emits them and the
  stylesheet handled only `h1`-`h4`, so `#####` fell through to the UA's `.83em` and
  rendered SMALLER than the body it introduced. (The round-1 note claiming web
  markdown was complete was checked against the elements the docs happened to use.)
- **`html { font-size: 17px }` → `106.25%`.** Both compute to 17px against a 16px
  default, but a percentage scales with whatever base the reader set; the px value
  discarded it, overriding the very readers the size bump was for.
- **Backup diff viewer.** Added/deleted/changed lines were pinned pastels
  (`#bbf7d0` 1.21, `#fecaca` 1.45, `#bfdbfe` 1.42 on white) — gone, not dim. Now the
  `success` / `danger` / `info` tokens.
- **Unwrapped-act warnings: NOT fixed, and the attempt is recorded.** Wrapping
  `MountedScreen.unmount()` in `act` silences them and took the 18-file
  device-harness set from 138 pass / 10 fail to **53 pass / 95 fail**; reverting
  restored the baseline exactly. The harness runs several files per PROCESS against
  one shared happy-dom, so an `act` scope opened during teardown interleaves with
  the next file's mount. The warning stays; the measurement is in the docblock at
  the call site. Right about the mechanism, wrong about the content — the real fix
  is process-per-file isolation, not a wrapper there.
- **A stale comment.** The web light-theme block said it used Apple's `#007AFF`; the
  code has never used it here (`#1064cc`), and `#007AFF` would fail AA under white
  ink at 4.02.

### A pre-existing red this lane neither caused nor fixed

`channels/__tests__/button-store.test.ts` ("two rows minted in the SAME ms resolve to
the LAST-inserted row") times out at 5000ms. Reproduced identically on `origin/main`,
on this branch's round-1 commit, and on its HEAD — 38 pass / 1 fail at all three — so
it is not this work's and not a flake. This branch touches only `app/`, `landing/` and
`docs/`, so `channels` is outside its lane; flagged rather than fixed. It is a
TIMEOUT, so it may be machine-speed-dependent.

### How the test signal was actually established

Worth writing down because the obvious method is wrong here: `bun test app/__tests__`
in ONE process reports ~200 failures on an untouched tree. Several app tests install
process-global `mock.module('react-native', …)` fakes and the device harness registers
a happy-dom for the whole process, so a single-process directory run measures
interference rather than correctness — which is exactly why `scripts/run-tests.sh`
chunks and why the device-harness lane exists. Every claim here rests on that runner,
or on running an identical file set at the baseline commit and diffing the counts.

### Still not covered

`attention` in light is unchanged and still the one documented exemption — it needs
the owner's ruling, not a unilateral fix.

**Nothing here has been seen on a device.** The harness renders react-native-web, so
it cannot see native layout. Every visual claim is UNVERIFIED until it runs on a
phone; the contrast numbers are arithmetic over the palettes and are as good as
arithmetic gets, which is not the same as "looks right".

## Round 3 (2026-08-11) — the type base was never applying, and a hook that was not named like one

Four review findings, and the first one matters most because every test in this change
said it was fine.

### THE 17px TYPE BASE WAS DEAD CSS

`landing/chat-react.html` — the comment above the rem base was TERMINATED
mid-paragraph, and the remaining five lines of prose ran on to a second terminator. A
browser reads that trailing prose as a selector prelude, fails to parse it, and CSS
error recovery discards the NEXT rule — which was `html { font-size: 106.25%; }`. The
root stayed at 16px, every `rem` on the page resolved against it, and the headline of
this whole change (Telegram sits at ~17, we were at 15) shipped as a no-op.

`type-scale.test.ts` was green throughout, because it read the raw file with
`readFileSync` and matched the declaration as a string. **Matching a declaration in a
file is not evidence the declaration takes effect.** The fix is one character; the
guard is the part worth keeping:

- the test now strips comments the way a CSS parser does — first opener to the NEXT
  closer, never nesting — and every web assertion reads the STRIPPED sheet, so a rule
  sitting in dead territory is no longer visible to the test either;
- `has NO stray comment terminator, so no rule is silently discarded` fails on any
  closer surviving into the parsed output, and on unbalanced delimiters either way;
- a positive control asserts the stripper can actually see a comment, so neither
  assertion can pass by returning nothing.

Mutation-tested: re-inserting the early terminator turns that test red with the
offending span quoted in the failure message.

### A hook that was not named like one, so the rule could not check it

`app/lib/theme-context.tsx` — `themeRead()` called `useContext`, which
`react-hooks/rules-of-hooks` flags as an error, and app lint was red. Renamed to
`useThemeRead()`, the one-line `themeState()` indirection collapsed into it, and the
two `eslint-disable` comments are GONE rather than moved — one was already unused, and
the other is no longer needed because of the next item. `eslint lib/theme-context.tsx`
now reports zero errors.

### The sheet cache moved to module scope

`useThemedStyles` memoised with `useMemo`, which is per COMPONENT INSTANCE: every
rendered `ChatRow`, `TaskRow` and rail row re-ran `StyleSheet.create` and retained its
own copy of an identical sheet. A long list paid the build once per ROW, the opposite
of what the module docblock claimed. It is now a `WeakMap<factory, WeakMap<palette,
sheet>>` at module scope — at most two sheets per factory for the life of the process,
shared by every instance.

That also REMOVED the conditional-hook problem rather than suppressing it: the cache is
a pure function of `(factory, palette)`, correct with or without a live React
dispatcher, so `useThemedStyles` now calls exactly one hook unconditionally and needs
no rules-of-hooks exemption at all.

### The remove-attachment glyph was invisible in light mode

`app/components/InputComposer.tsx` — the dismiss chip paints `theme.veil` (a dark
scrim, deliberately dark in BOTH palettes because it sits over an image thumbnail) and
inked its glyph with `theme.text_primary`, which is near-black in light mode: 2.01:1 on
that composite. `lib/button-primitives.tsx` next door already used `veil_ink`.
Switched.

`contrast.test.ts` had asserted the TOKEN-level fact — `veil_ink` clears AA on the
veil-over-white composite and `text_primary` does not — and both files were free to
ignore it. `no-captured-palette.test.ts` now carries the SITE-level half: a veil is
only ever painted in order to carry ink, so the set of files painting `theme.veil` and
the set drawing `theme.veil_ink` must be the same set. Mutation-tested — reverting the
one line names both files in the failure. A prefix-matching variant was written first
and deleted: it could not have caught this defect (the ink lived in a sibling style,
not inside the veil block), and a guard that cannot fail on the bug it was written for
is worse than none.

### The pre-paint probe no longer leaks a promise

`readStoredPreferenceSync` has to CALL `getItem` to discover whether the backing
answers synchronously. On native that returns a Promise it discarded — and an unhandled
rejection is a hard crash on React Native's default handler, so a broken AsyncStorage
would have taken the app down at boot through the very probe that exists to avoid a
wrong-coloured frame. It now attaches a no-op handler to both arms. The VALUE is still
ignored; the async read below is still the one whose answer is used.

### Test signal

`scripts/ci/lint.sh` and `scripts/ci/typecheck-all.sh` pass. The three touched app test
files run green (217 assertions). The flat-`bun test` caveat recorded in round 2 still
holds and was re-confirmed rather than assumed: 211 failures at this branch's HEAD and
211 identical failures with these changes applied — same test names, empty diff. A
directory run measures process-global interference, not correctness, which is why
`scripts/run-tests.sh` chunks. Real CI on the PR is green across all thirteen checks.

### Not addressed here

One of the three review lanes (the rubric runtime) produced no verdict at all — an
empty output file, not a passing one. That is a gap in review COVERAGE rather than a
defect in the change, and it is not something this lane can close from inside the
worktree; it needs re-running or substituting before merge.

**Still nothing seen on a device.**
