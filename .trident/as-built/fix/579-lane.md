## 2026-09-14 — Keep suppressed alerts eligible for notification retry

### Change and acceptance evidence

Issue #579: a successful live push used to complete a reply even when its configured notification sink suppressed the notification. The completion predicate now requires notification success for notification-eligible replies; live delivery completes only explicitly quiet envelopes or deliveries without a configured sink (`gateway/http/deliver.ts:447`, `gateway/http/deliver.ts:465`). This fixes the shared seam without classifying individual producers. The filed stable-key examples remain at `open/credential-lapse-notice.ts:133` and `cores/free/email/src/pipeline/escalate.ts:171`.

The real-store regression at `gateway/http/__tests__/deliver.test.ts:707` verifies: foreground live delivery persists a row with a non-null ID and NULL delivery timestamp; expiring presence and disconnecting live delivery lets the same key notify; notification success stamps that same row; a third emit stays quiet. Failure controls cover a false result, exception and timeout with a successful live socket (`gateway/http/__tests__/deliver.test.ts:740`). Explicit quiet posts still complete and deduplicate (`gateway/http/__tests__/deliver.test.ts:766`); the existing unwired-sink control remains at `gateway/http/__tests__/deliver.test.ts:695`.

### Decisions and continuously maintained state

The existing vocabulary is `ChatMessagePushSink`'s boolean result (`gateway/push/chat-message-push.ts:347`), `EmitResult.was_delivered` derived from the durable timestamp (`channels/button-store.ts:259`), and `DeliveryResult` (`gateway/http/deliver.ts:135`). This change adds no outcome. A configured sink's false result does not satisfy the notification obligation. Unknown success after a timeout or exception also cannot satisfy it (`gateway/http/deliver.ts:238`, `gateway/http/deliver.ts:317`). An unwired sink is an explicit configuration state (`gateway/http/deliver.ts:311`), distinct from a configured sink reporting zero recipients (`gateway/push/chat-message-push.ts:389`).

The stamp guard runs on every durable reply delivery before the idempotent database write (`gateway/http/deliver.ts:465`; `channels/button-store.ts:512`). The next emit reads that stored state before its early return (`gateway/http/deliver.ts:394`, `gateway/http/deliver.ts:411`). Presence expiry is maintained on read by the tracker, independent of a dead browser reporting departure (`gateway/push/web-presence.ts:153`, `gateway/push/web-presence.ts:176`). The regression advances an injected clock, requiring no cooperation from the expired connection.

The tests are armed through CI's partitioned runner (`.github/workflows/ci.yml:437`), its discovery call (`scripts/run-tests.sh:240`), and the test-file glob (`scripts/lib/discover-test-files.sh:25`).

### Mutation evidence

Each mutation was applied alone; its landing line was printed and the file diff shown before running `bun test gateway/http/__tests__/deliver.test.ts`. All were restored. The table enumerates the four mutations executed for this change.

| Guard / branch | Mutation and landing line | Red result | Restored result |
| --- | --- | --- | --- |
| Notification obligation | Restore `(notified || delivered)` at `gateway/http/deliver.ts:465` | 4 failures: foreground retry and false/throw/timeout controls | 41 pass |
| Unwired-sink completion | Remove `input.notify === undefined` at `gateway/http/deliver.ts:447` | 1 failure: existing live-only control at test line 695 | 41 pass |
| Explicit quiet completion | Remove `envelope.notify === 'suppress'` at `gateway/http/deliver.ts:447` | 1 failure: quiet deduplication at test line 766 | 41 pass |
| Successful notification completion | Remove `notified` arm at `gateway/http/deliver.ts:465` | 7 failures, including successful retry stamping and existing single-buzz control | 41 pass |

### Validation

- `bun test gateway/http/__tests__/deliver.test.ts gateway/push/web-presence.test.ts`: 58 pass, 0 fail; the changed test file contributes 41 passing tests.
- Additional `gateway/http/__tests__/replay-redelivery.test.ts`: 14 pass, 1 fail at line 476 (pending respawn wait). Replacing delivery code with the original HEAD version reproduces the same failure. No assertion was weakened or skipped.
- `bash scripts/ci/lint.sh`: passed all checks.
- `bash scripts/ci/typecheck-all.sh`: completed 51 configs; failed configs, enumerated from its `FAIL` lines: `app/tsconfig.json`, `gateway/tsconfig.json`, `logger/tsconfig.json`, `onboarding/tsconfig.json`, `tsconfig.json`. Errors include the missing implicit `@types` library, the Uint8Array assertion at `gateway/transcription/__tests__/whisper-install.test.ts:186`, the event-listener overload at `logger/__tests__/fire-and-forget.test.ts:301`, and the zlib import at `onboarding/history-import/__tests__/zip-writer.ts:10`. A separate gateway typecheck with BOTH edited files restored to HEAD reproduced its identical two errors. The final fixed files were restored and the 58 targeted tests rerun green.
- `bash scripts/ci/leak-gate.sh --tree .`: exit 3, incomplete because the private file/message denylist was unavailable; zero findings from rules that ran. This is not a clean leak result. The orchestrator must complete that check with its denylist.
- `git diff --cached --check`: passed. The record has exactly one level-two heading.

### Scope and deliberate limits

No producer retry scheduler, database schema, historical timestamp repair, or transport API expansion was added. Re-emission remains the trigger; the change does not automatically send an alert when presence expires. The existing live push is attempted on an unstamped retry (`gateway/http/deliver.ts:413`), so notification failure can cause repeated live frames carrying the same prompt ID. A late notification after timeout can still produce a duplicate buzz (`gateway/http/deliver.ts:226`). The separate transcript-loss limitation remains documented at `gateway/http/deliver.ts:449`.

The old acceptance-of-silence commentary was removed from the delivery seam. A tree-wide search for `THE COST OF THE|delivered.*notified|reached by some transport|delays an alert|it is in the transcript` found the old code as its positive control and historical `docs/AS_BUILT.md:12859`; that frozen history stays untouched. The intended suppression behavior is already documented at `docs/SYSTEM-OVERVIEW.md:4529`, so this is a defect correction, not a product decision change. The as-built location follows the explicit lane instruction overriding the repository's normal shard location.
