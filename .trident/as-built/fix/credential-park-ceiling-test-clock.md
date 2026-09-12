## 2026-09-12 — a six-hour bound red by one millisecond, and the clock was read twice

`runtime/credential-pool.test.ts`'s `the ceiling is anchored to when the park
BEGAN` failed on CI with `Expected: <= 21600000 / Received: 21600001` — one
millisecond over six hours, on a branch that touches no credential code.

**The ceiling was never wrong.** The test read the clock twice and subtracted.
`t0 = Date.now()` in the test; then `reportFailure` reads `Date.now()` itself and
stores it as `cooldown_started_at`; and the product derives the bound from that
anchor (`credential-pool.ts:334`, `c.cooldown_started_at + MAX_PARK_MS`). When a
millisecond boundary falls between the two reads, `first - t0` is exactly
`MAX_PARK_MS + 1`. The assertion compared a ceiling to an instant that was not
the one it was anchored to.

**Reproduced rather than called flaky.** Under a preloaded clock whose every read
advances 1 ms the case fails deterministically — 28 pass / 1 fail, `Received:
21600002`, two reads having ticked. After the fix it is 29 / 0 under that
adversarial clock and 29 / 0 under the real one. "Intermittent" is a statement
about how often a race is lost, not about whether it exists, and a race that can
be forced is a race that can be proven.

**The fix was already in the file.** The SECOND half of this same case pins
`Date.now` while it simulates a report five hours into the park. Only the first
half read the clock live. So the technique needed no invention — the case had
half-adopted it, and the unpinned half is the one that flaked. Worth naming
because it is the cheap tell: when one half of a test controls a dependency and
the other half reads it, the reading half is where the intermittency lives.

**One assertion was ADDED, none relaxed.** `toBeLessThanOrEqual(MAX_PARK_MS)` is
unchanged, and `toBe(MAX_PARK_MS)` now sits beside it. Pinning a clock can make a
bound pass for the wrong reason — a `reportFailure` that parked nothing at all
also satisfies `<= MAX_PARK_MS` — so the exact-value assertion is what keeps the
fix from being a way to make the test stop looking.

**Mutation.** Reverting the product to the original defect (`const ceiling =
Date.now() + MAX_PARK_MS`) reds this case *and* its standing-park sibling — 27
pass / 2 fail. The guard the case exists for is intact; only the timing race is
gone.

Fixed on its own branch rather than inside the PR whose CI it happened to red,
because it reds any branch at random and belongs to none of them.
