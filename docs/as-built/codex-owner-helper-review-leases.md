## 2026-09-19 — Private owner helper review permission leases

The durable owner helper now carries the native review permission transaction
across its authenticated Unix transport. The registry admits private preparation,
dispatch, restoration and acknowledgement operations only under the current
frontend grant (`runtime/adapters/codex-cli/persistent/project-owner-helper-registry.ts:22`).
Preparation accepts the stage directory, network choice and current epoch; dispatch
accepts only input plus the unpredictable helper-retained lease token. Unknown
policy fields, foreign tokens and repeat dispatches refuse before native execution
(`runtime/adapters/codex-cli/persistent/project-owner-helper-review.ts:38`).

Restoration first waits for the native transaction's completion and policy
readback. The helper then retains exclusive writer authority through a separate
acknowledgement and a subsequent authenticated receipt. The client sends that
receipt immediately, so a successful restore permits the next owner turn. A lost
prepare, start, restore or acknowledgement response closes the local proxy and
leaves helper attachment refused; native restoration alone cannot prove transport
delivery (`runtime/adapters/codex-cli/persistent/project-owner-helper-review.ts:21`,
`runtime/adapters/codex-cli/persistent/project-owner-helper-client.ts:99`). If the
final read-only receipt response is lost, the helper has already received proof
that its acknowledgement reached the frontend and can release; the frontend
still fences itself. This differs from losing the restore or acknowledgement
response, which leaves the helper lease retained. Abandon
synchronously fences the local proxy while making one best-effort helper notice
(`runtime/adapters/codex-cli/persistent/project-owner-helper-client.ts:129`).
Unresolved leases require explicit reconciliation; this change supplies no
automatic recovery workflow. Existing helper startup still refuses an existing
socket or descriptor (`runtime/adapters/codex-cli/persistent/project-owner-helper.ts:17`).

Verification used the real helper client, registry, broker and permission
transaction through disposable Unix transport fixtures with scripted native
responses. The five focused helper/broker/permission test files passed 44 tests.
They include successful restoration followed by an owner turn, repeated review,
forged owner RPC with an ordinary read as positive control, stale grant and epoch,
foreign lease, duplicate start, dropped response bodies, parent-only and wrong
child completion, changed native binding, failed restoration readback and
synchronous abandonment. This is protocol evidence; the native sandbox smoke is
a separate proof and the live owner was not used by these fixtures.

Three temporary semantic mutations were killed by the corresponding tests:
removing the foreign-token comparison, refusing every legitimate preparation,
and releasing the helper lease immediately after native restoration. Both root
and Open TypeScript checks and lint of the four changed runtime files passed.
The work preserves the project REPL and retained process model described in
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:87` and
`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md:21`.
