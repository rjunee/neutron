---
title: Recover an intermediate task checkpoint before reviewing the card
group: trident
status: open
priority: P0
cutover: true
---

# Same-run task-sequence crash handoff

Issue: #1219. This repairs the existing host loop under the locked
harness-orchestrator pivot, without changing execution strategy or review gates.

The builder durably records `built` before the host commits its task ledger and
advances the iteration. Therefore `built` alone cannot authorize review. The
consuming project-build regression reproduces a process ending after the real
checkpoint write, with `remainingTasks: 1`, no pending worker, and an unchanged
branch head. On the reported base it resumes through publication and merges only
the first task.

On a same-head resume, a task-sequence `built` checkpoint is terminal only when
its host-recorded remaining count is zero and agrees with the persisted,
validated execution plan. Every count must match that plan; a positive remainder
must also agree with its unchecked ledger. Recovery of an intermediate task must
commit that plan's ticked ledger and durably advance the existing iteration before
returning `continued`, using the ordinary idempotent handoff. It must not dispatch
another planner/builder, publish, review, or merge that intermediate task. Missing
or contradictory evidence must return `unknown` before any of those effects.
The same rule applies if the ledger was already committed and checkpointed but
the handoff had not yet advanced. A moved branch retains the existing rebuild
behavior; this item does not authorize adopting an unrecorded revision.

## Acceptance

- [x] Real durable intermediate checkpoints interrupted before ledger commit or
      before task advancement resume to `continued` in both PR and local modes.
      The next durable checkpoint is `task-built`, its iteration advances once,
      its committed ledger checks only the completed task, and no worker or
      publication/review/merge occurs during recovery. Re-entering after handoff
      builds the next unchecked task through the existing continuation path.
      verify: `open/__tests__/project-build-e2e.test.ts` and
      `trident/build-run.test.ts`.
- [x] Missing remaining count, missing plan, or count/ledger disagreement (including
      a zero checkpoint whose accepted plan still has work remaining) returns
      `unknown` without handoff or review. A blanket refusal also fails acceptance:
      a matching positive remainder must hand off, while a terminal zero-remainder
      checkpoint must review and merge without new planning or building.
      verify: the same consuming test file and `trident/build-run.test.ts`.
- [x] Paired semantic mutations reinstate premature terminal reuse and refuse
      legitimate terminal reuse. Each must fail its named behavioral test;
      unmutated tests must pass first. Both consuming and focused tests remain
      green, as do `bunx tsc -p tsconfig.json --noEmit` and
      `bunx tsc -p trident/tsconfig.json --noEmit`; the Open package check
      `bunx tsc -p open/tsconfig.json --noEmit` is additional.
      verify: `trident/task-sequence-crash-mutation.test.ts`.
- [ ] The exact reviewed commit is merged and served, then a fresh live acceptance
      run proves the task sequence reaches merge on that served revision. Record
      the merge/served identities and run evidence under the locked pivot's
      delivery rule (`docs/plans/harness-orchestrator-pivot-2026-09-11.md`, §4).
      Local consuming and mutation tests establish static recovery behavior only;
      they cannot satisfy this live criterion or mark this item done.
