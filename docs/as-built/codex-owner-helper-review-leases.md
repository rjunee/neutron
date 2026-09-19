## 2026-09-19 — Private owner helper review permission leases

This record covers the native permission transaction and its helper transport
(`6848ac8d`, `9da4684c`, and the helper commits in this change). The native broker
admits review work through a host capability while excluding other project
writers. It installs and reads back a unique permission profile granting reads
from the filesystem root and writes only to the canonical per-step result stage,
then forces that profile and `approvalPolicy: never` on the native parent turn.
Enabled MCP servers refuse because their own writes are outside that filesystem
policy (`runtime/adapters/codex-cli/persistent/project-review-permissions.ts:119`).

Settlement follows native spawn edges and observed turn identities through the
whole descendant tree; a parent or direct child's completion cannot hide an
active grandchild. Restoration verifies both native policy and configuration,
retaining the broker journal until explicit host release
(`runtime/adapters/codex-cli/persistent/project-review-permissions.ts:73`,
`runtime/adapters/codex-cli/persistent/project-review-permissions.ts:155`). The
native dependency lane ran the installed Codex 0.154.0 smoke in both normal and
`--pending-descendant` modes. A real child could patch and write by subprocess in
its stage, while project, canonical target, unrelated temporary target, symlink
escape and escalation controls refused. A real grandchild outlived its direct
parent: early restore fenced; full descendant settlement allowed verified restore
while a direct native gateway write still refused until release. The subsequent
owner turn successfully patched the project again
(`runtime/adapters/codex-cli/persistent/project-review-permissions.smoke.ts:120`).

The durable owner helper now carries the native review permission transaction
across its authenticated Unix transport. The registry admits private preparation,
dispatch, restoration and acknowledgement operations only under the current
frontend grant (`runtime/adapters/codex-cli/persistent/project-owner-helper-registry.ts:22`).
Preparation accepts the stage directory, network choice and current epoch; dispatch
accepts only input plus the unpredictable helper-retained lease token. Unknown
policy fields, foreign tokens and repeat dispatches refuse before native execution
(`runtime/adapters/codex-cli/persistent/project-owner-helper-review.ts:26`).

Restoration first waits for the native transaction's completion and policy
readback, retaining the native broker journal and exclusive writer lock. Explicit
release sends a separate acknowledgement and a subsequent authenticated receipt;
only that receipt releases the native lease and permits the next owner turn. A lost
prepare, start, restore or acknowledgement response closes the local proxy and
leaves helper attachment refused; native restoration alone cannot prove transport
delivery (`runtime/adapters/codex-cli/persistent/project-owner-helper-review.ts:21`,
`runtime/adapters/codex-cli/persistent/project-owner-helper-client.ts:99`). If the
final release response is lost, the helper has already received proof
that its acknowledgement reached the frontend and can release; the frontend
still fences itself. This differs from losing the restore or acknowledgement
response, which leaves the helper lease retained. Abandon
synchronously fences the local proxy while making one best-effort helper notice
(`runtime/adapters/codex-cli/persistent/project-owner-helper-client.ts:135`).
Unresolved leases require explicit reconciliation; this change supplies no
automatic recovery workflow. Existing helper startup still refuses an existing
socket or descriptor (`runtime/adapters/codex-cli/persistent/project-owner-helper.ts:17`).

Verification used the real helper client, registry, broker and permission
transaction through disposable Unix transport fixtures with scripted native
responses. The five focused helper/broker/permission test files passed 49 tests,
covering the private transport and native writer exclusion together.
They include successful restoration followed by an owner turn, repeated review,
forged owner RPC with an ordinary read as positive control, stale grant and epoch,
foreign lease, duplicate start, dropped response bodies, parent-only and wrong
child completion, direct native TUI writes during retained restoration, changed
native binding, failed restoration readback and
synchronous abandonment. This is protocol evidence; the native sandbox smoke is
a separate proof and the live owner was not used by these fixtures.

Three temporary semantic mutations were killed by the corresponding tests:
removing the foreign-token comparison, refusing every legitimate preparation,
and releasing the helper lease immediately after native restoration. Both root
and Open TypeScript checks and lint of the four changed runtime files passed.
This adapter/helper change does not wire the Open build dispatch, review observer
and artifact-promotion consumer; that integration requires its own consuming
evidence. It does not establish an unattended Codex merge workflow. The work
preserves the project REPL and retained process model described in
`docs/plans/harness-orchestrator-pivot-2026-09-11.md:87` and
`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md:21`.
