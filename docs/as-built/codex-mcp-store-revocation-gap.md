## 2026-09-19 — Preserve unchanged MCP peers across the store revocation gap

The real approval store makes removal durable before awaiting credential cleanup,
then announces revocation after releasing its write chain
(`gateway/mcp-servers/store.ts:489`, `:504`, `:469`). Secret replacement likewise
awaits credential persistence before announcement (`:350`). During that interval,
an ordinary request could observe the changed aggregate approval fingerprint and
dispose the whole broker binding, killing unrelated approved peers.

Store callbacks, execution-time verification and notification verification now
share selective retirement in
`runtime/adapters/codex-cli/persistent/approved-mcp-broker.ts:139`. A changed
snapshot retires only removed or changed candidates, subprocesses and consumers;
it never starts replacements. The request's exact client identity is still
checked before forwarding and after results, so revoked peers remain unavailable.
An entirely revoked surface retains its existing unavailable-surface behavior.
Lost owner authority, unreadable approvals and unexpected transport failures
retain fail-closed disposal. No store write-chain ordering or native owner
lifecycle changes were made.

The real encrypted-store and SDK subprocess regression at
`runtime/adapters/codex-cli/persistent/approved-mcp-broker.test.ts:65` pauses removal
inside credential cleanup, or pauses secret replacement after credential write,
before `onRevoked` can run. Both request and notification variants preserve A,
retire B, refuse B's tool operation and prove the callback has not yet executed.
Releasing the write finishes the real callback and A still serves tools without
respawning. Existing quiet-idle retirement tests retain the no-next-turn control.

The under-restriction mutation accepts the changed fingerprint without retiring
B and fails the revoked-operation assertion. The over-restriction mutation
restores aggregate disposal and fails the unchanged A request. Both mutations
were restored. Verification: 231 tests pass across complete explicit Open
project-build E2E, composer HTTP wiring, owner bindings, SDK broker and gateway
suites. The four real-store cases also pass with an explicit assertion that the
notification had not arrived before the paused transaction window. Both root
and Trident TypeScript checks and touched-file lint pass. This is local consuming
evidence, not deployment acceptance; the earlier full-tree leak scan remains a
reported failure, not a clean purity claim.
