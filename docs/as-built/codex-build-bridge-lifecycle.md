## 2026-09-19 — Fence uncertain Codex build dispatches and serialize child observation

The acting bridge raced submission against its budget, but returning uncertainty
did not stop a later invocation from submitting another dispatch. The pane
session serialized input acknowledgements only, not the child's trailer
(`runtime/adapters/codex-cli/persistent/project-session.ts:139`).

`runtime/workers/codex-acting-turn.ts:22` now keeps lifecycle state on the
host-owned session object, shared by reconstructed acting-turn bindings. It
serializes the entire observation, records each run/step before submission,
and refuses replay. Cancellation, expiry, rejected submission, or another
uncertain outcome after dispatch fences subsequent calls pending host
reconciliation. A queued invocation rechecks its deadline and session liveness
before writing (`runtime/workers/codex-acting-turn.ts:86`). A cancellation
before submission leaves the session and step usable.

Submission must settle before a child trailer can end the bridge observation
(`runtime/workers/codex-acting-turn.ts:101`). This preserves native parent/child
ordering when the host's submission implementation waits for native completion.
It does not upgrade a terminal input acknowledgement into native completion:
the legacy pane implementation still only acknowledges input. Hosts must retain
the session object until reconciliation; constructing a fresh object loses
these in-memory guards. Native cancellation, durable recovery, actual child
spawn capability, and cross-host fencing remain the owner's responsibility.

Verification includes the focused lifecycle tests, Codex in-REPL and project
runner tests, and the consuming `open/__tests__/project-build-e2e.test.ts`.
Together these passed 138 tests; root, runtime, and Trident TypeScript checks
passed using worktree-local frozen-lockfile dependencies.
The lifecycle controls cover successful distinct steps, duplicate suppression,
lost acknowledgements, late settlement after cancellation/timeout, queued
cancellation and liveness changes, and waiting for the preceding child's file
(`runtime/workers/codex-acting-turn.test.ts:234`). Semantic mutations in both
directions were rejected: bypassing the submission wait failed the pending-parent
timeout test; replacing valid completion with uncertainty failed the positive
control. This is fixture evidence, not a native build or unattended merge.
The full-tree local leak gate exited 1 on existing repository denylist findings
and the worktree's local `.git` pointer; no clean purity result is claimed.

This bounded slice supports the locked project-REPL build design
(`docs/plans/harness-orchestrator-pivot-2026-09-11.md:87`) without claiming the
umbrella acceptance complete. It does not replace the old loop, establish gate
parity, or demonstrate an unattended card reaching MERGED
(`docs/spec-items/the-orchestrator-owns-the-build-loop.md:56`).
