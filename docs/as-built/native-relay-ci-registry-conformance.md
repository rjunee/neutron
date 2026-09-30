## 2026-09-30 — Native relay registry and architectural guard conformance

The native relay change introduced three legitimate source shapes that existing
CI registries had not classified. This repair changes the registries and guard
tests; production behavior remains the behavior at base `907853044`.

`gateway/claude-mcp-handler-drain.ts:27` writes the scoped admission fence to
serialize handler acceptance, then checks its open phase and exact generation
at line 30. `migrations/table-ownership.json:34` now records that writer alongside
the lifecycle-owning store, retaining the existing exact, bidirectional writer
comparison in `migrations/__tests__/table-ownership-conformance.test.ts:289`.

The validators at `runtime/workers/claude-capacity-client.ts:49` and
`runtime/workers/claude-native-continuation.ts:235` match identity-name candidates
through their broad regular expressions. The new entries in
`tests/integration/identity-env-readers-registry.test.ts:256` describe that
conservative classification and the explicit, signed source of identity.
The classification control at line 986 compares both files with the actual env
reader in `migrations/db-path.ts:35`; it does not claim registry membership
proves runtime receipt verification.

`runtime/adapters/claude-code/persistent/native-request-relay.ts:24` selects the
provisioned Unix socket, and line 25 supplies the native CLI's upstream default.
The architectural guard at `tests/integration/no-direct-anthropic-api.test.ts:159`
permits only those adjacent standalone assignments in that file. Additional
host references, reuse of the base-URL field, common HTTP API references, and
the same configuration in another file remain violations. The guard still
scans the relay file. This remains a textual endpoint fence, not general
network or computed-destination analysis. The authored documentation search
for `no-direct-anthropic`, provider-host restrictions, and relay references found
the current adapter rules and system overview consistent with native CLI
transport configuration; the guard's overbroad endpoint comment was corrected.

Validation on the base plus this repair: the three focused suites
(`table-ownership-conformance`, `identity-env-readers-registry`, and
`no-direct-anthropic-api`) passed 55 tests. Root and `trident/tsconfig.json`
checks both passed with `bunx tsc -p <config> --noEmit`. Temporary semantic
mutations were measured against the actual repository-scanning assertions:
an unregistered production fence writer and `fetch(routed.ANTHROPIC_BASE_URL)`
in the real relay file each failed their guard; deleting the capacity-client
registry entry failed with that exact unregistered path. The mutations were
reverted. Committed controls also reject a foreign socket assignment, a literal
direct provider fetch, an aliased fetch, and an aliased Node HTTPS request.
No full-suite, CI, served-runtime, merge, or deployment result is claimed here.
