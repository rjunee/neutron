# 2026-08-10 — Two guards that read a value nothing wrote

Round-3 follow-up to `docs/as-built/2026-08-09-notification-is-a-chat-message.md`.
Both defects came out of review, both were guards whose INPUT was never written, and
both had passing tests. That shared shape is the useful part of this entry.

## 1. The re-emit suppression was inert

**What it claimed.** `gateway/http/deliver.ts` computed
`alreadySeen = !emitted.was_new && emitted.was_delivered` and skipped the device
notification when true, so an idempotent re-emit — a reconnect re-render, a retried
ritual-approval prompt — would not buzz the owner about a message already in his chat.

**Why it could not work.** `was_delivered` is derived from `button_prompts.delivered_at`
(`channels/button-store.ts` `emit`, both existing-row branches). The ONLY writer is
`ButtonStore.markDelivered`, and a repo-wide grep found its callers were
`onboarding/interview/engine*.ts` and nothing else. No row created through `deliver` was
ever stamped, so `was_delivered` was false for every one of them, `alreadySeen` could
never be true, and the double-buzz persisted exactly as before. Real producers pass an
`idempotency_key` through this seam — `reminders/ritual-registration.ts` (approval and
egress-approval prompts) and `open/credential-lapse-notice.ts` — so this was live
behaviour, not a hypothetical.

**Why the tests missed it.** The suite's fake ButtonStore returned
`{ was_new: false, was_delivered: true }` from a literal. That exercises the BRANCH and
assumes the WRITE. Two links in a chain, one of them asserted.

**The fix.** After the notification, `deliver` stamps the row:

```
if (durability === 'reply' && (notified || delivered)) await stampDelivered(prompt_id)
```

Three things about that condition are deliberate:

- **`durability === 'reply'` only.** `persistInertAgentTurn` stamps `delivered_at` in its
  own INSERT ("delivered_at is stamped because the caller only persists what it already
  sent"), so a brief or a nudge has nothing left to record. A second write would be a
  redundant UPDATE on every one.
- **Gated on actually reaching him.** The ButtonStore contract's exception is
  load-bearing: `was_new: false` WITH `was_delivered: false` means the row landed in the
  DB but never reached the owner, and the channel adapters re-render in that case. If the
  stamp were unconditional, the first failed buzz would be the last one — an Expo outage
  during the first attempt would silence the message permanently.
- **Swallows its own failure.** The stamp is an audit write on a row that already exists.
  Letting a locked DB surface here would revert the reminder tick's claim and re-post the
  message (`reminders/tick.ts` #319) — trading a possible duplicate buzz for a certain
  duplicate post.

**Which forced a sink contract change.** `ChatMessagePushSink` now resolves `boolean`
rather than `void`, because "did the owner get it?" is now a question with consequences.
It reads `PushResult.ok`, not merely the absence of a throw:
`PushDispatcher.pushAll` CATCHES its own network failure and resolves with `ok: false`
(`gateway/push/dispatcher.ts`). A sink watching only for a throw would have reported an
Expo outage as a delivered notification and stamped the row for a buzz that never
happened — reintroducing the same defect one layer down.

**Test.** `gateway/http/__tests__/deliver.test.ts` gained a suite driving the REAL
`ButtonStore` against a real migrated DB — the only harness in which the write is a fact.
It asserts the buzz count across two deliveries of one key, AND `deliveredAt()` on the
row directly, AND that a refused transport leaves the row unstamped so the retry buzzes.
Mutation-verified: deleting the `stampDelivered` call reds 3 tests. The pre-existing
fakes gained a `markDelivered` so the stamp is a real call rather than a `TypeError`
absorbed by its own catch.

## 2. A legacy General reminder tap opened an error

`resolvePushRoute` emits the mobile RAIL spelling of the no-project scope —
`/projects/~general/reminders` — and `app/lib/reminders-client.ts` interpolated the
segment raw. The gateway's `sanitizeProjectId` rejects `~` (outside its
`[A-Za-z0-9_.-]` alphabet), so the tap opened the app and rendered `invalid_project_id`
where the reminders belong. Not only on push taps: opening General's Reminders tab from
the rail hit the same 400.

Fixed by routing every project segment through `general-scope.ts`
(`httpProjectSegmentEncoded`), which `docs-client` and `tabs-client` already do — the
module exists precisely because the fifth client to talk to a project-scoped surface was
the fifth to forget the mapping.

**The test is a UNION test**
(`app/__tests__/legacy-reminder-push-tap-reaches-general.test.ts`) because both halves
were independently green: it drives the real resolver's output through a router-shaped
segment decode into the real client, and asserts the URL that would go over the wire.
It asserts the absence of the raw sentinel and NOT of `%7E`, and that distinction is the
hazard itself — `~` is an UNRESERVED character, so `encodeURIComponent('~general')`
returns `~general` unchanged. The tilde survives encoding intact and dies at the
validator, which is why the existing "encodes the project_id" test could never see it.
Mutation-verified by restoring the raw interpolation: 2 tests red on `/projects/~general/`.

## 3. Smaller, from the same review

- **The notification can no longer hold a delivery open.** `POST /api/app/system-notice`
  AWAITS `deliver` to answer its caller, and the only bound underneath the notification
  was the Expo client's `EXPO_PUSH_TIMEOUT_MS` of 10 s PER BATCH — so a stalled `exp.host`
  could hold an HTTP response for tens of seconds over a best-effort buzz. Bounded at 3 s
  (`DEFAULT_NOTIFY_TIMEOUT_MS`), and a timeout counts as NOT sent, so the row stays
  unstamped and the next re-emit tries again. Asserted as an ORDERING — the delivery
  resolves while the transport is still outstanding — rather than as elapsed wall-clock
  time (ISSUES #438); the lint gate rejected the wall-clock version, correctly.
  Mutation-verified: removing the bound does not slow the test down, it hangs until
  bun's own timeout kills it.
- **`chatPushExcerpt` clamps its budget.** A 0 / negative / NaN `max` made every branch
  return the bare `…` — a buzz with no words, the one output the function promises never
  to produce. Unreachable from today's single call site, which is why it needed a test
  rather than a promise.
- **A foregrounded owner still gets a banner, and that is now pinned.** `deliver` does
  NOT gate the notification on `delivered_live`, deliberately: Android keeps the app-ws
  socket open while the app sits in the background, so a live socket is a render, not a
  read receipt, and gating on it would silence exactly the case a notification exists
  for. It looked like a bug in review, so there is now a test saying it is not.
- **Five in-code pointers were sending readers to the wrong file.** `reminders/tick.ts`,
  `gateway/push/dispatcher.ts`, `open/__tests__/composition-field-coverage-inventory.ts`,
  `reminders/tick.test.ts` and `tests/integration/reminders-tab-and-push.open.test.ts`
  all named `gateway/proactive/reminder-outbound.ts` as the notification's home — which
  that file's own header explicitly denies ("THE NOTIFICATION IS NOT HERE,
  deliberately"). They now name `gateway/http/deliver.ts` →
  `gateway/push/chat-message-push.ts`. Related: a recorded mutation-test proof referenced
  a `chat_push` field that does not exist in the shipped code, so the verification could
  not be run as written; it now names the real one (`notify:` on the `createDeliver`
  call in `open/composer.ts`).
- **`wire-types/push-kind.ts` documented the retracted encoding.** Its `agent_message`
  entry still said `project_id` was ABSENT for General, contradicting the sender
  (`project_id: input.project_id ?? GENERAL_RAIL_ID`, always a string) and its own
  passing test. The shared contract file is the worst place for a stale encoding, since
  it is what a second implementer would read.
- **`PushPayload` now declares `reminder_id` and `topic_id`.** The decoder reads both,
  and this tsconfig has no `noPropertyAccessFromIndexSignature`, so the reads compiled
  through the index signature and a rename would have compiled too.

## The pattern worth keeping

Both defects are the same failure: **a guard that reads a field, and nothing in the
system writes it.** Both were covered by tests that asserted the reading side against a
fixture supplying the value. This is the docblock-describing-a-mode trap in its
executable form — the CLAUDE.md rule says to grep for the code that ENTERS a mode a
comment describes, and the mechanical version is: *for every condition you branch on,
grep for its WRITER.* If the only writers are in an unrelated subsystem, the branch is
dead and the test proving it is a fixture talking to itself.

The corollary for tests: a fake that supplies the value under test cannot verify the
value is ever produced. Where a guard's correctness depends on a write, the test needs
the real store.
