## Issue #1011 — retained refusal causes outside the earlier gate sweep

### What changed

Five previously constant-only refusal paths now append the caught value while retaining their original outcome kind: the review-panel infrastructure block at `trident/gates/review-panel.ts:124`; the review and re-plan blocks at `trident/build-run.ts:290-293`; trailer decoding at `runtime/workers/project-runners.ts:64-66`; and the diff-artifact and result-trailer reads at `runtime/workers/codex-headless.ts:78-80,158-161`.

The shared lower-layer helper logs the full caught value once with `run_id`, then appends at most `TERMINAL_CAUSE_MAX` characters to the persisted detail (`runtime/refusal-cause.ts:12-15`). The cap is 500 at `runtime/refusal-cause.ts:9`; Trident imports and re-exports that same binding at `trident/inner-loop.ts:72-79`, while the required gate helper path re-exports the function at `trident/gates/unknown-cause.ts:1`. Its test independently proves the persisted bound, full log text, run identity, and single emission (`trident/gates/unknown-cause.test.ts:5-19`).

The filed locations had moved: review panel is line 124 rather than 117; project trailer decoding is lines 64-66 rather than 62; the Codex diff catch is lines 78-80 rather than 73; and the Codex result-trailer catch is lines 158-161 rather than 152. The build-run catch remains at lines 290-293 after its new import shifted it by one.

### Decisions and existing outcome vocabularies

No conditions, ordering, or control-flow branches changed. The worker results remain in the existing `BoundedWorkOutcome` vocabulary, where `unknown` is distinct from completed, blocked, refused, and failed (`runtime/bounded-work.ts:96-109`). Review-panel and build-run results remain in the existing `GateResult` / `ReviewDecision` vocabulary (`trident/build-run.ts:34-40`). The build-run switch still maps each worker outcome to its prior disposition (`trident/build-run.ts:295-300`). Thus the default handling of every enriched value is unchanged; only its diagnostic string and journal event differ.

The continuously maintained invariant is centralized in `unknownCause`: every adopted catch must pass its run identifier and caught value, the helper always logs before returning, and its returned cause is always sliced to the shared 500-character limit (`runtime/refusal-cause.ts:12-15`). This mechanism executes in the refusing host and does not depend on the failed source recovering. Runtime sites import the lower-layer implementation, while Trident keeps the filed helper path as a re-export; the dependency gate confirms this introduces no upward runtime dependency.

The provider-review exception remains deliberately constant because its comment says exception text may expose credentials (`trident/api-review.ts:40-42`). The regression test now pins the exact deferred result and separately proves the thrown text is absent (`trident/__tests__/api-review.test.ts:85-95`).

### Enumeration and positive controls

The enumeration used `rg -n "catch" trident/gates --glob '*.ts'` to list every gate catch, then a multiline search for catches returning `unknown`, `blocked`, or `infrastructure` across all of `trident/`. The same enumeration positively found cause-carrying catches in `trident/gates/fix-lineage.ts:23-25` and `trident/gates/review-readiness.ts:101-103`, proving the search sees the good shape. It also found the newly changed review-panel catch at `trident/gates/review-panel.ts:124`.

Seven constant-only gate-layer catches remain in this checkout and were deliberately left outside this filed issue: `trident/gates/release-readiness.ts:38,88`, `trident/gates/review-ci.ts:38`, `trident/gates/review-artifact.ts:25`, `trident/gates/project-admission.ts:74`, `trident/gates/review-suite.ts:50`, and `trident/gates/build-claim.ts:37`. The review-seat retry catch is also unchanged because it explicitly preserves the prior observation (`trident/gates/review-panel.ts:56-64`). This checkout's `origin/main` lacks the filed prerequisite from #1009; a ref-backed positive control found `CONTRIBUTING.md` but not `trident/gates/unknown-cause.ts`, so this change supplies the helper required by the five scoped sites.

Normal, specific refusals remain byte-pinned. Codex missing/empty/repeated/malformed-field results are asserted exactly at `runtime/workers/codex-headless.test.ts:161-178,186-193`; project trailer schema and blocked-reason refusals are asserted at `runtime/workers/project-runners.test.ts:136-162`. These checks passed unchanged alongside the new thrown-source cases.

### Mutation table

| Guard | Compiling mutation | Red proof | Restored proof |
|---|---|---|---|
| Review-panel cause at `trident/gates/review-panel.ts:124` | Restored the former constant infrastructure detail | 1 focused test failed on missing `synthesis transport offline` | 1 passed |
| Review/re-plan causes at `trident/build-run.ts:291-292` | Restored both former constant block strings | 2 focused tests failed on missing reviewer and planner errors | 2 passed |
| Project decoder cause at `runtime/workers/project-runners.ts:65` | Restored the former constant unknown detail | 1 focused test failed on missing `validator process offline` | 1 passed |
| Codex diff cause at `runtime/workers/codex-headless.ts:79` | Restored the former constant unknown detail | Focused diff test failed on missing `ENOENT` | Passed in the 2-test restored run |
| Codex result-trailer cause at `runtime/workers/codex-headless.ts:159` | Restored the former constant unknown detail | Focused trailer test failed on missing `ENOENT` | Passed in the 2-test restored run |

Every mutant line was printed before its focused test. All mutations compiled and reached their throwing fixtures.

### Validation

The explicit six-file command passed 256 tests, 0 failures, and 950 assertions: `trident/gates/unknown-cause.test.ts`, `trident/gates/review-panel.test.ts`, `trident/build-run.test.ts`, `runtime/workers/project-runners.test.ts`, `runtime/workers/codex-headless.test.ts`, and `trident/__tests__/api-review.test.ts`. `bunx tsc -p trident/tsconfig.json --noEmit`, `bash scripts/ci/lint.sh`, and `bash scripts/ci/depcruise.sh` passed. The public-tree leak check found zero findings in the rules it could run but reported incomplete because the local PII denylist was unavailable. The full suite was not run, per the lane instruction.

### Deliberately not changed

The security-controlled provider-review catch was not given a cause. The seven gate-layer catches absent their prerequisite change were enumerated but not folded into this five-site issue. No outcome kind, refusal condition, retry, feature switch, alternate path, spec item, or `SPEC.md` decision changed. The forbidden orchestration and adapter paths were untouched.
