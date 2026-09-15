## G019 — bound PR execution remains review-only

### Change and decision

Chose the retained-executor shape required by G019's keep-in-place disposition
(`docs/trident-gates-inventory.md:83`). `buildRun` now blocks `bound_pr` by name
before worker admission, measurement, or resume loading (`trident/build-run.ts:148`).
The composed host exposes `run`, routes this mode to `executeBoundReview`, and
returns its result directly (`trident/build-host.ts:119`, `trident/build-host.ts:126`).
Callers supply the retained run and dependency context through `boundReview`
(`trident/build-host.ts:20`); mismatched run IDs or PR numbers and missing context
block at `trident/build-host.ts:122`. Ordinary modes call the driver at
`trident/build-host.ts:128`.

This preserves the existing single review round (`trident/review-run.ts:499`) and
failure handling (`trident/review-run.ts:507`, `trident/review-run.ts:550`). It avoids
reimplementing the panel, worktree sealing, and cleanup contracts
(`trident/review-run.ts:496`, `trident/review-run.ts:552`). The old bound-PR-specific
build identity checks were replaced by the unconditional driver exclusion; fresh
build PR rejection remains at `trident/build-run.ts:175`.

### Outcome vocabulary and continuous enforcement

Named driver refusal and missing/mismatched review context use the existing
`BuildRunOutcome.kind = blocked`, whose recipient is the orchestrator
(`trident/build-run.ts:106`, `trident/build-run.ts:139`, `trident/build-host.ts:123`).
There is no new terminal cause to classify. The host preserves the retained
`BoundReviewOutcome` success/failure vocabulary (`trident/review-run.ts:80`),
including failure, instead of converting failure into a build retry
(`trident/build-host.ts:126`).

The host return and independent driver entry guard maintain the boundary on every
invocation (`trident/build-host.ts:126`, `trident/build-run.ts:148`), including
resume. Neither needs a failed reviewer to cooperate. The retained executor's
scratch database isolation prevents a panel result becoming a build result after
host interruption (`trident/review-run.ts:8`). This change does not wire the new
host entry point into the outer orchestrator; the lane explicitly excludes that
file. Direct driver callers receive the named block.

### Tests and mutation evidence

Positive case: the real retained executor runs one panel and returns success,
with zero build-worker or release effects (`trident/build-host.test.ts:516`). The
same test with a failed panel returns failure and zero effects. A separate control
runs the same build dependencies in PR mode and observes plan, build, review,
publish, merge (`trident/build-host.test.ts:525`). Thus unrelated gates cannot hide
the prohibited effects in the mutation fixtures.

Every mutation below was applied individually, its actual changed source line
printed, compiled and executed by Bun, then restored. Red means a wrong runtime
answer, not a compilation error. Filter names below are passed with `bun test -t`
to the indicated test file.

| Guard / source line | Mutation | Red test and observation | Restored |
| --- | --- | --- | --- |
| Driver boundary, `trident/build-run.ts:148` | Replace refusal with `/* G019 refusal removed for mutation proof. */` | `trident/build-run.test.ts:461`, filter `G019 driver`: 2 failures; merged instead of blocked | 2 pass |
| Failure return, `trident/build-host.ts:126` | Await retained result; on failure return `buildRun({ ...input, mode: 'pr' }, deps, signal)` | `trident/build-host.test.ts:516`, filter `G019 host retained review failure`: 1 failure at :520; actual effects are plan, build, review, publish, merge | 1 pass |
| Success return, `trident/build-host.ts:126` | Await review then return `buildRun({ ...input, mode: 'pr' }, deps, signal)` | `trident/build-host.test.ts:516`, filter `G019 host retained review success`: 1 failure at :520 with the same five effects | 1 pass |
| Mode routing, `trident/build-host.ts:120` | Change equality to inequality | `trident/build-host.test.ts:516`, filter `G019 host retained review`: 2 failures, panel count zero | 2 pass |
| Context guard, `trident/build-host.ts:122` | Invert both identity comparisons | Same retained-review filter: 2 failures, valid contexts blocked | 2 pass |
| Run identity, `trident/build-host.ts:122` | Remove run-ID mismatch clause | `trident/build-host.test.ts:533`, filter `G019 host rejects run`: 1 failure, mismatched context executes | 1 pass |
| PR identity, `trident/build-host.ts:122` | Remove PR mismatch clause | `trident/build-host.test.ts:533`, filter `G019 host rejects pr`: 1 failure, mismatched context executes | 1 pass |

Final bounded validation: `bun test trident/build-run.test.ts
trident/build-host.test.ts trident/gates/ trident/review-run.test.ts` — **171 pass,
0 fail, 727 assertions across 9 files**. This includes the existing terminal
head-resolution-failure certification (`trident/review-run.test.ts:492`).

`bun run typecheck` reports missing script; the scripts object is at
`package.json:57`. Direct local compiler checks of both `tsconfig.json` and
`trident/tsconfig.json` passed with `--noEmit`. `bash scripts/ci/lint.sh` passed.
`git diff --check` passed. No full test suite was run.

### Replaced tests and scope

The former test requiring bound PRs to build and merge asserted the policy G019
forbids. It was replaced with fresh/resume refusal tests
(`trident/build-run.test.ts:460`) and retained execution tests
(`trident/build-host.test.ts:516`). Bound build-stage identity scenarios were
replaced by host-context identity checks (`trident/build-host.test.ts:532`);
ordinary worker corroboration tests still cover Ralph and wave
(`trident/build-run.test.ts:473`). This is a policy correction, not a relaxed
approval assertion.

Searched the working tree with `rg -n` for the retired test title and the two
retired bound-identity/local-mode messages, alongside the positive-control string
`Fresh build already has a PR`; only the control matched
(`trident/build-run.ts:175`). This enumerates matching content in this checkout,
not remote tracked-file state. No network operation was attempted.

No product decision changed: G019 already supplies the contract. The retained
executor and outer orchestrator were deliberately not edited. No feature flag,
new review engine, or build fallback was introduced. Changed files are enumerated
by the staged Git diff: the driver, host, their two test files, and this record.
The lane's explicit as-built location overrides the general documentation path.
