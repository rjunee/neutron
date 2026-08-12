# A review panel cannot see a red build — so now something else does

## The gap

Four reviewers read the **diff**. None of them runs the tests. So a change that
type-errors, fails a lint gate or reds a shard could be **unanimously APPROVED** — and
on a repo without branch protection, merged.

The reference deployment never showed this because a GitHub setting blocks a red merge
there. That is the problem, not the reassurance: **the discipline lived in repository
configuration rather than in the harness, so every self-hoster and every local-merge
run had nothing at all.** The predecessor harness has had a CI gate for months; Open had none.

## The design

**Deterministic, never interpreted.** The agent is handed one command and asked to
report its output *verbatim*; every judgement happens in JS. A model asked "is CI
green?" can answer yes for a plausible-looking wall of text, and a hallucinated green
merges a broken build — the one failure this gate exists to prevent.

**One gate, peers as data** — the file's own stated rule. Rather than adding a second
near-identical gate (which is how one of the two quietly stops being enforced):

- **red** → the failing checks become **code blocker findings** and force
  `REQUEST_CHANGES`, so the fix loop re-Forges against them. There is something to
  change, and the next round should change it.
- **pending / unreadable** → a **deferred peer** on the existing `deferredPeers` list,
  so `enforceCrossModelGate` refuses to APPROVE and `classifyBlock` returns
  `infra-only`, which exits the loop rather than editing code to "fix" a timer.
- **green / none** → nothing at all.

`none` is deliberately distinct from `green`: a repo with no checks has nothing to wait
for, and blocking it would deadlock every self-hoster who hasn't set CI up. Local mode
short-circuits before spending an agent, because a local build has no PR and never will.

## The hole this nearly shipped with

Attaching CI findings was not enough. **`enforceCrossModelGate` returns the synthesis
untouched when there are no deferred peers** — so a red build with no other problems
would have produced an `APPROVE` carrying a "CI FAILING" finding, and merged. Red CI now
sets the verdict explicitly, and that is asserted rather than left to reading.

A second near-miss: an unreadable reply with exit 0 originally classified as `none`.
That is the unsafe direction — a reply we cannot parse would produce no gate at all.
`gh` prints `[]` for a repo with no checks, so the genuine case is already covered;
anything unparseable is now always `unknown`. **My own test caught this, not my reading
of the code.**

## Verification

`trident/__tests__/ci-gate.test.ts` — 22 tests against the **real functions extracted
from the `.mjs` and evaluated**, the same technique the cross-model gate tests use and
for the same reason: a hand-copied duplicate is a test that cannot fail for the reason
it claims to check. The extractor has its own guard, loaded *inside* a test, because a
load failure at describe time deletes the tests instead of failing them.

**Five mutants, each caught — all of them fail-open:** red adding findings without
forcing the verdict · an unreadable reply reading as no-checks · pending beating red ·
an unusable answer never reaching the gate · the probe never being called.

Also covered: every terminal-failure state (not just `FAILURE` — a cancelled or
timed-out gate is red too), `SKIPPED`/`NEUTRAL` as non-failures, a non-zero exit with
parseable rows still trusting the rows (`gh` exits 8 for pending and 1 for failures, so
treating non-zero as an error would turn every red build into a deferral), and noise
around the JSON.

**The new agent label was caught by #157's own coverage test** and routed to the cheap
tier — the CI probe is the same shape as the head probe, and leaving it to the fallback
is exactly how head-probe silently sat on the most expensive tier for months.

## Two source-shape assertions moved, and that is worth naming

Adding a third parameter to `reviewAndSynthesize` broke two existing tests **whose
subject was untouched** — one pinning `enforceCrossModelGate(synthesisRaw, …)` by
variable name, one matching a call by its full argument list. Both now pin the
construct rather than its spelling. One of them had already been loosened once for the
same reason, which is the argument for doing it properly the second time.

Trident suite: 599 pass. Typecheck 51/51 · lint clean · byte-scanned.
