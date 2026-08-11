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

---

## Round-3 review fixes — `ok: true` is not a delivery, and a ritual row must never nudge

Two blockers from the adversarial review round, both fixed here.

### 1. A push that reached nobody was recorded as delivered

`gateway/push/chat-message-push.ts` decided "was this notification sent?" by looking at
`PushResult.ok` alone. But `ok` means only *no HTTP/network exception*, and it is `true`
in two ordinary cases where nothing was delivered:

* **zero registered devices** — `gateway/push/dispatcher.ts` short-circuits with
  `{ attempted: 0, delivered: 0, ok: true }` and never calls Expo. This is the state of
  every fresh install.
* **every ticket errored** — e.g. all tokens `DeviceNotRegistered` after a reinstall.
  `{ delivered: 0, errored: N, ok: true }`, because the gateway did receive the tickets.

In both, the sink answered `true`, `gateway/http/deliver.ts` stamped `delivered_at`, and
the idempotent re-emit was silenced **forever** for a message the owner never got — the
precise failure that file's own docblock claims to prevent.

The sink now requires a numeric `delivered >= 1`, and **fails closed**: a result that
does not report a count has proven nothing. That inverts the previous contract, which
said "anything without an explicit `ok: false` counts as accepted, so a fake that
resolves `undefined` reads as success" — that permissive default is what let this
through, and it meant the test doubles could not distinguish "accepted for a device"
from "sent nowhere". Fixtures now carry the count.

### 2. The `ritual:<id>` token could still reach the owner, by a second route

`ritual_planner` is null on a box with no LLM (`init_ritual_planner` never runs), and
`reminders/dispatcher.ts` then classified **every** row as a nudge — including ritual
rows, whose stored `message` IS the dispatch token. So the token went through
`classifyReminderMessage` as literal intent and the lock screen read `ritual:kaizen`
again, arriving by a completely different path from the one this lane originally fixed.

The comment on `ritualPlanner` in `open/composer.ts` called that fall-through
"fail-closed: nothing reads a ritual's prompt" — true about the prompt, silent about the
notification, and it made a null planner read as harmless. The dispatcher now refuses a
ritual row outright when it cannot plan one, keyed on `reminder.ritual_id`
(`reminders/store.ts:59`) rather than on the shape of the message text: the column is
what makes the row a ritual, and a prefix test would also swallow a plain reminder the
owner happened to word that way. The composer comment now says what actually makes the
null safe.

### Verification

Each guard was mutation-tested by deleting it and confirming a red run: the delivery
guard kills 3 of its 4 new cases (the fourth, "one accepted ticket among failures IS a
delivery", is the positive control and must keep passing), and the ritual-row guard
kills the no-planner case. A second control asserts a **plain** reminder still fires
normally with no planner — without it the fix could have traded one reported bug for a
much worse unreported one.

📌 **Both fixes are the same shape as the two above them in this document: a success
signal that was weaker than the thing it was taken to prove.** `ok` was read as
"delivered"; "no prompt was read" was read as "nothing leaked". In each case the
narrower true statement was sitting right next to the broader false one.

---

## Round-4 review fixes — refusing to compose is only half of a refusal

### 1. The refused occurrence was consumed in silence

The round-3 fix above stopped a ritual row from composing its dispatch token when no
planner is wired. It then returned normally with a single `log()` line — and the next
review round found what that hid.

`reminders/tick.ts` claims an occurrence BEFORE dispatch (`markFired` /
`advanceRecurrence`) and reverts only in its `catch`. A normal return therefore RETIRES
the occurrence. And the `log` seam defaults to `dispatcherLog.debug`, which
`open/composer.ts` does not override. So a scheduled ritual on an instance with no model
credential vanished completely: no post, no ledger row, no journal line at the default
level, and nothing to distinguish it from a ritual that was never scheduled. That is the
ISSUES #506 shape, and `reminders/AGENTS.md` states the contract the other way round —
for a ritual, a failure is **recorded and noticed**.

Reachable without any exotic state: `init_ritual_planner` is gated on `llmPool !== null`
(`open/composer.ts`), so an expired or removed model credential is enough, and the
rituals keep firing into a null planner meanwhile.

Both halves now happen:

- **Recorded** — `dispatcherLog.error('ritual_unplannable', { reminder, ritual_id, reason })`,
  at a level nothing has to opt into.
- **Noticed** — one plain-language chat post, `formatRitualUnplannableNotice`
  (`reminders/ritual-delivery.ts`): *"Ritual 'x' did not run: this instance has no model
  configured, so its approved prompt could not be checked or composed. This occurrence
  was skipped, not retried."*
- **And if the notice itself is refused, the dispatcher THROWS**, which reverts the tick's
  claim and leaves the row pending. Consuming the occurrence is only defensible because
  the owner was told; if he was not told, it must not be consumed. Same posture as the two
  sibling post sites, and the #319 contract holds because the throw is before any
  successful delivery.

**Three deliberate non-choices, recorded so they are not mistaken for oversights.**
*It does not throw on the ordinary path*: a missing credential cannot resolve by the next
tick, so throwing would re-fire the row every 30 s until an operator intervened — the
same reasoning the planner's own `skipped` branch rests on. *It writes no
`code_ritual_runs` row*: the ledger writer and the run-id mint both live inside the
planner, which is the absent thing, and `skip_reason` is a closed set at the schema level
(`migrations/0106_ritual_schema.sql`) with no member for this state — so the record is the
error log and the notice is what reaches the owner. *The notice cites no run id*, because
a fabricated one would send him to `rituals_status` hunting a run that was never written.

**Tests** (`gateway/push/__tests__/ritual-post-notifies-as-a-chat-message.test.ts`). The
arm that used to assert `expect(chain.expo).toEqual([])` now asserts exactly ONE
notification whose body is a sentence and not the token — the old emptiness was the bug,
not the proof. Two arms beside it pin the deliberate halves: the occurrence resolves
rather than throwing on the ordinary path, and a REJECTED notice rejects. Mutation-
verified: replacing the post with `const noticed = true` reds 2, and neutering the
`if (!noticed)` throw reds 1.

### 2. Two comments that a reader would have been right to trust

Both in `gateway/push/chat-message-push.ts`, both found by probing the claim rather than
reading it — and one of them was hiding a real behaviour gap.

- **"the untrimmed clip … cannot be empty because `flat.length > budget >= 1`".** It can.
  At budget 1 a leading emoji clips to a lone high surrogate, `dropDanglingSurrogate`
  removes it, and the fallback is `''`: `chatPushExcerpt('😀 hello', 1)` walks that path.
  The output is right, but the invariant is held by the `hasVisibleContent(kept)` check
  below — not by this line — and a reader trusting the old claim would have thought that
  check redundant and deleted it. Comment corrected, and a test now makes deleting it red.
- **`hasVisibleContent` claimed emoji-only posts count; flags did not.** A regional-
  indicator pair carries no `\p{L}`, `\p{N}` or `\p{Extended_Pictographic}`, so a `🇺🇸`
  body read as EMPTY and sent no notification at all, while `✅` (a pictograph) sent one.
  This one is a real defect rather than a wrong comment: `\p{Regional_Indicator}` joins the
  class. Mutation-verified by removing it. The boundary that is still deliberate — `→`,
  `✓`, `★`, `•` are NOT content, because Unicode does not call them emoji and a shade
  containing one arrow says only that something happened — now has both a docblock naming
  it and a test asserting it, so the next reader does not "finish the job" by admitting
  every `\p{S}`.

### 3. And one seam named rather than closed

`withTimeout` in `gateway/http/deliver.ts` bounds the notification at 3 s but does not
CANCEL it. If Expo answers at 3.1 s the buzz still goes out, while the call already
reported not-sent and left the row unstamped — so the next idempotent re-emit buzzes
again: one message, two banners. Left as is and documented in place. Cancellation means
threading an `AbortSignal` through `ChatMessagePushSink` into the Expo client, and what it
buys back is a duplicate notification of a message that is correct and present in the
transcript either way. The opposite default — treating a timeout as sent — is the one that
loses information, and it is the defect this document opens with.

📌 **The round-3 fix and the first comment above are the same error at different scales:
a guard was written, and the question "what happens on the path it now takes?" was not
asked.** Refusing to compose the token was correct and left the occurrence consumed;
falling back to the untrimmed clip was correct and left the string possibly empty. In both
cases the code after the guard was doing work the guard's author had stopped thinking
about.

## Round 5 — a latch that is never released is a one-shot feature

Cross-model review (codex, `gpt-5.6-sol`) found the one reachable defect the Opus lanes
missed, and it was in this change's own new code: `honouredDeepLink` in
`app/components/ChatSyncSurface.tsx` latched the honoured target id and nothing ever
cleared it.

The sequence that breaks: tap the notification for X (the transcript re-anchors, X is
latched), rail-tap to another project — `/projects/<other>/chat`, no query, so no target —
then tap the SAME notification again, which is still sitting in the shade. The equality
check swallowed it and the transcript did not move.

**It survives the project switch because nothing here is remounted.** The shell is a single
root-stack screen named `projects/[id]`, and expo-router only diverges on a route named
exactly `[id]`, so a rail tap RE-RENDERS this component rather than replacing it
(`app/app/projects/[id]/_layout.tsx` carries the device-instrumented note). FlashList has
no `key` either, so it keeps `isInitialScrollComplete` latched across the switch and the
frozen render-path anchor cannot act on the way back. The imperative seam was the only
thing that could move the transcript, and it had disqualified itself.

The fix is that the target is a PER-VISIT instruction: a render with no target clears the
latch, so a visit without one cannot leave a spent instruction behind. Mutation-verified —
restoring the bare `if (deepLinkTarget.length === 0) return;` reds the new sixth arm of
`app/__tests__/chat-push-tap-lands-on-the-message.test.tsx` and nothing else.

Same review raised a second, weaker one that is worth writing down because the mechanism is
real even where the consequence is not. `scrollToIndex` is typed
`(params) => Promise<void>`, and its executor calls `recyclerViewManager.getLayout(index)`
synchronously, which THROWS when the layout manager is not yet initialised — a throw inside
a Promise executor is a rejection, and the call site dropped it, so that is an unhandled
rejection. It is now caught. What is NOT done, deliberately: re-arming the latch on a
rejection. The only state that can reject is a list whose native layout has not landed,
which is the cold open where the frozen `initialScrollIndex` owns the position anyway, and
re-arming would let a later `rows` commit yank a transcript the owner was already placed in
correctly. Not mutation-tested — the FlashList test stub cannot reject — and said plainly
rather than claimed.

📌 **A "once per X" latch needs a stated release condition, or "once" silently means "once
per process".** The docblock said "ONCE PER TARGET" and the code honoured it exactly; what
was never written down is that a target is scoped to a VISIT, and the missing sentence was
the missing line of code.
