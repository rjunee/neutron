## 2026-09-19 — Retire revoked Codex MCP peers while the owner is idle

The durable owner provider previously checked approval changes on requests,
notifications and admission, but the store callback retired only Claude peers.
A quiet Codex subprocess could retain revoked secrets indefinitely, contrary to
`docs/spec-items/owner-installable-mcp-servers.md:18`.

`open/composer.ts:4298` now calls
`open/wiring/codex-owner-binding.ts:321` from the existing store revocation hook.
The broker re-resolves approved material and retires only removed or changed
servers, aborting their requests and closing their gateway consumers
(`runtime/adapters/codex-cli/persistent/approved-mcp-broker.ts:123`). Unchanged
peers and the native conversation remain alive. Removed-client identity checks
refuse late results and notifications. Replacement peers start only at the next
explicit idle owner preparation; revocation itself never starts a subprocess.

The real helper/broker/SDK consuming tests at
`open/__tests__/project-build-e2e.test.ts:84` cover denial and secret rotation.
They establish both subprocesses are alive, prove unchanged approval checks
preserve them, revoke while no turn or notification runs, and require the revoked
PID to be dead before any successor dispatch. The unrelated PID, consumer handle
and native owner survive the subsequent chat. The real HTTP delete test at
`open/__tests__/open-mcp-servers-wiring.test.ts:284` additionally pins the composer
callback while retaining its Claude retirement assertions.

Verification: 220 tests pass across the complete explicit Open project-build E2E,
Open MCP HTTP wiring, owner bindings, SDK broker and gateway suites. Root and
Trident TypeScript checks and touched-file lint pass. Three restored semantic
mutations were detected: skipping idle retirement leaves the revoked PID alive;
retiring every peer kills the unrelated PID; removing the composer callback fails
the real delete-surface wiring assertion. These checks establish local consuming
behavior, not deployment or live-account acceptance. The earlier full-tree leak
scan remains a reported failure, not a clean purity claim.
