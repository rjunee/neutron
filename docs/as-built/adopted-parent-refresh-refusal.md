## 2026-09-23 — Refuse adopted-parent refresh while native children are unknown

An adopted Claude parent reconstructs no native-child leases. An idle parent
prompt therefore cannot authorize killing it: the pane may still host a native
child. The profile-only reuse exception preserved that parent, but credential,
tool-surface, bridge, MCP and poison mismatches still reached eviction or
quarantine. This violated the unknown-liveness rule in
`docs/spec-items/project-herdr-workspaces.md:46-51`.

`runtime/adapters/claude-code/persistent/spawn.ts:1616` now refuses these turns
before either path with the existing `repl_unreconciled` error class. The pool,
child and durable ownership remain intact. The failed freshness guard is never
bypassed to serve the turn, and no replacement is spawned. Profile-only reuse
and known-lifetime nonadopted credential rotation retain their prior behavior.
The existing caller at `runtime/adapters/claude-code/persistent/pool.ts:627`
emits the classed error and ends the turn before acquiring or injecting it.

The focused adoption tests reproduce a quiet parent with a running native child,
current bounded-worker profile, and no reconstructed leases. They check repeated
refusal, live pane preservation, identical registry ownership and zero replacement
spawns for all five mismatches, including poison with positive hosted work.
Before the fix the five initial counterexamples failed. An unconditional-refusal
mutation also failed the existing successful same-credential OAuth refresh test
(`credential-rotation-rekey.test.ts:207`), establishing the opposite boundary.
The final focused adoption, rotation and concurrent-ownership suites pass all
55 tests (409 assertions).

This is a safety refusal, not lifecycle handoff or cutover completion. An adopted
parent needing refresh can remain unavailable until its lifetime is reconciled;
the change supplies no child census and authorizes no forced respawn.
