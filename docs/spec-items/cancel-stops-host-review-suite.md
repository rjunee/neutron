---
title: Cancellation stops the run's host review suite
group: trident
status: open
priority: P0
cutover: true
issue: 1265
---

Work state: #1265. The locked harness pivot keeps the existing gates and repairs
the loop in place (`docs/plans/harness-orchestrator-pivot-2026-09-11.md:266-279`).
G063–G065 require host-observed suite evidence; interruption cannot stand in for
a zero exit or eligible base-comparison evidence
(`docs/trident-gates-inventory.md:148-150`).

## Grounded defect

Observed at the investigated base `a1145a499`:

The served `codegen_cancel` route commits a terminal transition through the
terminator (`gateway/codegen-cancel-router.ts:177`, `trident/terminate.ts:143`).
The project launcher creates its own abort controller
(`trident/project-launcher.ts:104`), but the host review and publication suites
invoke a command runner without cancellation
(`open/wiring/project-build.ts:924`, `:961`). Its timeout signals only the direct
child (`trident/git-mode.ts:1146`), which does not establish that the suite's
child test processes stopped. A terminal run row is not process-exit evidence.

## Required behavior

A host suite is owned by the exact dispatched run. A durable terminal transition
for that run, or cancellation of its supplied host signal, must stop the running
suite and descendants retaining its unique process-ownership claim, including a
detached TERM-resistant test child. Cancellation observed before launch must prevent
launch. Recheck the durable run before accepting a returned suite result so a
concurrent cancellation cannot mint a usable success receipt.

Apply this to both review and publication-retry suite execution. Preserve the
existing wall budget, on-disk log, failure identity and base-comparison rules.
An interrupted suite produces unknown evidence and cannot start another review,
fix or publication step. A different run's suite and unrelated processes stay
alive; a later uncancelled run can execute its own suite normally.

This slice governs host-owned suite execution. It does not infer that cancelling
a run proves native model children terminal, clear their leases, or add a
gateway-restart reaper. Reuse the existing exact-claim and pidfd ownership
contract; never use broad process-name, cwd or numeric-PID sweeps. Commands that
deliberately discard their entire inherited environment retain the existing
lane-ownership limitation (`docs/spec-items/dead-lane-process-reaping.md`).
Interrupted cleanup must also cover same-claim descendants created by TERM handlers after
an initial process census. Require a known empty subsequent census; bound
repeated cleanup attempts and report unconfirmed cleanup if the bound is
exhausted or ownership/exit observations are unknown. These interruption checks
do not redefine ordinary foreground exit evidence: an uncancelled command keeps
its actual zero/red exit, with cleanup uncertainty recorded separately and no
claim of confirmed descendant closure. Cancellation arriving during normal
cleanup still requires the strict interrupted-run proof.
After the process owner exits, inherited output pipes must not delay the
interrupted result indefinitely: bound their drain and refuse usable evidence
when a remaining descendant holds them open.

## Acceptance

- [ ] Through `codegen_cancel`, stop a fixture run while its actual host suite
      and TERM-resistant grandchild are emitting heartbeats. Both cease within
      the test's bounded deadline, the row remains stopped, and no review or
      merge follows. A simultaneously running unrelated fixture survives.
      Verify: `open/__tests__/project-build-e2e.test.ts`,
      `trident/host-suite.test.ts`, and `trident/lane-processes-test.py`.
- [ ] A terminal run or already-aborted signal starts no suite process. A
      cancellation racing a zero exit yields no usable success receipt. Apply
      both checks to review and publication retry; an uncancelled zero exit
      remains usable and a normal red retains its failure evidence.
      Verify: consuming Open suite tests and the suite-runner tests.
- [ ] Disable cancellation observation or descendant signalling and the
      heartbeat regression fails. Overapply cancellation to a live sibling and
      its positive control fails. Restore the implementation and both pass.
- [ ] Run the consuming Open build tests and root/Trident typechecks. Before
      merge, run the canonical host suite and fresh CI on the integrated head;
      targeted green tests alone do not close this item.
