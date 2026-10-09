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
handoff. Live Work Board acceptance remains open under #1416 and #1295.

Final canonical local validation ran `bash scripts/check-shared-host.sh` at
`d9c12aa628e9473461710fbec962c3c9b68b5122` from 2026-10-09 00:42:57.801 UTC
to 01:19:48.793 UTC. It exited 1: **FAIL**, with complete coverage, not a local
full-suite pass. All 51 TypeScript projects passed. All 1,799 test files executed
across 19 lanes: 28,003 tests passed, one failed, 24 skipped, and 134,741 assertions
ran. All 178 real-HTTP files passed, including the consuming end-to-end controls.
The sole failure was the unchanged Codex retirement fixture at
`runtime/adapters/codex-cli/persistent/project-owner-retirement.test.ts:12`:
reading `child.exited` threw `EBADF` from `epoll_ctl` before any retirement
assertion. Its adjacent stronger live-process-to-retirement control passed.
The failing file is unchanged from the branch base; the descriptor failure's
cause remains unknown and is tracked separately in #1457. This evidence does not
justify weakening or changing the recovery authority checks.

The canonical log SHA-256 is
`36ef1653eaf507de92106a9c6ba95628c83225d533395b795704f8155ef29b2c`.
The measured suite input identity is
`f57a448edd5d929fff756b2292439a3e7c068c7e9faea2793d77c22bbb3ff0e4`,
unchanged through the run. The identity reader includes the Git revision in its
preparation key (`open/wiring/project-build-dependencies.ts:126`). The subsequent
documentation-only publication commit therefore has a different measured suite
identity. No proof transfers to that revision: the local FAIL belongs to the
tested revision above, and neither complete coverage nor this record is green
full-suite proof. Dependency analysis exited 0 across 3,232 modules and 9,122
dependencies, with eight existing ignored violations. Bounded native arbitration
retains source GO while recording the local failure; exact publication-head CI
must be green before merge. Deployment and live acceptance remain pending.
