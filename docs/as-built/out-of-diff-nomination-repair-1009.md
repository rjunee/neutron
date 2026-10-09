## 2026-10-09 — Recover an out-of-diff mutation nomination through bounded worker repair

A live build nominated an unchanged gateway file for mutation testing while
adding executable test-support code. The host correctly rejected that claim,
but stopped the run before review instead of requesting the correction already
available for missing nominations and invalid test commands. The built work
survived in unreviewed PR #1465; it did not complete autonomous acceptance.

`trident/mutation-prover.ts:4821` preserves the rejected, nonexempt result with
no mutation evidence. It adds the existing `invalid-nomination` repair signal
only if the measured diff contains a surviving legal executable target and a
second head observation still matches the original pin. The existing consumer
at `trident/build-host.ts:208` and bounded fix loop at
`trident/build-run.ts:1005` request a real corrected worker result. No mutation
proof, review, suite, publication or merge gate is waived. Unavailable evidence,
moved heads, configuration-only and deletion-only changes do not gain repair
authority. Declared-test/prose exemptions retain their existing semantics.

The consuming tests cover fresh PR and local delivery, retained unchanged-tip
retry at task iteration two, repeated findings and exhausted rounds. They check
that the original build artifact survives, planning/build are not replayed,
task spend is preserved, and blocked repairs do not fabricate a review. A fixture
can nominate an unchanged file separately from its actual source change, so the
test reaches the same refusal as the live build.

Measured focused evidence:

- Before the production change, the two new unit checks and the two fresh
  consuming cases failed at the missing repair signal or blocked outcome.
- `bun test trident/mutation-prover.test.ts`: 234 passed, zero failed, 1,579
  assertions.
- `bun test open/__tests__/project-build-e2e.test.ts -t 'nomination gets one bounded fix|unchanged-tip retry consumes prior'`:
  20 passed, zero failed, 324 assertions.
- Removing the repair signal makes the PR consuming case stop at publication;
  the existing malformed-command repair sibling still merges. Granting repair
  for every diff fails the configuration refusal control. Removing the head
  recheck fails the moved-head refusal control. Both unit mutations retain the
  legitimate executable-target sibling. All three mutations were restored.

The initial canonical check on `c1ee5cb0980f84a2418bf13ae6fb009336e4cf9c`
passed lint but failed the Open and root TypeScript configurations: the new
fixture assigned `undefined` to an optional property under
`exactOptionalPropertyTypes`. The other 49 configurations passed; the complete
suite was not started. Both resets now delete the optional property. The failed
receipt remains failed.

The corrected candidate, `ed524131e69f052ca0dfd9433f15885fee294259`, completed
`bash scripts/check-shared-host.sh` with the canonical jobs=4/chunk-size=100
profile. Lint and all 51 TypeScript configurations passed. The coverage audit
recorded all 1,800 discovered files executed: 1,557 general, 22 database, 43
device and 178 HTTP files. Summing the final batch summaries gives 28,012 passed,
24 skipped and one failed. The sole failure is the previously recorded #1457
`EBADF`/`epoll_ctl` at
`runtime/adapters/codex-cli/persistent/project-owner-retirement.test.ts:12`,
while accessing `child.exited`; its cause remains unproved. The complete local
gate exited 1 and remains **FAIL**. Its measured suite input identity stayed
`6a6eabae249cceba50c684698f0c9c3923d9eba253adedf9dcfbc217a760ea95`.

All 603 project-build consuming cases passed within that full run, including
the five new fresh/retry nomination cases. The database and device lanes passed
504 and 434 cases respectively. `bash scripts/ci/depcruise.sh` reported no new
violations (eight known violations ignored). The full local privacy scan exited
1 with 452 findings, including the untracked worktree metadata pointer; none of
the five changed files is named in its report. This is not a clean privacy
receipt, and exact-head CI remains required.

Independent native and bounded cross-model reviews approved the initial code.
Non-blocking review notes are tracked in #1467. The corrected 20-case consuming
matrix also passed separately with 324 assertions. Only this validation record
changed after the corrected complete local check. Final-head review, CI,
deployment and a fresh unattended Work Board retry remain pending at this stage.
These results are not live autonomous acceptance; #1416 and cutover acceptance
stay open.
