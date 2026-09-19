## 2026-09-19 — Settle durable broker mutations before acknowledging them

Independent review found that a successful settings request resolved before its
durable pending marker was cleared. A caller that immediately closed the broker
after awaiting that request left the next generation inspection-only. The prior
test's timer yielded to the settlement callback and hid the race.

`runtime/adapters/codex-cli/persistent/project-control-broker.ts:199` now clears
the completed work and commits journal settlement before resolving its caller
(`:214`). Active turns retain their marker. A failed settlement closes the broker
and rejects acknowledgement, preserving the uncertain outcome for recovery.
Native refusals also finish settlement before rejecting the caller (`:223`).

The exact await-request / close / reopen sequence failed before the fix and
passes without a timer (`project-control-broker-recovery.test.ts:60`). Companion
tests preserve an acknowledged active turn across immediate close (`:70`) and
force a real SQLite settlement failure with a trigger, proving that the caller
does not receive success and the next generation retains its pending marker
(`:81`). A bypass mutation clearing active-turn markers failed the active-turn
test; an overapplication mutation withholding completed settlement failed the
immediate settings restart test. Both controls were restored.

Validation: 23 broker tests, 109 assertions; root and Trident TypeScript checks;
native consuming smoke with a disposable home and local provider. The smoke
retained native TUI/gateway sharing and conversation history after restart.
Production binding attestation, bootstrap and uncertain-outcome reconciliation
remain outside this ordering repair.
