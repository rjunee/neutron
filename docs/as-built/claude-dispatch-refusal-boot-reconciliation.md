## 2026-09-27 — Reconcile authenticated pre-input refusals without restarting work

Signed original-dispatch receipts were consumable by the runner, but a failed
run is excluded from the ordinary tick (`trident/tick.ts:831`). A restart could
therefore retain a child whose original dispatch actor had durably proved that
it never submitted input. The terminal-state reaper could later remove that
proof. Terminal run status itself is not child-completion evidence: the target
continues to preserve unresolved children and refuses unknown liveness
(`docs/spec-items/project-herdr-workspaces.md:46`, `:79`).

`open/wiring/claude-native-dispatch-reconcile.ts:23` inspects the actual stored
child leases against canonical run/scope and dispatch-attempt rows. The full
request comes from the signed body, authenticated against the exact lease before
use; the database independently binds provider, placement, role, model and
prepared/started attempt. The database does not contain the full request. Reads
use the canonical state root and run/step identity, never request-supplied paths.
Exact-token release still verifies the original pinned signing key. Missing,
unsigned, partial, foreign, submitted or contradictory evidence retains the
lease; no original authority is reconstructed from terminal status.

`open/composer.ts:4502` invokes reconciliation before startup build-lease
reconciliation and artifact reaping, and again inside the existing serialized
recovery loop (`:7047`). It creates no native actor, sends no turn and does not
restart a failed run. `open/wiring/project-build-state-reaper.ts:25` retains the
state of every unresolved child; unreadable or malformed census cannot discard
evidence. Legacy unknown children remain unknown.

The consuming retry regression also confirms that a live-signal same-step retry
uses the existing armed reservation without invoking another actor; a distinct
step remains usable (`runtime/workers/claude-native-dispatch-retry.test.ts:8`).
The per-step exclusive receipt path is unchanged. Accounting explicitly defines
a provider retry as a new step (`trident/attempt-accounting.ts:40`).

Validation: 24 focused mock/temporary-database tests, 54 assertions, including
the actual Open composer at boot and its unattended recurring callback. Both
retain the failed run and assert zero native turns. Negative controls cover
canonical attempt mismatches, missing/unsigned/forged/torn/submitted receipts,
wrong scope, deleted project, duplicate token and unavailable census. Semantic
mutations removing initial recovery, recurring recovery, model binding and
unresolved-child retention each fail their corresponding consuming control;
all mutations were restored. Root, Open and Trident TypeScript checks pass.
No physical-provider, live-host or full-suite validation is claimed here.
