## 2026-09-19 — Preserve unchanged peers when an admitting MCP peer is revoked

The stale-candidate fence prevented a revoked peer from starting, but retiring a
peer already awaiting its handshake rejected `client.connect` into the whole
binding's failure handler. Unchanged connected peers were consequently closed.
This contradicted the selective retirement contract in
`docs/SYSTEM-OVERVIEW.md:887` and the previous idle-retirement record.

The per-candidate handshake and discovery boundary now recognizes explicit
candidate retirement: its client and reserved fingerprint must both be removed,
the same pending binding must remain live, and current authority and caller
cancellation are checked again
(`runtime/adapters/codex-cli/persistent/approved-mcp-broker.ts:343`). Only that
expected cancellation continues to the next candidate. Unexpected connection
failure, timeout, EOF, lost authority or caller cancellation retains whole-binding
fail-closed disposal. Discovery cannot publish a removed client's metadata.
Native owner ownership and lifecycle are unchanged.

Real SDK subprocess tests at
`runtime/adapters/codex-cli/persistent/approved-mcp-broker.test.ts:65` cover both
cold and already-established A, with B removed or secret-rotated while its
handshake waits. A remains alive, is not respawned and serves tools; B dies and
cannot serve tools. A separate real handshake timeout requires admission refusal,
A retirement and eventual B retirement within the SDK's bounded close grace.

The over-restriction mutation sends expected cancellation back into whole-binding
failure and fails all four preservation cases. The under-restriction mutation
swallows arbitrary connection errors and disables the redundant unexpected-EOF
retirement; the timeout control then observes successful admission and fails.
Both mutations were restored. Verification: 227 tests pass across the complete
explicit Open project-build E2E, composer HTTP wiring, owner bindings, SDK broker
and gateway suites. Both root and Trident TypeScript checks and touched-file lint
pass. These are
local consuming checks, not deployment acceptance. The earlier full-tree leak
scan remains a reported failure, not a clean purity claim.
