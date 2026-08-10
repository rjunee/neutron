# The usage readings are remembered, and turned into a pace

## What was missing

`open/credential-usage-monitor.ts` has always probed the active credential every 60
seconds, cached **one** reading, and aged it out after five minutes. So the product
measured utilisation continuously and remembered nothing: the meter could say a window
was 72% full and could not say whether that was climbing fast or flat, what was left an
hour ago, or when it last hit the ceiling.

**"Which pool can take this build?" is a question about a trend**, and a single
instantaneous number cannot answer it. That is why the dashboard needed a migration
before it needed a chart — PR1 of `docs/plans/2026-08-09-model-usage-dashboard.md`.

## What landed

Migration `0119` + `persistence/usage-samples-store.ts` + a fail-soft `onSample` hook on
the monitor, wired in the composer alongside the existing `onStanding` observer. The
prune rides on the same call rather than a separate schedule: a cleanup job that can fall
out of step with its writer eventually either grows forever or deletes something in use.

**Pace is the point.** `fraction consumed ÷ fraction of the window elapsed` — above 1
means burning faster than the window refills, and that single number is what turns "72%"
into a decision. It is computed at read time, never stored: a stored derivative goes
stale the moment the formula improves, and this formula will.

## Two things the tests found that reading did not

**The exhaustion projection was wrong.** My first draft divided by pace *twice* —
arithmetically incorrect and entirely plausible-looking, which would have projected
exhaustion far too early on every fast window. It is now derived in the comment and
pinned by a hand-checkable case: 5h window, half elapsed, 75% used → pace 1.5, and the
remaining 25% at 1.5× takes **50 minutes**. Small enough to verify on paper, which is
the point of choosing it.

**A guard I wrote was mathematically unreachable.** I had an `at < reset_at` check for
"the projection lands after the reset, so don't cry wolf". A mutation pass showed
removing it changed nothing, and the derivation says why: `pace > 1` implies
fraction > elapsed, and the projected time to burn the remainder is then *always*
shorter than the time left. **A dead branch dressed as safety is worse than none** — it
cannot be tested, so it reads as protection that has never been exercised. Removed, with
the proof written down, and the test rewritten as a property over a grid (with a
positive control, since a property test over an empty grid asserts nothing).

## What it deliberately does not claim

`account_label` exists and is **always null today**. The rotation happens *outside* this
process — a credential file is replaced underneath a running child — so the instance
genuinely cannot name the account behind a reading. The column is there so the history
gains the dimension without a migration if the rotator ever writes a label; until then
the card says "active credential". **An inferred account name shown as a measurement
would be worse than no name at all.**

A sample with nothing measurable in it is not written: all-null rows would make "no
data" indistinguishable from "we measured nothing", which are different facts. And a
failed or unauthorized probe writes nothing, because it learned nothing about
utilisation — a gap is not a zero.

## Verification

`persistence/usage-samples-store.test.ts` (20) — mostly about the **refusals**, since a
plausible number out of one sample is easy and hard to eyeball once rendered: a
barely-started window, an unknown reset time, a NaN, a full window.
`open/__tests__/usage-sample-persistence.test.ts` (4) — the wiring.

**Six mutants, five caught immediately; the sixth is what exposed the dead branch.**
The wrong arithmetic · no floor on a barely-started window · all-null rows entering the
series · the monitor never calling the sink · the composer never pruning.

**The test split is an architectural point, not housekeeping.** The wiring tests began
in `persistence/` importing the monitor; the lint rule refused, and it was right —
`open` depends on `persistence` and never the reverse. Same signal as the parity test in
#164: the resolve failure was telling me the dependency direction.

The table is enrolled in `table-ownership.json` on creation rather than retrofitted — it
has exactly one writer, and enrolling it now is what keeps that true.

Typecheck 51/51 · lint clean · byte-scanned · migration snapshot regenerated and the
runner's list extended to 119.

## Still to come

No endpoint and no card yet — this is the store. `GET /api/app/usage/dashboard` and the
web card are the next PR, and they now have a series to read rather than a single
five-minute-old number.
