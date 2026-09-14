## 2026-09-14 — Diagnose lane survival failures (#739, unresolved)

### Built versus requested

This is diagnostic coverage, not a demonstrated fix for the reported CI death.
The original killer remains unknown. Do not close #739 on this commit.

The survival checks now identify the first and second sweep separately and retain
both reports (`trident/lane-processes-test.py:209`, `trident/lane-processes-test.py:212`).
The assertion collects the child's wait status before teardown can signal it,
including negative signal numbers (`trident/lane-processes-test.py:102`).
A diagnostic test distinguishes normal exit 0 from SIGKILL -9 and checks that
phase and report evidence reach the failure (`trident/lane-processes-test.py:109`).

### Investigation, in issue order

1. The filed line 171 was the second assertion, as verified before editing; it is
   now `trident/lane-processes-test.py:213`. A failing pidfd assertion establishes
   exit, not the sender or signal. Both reports and the status now distinguish
   the local sweep phases from an exit absent from their reap reports.
2. A deleted subdirectory has its own unlinked inode; that alone does not imply
   its parent root is absent. `trident/lane-processes.py:80` checks the cwd inode,
   then `trident/lane-processes.py:94` stats the root. The first sweep completes
   before this test removes the root (`trident/lane-processes-test.py:209`,
   `trident/lane-processes-test.py:211`). The later unrelated prefix is refused
   at `trident/lane-processes.py:85`. The local first sweep cannot race that later
   removal inside this test.
3. A real global sweep exists: the loop test supplies `spawnCapture` at
   `trident/worktree-reaper.test.ts:418`, starts the loop at
   `trident/worktree-reaper.test.ts:433`, and supplies zero repositories at
   `trident/worktree-reaper.test.ts:413`. The loop calls the Python sweep at
   `trident/worktree-reaper.ts:1951`; the command construction and execution at
   `trident/worktree-reaper.ts:1962` do not use the TypeScript proc-root seam.
   This can reach dead-claimed fixtures, but does not explain the reported
   unclaimed child's death. That fixture removes the claim at
   `trident/lane-processes-test.py:89` and now verifies its absence at
   `trident/lane-processes-test.py:208`.

Sweep-call search used:
`rg -n 'lane-processes|buildWorktreeReaperLoop|unexpected host command' --glob '*test*'`.
Its requested positive control is the fake host rejecting Python at
`gateway/composition/build-core-modules-trident-stranded-sweep.test.ts:105`;
its dispatch at `gateway/composition/build-core-modules-trident-stranded-sweep.test.ts:99`
executes only git for real. Another rejecting host is
`trident/stranded-salvage-realgit.test.ts:264`. Other hits include the Python
suite entry at `trident/lane-processes.test.ts:7`, the copied production wrapper
at `trident/codex-build.test.ts:641`, and a source assertion at
`open/__tests__/loop-inventory-open-composer.test.ts:251`. Wrapper completion
uses exact finished-claim cleanup (`trident/lane-processes.py:167`). This is an
enumeration of those textual entry points, not proof against arbitrary indirect
process killers or historical CI execution orders.

### Current shard enumeration

Ran the runner's plan-only mode with `NEUTRON_TEST_SHARD=7/8` and
`NEUTRON_TEST_PLAN_ONLY=1`; this mode emits the actual selected file list without
running tests (`scripts/run-tests.sh:548`). It selected 182 general files. The
100-file chunk size (`.github/workflows/ci.yml:436`) puts the process proof in
the second chunk of 82, using the slicing at `scripts/run-tests.sh:576`.

Searching the complete plan for
`codex-build|lane-processes|worktree-reaper|stranded|PLAN-ONLY` found the process
proof and fake composition test, but not the real loop test or Codex-build test.
The matching process proof is the positive control for this absence result.
Searching the 82 enumerated second-chunk files for
`lane-processes|buildWorktreeReaperLoop|buildCoreModules|unexpected host command|codex-build.sh`
found the process-proof launcher (`trident/lane-processes.test.ts:7`) and a
source read (`trident/__tests__/model-tiers.test.ts:35`). Searching the whole
test tree with the earlier pattern also finds the requested fake-host control.
Thus the identified real global-loop caller is not in the current shard 7 plan;
this does not establish the plans or execution history of the two older CI runs.

### Eligibility vocabulary and decisions

The existing `environment_claim` vocabulary remains unchanged: missing claim
returns None (`trident/lane-processes.py:69`), malformed claims raise and enter
`unknown` (`trident/lane-processes.py:73`, `trident/lane-processes.py:137`). An
unclaimed process defaults to repository-scoped removed-root proof
(`trident/lane-processes.py:125`); no configured repositories means no qualifying
prefix (`trident/lane-processes.py:83`). Finished-claim cleanup excludes it
(`trident/lane-processes.py:116`). The new control verifies both an unclaimed
removed-root survivor and a dead-claimed target in the same sweep
(`trident/lane-processes-test.py:127`). Its positive root check at
`trident/lane-processes-test.py:134` proves the fallback fixture is reachable.
This control passes on the baseline; it does not reproduce the filed failure.

No product decision, production guard, outcome, or invariant was added. The
existing independent gateway startup/periodic sweep remains the continuous
cleanup mechanism (`trident/worktree-reaper.ts:1944`), independent of the dead
owner. No tolerance, sleep, retry, feature flag, or skip was added. No speculative
eligibility exemption or source-of-truth spec change was made.

### Mutation evidence

Each mutation was printed at its landed line, run against the named test below,
and restored before rerunning that test. All mutated runs exited 1; all restored
runs exited 0. Production mutations were restricted by the existing fixture PID
listing (`trident/lane-processes-test.py:40`).

| Guard or diagnostic | Landed mutation | Red evidence | Restored |
| --- | --- | --- | --- |
| Existing root, `trident/lane-processes.py:94` | Replace stat with FileNotFoundError | `test_deleted_subdirectory_and_unrelated_repo_survive`: first sweep, status -9, PID in first report | Green |
| Unrelated prefix, `trident/lane-processes.py:86` | Replace continue with pass | Same test: second sweep, status -9, PID only in second report | Green |
| Unclaimed default, `trident/lane-processes.py:125` | Authorize when repos is empty | `test_global_sweep_reaps_dead_claim_but_preserves_unclaimed_removed_root`: unclaimed PID incorrectly reaped | Green |
| Survival assertion, `trident/lane-processes-test.py:107` | Assert False instead of exited | `test_survival_diagnostic_records_phase_and_wait_status`: expected failures not raised | Green |
| Wait evidence, `trident/lane-processes-test.py:106` | Replace status with None | Same diagnostic test: both expected statuses missing | Green |

### Validation

- Baseline joint run of `trident/lane-processes.test.ts` and
  `trident/worktree-reaper.test.ts`: 128 pass, zero failures.
- Modified Python test file: 20 pass, zero failures.
- Final `bun test trident/lane-processes.test.ts`: one wrapper passed, all 20
  Python cases passed.
- `bash scripts/ci/typecheck-all.sh`: all 51 configurations passed (the repository
  has no root typecheck script; this is its documented matrix command).
- `bash scripts/ci/lint.sh`: passed.
- `git diff --check` and the record's exactly-one-heading check: passed.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, INCOMPLETE. Zero findings from
  executed rules; private PII denylist rules could not run. This is not a clean
  leak-gate result. The full test suite was not run.
