## Issue 1129 / PR 1141 — reuse the review full-suite receipt

### Change and evidence

The project host retains the latest independently acquired review receipt, copying it so later reader mutations cannot rewrite its evidence (`trident/project-build-host.ts:106`). Terminal assessment reuses that receipt only with a configured publication source, matching full-suite scopes, identical strategies and the same head (`trident/project-build-host.ts:121`). Otherwise it calls the existing publication assessment (`trident/project-build-host.ts:126`). The live command reader and fixture wiring were left as supplied.

Identity is checked when the project source acquires the receipt (`trident/project-observation-sources.ts:78`) and again by `assessReviewSuite` using its original run, head and round (`trident/project-build-host.ts:124`, `trident/gates/review-suite.ts:37`). The receipt is never relabeled as a terminal measurement. A new observation first clears the previous receipt, including when acquisition becomes unknown (`trident/project-build-host.ts:107`). These are host mechanisms and do not depend on a worker to invalidate stale evidence.

This joins the existing `SuiteAssessment` vocabulary without adding an outcome. Unknown evidence remains unknown, successful evidence is known, and nonzero exits retain the existing blocker/advisory classification (`trident/gates/review-suite.ts:36`, `trident/gates/review-suite.ts:42`, `trident/gates/review-suite.ts:46`). The terminal driver still stops on unknown or non-advisory findings before merge (`trident/build-run.ts:604`). In particular, reusing a red receipt cannot turn it green (`trident/project-build-host.test.ts:392`).

### Decisions

Reuse belongs in the project composition because that boundary knows both configured strategies (`trident/project-build-host.ts:85`). The generic host assessment still owns the original publication source. The project composition replaces its terminal callback with the reuse decision (`trident/project-build-host.ts:115`); the driver calls those same dependencies (`trident/build-host.ts:247`). Receipts are local to this host instance; reconstruction obtains fresh evidence through the existing source.

No product decision changed. The original branch record describes the initial separate-source implementation; this shard records the follow-up reuse correction. The issue's review configuration citation moved to `open/wiring/project-build.ts:426`; the protected invocation assertion is `open/__tests__/project-build-e2e.test.ts:803`. The identity comparison itself is now `trident/gates/review-suite.ts:37`.

### Tests and mutations

New cases are exhaustively enumerated by the scenario array at `trident/project-build-host.test.ts:351`: matching head, changed head, two subset rounds, different strategy, missing publication source, wrong run, wrong round, red suite, later subset, later unknown and publication subset. The two subset rounds use different heads before one terminal acquisition (`trident/project-build-host.test.ts:375`). Existing live wiring proves that the intermediate checkpoint does not launch the full suite and terminal acquisition launches it once (`open/__tests__/project-build-wiring.test.ts:147`).

Every mutation below was applied individually, its actual changed line printed, and restored. The restored host file passes all 29 tests; the unchanged e2e file passes all 34 tests.

| Guard | Mutation and actual line | Red evidence | Restored |
|---|---|---|---|
| Reuse eligible receipt | Force condition false, project-build-host.ts:121 | Single-round e2e expected length 1, received 2 | Green, unchanged assertion |
| Review full scope | Replace scope comparison with receipt existence, project-build-host.ts:121 | Subset/later-subset acquisition count | Green |
| Publication full scope | Replace comparison with true, project-build-host.ts:122 | Publication-subset acquisition count | Green |
| Same strategy | Replace equality with true, project-build-host.ts:122 | Different-strategy acquisition count | Green |
| Same head | Replace equality with true, project-build-host.ts:123 | Changed-head result becomes unknown instead of acquiring new evidence | Green |
| Required source | Allow absent configuration through condition, project-build-host.ts:121-122 | Missing-source expected unknown, received known | Green |
| Retain known receipt | Force known-receipt branch false, project-build-host.ts:109 | Same-head acquisition count | Green |
| Latest receipt only | Remove clear, project-build-host.ts:107 | Later-unknown acquisition count | Green |

### Verification and measured cost

Real `bun install` completed successfully. `readlink -f node_modules/@neutronai/trident` resolved to the build worktree's own package. Root `bunx tsc --noEmit -p tsconfig.json`, module `bunx tsc --noEmit -p trident/tsconfig.json`, and `bash scripts/ci/lint.sh` passed.

Consumer tests were enumerated by searching `createProjectBuildHost|projectBuildRunners` in the project and open test files, including the known direct caller in `trident/project-build-host.test.ts:64`, then adding the driver and suite classifier tests. Each file ran in its own Bun process:

- `trident/project-build-host.test.ts`: 29 passed.
- `trident/build-host.test.ts`: 54 passed.
- `trident/build-run.test.ts`: 185 passed.
- `trident/gates/review-suite.test.ts`: 7 passed.
- `trident/project-launcher.test.ts`: 7 passed.
- `open/__tests__/open-trident-prod-boot-wiring.test.ts`: 8 passed.
- `open/__tests__/project-build-e2e.test.ts`: 34 passed.
- `open/__tests__/project-build-wiring.test.ts`: 28 passed, 1 failed during local port reservation at `tests/support/test-isolation.ts:161`, invoked at `open/__tests__/project-build-wiring.test.ts:857`. The same isolated case fails at that bind. The intermediate/full-suite case also ran separately and passed. No test was weakened or skipped to claim a green whole-file result.

Before this correction, the e2e file took 36.87 seconds with the duplicate-invocation failure; after, it took 35.93 seconds with all cases passing. These are controlled fixture times, not production full-suite timings. The cost result is two named suite invocations reduced to one on the same head (`open/__tests__/project-build-e2e.test.ts:801`).

### Deliberately not done

No full repository test run, real production-suite benchmark, network operation, PR creation, push or merge. The required publication source, existing fixture wiring, e2e assertion and product spec decisions remain as supplied. The local-port fixture failure is reported rather than repaired as part of this receipt-reuse change.
