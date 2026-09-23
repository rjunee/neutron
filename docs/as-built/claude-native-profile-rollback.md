## 2026-09-23 — Restore native child dispatch for existing project conversations

Selectively reverses the production and profile-test changes in PR #1233
(`bcf022a14f1f471784cd4515e2fa65c719364ae6`). Its
[original record](claude-bounded-native-tools.md) remains immutable. The bounded
profile was merged but had not been deployed when this rollback was prepared.
An adopted parent retained its actual older spawn profile, while the new acting
turn refused that profile. Preserving the pane alone therefore preserved a
conversation that could no longer dispatch its same-provider work.

The native runner again requests Claude's built-in `general-purpose` child,
with the requested model, brief and result-file contract
(`runtime/workers/claude-in-repl.ts:52`). All parents use this one route.
Spawn-time custom-agent injection, profile fingerprints, profile-only recycling
and the profile capability refusal are removed. The actual `Agent` surface
preflight remains (`runtime/workers/claude-acting-turn.ts:207`), as do grants,
acknowledgement, result correlation, dispatch reservations and background-child
ownership. Matching parents continue to be reused
(`runtime/adapters/claude-code/persistent/spawn.ts:1602`). The merged adopted-parent
refresh refusal remains intact: credential, tool, bridge, MCP or poison mismatch
refuses the new turn without evicting an adopted parent whose native-child
liveness is unknown (`runtime/adapters/claude-code/persistent/spawn.ts:1609`).
Explicit project placement still reaches the spawn boundary
(`runtime/adapters/claude-code/persistent/spawn.ts:536`).

The adoption regression exercises registry adoption, warm lookup, native request
construction, acknowledged submission and result-file observation on the same
parent, and verifies that its pane and registry remain intact. A separate test
holds a native child lease and queues another dispatch while repeating warm
lookup. Request tests pin `general-purpose`, the selected provider/model and
result contract; existing refusal tests cover a missing or unreadable `Agent`
surface. Semantic mutations in both admission directions fail: refusing a
capable adopted parent breaks the adoption test, and admitting a parent without
`Agent` breaks the missing-surface test.

This restores the wider inherited tool schema, including the associated context
cost. It does not solve the P0 efficiency target, establish a durable census of
legacy native children, or authorize automatic replacement of an adopted
parent. Those efficiency and lifecycle requirements remain open in
[the build-efficiency specification](../spec-items/trident-build-efficiency.md).
The locked project-conversation and native-child placement contract remains
unchanged; cross-provider work retains its separate route.
