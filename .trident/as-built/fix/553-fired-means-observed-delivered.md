## Reminder delivery observations (#553)

### Change and decisions

The scheduler records a durable attempt before dispatch and stamps a one-shot
fired only after affirmative observation (`reminders/tick.ts:178`,
`reminders/store.ts:227`, `reminders/store.ts:238`). The dispatcher returns
three-valued delivery evidence and preserves an earlier accepted post through
later failures (`reminders/dispatcher.ts:528`, `reminders/dispatcher.ts:554`).
The production boundary is durable chat persistence, not a live push or human
read receipt (`gateway/proactive/reminder-outbound.ts:41`, `:52`). The policy is
recorded in `SPEC.md:294`.

The existing scheduling vocabulary remains pending/fired/cancelled. A separate
module-owned occurrence ledger records delivered, known-not-delivered, and
not-yet-known; SQL rejects an unclassified observation (`reminders/store.ts:158`,
`:162`). Retry disposition is independent of evidence: five attempts or one hour
exhaust the occurrence without manufacturing a negative receipt
(`reminders/delivery.ts:1`, `:24`). Unknown and rejected outcomes retry within
that budget by default; void and thrown dispatches become unknown
(`reminders/tick.ts:184`, `:189`). This can duplicate an uncertain send.
A delivered ritual failure notice counts as a turn; silence does not
(`reminders/dispatcher.ts:531`, `:554`).

The continuous enforcement is the persisted attempt count, next-attempt time,
terminal query filter, and transactional settlement (`reminders/store.ts:179`,
`:190`, `:219`). Counts survive actual database reopen. Expiry runs before
dispatch, so retiring a crashed attempt does not require its completion callback.
Expiry and recurrence advancement share a transaction; settlement preserves an
owner's changed occurrence (`reminders/store.ts:197`, `:235`). Transaction rollback
is tested by refusing schedule writes (`reminders/delivery.test.ts:357`).

Removed the obsolete claim/revert helpers and changed success fixtures to
explicitly acknowledge delivery. The integration clocks now reach the next
occurrence and retry cadence while retaining their delivery assertions
(`reminders/dispatcher.integration.test.ts:111`, `:167`). Gateway routing and
timezone fixtures retain their assertions and use the new receipt contract
(`gateway/composition/build-core-modules-ritual-planner.test.ts:66`,
`gateway/__tests__/reminders-owner-timezone-wiring.test.ts:64`).

### Validation

- Final continuation: 336 passed, zero failed, 1152 assertions across 19 files.
  The files were all 16 `reminders/**/*.test.ts` files (enumerated with
  `rg --files reminders`) plus `gateway/__tests__/reminders-owner-timezone-wiring.test.ts`,
  `gateway/composition/build-core-modules-ritual-planner.test.ts`, and
  `gateway/push/__tests__/ritual-post-notifies-as-a-chat-message.test.ts`.
  Five existing external-service skips remain; no assertion or skip was weakened.
- Removed the duplicate clock increment left by concurrent edits at
  `reminders/dispatcher.integration.test.ts:167`; its five tests passed again.
  A broader five-file run passed 11 tests but failed 23 listener-dependent tests
  in `gateway/__tests__/reminders-production-composer.test.ts` and
  `gateway/__tests__/reminders-core-chat-composer.test.ts`. Their listener setup
  (`:141` and `:175`, respectively) failed with EADDRINUSE on port zero; a
  standalone `Bun.serve({port: 0, ...})` control failed identically. These broader
  suites are not certified green. The outbound and tool-surface suites in that
  run passed. No listener fixture was bypassed to hide this environment failure.
- `bunx --no-install tsc -p reminders/tsconfig.json --noEmit`: passed.
- `bun run typecheck`: no script is defined; ran the repository's
  `scripts/ci/typecheck-all.sh` instead (51 configurations). It failed on external
  type/dependency diagnostics. A final gateway typecheck still reports the byte
  array matcher at `gateway/transcription/__tests__/whisper-install.test.ts:186`
  and the missing zlib export at `onboarding/history-import/__tests__/zip-writer.ts:10`.
  The full matrix also reports an app implicit type-library resolution error and
  the event-listener overload at `logger/__tests__/fire-and-forget.test.ts:301`.
  These diagnostics are unresolved; repository-wide typechecking is not green.
- `bash scripts/ci/lint.sh` and `git diff --check`: passed.
- Leak gate: zero findings in executed rules, but INCOMPLETE because the private
  PII denylist was unavailable. This is not a clean leak-gate result.

### Mutation evidence

Each row below was run alone against `reminders/delivery.test.ts`. The changed
line and the before/after file diff were printed before the test. Every row went
RED and then GREEN after restoration. Concurrent writes in the build worktree
invalidated an initial run; the completed proofs used an isolated copy.
Executable source was compared with the build worktree as detailed below.
The final continuation independently ran 31 mutations, with exit 1 mutated
and exit 0 restored for every row. Executable source and the mutation suite were
compared with the build worktree; concurrent differences were confined to store
doc comments and the separate integration clock fixture. The settlement
transaction proof was rerun after synchronizing those comments, printing the
actual changed line (`reminders/store.ts:224`) before testing.
The initial exhausted-state fixture was masked by its future cadence timestamp;
resetting that timestamp made the terminal guard reachable independently
(`reminders/delivery.test.ts:110`). A last-attempt success fixture also reaches
the positive-receipt exemption independently (`reminders/delivery.test.ts:336`).

| Guard and landing line | Mutation | Test that went red | Restored |
| --- | --- | --- | --- |
| attempt bound (`reminders/delivery.ts:25`) | `false` | bounds include five attempts and the full hour | GREEN |
| hour bound (`reminders/delivery.ts:26`) | `false` | bounds include five attempts and the full hour | GREEN |
| hour equality (`reminders/delivery.ts:26`) | `now >= fire_at + REMINDER_DELIVERY_WINDOW_SECONDS` | bounds include five attempts and the full hour | GREEN |
| sql observation vocabulary (`reminders/store.ts:162`) | `remove SQL constraint` | database refuses an unclassified delivery observation | GREEN |
| query exhaustion (`reminders/store.ts:184`) | remove exhausted predicate | query excludes exhausted, delivered and waiting rows before applying limit | GREEN |
| query delivered (`reminders/store.ts:184`) | remove delivered predicate | dispatch query filters cadence, delivered and terminal rows before its limit | GREEN |
| query cadence (`reminders/store.ts:184`) | `d.next_attempt_at < ?` | lost completion survives restart and time expiry never stamps fired | GREEN |
| claim schedule status (`reminders/store.ts:193`) | `current?.fire_at !== reminder.fire_at` | claim rejects cancelled, moved, terminal, and early attempts | GREEN |
| claim schedule time (`reminders/store.ts:193`) | `current?.status !== 'pending'` | claim rejects cancelled, moved, terminal, and early attempts | GREEN |
| claim exhausted (`reminders/store.ts:195`) | `before?.state === 'delivered'` | claim rejects cancelled, moved, terminal, and early attempts | GREEN |
| claim delivered (`reminders/store.ts:195`) | `before?.exhausted_reason` | claim rejects cancelled, moved, terminal, and early attempts | GREEN |
| claim cadence (`reminders/store.ts:206`) | `if (false) return null` | claim rejects cancelled, moved, terminal, and early attempts | GREEN |
| stale settlement (`reminders/store.ts:226`) | `before?.state === 'delivered'` | stale or duplicate observation cannot overwrite a newer attempt or delivery | GREEN |
| duplicate settlement (`reminders/store.ts:226`) | `before?.attempts !== attempt` | stale or duplicate observation cannot overwrite a newer attempt or delivery | GREEN |
| delivered stamp (`reminders/store.ts:227`) | `const delivered = true` | outbound false has an explicit durable observation | GREEN |
| rescheduled settlement (`reminders/store.ts:235`) | `if (false) return delivered` | delivery preserves concurrent owner reschedule | GREEN |
| pre-dispatch expiry advance (`reminders/store.ts:203`) | `if (false) await this.advanceRecurrence(reminder.id, next_fire_at)` | expired recurring occurrence advances atomically without a delivery stamp | GREEN |
| completion expiry advance (`reminders/store.ts:236`) | `if (delivered) {` | recurring fifth failure advances only its occurrence and retains history | GREEN |
| unknown return (`reminders/tick.ts:185`) | `state: 'delivered'` | attempt three stamps fired once and only once | GREEN |
| positive acknowledgement (`reminders/dispatcher.ts:554`) | `if (accepted !== false) receipt.observation` | outbound void has an explicit durable observation | GREEN |
| negative acknowledgement (`reminders/dispatcher.ts:555`) | `accepted !== true && receipt.observation.state !== 'delivered'` | outbound void has an explicit durable observation | GREEN |
| preserve delivered on unknown (`reminders/dispatcher.ts:545`) | `if (true) {` | ritual notices preserve positive evidence through later rejection, silence or throw | GREEN |
| preserve delivered on rejection (`reminders/dispatcher.ts:555`) | `accepted === false` | ritual notices preserve positive evidence through later rejection, silence or throw | GREEN |
| preserve receipt on throw (`reminders/dispatcher.ts:537`) | `if (true) {` | ritual notices preserve positive evidence through later rejection, silence or throw | GREEN |
| expiry refusal branch (`reminders/store.ts:197`) | `if (false) {` | lost completion survives restart and time expiry never stamps fired | GREEN |
| no false stamp at exhaustion (`reminders/store.ts:238`) | `else if (true) await this.markFired` | known-not-delivered exhausts across actual database reopen without firing | GREEN |
| skip refused dispatch (`reminders/tick.ts:181`) | `if (false) continue` | fifth crashed attempt exhausts on restart without a completion callback | GREEN |
| unknown observation timestamp (`reminders/store.ts:232`) | `now` | outbound void has an explicit durable observation | GREEN |
| delivered has no exhaustion (`reminders/store.ts:228`) | `exhaustionReason(attempt, reminder.fire_at, now)` | positive evidence on the last attempt wins over retry exhaustion | GREEN |
| claim transaction (`reminders/store.ts:191`) | `return ((f) => f())(async () => {` | expiry and settlement roll back their ledger when schedule advancement fails | GREEN |
| settlement transaction (`reminders/store.ts:224`) | `  ): Promise<boolean> {     return ((f) => f())(async () => {` | expiry and settlement roll back their ledger when schedule advancement fails | GREEN |

### Documentation sweep and limits

The search `rg -n 'revertRecurrenceAdvance|claims each due row BEFORE dispatch|CONSUMED HERE|rejected settle notice|ReminderStore.listDispatchable'`
found the positive control at `reminders/tick.ts:6`. Current module guidance and
the system overview were corrected. The remaining historical hits at
`docs/AS_BUILT.md:13094`, `:21408`, and `:24719` stay because that log is frozen.
The whole-tree TypeScript search for `revertRecurrenceAdvance`, `.reopen(` and
`markFired(` found the old helper definition and the positive-control markFired
callers before removal; there were no external revert callers in that search.

No transport protocol, human read tracking, live-delivery acknowledgement,
retention sweep, or outbound timeout was added. The ledger initializes lazily
before tick queries (`reminders/tick.ts:172`), rather than changing the existing
schedule-status constraint. Exhausted one-shots remain pending in existing
schedule APIs, with the terminal disposition available in the delivery ledger.
Historical fired rows are not reinterpreted. The retry policy bounds later
attempts after restart; it does not impose a timeout on an outbound call already
in flight. No push, PR creation, or merge was performed.
