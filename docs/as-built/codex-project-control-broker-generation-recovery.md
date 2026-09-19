## 2026-09-19 — Durable Codex broker generations and bounded restart recovery

The locked harness plan requires one long-lived project conversation and
in-place model control (`docs/plans/harness-orchestrator-pivot-2026-09-11.md:87`,
`:185`). This extends the unintegrated broker from
`codex-project-control-broker.md`; its process-local epoch limitation is replaced
by a private SQLite journal beside the Unix socket. Existing as-built shards
remain historical records.

`runtime/adapters/codex-cli/persistent/project-control-broker-journal.ts:58`
claims a generation in an immediate transaction, binding the socket, thread,
working directory and Codex home. Each replacement advances the durable epoch,
including replacement before the first mutation. Admission persists each new
epoch (`:89`); the send boundary checks the generation and records an unresolved
mutation before forwarding (`project-control-broker.ts:99`). The journal uses
FULL synchronization. Boot identity and process start ticks distinguish a dead
owner from PID reuse; live and unknown ownership cannot be stolen
(`project-control-broker-journal.ts:19`). Recovery also matches the recorded
socket device/inode before unlinking (`:64`), and forwarding checks that the
journal file itself has not been replaced (`:73`).

An acknowledged settings operation or an exactly completed turn clears its
pending marker. A lost acknowledgement or crash during a turn preserves that
marker. The next broker exposes `phase: recovery` with the unresolved method;
inspection reads work, while mutations are refused without replay
(`project-control-broker.ts:226`). This follows the UNKNOWN and guard
satisfiability requirements in `docs/INVARIANTS.md:1072`, `:1102`, `:1183`:
clean recovery has a working writer, while uncertain recovery reports its
missing evidence explicitly.

Validation: 21 broker tests, 103 assertions. Before implementation, two semantic
tests failed because a restarted broker accepted an unused old epoch and
accepted a new mutation after a lost acknowledgement. The recovery suite now
covers actual SIGKILL of idle and active subprocesses, live-owner exclusion,
generation replacement, binding mismatch, private journal permissions and
preservation of an unrelated replacement socket
(`project-control-broker-recovery.test.ts:33`, `:93`, `:106`, `:119`, `:129`,
`:139`). Disabling the unresolved guard made both uncertain-recovery tests fail;
making it unconditional rejected the legitimate settled-settings writer
(`:60`). Both mutations were removed.

Root and Trident TypeScript checks passed using an isolated frozen dependency
installation. The consuming native smoke passed with a disposable Codex home,
PTY and local model fixture: native TUI and gateway used one thread; restarting
the broker and native child rejected the old epoch and continued the same thread
with seed, TUI and gateway history (`project-control-broker.smoke.ts:137`).

This is bounded Linux process recovery, not production lifecycle integration.
The caller must retain the same private socket/journal location, preserve the
journal, and supply a dedicated native child for the same pre-existing thread.
An unresolved mutation remains inspection-only: this change does not invent
model/config reconciliation or a force-clear operation. In particular, it does
not claim orphan native work has stopped when the broker dies. A crash between
socket creation and recording its inode can leave an unprovable socket, which
is refused. Active-turn attachment, approval-owner transfer, model-operation
atomicity and gateway/startup wiring remain outside this change.
