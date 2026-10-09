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

Independent review approved the five-file change. The full local check,
exact-head CI, deployment and a fresh unattended Work Board retry remain pending
at this stage. Focused test results
are not live autonomous acceptance; #1416 and the cutover acceptance stay open.
