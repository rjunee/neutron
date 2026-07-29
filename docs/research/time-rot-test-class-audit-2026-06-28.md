# Time-rot test-class audit — 2026-06-28

**Trigger.** #90's CI surfaced a silent *time-rot* defect: `reflection/index.ts`'s
`readDiary` defaulted its day-file read window to the real `Date.now()` while
`appendDiary` honored the injected `now`. A test pinned to `now: 2026-06-21`
passed only while wall-clock stayed within the 7-day read window; once wall-clock
crossed 2026-06-28 the window no longer covered the written day-file, the read
returned empty, and **all Open PRs were blocked**. Fixed in #90 (commit
`939c057`) by threading the injected clock into `readDiary`.

This audit hunts the *same class* across the suite, per CLAUDE.md: *time-dependent
tests MUST use `Date.now()`-relative timestamps, never hardcoded ISO strings.*

## The bug class, precisely

- **ROT-PRONE** — the code-under-test computes a window / recency / "is it time to
  run" decision relative to the **real** `Date.now()` / `new Date()`, while the
  test supplies a hardcoded date. As wall-clock advances the hardcoded date
  eventually falls out of the window and the test breaks — silently, in the
  future, with no code change.
- **SAFE** — the test injects a fixed clock AND the code-under-test honors that
  *same* injected clock on BOTH the write and the read/window path (internally
  consistent → never rots regardless of wall-clock), OR the hardcoded dates are
  not used in any real-`Date.now()`-relative window comparison at all (relative
  sort, fixed-constant comparison, formatting-only, or string-equality).

## Method

For each candidate the read path of the *production code-under-test* was traced
(not the test in isolation): identify every hardcoded 2026 date literal, follow
it into production, and determine whether the windowing/recency/decision logic
reads an **injected** clock (deps/params/options) or the **real global**
`Date.now()`/`new Date()`. Each test was also run to confirm current status.

## Result: all 11 candidates SAFE — #90 was the sole instance

No production code required changing. Every sibling already threads an injected
clock through both read and write (the correct post-#90 pattern), or compares
against fixed constants / relative ordering rather than a wall-clock window.

### 1. `tasks/__tests__/focus-score-cron.test.ts` — SAFE
Injected `now: () => nowMs` (`Date.parse('2026-05-20')`) flows into
`recomputeFocusScoresForProject`. Urgency/staleness math in
`tasks/focus-score.ts:93` (`daysLeft = (dueMs - nowMs)/DAY_MS`) and `:107`
(`daysStale = (nowMs - updatedMs)/DAY_MS`) both read `nowMs = input.now.getTime()`
(`:86`) — the injected clock, threaded at `focus-score-cron.ts:77,103`. The key
assertion compares the stored score against `computeFocusScore({..., now:
new Date(nowMs)})`; both sides use the identical injected `nowMs`. Internally
consistent. **5 pass.**

### 2. `onboarding/synthesis/__tests__/synthesis-session.test.ts` — SAFE
`created_at` of `2026-05-01`/`2026-05-10` feeds only `prepass.ts:117,135-137`,
a relative recency *sort* (`recencyKey(b) - recencyKey(a)`, `recencyKey =
created_at ?? 0`) with no cutoff/window, and `synthesis-session.ts:365` (date →
label string, formatting only). The only absolute-time logic is duration timeouts
(`idle_timeout_ms`/`timeout_ms`), which measure elapsed deltas, never the calendar
dates. No real-`Date.now()` window. **23 pass.**

### 3. `onboarding/overnight/dispatcher.test.ts` — SAFE
`dispatcher.ts:247` `const nowMs = this.deps.now()`; window helpers `localParts`
(`:90` `new Date(nowMs)`), `inOvernightWindow` (`:103`), `currentWindowDate`
(`:124`) all take `nowMs` as a param. Test injects `now: () => now` and
`now: () => REPORTER_TIME`; `WINDOW_DATE` is derived from `INSIDE_WINDOW` by the
same production logic. Writes use the same injected clock (`:299,373,389,443`).
The only bare `new Date()` (`queue-store.ts:128`) is a default `created_at`
writer, never in a window compare. **11 pass.**

### 4. `onboarding/overnight/morning-brief.test.ts` — SAFE
`morning-brief.ts:145` `windowDate = deps.window_date ?? currentWindowDate(
deps.now(), tz)`; `dispatcher.ts:90` `new Date(nowMs)` wraps the *passed*
timestamp (injected `REPORTER_TIME`), not the global clock. Selection
(`morning-brief.ts:67-72`) is a string-equality on `window_date_local`. No
`Date.now()` / bare `new Date()` in the read path. **7 pass.**

### 5. `cores/free/calendar/__tests__/pre-meeting-brief-scheduler.test.ts` — SAFE
Two seams, both injected. `pre-meeting-brief-scheduler.ts:120` `now = opts.now ??
(() => Date.now())` (fallback never reached). Window walk
(`:272,305-309` `range_start_ms: t, range_end_ms: t + lookahead_ms`), past/skip
(`:314-322` `startMs <= t`), fire delay (`:202` `fire_at_ms - input.now_ms`), and
boot re-arm (`:216,220`) all read the injected `t = now()`. Test injects a fake
clock + `scheduleTimer`. **11 pass.**

### 6. `cores/free/email/__tests__/triage-scheduler.test.ts` — SAFE
`tick(now: Date)` receives the hardcoded dates directly; `isFireTime(now, tz)`
(`triage-scheduler.ts:112-116`) and `ymdKey(now, tz)` (`:118-121`) consume that
same `now`. The window is matched against fixed `dailyHour`/`dailyMinute` (8/0)
**constants**, not a wall-clock-relative window — so advancing real time can never
push a hardcoded date out of window. `start()`'s self-tick uses `opts.now`
(`:107`), injected by every test. Idempotency is an in-memory `Map` keyed by the
`now`-derived ymd. **5 pass.**

### 7. `gateway/__tests__/app-focus-surface.test.ts` — SAFE
`FROZEN_NOW` injected via `now: () => now`. `app-focus-surface.ts:158`
`now = opts.now ?? (() => Date.now())`; `:204` `nowMs = now()`; `:257-260` every
horizon (`horizonMs = nowMs + TODAY_WINDOW_MS`, `horizonS = nowS +
REMINDER_TODAY_WINDOW_S`) derived from `nowMs`; comparisons `:293,310-314,422-426`
(`bucketFor(due_ms, nowMs)`) all use the threaded clock. All task/reminder dates
are `FROZEN_NOW`-relative offsets. **20 pass.**

### 8. `gateway/__tests__/calendar-core-production-composer.test.ts` — SAFE
Injected `now: () => new Date('2026-05-21T17:00:00Z')`. `calendar-wiring.ts:87`
`now = deps.now ?? (() => new Date())`; `:99` `parseCalCommand(trimmed, now())`;
`:106` `now: now()`. Window computed in `chat-commands.ts:153-198` (`parseShow`)
purely from its `now` arg; `executeShow`/`executeNext` (`:442-548`) read
`ctx.now`. No `Date.now()`/`new Date()` in `chat-commands.ts`. (The fake Google
`events.list` stub also ignores `timeMin`/`timeMax`.) **12 pass.**

### 9. `gateway/cores/__tests__/mount-cores-scribe-fan-out.test.ts` — SAFE
`t0 = Date.parse('2026-06-15T08:00:00Z')` injected into scribe `now`, budget
state, `fired_at`, mount `nowMs`, and `tick(new Date(t0))`. Fire-window:
`triage-scheduler.ts:164` reads the passed `now`; mount sets `nowFn = () =>
new Date(input.nowMs!())` (`mount-cores-scribe-fan-out.ts:223`). Email watermark
dedup (`email-managed-wiring.ts:184-192`) compares `internal_date` against a
*stored* mark (starts at 0), not wall-clock. Scribe writes (`scribe/index.ts:190,
238,240`) all use injected `now`. **6 pass.**

### 10. `reflection/__tests__/diary-store.test.ts` — SAFE
The store's read window *does* default to real `Date.now()`
(`reflection/diary-store.ts:149` `now = input.now ?? Date.now()`, window built at
`:153-155`) — the bug-class surface. **But the test is internally consistent:**
every data-bearing read passes `now` aligned to the `observed_at` it wrote
(lines `25,50,60,70,83,99`). The single read without `now` (`:92`) targets a
fresh tmp dir with no `diary/` subdir, hitting the empty-dir guard
(`diary-store.ts:146` `existsSync(dir) === false → return []`) — clock-independent.
The store defaulting to `Date.now()` is by design; the *caller* (reflection
index) is responsible for passing `now`, which #90 fixed. **8 pass.**

### 11. `reflection/__tests__/index.test.ts` — SAFE (fixed by #90)
`reflection/index.ts:169` threads `now: now()` into `readRecentDiary` (the #90
fix; `now` = `deps.now ?? (() => Date.now())`). Write (`appendDiary`, `:158`) and
read both use the same injected clock. **Now hardened further** — see below.

## Proactive guard added (only code change in this PR)

`reflection/__tests__/index.test.ts` gains an **always-on** regression guard:

```ts
test('readDiary honors the injected clock even far from wall-clock (no Date.now() read-window rot)', () => {
  const farPast = () => Date.parse('2020-06-21T08:00:00.000Z')
  const r = createReflection({ ownerDataDir: tmp, now: farPast })
  r.appendDiary({ text: 'Journaled under a clock years before wall-clock.' })
  const back = r.readDiary()
  expect(back).toHaveLength(1)
})
```

The injected clock is set *years* before wall-clock (2020), so the written
day-file (`2020-06-21.md`) is always outside the default 7-day window computed
from real `Date.now()` — regardless of which wall-clock the suite runs on. The
entry is found **only if** `readDiary` honors the injected clock. This converts
the original latent failure (which only manifested once wall-clock drifted past a
hardcoded date) into an **always-on** guard: it fails the instant `readDiary`
regresses to `Date.now()`.

**Verified with teeth.** Temporarily reverting the #90 fix (removing
`now: now()` from `readDiary`) flips this guard — and the existing round-trip /
correction-breadcrumb tests — red (3 fail). Restoring the fix returns the file to
**6 pass / 0 fail**.

## Takeaway

The time-rot class is clean in Open as of 2026-06-28. The correct, consistently
applied pattern is: **thread one injected clock through both the write and the
read/window path** (the post-#90 shape). The new guard locks that invariant for
the reflection diary — the proven failure surface — so a future regression fails
immediately rather than silently rotting into a merge-blocker.
