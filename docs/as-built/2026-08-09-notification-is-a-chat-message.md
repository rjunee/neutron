# A ritual post is a chat message, so its notification is a chat message

**Landed:** 2026-08-09 · **Surface:** `gateway/http/deliver.ts`, `gateway/push/`,
`wire-types/`, `app/lib/push-deep-link-dispatch.ts`, `app/components/ChatSyncSurface.tsx`

## What the owner saw

> "the notification that comes in on Android says 'ritual:kaizen'. I don't need a
> special case notification for rituals. I should just get notifications of chat
> messages, and a ritual posting is just a chat message. And the notification should
> include at least the first part of the chat message in the notification itself.
> Also when I tapped the notification it opened the app but didn't open in the right
> project (in this case it should have opened in general scrolled to unread
> messages)"

## One root cause under both halves

The push was composed from the **reminder row**, not from the message the fire
posted. `PushDispatcher.pushReminder` built `{ title: 'Reminder', body:
reminder.message, data: { kind: 'reminder', reminder_id, project_slug } }` on the
reminder tick's `on_fired` hook.

- For a ritual, `reminder.message` **is** the dispatch token `ritual:<id>`
  (`reminders/ritual-registration.ts:982`). So the notification could never contain
  the composed text — the text does not exist yet when the row is written, and the
  tick never sees it.
- `kind: 'reminder'` routed to `/projects/<id>/reminders` — the Reminders **tab**,
  not the chat the message is in — and the project field it carried was
  `reminder.owner_slug`, the instance slug, which resolves to no project at all.

Both symptoms were the same mistake, so both are fixed by moving composition to the
one place that holds the posted text **and** its durable row id.

## What changed

**The notification is composed by the DELIVERY SEAM.** `gateway/push/chat-message-push.ts`
is new and pure: `chatPushExcerpt` collapses whitespace and truncates on a word
boundary with an ellipsis; `buildChatMessagePush` emits `{ title, body, data: { kind:
'agent_message', message_id, project_id } }`; `buildChatMessagePushSink` fans it over
the Expo transport, swallowing its own failures. `createDeliver` takes that sink as
`notify` and calls it after any post that got a **durable row** — `'reply'` (a fired
reminder or ritual) and `'inert'` (the morning brief, the idle nudge, the overnight
report, a system notice) — and never for `'none'`, a transient live-only pill with no
row for a tap to land on.

It lives there rather than in the reminder outbound, and that was a review
correction worth recording. The first version of this change composed the
notification in `gateway/proactive/reminder-outbound.ts`, which cured the reported
message and **left every other out-of-turn producer silent** — the brief, the nudge
and the overnight report post through the same `deliver` on a different sink, so a
per-producer notification reproduced exactly the per-producer-registry mistake
`deliver` exists to have ended. The owner's sentence is the rule: *"a ritual posting
is just a chat message"* — and so is a brief, and so is a nudge.

**What was deleted, because it could not be fixed in place.** `pushReminder` +
`onFired` (`gateway/push/dispatcher.ts`, now a transport only), `ReminderFiredHook` +
`on_fired` (`reminders/tick.ts`), and the `push_dispatcher` composition field with its
`build-core-modules.ts` attachment. The tick can only see the row; it was never a
place a truthful chat notification could be built. Deleting a composition field is
explicitly permitted by `scripts/ci/composition-field-ratchet-guard.sh` — demoting one
is not.

**`agent_message` promoted, `reminder` kept as a DECODER only** in
`wire-types/push-kind.ts` and `app/lib/push-deep-link-dispatch.ts`. `agent_message`
was a resolver branch with no sender, deliberately kept out of `PUSH_KINDS` so the
exhaustiveness test could not be padded by an unsent kind; now something sends it, so
it is listed and covered. `reminder` has **no sender left** and is absent from
`PUSH_KINDS` for the same reason — but its resolver branch stays, because its payloads
are real: notifications already sitting in the shade, and self-hosted gateways that
have not upgraded while a store-published app has. Deleting the decoder would turn
those taps into "the app opens and nothing routes", which is the complaint. It also
keeps the ISSUE #38 reminders deep-link surface reachable rather than orphaned. One
behaviour did change there: a legacy payload with no resolvable project now falls back
to General instead of refusing outright, which is a latent bug fixed in passing — the
retired sender wrote the OWNER slug and no project id, so that branch had returned
null for every General reminder notification it ever received.

**General NAMES ITSELF, and this too was a review correction.** The first version
encoded the no-project scope by OMITTING `project_id`, on the argument that the client
owns General's route spelling and that a second copy of the sentinel is what caused the
`~general` / `#general` / `general` confusion of ISSUES #410/#411. Right about the
hazard, wrong about the fix: the released app bundle treats `agent_message` with no
project as malformed and refuses to route, and a store artifact cannot be upgraded in
lockstep with a self-hosted gateway — so the omission would have preserved the exact
symptom. The answer to #410/#411 is one DEFINITION, not silence: `GENERAL_RAIL_ID`
now lives in `wire-types/topic-id.ts`, above both sides of the wire, and
`app/__tests__/general-scope.test.ts` pins the client's constants to it.

**What the tap actually opens today, stated plainly.** Every out-of-turn producer in
the Open composer delivers to the owner's **bare** `app:<user>` topic — suffixing it
is the PR #105 deliver-to-nobody bug — so every notification is General-scoped, and
that is correct: the message really did land in his General chat, which is where he
asked the tap to take him. `chatMessagePushScope` also parses the project form
(`app:<user>:<project>`, a topic the mobile client does bind when a project chat is
open — `app/lib/chat-core/use-mobile-chat.ts:300`), which is the answer for the first
producer that posts into one. That branch is covered by unit tests over the parser and
deliberately not by an integration test, because there is nothing yet to integrate.

**The `?message_id=` param is consumed.** It had reached the chat route since
2026-05 with nothing reading it. `chat.tsx` now threads it as `targetMessageId`, and
`ChatSyncSurface` uses it two ways from ONE rule:

- at render, `chatDeepLinkAnchor` joins `projectId` in the frozen-anchor key, so a
  **cold** open from a tap decides its anchor the latch-friendly way;
- in an effect, `chatDeepLinkScrollIndex` drives `listRef.scrollToIndex` **once per
  target**, because a tap into an ALREADY-MOUNTED project cannot be re-anchored any
  other way — FlashList applies its initial scroll once and latches
  `isInitialScrollComplete`.

Both paths ask the same function, so on a cold open they land on the same index and
cannot race to different places. The rule prefers the **unread run's start** when the
referenced message is inside it (ISSUES #505: read the run from its beginning) and the
referenced row itself when it is behind the read watermark. With no `targetMessageId`
— every ordinary open — nothing scrolls imperatively and the anchor is byte-identical
to before. That regression arm is asserted, because #505/#511 is the incident class
this touches.

Two details of that effect were tightened after review. It now applies the SAME
`selfDeviceId.length > 0` guard the render path applies, so the two halves cannot
answer differently for the same rows; and it latches `honouredDeepLink` only once a
scroll can actually happen, because latching before an unattached ref burned the
target with no retry. `chatDeepLinkScrollIndex` returns an index or `null` rather
than an anchor union, which removed an unreachable `scrollToEnd` arm — once the target
resolves, `chatDeepLinkAnchor` cannot return `bottom`.

**Transport.** The Expo POST now carries `AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS)`.
A bare `fetch` has no deadline, and this call is now awaited inside a durable
delivery, so a stalled connection to `exp.host` would park a reminder fire — and the
tick that claimed its row — for as long as the socket stayed open.

## Tests

- `gateway/http/__tests__/deliver.test.ts` — a `'reply'` post notifies, an `'inert'`
  post notifies, a `'none'` pill does not, a failed persist does not, the topic's
  scope is derived, and a THROWING notify cannot cost `persisted` (which is what the
  tick reads to decide whether to fire the row again).
- `gateway/push/__tests__/ritual-post-notifies-as-a-chat-message.test.ts` — the whole
  chain, from a ritual `reminders` row through the REAL planner, dispatcher, outbound,
  deliver and sink, to the bytes Expo is handed. The approved arm requires a composed
  turn and a non-empty send BEFORE asserting anything about content; the unapproved
  arm asserts `toEqual([])` through the real `ApprovalManager`.
- `gateway/push/chat-message-push.test.ts` — the excerpt (word boundary, single
  over-long word, blank body, all-punctuation head, surrogate pair), the scope
  derivation, the payload's exact key set.
- `app/__tests__/push-kind-coverage.test.ts` — the `agent_message` fixture is produced
  BY the gateway builder, not hand-copied, so a field renamed server-side reds here.
  Plus the sender → resolver union walked in one assertion, including the `message_id`
  linkage read back out of the resolver's route rather than compared to a literal.
- `app/__tests__/push-deep-link-routing.test.ts` — the legacy `reminder` decoder:
  explicit project, `app-project:` topic decode, General fallback, and absence from
  `PUSH_KINDS`.
- `app/__tests__/chat-push-tap-lands-on-the-message.test.tsx` — mounts the real
  surface; drives the real list ref (the stub forwards one and records imperative
  calls, so a dead handler is visible); mounts the real ROUTE at the real tap URL so
  nothing hand-passes the prop; and drives every socket callback through
  `screen.dispatch`, which runs it inside an act window so the scroll-vs-frame
  ordering these arms assert is not decided by React's scheduler.
- `tests/integration/reminders-tab-and-push.open.test.ts` — fires a reminder through
  the real composer's `reminder_dispatcher` and reads what reaches Expo, and drives a
  NON-reminder producer (`POST /api/app/system-notice`, durability `'inert'`) to prove
  the notification is a property of the seam rather than of one producer.

Mutation-tested by deliberately breaking each guard and confirming a red: deleting
the `notifyDevices` call from `deliver` (3 of 4 arms of the ritual suite red), posting
`ritual:${reminder_id}` instead of the composed body (2 red, including the token
assertion), and omitting `project_id` for General (the tap-payload arm red). The
act-wrapping change is the exception and is not claimed as mutation-tested: it removes
nondeterminism rather than a failure, so reverting it does not flip a result.
