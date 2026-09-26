## 2026-09-26 — Scheduled vault pushes survive overlapping document commits

The shared writer previously let `backupNow()` reuse a local-only document
commit's result. A scheduler tick could therefore record its six-hour attempt
without sending the configured encrypted backup. The existing schedule and
remote contract is specified in `docs/spec-items/project-code-repos-and-vault-split.md`.

The store now identifies the active writer as a document commit or full backup
(`gateway/git/project-backup-store.ts:305`). Backup callers wait for document
commits, then recheck both writer and restore locks; concurrent full backups
still share their result (`gateway/git/project-backup-store.ts:515`). The idle
path installs its writer without yielding, preserving the implicit restore
safety backup's ordering. Document commits retain their local-only behavior and
release only their own writer entry (`gateway/git/project-backup-store.ts:537`).
Restore and drain consume the promise carried by that same entry
(`gateway/git/project-backup-store.ts:916`, `gateway/git/project-backup-store.ts:950`).

Real-store controls pause a document commit while the actual scheduler and two
run-now callers arrive, then verify one encrypted push and fresh-directory
recovery of the edited bytes and exact HEAD. A second control pauses an upload,
coalesces another backup and verifies a queued document's own history. A third
queues restores behind a document commit; the overlapping backup shares the
first restore's safety backup. It checks recovery parents, restored bytes and
preservation of the latest edit, without exercising the backup caller's wait
on an active restore. These three controls passed with
25 assertions (`gateway/__tests__/project-backup-store.test.ts:750`).

Both semantic mutations failed: sharing document results caused the scheduled
and run-now results to report `pushed: false`; waiting instead of sharing a full
backup produced two transport pushes where the consumer requires one. Both
mutations were reverted before final verification.

The seven-file focused run exercised the backup store, scheduler, document
history, restore surface, backup admin surface, encrypted transport and Open
loop composer: 149 tests passed; 14 restore HTTP tests could not bind their test
server in the sandbox. The isolated restore surface subsequently passed all
36 tests / 126 assertions with socket binding available. The final three new
controls were rerun after strengthening the restore-byte assertions. These are
focused local receipts; the complete shared-host gate and live offsite recovery
are separate evidence.

Final local validation ran `bash scripts/check-shared-host.sh` on clean revision
`8f364536073f1df5760d5e7fed7c03480cb575ac` (tree
`79f6fe7e717cc422fc94565eba94762b3ab7d20b`). The initial restricted-environment
attempt passed all 51 TypeScript configurations, then refused loopback socket
preflight with exit 3 before test execution. Its log SHA-256 is
`648bb1e881cd50cb93aadb8c436393c69aa6d422fc71a9777181a7475605cf91`;
that attempt is not a full-suite pass.

The authorized normal-host attempt completed with exit 0. All 51 TypeScript
configurations passed, including root and Trident. Declared, Bun-discovered,
assigned and executed counts were each 1,698 files: 1,464 general, 22 PGLite,
43 device and 169 real-HTTP. All 18 bounded-memory lanes passed, with 25,892
tests passed, 23 skipped, zero failures and 117,804 assertions. The general
lane included `open/__tests__/project-build-e2e.test.ts`; PGLite passed on its
first attempt. The completed log SHA-256 is
`de56ff24048b70494acdde90757da540cfb8747cee9da569f4343c3220fec16f`.
This receipt records the measured revision above; adding the receipt does not
transfer its identity to a later commit. Live offsite recovery remains unverified.
