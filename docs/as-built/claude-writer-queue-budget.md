## 2026-09-29 — Separate Claude writer queue wait from bounded execution

Issue #1295's deadline-before-lock defect remained at base
`718fb2def29893ac1f8e1cab5e95c5c8d50a1005`. The outer Claude runner,
acting turn and closed planner operation grant all shared a deadline established
before acquisition of the project REPL writer slot. Fixing only the actor would
still expire the runner and revoke the planner grant.

`runtime/workers/claude-dispatch-budget.ts:5` now owns one bounded queue
interval per dispatch. Acquisition must finish before the original deadline;
only its measured wait is credited, once. Preparation remains charged and
execution receives no additional allowance. Cancellation or expired acquisition
cannot create time. `runtime/workers/claude-acting-turn.ts:269` measures the real
session lock, and the runner's timer follows the same adjusted deadline.
`open/wiring/project-build.ts:555` binds the closed planner grant to that shared
deadline and the dispatch cancellation signal. The existing attempt events
record the writer queue interval separately at `:561`; it overlaps the outer
attempt interval and must not be added to that interval as elapsed wall time.

The change retains the original reservation, pending step, durable child lease,
placement and result decoder. An execution timeout remains unknown, and recovery
observes the original child without submitting again. It does not alter proof,
preparation reuse, review gates or the session's writer independence policy.

Validation: the focused Claude actor, runner, project-runner and budget tests
passed 192 cases. The consuming `open/__tests__/project-build-e2e.test.ts` subset
passed the real writer queue/closed planner grant case, disjoint and simultaneous
native writer barriers, aliased serialization, preparation expiry/cancellation,
lost acknowledgement, hung transport and execution-expiry recovery controls.
Removing queue credit makes the consuming planner case fail with an unknown
outcome. Crediting expired or cancelled acquisition makes all three negative
budget controls fail; restored controls pass. Root and Trident TypeScript checks
passed.

This budget repair does not itself introduce parallel builds. Existing
`runtime/adapters/claude-code/persistent/repl-session.ts:553` admits overlapping
children only under its workspace independence contract; other writers remain
serialized. The consuming barriers prove the existing admitted-disjoint path,
not live provider execution or every same-project build topology. No live input,
deployment or issue closure is claimed by this record.
