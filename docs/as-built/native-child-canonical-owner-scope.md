## 2026-09-25 — Preserve native child scope across owner wake dispatch

An owner wake carrying only `metering_context.project_id` could recreate a named
project's pool key without its `conversationProjectId`. Supervision then replaced
the stamped options with the unstamped options, and native-child retirement
treated the missing scope as no live children despite a durable lease.

Terminal build/deploy wakes now carry exact conversation scope, including a named
`general` project, and route using that scope. The host acting-turn path forwards
the exact scope it admitted. The shared
owner substrate uses the same scope decoder and carries that scope into Claude
options and pool identity. Explicit General remains null; a literal named
`general` project stays distinct. Same-key supervision preserves an existing
scope, and runtime child queries protect ambiguous legacy scope while consulting
the existing admission authority for unambiguous named scope. No journal or lease
expiry was added. Query registration can be cleared for test teardown.

The real shared-substrate regression captures stamped and wake-shaped options,
then consumes them through actual pool retirement against a migrated admission
database. Named, General and literal-general cases refuse retirement with a child
lease and retire after exact completion; unrelated scope remains clear. Unknown
legacy scope and same-key registration have separate controls. The combined
boot-adoption/model-control test sequence also verifies query isolation.

Mutations removing owner stamping, allowing supervision to erase scope, and
treating unknown scope as idle each fail their targeted tests. Consuming Open
build E2Es and root/Open typechecks pass. No deployed proof or full canonical
suite is claimed; the separate queue-budget work remains outside this repair.
