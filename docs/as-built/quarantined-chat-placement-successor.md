## 2026-10-08 — Fresh Chat placement after completed conversation quarantine

A completed conversation quarantine detached the native wrapper while preserving
its process, pane and transcript. The project workspace journal still held that
pane as the active Chat owner. A normal subsequent Work Board turn therefore
failed in prewarm: both scope handoff and terminal placement refused the retained
live pane. This change completes the fresh-conversation lifecycle required by
`docs/spec-items/a-gateway-restart-keeps-the-project-repls.md`; it does not alter
quarantine eligibility or any lease-release policy. The earlier recovery record
in `docs/as-built/never-admitted-planner-conversation-quarantine.md` remains intact.

The admission store now reads a completed operation by joining the exact
conversation quarantine to its canonical retirement. Open verifies the retained
signed preparation against the independently configured host and capacity pins,
checks completion and scope, and supplies a read-only lifecycle grant. A prepared
tombstone cannot release the terminal claim. The runtime joins that grant to a
unique preserved registry row, exact parent generation, kernel identity and pane,
with no old pool owner or pending construction. The workspace manager checks its
live ownership marker, pane placement, recorded pane incarnation when available,
and exact parent membership in foreground processes; additional native helper
processes do not make that identity ambiguous. Its durable journal comparison
rechecks the grant and process before moving only the Chat claim into distinct
`quarantinedChats` history. It neither sends native input nor closes a pane.

A restarted manager recognizes the released Chat slot before a replacement is
spawned. The registered conversation factory then creates a fresh native session
without resume or copied input. Quarantined history is excluded from automatic
workspace retirement and dead-shell cleanup. Workers and other scopes retain
their claims. An unverified workspace inspection now returns an unknown handoff
instead of reporting readiness that the placement manager would later refuse.

Author validation: the ten affected test files passed 260 tests and 2,025
assertions, including the actual conversation wrapper, production substrate
factory, signed capacity registration, scope lifecycle and real workspace manager
against a synthetic native process/dev-channel and terminal RPC boundary. The
consuming control checks actual wrapper options, derived registry, three-entry
foreground membership, fresh UUID, no resume/replay, preserved original pane and
registry, and restart before spawn. Opposing controls cover prepared-only and
forged authority, wrong scope/session/generation/PID, duplicate registry ownership,
foreign native ownership, changed channel/workspace/pane incarnation, concurrent
journal or authority change, and unresolved owners. Worker/sibling preservation
and exclusion from workspace retirement also pass. The Open and Runtime
TypeScript projects passed. Three source mutations were assertion-killed: omit the metadata handoff,
omit preparation authentication, or omit the final journal comparison. Every
mutated source was restored byte-for-byte before publication preparation; the
15 new controls passed again afterward (129 assertions).

A separate read-only rehearsal against the deployed completed authority, registry,
kernel identity and terminal RPC reached the authorized metadata boundary while
leaving the journal unchanged. It did not create a replacement or perform a live
handoff. Required canonical local checks, exact-head review and CI remain the
publication gates; live Work Board acceptance remains open under #1416 and #1295.
