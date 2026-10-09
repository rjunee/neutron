## 2026-10-09 — Recognize a repaired host suite during review progress

The fresh sequence behind #1479 passed its second host suite and exact-head CI,
but stopped after review because its earlier failed suite had no individual
failure identity. The recorded blocker count fell from eight to three. G072
still treated the old unidentified host failure as unresolved, even though the
remaining findings came from the new code review. This did not establish a
successful sequence or authorize merging its candidate.

`trident/gates/review-suite.ts:66` now distinguishes affirmative full-suite
exit-zero evidence from an empty assessment. The existing run, head and round
checks precede that evidence. No strategy, a deferred subset, a passing subset,
unreadable evidence and advisory red do not acquire it. The consuming driver at
`trident/build-run.ts:1179` supplies it to progress only with a clear CI assessment.
`trident/gates/review-progress.ts:36` can then resolve the prior unknown host
failure while distinct, decreasing code findings still need a repair. Repeated
findings, nondecreasing counts and current unknown failures retain their existing
vetoes. Recorded baselines, budgets, publication gates and historical runs are
unchanged. The current gate inventory and review-loop acceptance describe this
evidence requirement; earlier as-built records remain immutable.

Before implementation, both new gate regressions failed and the real prepared
build reproduced the same G072 refusal. The corrected consuming fixture executes
an actual generic shell failure followed by passing commands after its first
fix, then completes the remaining code repair, review and merge. It dispatches
one planner, one builder and two fixes. Removing the full-pass evidence at the
host boundary refuses the second fix. Two existing still-red siblings also
refuse. All four consuming cases pass, with 21 assertions.

Focused gate, suite, receipt and driver coverage passes 475 tests. Host composition
passes 56 cases; its exact-result assertions now distinguish full and subset
success. Two semantic mutants fail their opposing tests: treating subset success
as full-suite proof, and letting the consumer proceed without that proof. Original
source bytes were restored. The Trident typecheck and CI lint pass. The ten
changed/new files and an unchanged tracked control pass the configured privacy
gate; this scoped scan does not replace full-tree CI purity.

The combined `bash scripts/check-shared-host.sh` ran at source
`3de9db95cb1ac10be5b16c36aef14f44b0d24d7a` from 20:27:16 through 21:01:03 UTC.
Lint and all 51 TypeScript projects passed; all 1,806 discovered files executed.
Eighteen of 19 lanes passed. The only failure was the inventory citation guard:
the new G072 row omitted test-citation line numbers. Those citations are now
corrected to the actual enforcement and regression lines. The unchanged guard
passes both tests with 1,524 assertions. Only that documentation row and this
change's two new records changed after the full run; runtime code, test code and
runner configuration were not edited. This records a failed full run followed by its
affected guard passing, not a second full-suite pass. Exact publication-head CI
remains required before merge.

Source publication, deployment and a fresh unattended live sequence are pending.
These fixture results do not complete #1196 or the live acceptance goal.
