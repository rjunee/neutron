# A ritual post is a chat message, so its notification is a chat message

**Landed:** 2026-08-09 · **Surface:** `gateway/push/`, `gateway/proactive/reminder-outbound.ts`, `wire-types/push-kind.ts`, `app/lib/push-deep-link-dispatch.ts`, `app/components/ChatSyncSurface.tsx`

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

**The notification is composed at DELIVERY.** `gateway/push/chat-message-push.ts` is
new and pure: `chatPushExcerpt` collapses whitespace and truncates on a word boundary
with an ellipsis; `buildChatMessagePush` emits `{ title, body, data: { kind:
'agent_message', message_id, project_id? } }`; `buildChatMessagePushSink` fans it over
the Expo transport, swallowing its own failures. `gateway/proactive/reminder-outbound.ts`
calls it after a persisted `deliver`, passing `prompt_id` as the `message_id` and the
delivery topic's scope as the project. A nudge and a ritual reach that `post`
identically, so they cannot produce different notifications.

**What was deleted, because it could not be fixed in place.** `pushReminder` +
`onFired` (`gateway/push/dispatcher.ts`, now a transport only), `ReminderFiredHook` +
`on_fired` (`reminders/tick.ts`), and the `push_dispatcher` composition field with its
`build-core-modules.ts` attachment. The tick can only see the row; it was never a
place a truthful chat notification could be built. Deleting a composition field is
explicitly permitted by `scripts/ci/composition-field-ratchet-guard.sh` — demoting one
is not.

**`agent_message` promoted, `reminder` retired** in `wire-types/push-kind.ts`.
`agent_message` was a resolver branch with no sender, deliberately kept out of
`PUSH_KINDS` so the exhaustiveness test could not be padded by an unsent kind; now
something sends it, so it is listed and covered. `reminder` has no sender left, so its
resolver branch and its `topic_id = 'app-project:<id>'` decode fallback are gone — a
decode path with no encoder cannot be exercised, which is how a wrong one survives.

**General is encoded by ABSENCE.** The gateway omits `project_id` for the no-project
scope rather than shipping a second copy of General's route sentinel. The client owns
that spelling (`GENERAL_PROJECT_ID`), and the `~general` / `#general` / `general`
confusion of ISSUES #410/#411 is what a second copy costs.

**The `?message_id=` param is consumed.** It had reached the chat route since
2026-05 with nothing reading it. `chat.tsx` now threads it as `targetMessageId`, and
`ChatSyncSurface` uses it two ways from ONE rule (`chatDeepLinkAnchor`):

- at render, it joins `projectId` in the frozen-anchor key, so a **cold** open from a
  tap decides its anchor the latch-friendly way;
- in an effect, it drives `listRef.scrollToIndex` **once per target**, because a tap
  into an ALREADY-MOUNTED project cannot be re-anchored any other way — FlashList
  applies its initial scroll once and latches `isInitialScrollComplete`.

Both paths ask the same function, so on a cold open they land on the same index and
cannot race to different places. The rule prefers the **unread run's start** when the
referenced message is inside it (ISSUES #505: read the run from its beginning) and the
referenced row itself when it is behind the read watermark. With no `targetMessageId`
— every ordinary open — nothing scrolls imperatively and the anchor is byte-identical
to before. That regression arm is asserted, because #505/#511 is the incident class
this touches.

## Tests

- `gateway/push/chat-message-push.test.ts` — the excerpt (word boundary, single
  over-long word, blank body), the scope derivation, the payload's exact key set.
- `gateway/proactive/__tests__/reminder-outbound.test.ts` — the notification carries
  the POSTED body and the durable row id and never the `ritual:` token; no
  notification without a durable row; a throwing sink cannot double-post the reminder
  (the tick would read an escaping throw as "the post did not happen").
- `app/__tests__/push-kind-coverage.test.ts` — the `agent_message` fixture is produced
  BY the gateway builder, not hand-copied, so a field renamed server-side reds here.
  Plus one test that walks sender → resolver in a single assertion.
- `app/__tests__/chat-push-tap-lands-on-the-message.test.tsx` — mounts the real
  surface; drives the real list ref (the stub now forwards one and records imperative
  calls, so a dead handler is visible); and mounts the real ROUTE at the real tap URL
  so nothing hand-passes the prop.
- `tests/integration/reminders-tab-and-push.open.test.ts` — now FIRES a reminder
  through the real composer's `reminder_dispatcher` and reads what reaches Expo. That
  is more coverage than before: the old test asserted a payload without the message
  ever being posted.

Every guard mutation-tested: dropping the imperative scroll, dropping the route's
param, composing from `reminder.message`, and routing back to `/reminders` each red a
test.

## Noted, not fixed

`app/app/projects/[id]/chat.tsx` passes the route segment to `ChatSyncSurface`
unchanged, so General's chat mounts with `projectId = '~general'` and
`useMobileChat` derives `app:<user>:~general` — while `railIdToScope` exists precisely
to collapse that sentinel to `''`. Untouched here because it is orthogonal to this
change and the push path lands in General either way (the gateway delivers every
fired reminder to the bare `app:<user>` topic).
