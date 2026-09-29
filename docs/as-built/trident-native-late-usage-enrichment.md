## 2026-09-29 — Retain native child usage after accepted results

Implements the observed-spend slice of #1196, not completion of the whole
efficiency item. The governing contract is
`docs/spec-items/trident-build-efficiency.md:100–115`: failed and successful calls
retain measured spend, restart cannot count a call twice, and telemetry cannot
authorize or veto a result. `docs/spec-items/trident-phase-accounting.md:11–25`
keeps unknown metrics NULL and distinguishes metric coverage from workflow
completion. The locked pivot's same-provider native-child placement and existing
gates remain unchanged (`docs/plans/harness-orchestrator-pivot-2026-09-11.md:94–111`,
`:265–274`).

### Cause and implementation

A valid result can be collected before the provider writes its last assistant
acknowledgement. The first accounting snapshot therefore need not include that
message. Result acceptance subsequently deletes live child admission, so an
unsigned observation locator cannot become durable archival authority.

`runtime/workers/claude-native-dispatch-receipt.ts:37–70` exposes a fresh deep copy
of the independently supplied original admission pin. Before downstream result
acceptance releases admission, `open/wiring/project-build.ts:604–619` verifies the
child-bound signed receipt against that pin and the complete original request,
then archives it with the host-computed transcript directory and observation
time. Archival failure remains advisory. It neither changes the accepted outcome
nor retains otherwise releasable admission.

Migration 0162 adds an optional per-attempt association in the host database.
There is no inferred binding for old attempts. `trident/attempt-ledger.ts:71–109`
owns immutable insert/conflict refusal, terminal-attempt selection, a separate
last-checked cursor, and overlap refusal across ledger wrappers sharing the
canonical database. `trident/native-usage-binding.ts:15–25` checks the canonical
prepared/started Anthropic in-REPL attempt, role/model and signed request before
use. The archived original generation remains historical evidence; a newer
admission generation neither replaces it nor authorizes a new call.

`open/wiring/claude-native-usage-reconcile.ts:16–39` checks owner/project scope and
reads only the archived parent session and exact child ID. It does not rediscover
a child through mutable metadata. Each pass takes at most 16 candidates, checking
a one-second scheduling budget before each candidate; each transcript read uses
the existing 250 ms timeout, 8 MiB snapshot and 256 KiB line bounds, regular-file
and no-follow checks (`runtime/workers/claude-child-observation.ts:11–48`). The
scheduling budget is not a hard wall around database I/O. Last-checked ordering
makes later bindings eligible on subsequent ticks instead of starving behind
the first batch. `open/composer.ts:4603–4622` invokes this passive path on existing
startup and recurring recovery. No provider dispatch, result validation, lease
mutation or workflow transition capability is supplied to the helper.

Existing `AttemptAccounting.observe` and `TridentAttemptLedger.observe` remain
the only cumulative accounting writers. Distinct provider messages contribute
once; repeated streaming blocks retain per-field maxima. Missing, malformed,
foreign, regressed or unavailable observations preserve earlier measured spend.
Cost stays NULL. Host observation timestamps improve independently of phase
completion and do not rewrite the attempt or run outcome.

### Verification

Focused accounting, phase usage, signed receipt, bounded observer and passive
recovery tests pass, including actual Open startup and periodic recovery without
a turn. Migration runner and schema snapshot tests cover the added table.
Root, Open and Trident TypeScript checks pass.

The consuming `open/__tests__/project-build-e2e.test.ts` cases run by name are:

- `accepted native result archives authority before lease release and enriches late ACK usage after restart`;
- `native usage archive failure cannot veto an accepted result or retain its released admission`;
- `attempt accounting reconciles pre-crash provider spend through actual pending gateway recovery without dispatch or approval`.

All three pass (46 assertions). The first executes real project-build wiring,
accepts and merges a result, confirms admission deletion, appends duplicate late
ACK rows, reopens the host database, and verifies cumulative enrichment once
without dispatch or changed run/attempt state. Unit controls cover advanced
generation, missing/malformed archives and files, partial-to-known measurements,
self-selected replacement keys, changed requests, foreign identities, symlinks,
oversized/stalled reads, legitimate siblings, concurrent pass refusal, and a
second recovery tick reaching the legitimate binding after 20 earlier entries.

Sixteen temporary semantic mutations failed at their intended executable
assertions, then were restored: reject every valid archive; accept an altered
full request; allow archive replacement; expose a mutable pin; allow overlapping
passes; lift the candidate bound; starve later bindings; ignore the scheduling
deadline; accept foreign owner/project scope; accept foreign canonical identity;
rediscover metadata; suppress live archival capture; let archive failure veto
the result; select the wrong archived child; permit traversal IDs; and remove
the production startup hook. Positive legitimate controls pass after restoration.
The two live-capture/result-veto mutants fail in the named consuming E2E tests;
the startup-hook mutant fails in actual Open composition, not a helper mock.

### Deliberate boundary

This is later observed-prefix enrichment, not proof that all lifetime tokens are
complete. A transcript may remain partial or later disappear. Attempts without
a successfully captured original host binding are not retroactively trusted.
No stop notification or transcript text becomes result, cancellation, admission,
or lease-release authority. No provider/model/configuration change, live database
write, paid probe or full-suite run was performed for this slice; the integrated
full gate belongs to the publishing batch.
