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
their claims. Ordinary pending-placement recovery remains with the placement
manager: a refused inspection alone cannot prevent its positive
`workspace_not_found` probe and reconstruction. A surviving pending workspace
still refuses. This preserves recovery independently of quarantine authority.

Author validation: the initial ten affected test files passed 262 tests and 2,071
assertions, including the actual conversation wrapper, production substrate
factory, signed capacity registration, scope lifecycle and real workspace manager
against a synthetic native process/dev-channel and terminal RPC boundary. The
consuming control checks actual wrapper options, derived registry, three-entry
foreground membership, fresh UUID, no resume/replay, preserved original pane and
registry, and restart before spawn. Opposing controls cover prepared-only and
forged authority, wrong scope/session/generation/PID, duplicate registry ownership,
foreign native ownership, changed channel/workspace/pane incarnation, concurrent
journal or authority change, and unresolved owners. Worker/sibling preservation
and exclusion from workspace retirement also pass. A separate ordinary project
uses the same production factory to recover a pending placement after positive
workspace absence; the opposing surviving-workspace case refuses without changing
the unrelated quarantined conversation. The Open and Runtime
TypeScript projects passed. Four source mutations were assertion-killed: omit the metadata handoff,
omit preparation authentication, omit the final journal comparison, or reinsert
a generic handoff veto that blocks ordinary pending-placement recovery. Every
mutated source was restored byte-for-byte before publication preparation; the
17 new controls passed again afterward (175 assertions).

The canonical shared batch then exposed a test-fixture omission: an earlier Open
composition had registered the owner census against its subsequently closed
database. The new consuming fixture constructed an admission store but did not
bind it to that runtime reader. The production unknown-ownership guard correctly
refused. The fixture now binds its own real all-child and chat-specific admission
queries exactly as composition does, with cleanup scoped to that owner; no
production guard changed. The exact original 100-file batch reproduced both
failures before this correction, then passed 1,472 tests and 6,612 assertions.
A minimal predecessor pair independently reproduced the cause. Its corrected
controls also include a genuinely admitted, finished-preparing child lease:
ordinary input remains refused and the lease stays unchanged. Replacing the real
chat census with a constant false was assertion-killed, and the restored control
passed. Open typechecking passed again after the test-only correction.

A later full batch passed every new control but exposed an existing positive
receipt-recovery test using the fixture's 50ms uncertainty budget. Its original
failure recorded only `unknown`, not the detail. A controlled 75ms native
acknowledgement reproduced `Claude trailer not observed before cancellation or
host budget expiry`; a 5-second budget reached `turn-ended` with the same signed
submission phase, one input and retained lease. Only that non-deadline positive
now uses the file's existing 5-second precedent, for both immediate and delayed
acknowledgements. All original receipt-forgery, lease, input, spawn and recovery
assertions remain, as do the short-deadline uncertainty controls. Restoring the
short positive budget was assertion-killed. The corrected canonical ordered
100-file batch passed 1,473 tests and 6,621 assertions; the restored focused file
passed eight tests and 54 assertions, and Open typechecking passed. Production
code did not change for either fixture correction.

A separate read-only rehearsal against the deployed completed authority, registry,
kernel identity and terminal RPC reached the authorized metadata boundary while
leaving the journal unchanged. It did not create a replacement or perform a live
handoff. Required canonical local checks, exact-head review and CI remain the
publication gates; live Work Board acceptance remains open under #1416 and #1295.
