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
validated execution plan. The sole missing-plan
exception preserves a host-authenticated migrated checkpoint: the persisted
selection source is `legacy`, the accepted plan is null, and the checkpoint
explicitly records `remainingTasks: 0`. It may resume fresh review only after
the existing full-commit-identity and nonempty regenerated-diff checks pass.
It cannot authorize intermediate handoff or bypass review, suite proof,
publication, or merge gates. Modern selections still require the accepted plan;
any persisted plan must agree with the count, including at zero.
A positive remainder always requires that plan and its matching unchecked
ledger. Recovery of an intermediate task must
commit that plan's ticked ledger and durably advance the existing iteration before
returning `continued`, using the ordinary idempotent handoff. It must not dispatch
another planner/builder, publish, review, or merge that intermediate task. Missing
or contradictory evidence must return `unknown` before any of those effects.
The same rule applies if the ledger was already committed and checkpointed but
the handoff had not yet advanced. Before writing Git, the completed intermediate
build records an intent containing its original iteration, builder head and exact
ticked ledger bytes, and charges that iteration in the same database transaction.
The charge survives a differing branch tip and rejection of checkpoint adoption.

A lost Git-commit acknowledgement may recover only the intended ledger-only
direct child: exactly one parent equal to the builder head, only the branch's
ledger path changed, and the expected regular-file blob. The host remeasures the
tip before acknowledging recovery. This explicit intent is the sole exception to
G038's moved-head rebuild rule; arbitrary moved heads still rebuild within the
remaining budget. Exhausted runs dispatch no worker, including on repeated
restart. Handoff consumes the original task identity once without adding spend
again. An intent whose run or linked card has advanced beyond its one recorded
charge is stale and cannot restore an older task identity. Old checkpoints
acquire the intent before their next ledger write; missing
or malformed evidence never authorizes adoption of a moved revision.

## Acceptance

- [x] Real durable intermediate checkpoints interrupted before ledger commit or
      before task advancement resume to `continued` in both PR and local modes.
      The next durable checkpoint is `task-built`, its iteration advances once,
      its committed ledger checks only the completed task, and no worker or
      publication/review/merge occurs during recovery. Re-entering after handoff
      builds the next unchecked task through the existing continuation path.
      verify: `open/__tests__/project-build-e2e.test.ts` and
      `trident/build-run.test.ts`.
- [x] Interruption after the real Git commit but before the head checkpoint
      resumes without planner/builder dispatch, including a second interruption
      during recovery. Run/card spend remains one. An unrelated changed tip
      rejects adoption: an exhausted sibling cannot dispatch, while a sibling
      with remaining budget rebuilds under the next task identity.
      verify: `open/__tests__/project-build-e2e.test.ts`.
- [x] Extra-file, wrong-blob, grandchild and merge-shaped candidates cannot
      authenticate as ledger recovery. Malformed intents fail closed; older
      checkpoints remain readable. Semantic mutations separately remove parent,
      ledger-only and spend checks, and refuse valid recovery; all must fail.
      verify: `trident/production-host-effects.test.ts` and
      `trident/task-ledger-intent-mutation.test.ts`.
- [x] Missing remaining count, missing plan outside the authenticated legacy
      terminal exception above, or count/ledger disagreement (including
      a zero checkpoint whose accepted plan still has work remaining) returns
      `unknown` without handoff or review. A blanket refusal also fails acceptance:
      a matching positive remainder must hand off, while a terminal zero-remainder
      checkpoint must review and merge without new planning or building.
      A migrated legacy checkpoint with no accepted plan and explicit zero
      remainder must resume fresh review and merge without inventing a plan or
      replaying planning/building; positive or missing legacy remainders and
      contradictory persisted legacy plans must still return `unknown`.
      verify: the same consuming test file, `trident/build-run.test.ts`, and
      `trident/legacy-terminal-checkpoint-mutation.test.ts`.
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
