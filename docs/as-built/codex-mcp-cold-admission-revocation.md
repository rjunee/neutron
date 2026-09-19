## 2026-09-19 — Fence revoked peers during cold MCP admission

Selective idle retirement also encounters pending admission. While one SDK peer
awaited its handshake, retirement could update the aggregate approval fingerprint
but leave the admission loop's original candidate list intact. A later removed
candidate could then spawn and serve requests under the updated fingerprint.
This violated `docs/spec-items/owner-installable-mcp-servers.md:18`.

Admission now reserves each candidate's exact material fingerprint before opening
peers (`runtime/adapters/codex-cli/persistent/approved-mcp-broker.ts:288`).
Retirement removes stale reservations for the entire candidate set, including
peers not yet spawned (`:135`). The admission loop checks the reservation after
its asynchronous authority check and before creating a client (`:293`). It skips
revoked candidates without cancelling an unchanged peer's handshake or native
owner conversation. Secret-rotated candidates likewise cannot spawn using the
previous secret; replacement admission remains a later explicit preparation.

The real subprocess test at
`runtime/adapters/codex-cli/persistent/approved-mcp-broker.test.ts:65` delays A's
handshake, removes or rotates B, awaits retirement, and requires admission to
complete with A only. B has no spawn log and cannot serve a request; A stays
alive and serves tools without respawning. Removing the reservation guard makes
the test observe both A and B; over-broadly pruning unchanged reservations fails
the surviving-admission control. Both semantic mutations were restored.

Verification: 222 tests pass across the complete explicit Open project-build E2E,
Open MCP HTTP wiring, owner binding, SDK broker and gateway suites. Root and
Trident TypeScript checks and touched-file lint pass. This is local consuming evidence, not deployment
acceptance; the prior full-tree leak scan remains a reported failure.
