## 2026-09-14 — Reminder fired means observed delivery (#553)

### Change and evidence

The loop persists an attempt before dispatch, then stamps a one-shot reminder
only after an explicit delivered observation (`reminders/tick.ts:178`,
`reminders/store.ts:227`, `reminders/store.ts:238`). Missing acknowledgements,
void returns and exceptions remain not-yet-known (`reminders/tick.ts:184`,
`reminders/dispatcher.ts:545`). Explicit outbound false is known-not-delivered;
true is delivered, and later failures cannot erase positive evidence
(`reminders/dispatcher.ts:554`). The observation boundary is durable chat-row
acceptance, as provided by `gateway/proactive/reminder-outbound.ts:50`.

Named constants permit five attempts and no attempt starting more than one hour
after the occurrence (`reminders/delivery.ts:2`, `reminders/delivery.ts:4`,
`reminders/delivery.ts:25`). Retry eligibility follows the loop cadence
(`reminders/store.ts:206`, `reminders/store.ts:214`). A successful fifth attempt,
or an attempt whose positive acknowledgement arrives after the window, remains
delivered rather than exhausted (`reminders/store.ts:228`).

### Vocabulary, persistence and decisions

The existing SQL scheduling vocabulary is pending/fired/cancelled
(`reminders/store.ts:40`). It remains separate from delivery observation:
`reminder_delivery` stores the three observations, their timestamps, attempt count
and terminal undelivered reason (`reminders/store.ts:158`). Its SQL CHECK rejects
unclassified observations (`reminders/store.ts:162`); a missing acknowledgement
maps to not-yet-known by default (`reminders/tick.ts:184`). Exhaustion does not
invent a negative observation (`reminders/delivery.ts:11`). An exhausted one-shot
keeps scheduling status pending but is excluded from dispatch by the ledger
(`reminders/store.ts:184`); `getDelivery(id, fire_at)` exposes its terminal reason
and historical occurrence (`reminders/store.ts:173`).

The ledger is bootstrapped through ProjectDb's asynchronous DDL API inside the
reminders module (`reminders/store.ts:157`, `persistence/db.ts:206`). This keeps
the schema change inside the assigned module without changing the constrained
legacy table. The existing transaction implementation holds the writer lock
across the callback (`persistence/db.ts:249`); both attempt accounting and
settlement use it (`reminders/store.ts:191`, `reminders/store.ts:224`). Counts
survive database reopen, and a restarted loop retires a fifth crashed attempt
without a completion callback (`reminders/delivery.test.ts:56`,
`reminders/delivery.test.ts:246`). Recurring exhaustion advances the schedule
atomically while retaining the old occurrence (`reminders/store.ts:203`,
`reminders/store.ts:237`). Settlement checks the attempt and occurrence before
changing scheduling state (`reminders/store.ts:226`, `reminders/store.ts:235`).

The former attempt-as-fired/revert path is replaced by the observation path.
Retries of an unknown send may duplicate delivery within the finite budget.
A delivered ritual notice counts as a turn; silent or skipped execution does
not (`reminders/dispatcher.ts:598`, `reminders/dispatcher.ts:608`).

### Acceptance and verification

Acceptance is pinned in `reminders/delivery.test.ts`: three observations,
persistent retry count, elapsed-time bound, cadence, third-attempt delivery with
one stamp, restart recovery, stale settlement, and preservation of positive
receipts through later failures. The checks were enumerated from the test
file's test declarations; the mutation list below enumerates the predicates and
state transitions changed in delivery.ts, store.ts, tick.ts and dispatcher.ts.

The final targeted command passed **155 tests in seven files**:

```sh
bun test reminders/delivery.test.ts reminders/tick.test.ts reminders/store.test.ts reminders/dispatcher.test.ts reminders/dispatcher.integration.test.ts reminders/owner-timezone-tick.test.ts reminders/bundled-rituals.test.ts
bunx tsc -p reminders/tsconfig.json --noEmit
```

The package typecheck passed. The repository lint script passed. The leak gate
reported zero findings from the rules it ran, but exited 3 (INCOMPLETE) because
the private PII denylist was unavailable; this is not a clean leak-gate result. The first
repository-wide typecheck checked 51 configurations and failed in app, gateway,
logger, onboarding and root. Reported problems include missing @types resolution,
Node timer overloads and the unavailable node:zlib crc32 export at
`onboarding/history-import/__tests__/zip-writer.ts:10`; it also caught a gateway
test helper still declaring Promise<void> for dispatch. Concurrent edits outside
this lane's assigned territory were preserved for the orchestrator. This is not
a claim that the repository-wide typecheck is green. The root package has no
typecheck script; the repository's all-config script was used.

The old tick fixtures asserted fired before dispatch; those assertions described
the defect and were replaced with pending-before-observation assertions
(`reminders/tick.test.ts:82`). The recurring integration fixture advanced eight
days for a weekly reminder, beyond the new window; it now uses the next scheduled
occurrence. The retry fixture now advances one cadence
(`reminders/dispatcher.integration.test.ts:111`,
`reminders/dispatcher.integration.test.ts:167`). Success assertions were retained.

### Mutation evidence

Each mutation was applied to a unique source expression, its actual landing line
printed, and the file's git diff captured before running delivery.test.ts. Each
restoration ran the same test file again. All final rows below are RED with the
mutation (exit 1) and GREEN restored (exit 0).

| Guard and landing | Mutation | Mutated / restored |
| --- | --- | --- |
| attempt bound — `reminders/delivery.ts:25` | `false` | RED / GREEN |
| hour bound — `reminders/delivery.ts:26` | `false` | RED / GREEN |
| hour equality — `reminders/delivery.ts:26` | `now >= fire_at + REMINDER_DELIVERY_WINDOW_SECONDS` | RED / GREEN |
| sql observation vocabulary — `reminders/store.ts:162` | `remove SQL CHECK` | RED / GREEN |
| query exhaustion — `reminders/store.ts:184` | `remove SQL CHECK` | RED / GREEN |
| query delivered — `reminders/store.ts:184` | `remove SQL CHECK` | RED / GREEN |
| query cadence — `reminders/store.ts:184` | `d.next_attempt_at < ?` | RED / GREEN |
| claim schedule status — `reminders/store.ts:193` | `current?.fire_at !== reminder.fire_at` | RED / GREEN |
| claim schedule time — `reminders/store.ts:193` | `current?.status !== 'pending'` | RED / GREEN |
| claim exhausted — `reminders/store.ts:195` | `before?.state === 'delivered'` | RED / GREEN |
| claim delivered — `reminders/store.ts:195` | `before?.exhausted_reason` | RED / GREEN |
| claim cadence — `reminders/store.ts:206` | `if (false) return null` | RED / GREEN |
| duplicate settlement — `reminders/store.ts:226` | `before?.attempts !== attempt` | RED / GREEN |
| delivered stamp — `reminders/store.ts:227` | `const delivered = true` | RED / GREEN |
| rescheduled settlement — `reminders/store.ts:235` | `if (false) return delivered` | RED / GREEN |
| pre-dispatch expiry advance — `reminders/store.ts:203` | `if (false) await this.advanceRecurrence(reminder.id, next_fire_at)` | RED / GREEN |
| completion expiry advance — `reminders/store.ts:236` | `if (delivered) {` | RED / GREEN |
| unknown return — `reminders/tick.ts:185` | `state: 'delivered'` | RED / GREEN |
| positive acknowledgement — `reminders/dispatcher.ts:554` | `if (accepted !== false) receipt.observation` | RED / GREEN |
| negative acknowledgement — `reminders/dispatcher.ts:555` | `accepted !== true && receipt.observation.state !== 'delivered'` | RED / GREEN |
| preserve delivered on unknown — `reminders/dispatcher.ts:545` | `if (true) {` | RED / GREEN |
| preserve delivered on rejection — `reminders/dispatcher.ts:555` | `accepted === false` | RED / GREEN |
| preserve receipt on throw — `reminders/dispatcher.ts:537` | `if (true) {` | RED / GREEN |
| stale settlement — `reminders/store.ts:226` | `before?.state === 'delivered'` | RED / GREEN |
| expiry refusal branch — `reminders/store.ts:197` | `if (false) {` | RED / GREEN |
| no false stamp at exhaustion — `reminders/store.ts:238` | `else await this.markFired(reminder.id, now)` | RED / GREEN |
| skip refused dispatch — `reminders/tick.ts:181` | `if (false) continue` | RED / GREEN |
| unknown observation timestamp — `reminders/store.ts:232` | `now` | RED / GREEN |
| delivered has no exhaustion — `reminders/store.ts:228` | `exhaustionReason(attempt, reminder.fire_at, now)` | RED / GREEN |

Two initially green mutations were findings and were corrected before accepting
these results. Removing the terminal guard still hit the future cadence guard;
the fixture now corrects next_attempt_at too, independently reaching the terminal
condition (`reminders/delivery.test.ts:110`). Removing delivered's exemption from
exhaustion initially had no fifth-attempt positive receipt to distinguish it;
the final fixture delivers on attempt five both inside and across the window.
The stale-settlement mutation's initial printed line matched an earlier identical
replacement substring; its unique original expression was used to print and
rerun the actual landing at `reminders/store.ts:226`.

### Deliberate limits and handoff

No live-push or human-read receipt is claimed. Existing historical fired rows are
not reclassified. No separate retry timer or cancellation protocol for a hung
outbound was introduced; dispatch remains awaited (`reminders/tick.ts:184`).
The ledger protects retry accounting across restarts, while a permanently
unsettled dispatch still holds the existing single-flight loop. Scheduling UI
changes, legacy-table migration and retrospective receipt reconstruction are
outside this module change.

The as-built path follows the explicit build-lane instruction rather than the
repository's default docs/as-built location. Concurrent SPEC, system-overview and
gateway-test edits were not authored as part of this lane and are left for the
orchestrator's scope review. This lane commits reminders/ and this record only;
it does not push, open a PR or merge.
