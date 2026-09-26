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
