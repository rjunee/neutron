## 2026-09-19 — Atomic broker journal bootstrap

The journal previously committed its schema before inserting initial ownership.
A process killed between those writes left an empty broker table, and every
restart refused the missing identity. Schema creation now shares the immediate
transaction with ownership insertion
(`runtime/adapters/codex-cli/persistent/project-control-broker-journal.ts:58`).
An interrupted first transaction can leave a database file without a broker
table; a restart can initialize it. A committed table with a deleted ownership
row still fails closed, as does an unidentified socket beside an unfinished
database (`project-control-broker-journal.ts:64`). No automatic deletion or
repair of corrupt ownership evidence was added.

The new `project-control-broker-bootstrap.test.ts:17` instruments the real
SQLite CREATE boundary in a child process, sends SIGKILL, and checks that the
restart owns generation 1 and can reserve an epoch. Before the fix it failed
with `Broker journal identity missing`; its deleted-row control passed. With
the fix, all 26 bootstrap, broker and recovery tests pass (119 assertions).
The deleted-row and unknown-socket controls are at `:49` and `:61`.
Removing the existing-table refusal produced one expected failure while crash
recovery and socket refusal passed. Overapplying refusal to every existing
database file produced one expected crash-recovery failure while both refusal
controls passed. Restoring the predicate returned all tests to green.

The native consuming broker smoke passed with a disposable Codex home and a
loopback provider: native TUI and gateway shared history, restart invalidated
the stale epoch, and native history survived. Root and runtime TypeScript
checking both passed after installing the isolated worktree's dependencies.

The existing socket limitation remains: `project-control-broker.ts:264` binds
the socket before `:307` records its identity through the journal's `bound()`
transaction (`project-control-broker-journal.ts:90`). SIGKILL after binding but
before that transaction commits leaves a socket whose identity is unproven.
Restart refuses it at `project-control-broker-journal.ts:68`; this change does
not authorize unlinking it or claim recovery from every startup instruction.
