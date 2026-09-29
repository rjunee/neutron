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

The first integrated shared-host gate passed all 51 TypeScript projects and
declared, discovered and executed the same 1,755 test files across 19 lanes.
It exited 1: four tests failed in two lanes. Both explicit later-migration lists
in `migrations/__tests__/live-ledger-125-repair.test.ts:93,177` omitted migration
0162, while the identity registry had not classified the observer's child-ID
validation regex (`runtime/workers/claude-child-observation.ts:55`). The suite
input identity remained unchanged through that run:
`d7db3bb78e5ee9effaa9655b36533b92a0c35efa2cc28292a1927c642cc677e6`.

The bounded validation repair appends 162 to both explicit ordered lists and
registers that broad regex conservatively
(`tests/integration/identity-env-readers-registry.test.ts:254–255`). The added
control at `tests/integration/identity-env-readers-registry.test.ts:970–980`
detects the observer as a regex candidate, rejects actual env-read classification,
and recognizes `migrations/db-path.ts` as the actual-reader positive control.
The migration repair, identity registry and observer suites reproduced the four
failures (43 passing tests, 169 assertions), then passed after repair (48 tests,
190 assertions). Removing the registry entry caused its two completeness guards
to fail; removing 162 from the explicit lists caused both migration assertions
to fail. Restoring both repairs passed the same three suites again. These were
semantic assertion failures. The corrected integrated full gate passed as
recorded below; the focused proof alone did not replace it.

### Corrected consolidated publication receipt

On 2026-09-29, the exact frozen candidate
`0263fc765483da84046bdbbb013f0bb03ac9c460` passed
`bash scripts/check-shared-host.sh` with exit status zero. All 51 TypeScript
configurations passed, including the root and Trident configurations. All
1,755 declared, Bun-discovered, assigned and executed files matched across
19 lanes: 1,517 general, 22 PGLite, 43 device and 173 real-HTTP files, with
zero failed lanes. The consuming E2E suite and five new reconciler controls
passed. Conditional skips remain skips, not claimed execution.

Suite input identity remained unchanged:
`e07929d1bfc812c1d7804e7f650179d6761950f72c240a90de5ece4dc791704a`.
The complete gate, including TypeScript checks, took 25 minutes 11.672 seconds
(09:25:21.683–09:50:33.355 UTC).

This receipt records that exact tested candidate. The subsequent publication
commit only updates this record. It changes no runtime, tests or configuration.
The canonical identity is HEAD-bound, so the publication commit has its own
identity and does not inherit the tested candidate’s receipt.
It does not claim that the later documentation commit ran this
gate or transfer suite authority to another checkout. Required CI must pass on
the exact final publication head. Deployment, served controls, live acceptance
and measured efficiency savings remain unverified; #1196 stays open.

### Deliberate boundary

This is later observed-prefix enrichment, not proof that all lifetime tokens are
complete. A transcript may remain partial or later disappear. Attempts without
a successfully captured original host binding are not retroactively trusted.
No stop notification or transcript text becomes result, cancellation, admission,
or lease-release authority. No provider/model/configuration change, live database
write or paid probe was performed for this slice. The initial integrated gate
was red; the corrected candidate's full gate passed as recorded above.
