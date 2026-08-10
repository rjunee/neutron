/**
 * @neutronai/gateway/push — a chat message's push notification.
 *
 * THE OWNER'S REPORT (2026-08-09): *"the notification that comes in on Android
 * says 'ritual:kaizen'. I don't need a special case notification for rituals. I
 * should just get notifications of chat messages, and a ritual posting is just a
 * chat message. And the notification should include at least the first part of
 * the chat message in the notification itself."*
 *
 * ONE ROOT CAUSE UNDER BOTH HALVES OF THAT: the push was composed from the
 * reminder ROW instead of from the message the fire actually posted. The row's
 * `message` for a ritual is the dispatch token `ritual:<id>`
 * (`reminders/ritual-registration.ts:982`), so the body could only ever be a
 * routing token; and the payload's `project_slug` was the OWNER slug, not a
 * project id, so the tap had nothing it could resolve.
 *
 * So this module composes a push FROM A DELIVERED MESSAGE and nothing else:
 * the text that was posted, and the durable row id it was posted as. There is no
 * ritual shape, no reminder shape — a ritual post and an ordinary agent post
 * produce the same notification, because they are the same thing.
 *
 * The `project_id` it carries is the ROUTE the tap resolves
 * (`app/lib/push-deep-link-dispatch.ts` → `/projects/<id>/chat?message_id=<id>`),
 * and it is ALWAYS PRESENT — including for the no-project General scope, which
 * names itself with the shared `GENERAL_RAIL_ID` sentinel.
 *
 * That was the other way round for one round of review, on the argument that the
 * client should own General's route spelling and a second copy of the sentinel is
 * what caused the `~general` / `#general` / `general` confusion of ISSUES
 * #410/#411. The argument is right about the hazard and wrong about the fix. A
 * payload that omits the field is MALFORMED to every app bundle already installed
 * (`resolvePushRoute` on the released client warns and returns null when
 * `agent_message` carries no project) — and a store artifact cannot be upgraded in
 * lockstep with a self-hosted gateway, so "the owner taps and the app opens
 * nowhere" would have survived the fix that was supposed to end it. The real
 * answer to #410/#411 is ONE definition, not silence: the sentinel lives in
 * `wire-types/topic-id.ts`, above both sides, and `app/__tests__/general-scope.test.ts`
 * pins the client's copy to it.
 */

import { GENERAL_RAIL_ID } from '@neutronai/wire-types/topic-id.ts'
import { PUSH_KIND_AGENT_MESSAGE } from '@neutronai/wire-types/push-kind.ts'

/**
 * How much of the message body rides in the notification.
 *
 * Sized for the shade, not for the transport: Android collapses a notification to
 * roughly two lines and iOS to about four, so a longer body is truncated by the OS
 * anyway — but truncated MID-WORD, and with no ellipsis to say it happened. Cutting
 * it here on a word boundary is the difference between "Kaizen review: three
 * things landed today, and one…" and "Kaizen review: three things landed today,
 * and o".
 */
export const CHAT_PUSH_BODY_MAX = 160

/** The title a General-scope (no-project) chat message wears. */
export const CHAT_PUSH_GENERAL_TITLE = 'General'

/**
 * The first part of a posted message, fit for a notification body.
 *
 * Collapses every run of whitespace to one space FIRST — a composed reminder or a
 * ritual digest is routinely multi-line markdown, and a raw newline in a
 * notification body renders as a blank half-line on Android that eats the two
 * lines the shade gives you. Then truncates on the last word boundary at or before
 * the budget and appends a single-character ellipsis.
 *
 * Never throws, never returns whitespace-only: an empty/blank body comes back as
 * the empty string and the caller decides (the reminder outbound skips the push,
 * because a notification with no body is a buzz with no information).
 */
export function chatPushExcerpt(body: string, max: number = CHAT_PUSH_BODY_MAX): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const clipped = dropDanglingSurrogate(flat.slice(0, max))
  const lastSpace = clipped.lastIndexOf(' ')
  // A single word longer than the whole budget has no boundary to cut on — take
  // the hard clip rather than returning nothing.
  const head = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped
  const trimmed = head.replace(/[\s,;:.!?-]+$/, '')
  // A head that is ENTIRELY trailing punctuation strips to nothing, and `…` alone
  // is a buzz with no words. It also survives the sink's `length === 0` check, so
  // the guard has to be here rather than there. Fall back to the untrimmed clip,
  // which cannot be empty because `flat.length > max >= 1`.
  return `${trimmed.length > 0 ? trimmed : clipped}…`
}

/**
 * Drop a LONE high surrogate left at the end by a mid-codepoint clip.
 *
 * `slice` counts UTF-16 units, so cutting at a fixed budget can land between the
 * halves of an emoji. The orphan renders as `�` in the shade — the first
 * visible character of a notification being a replacement glyph reads as a
 * corrupted message rather than a truncated one.
 */
function dropDanglingSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s
}

/** The scope a delivered chat message belongs to, as the tap must route it. */
export interface ChatMessagePushScope {
  /** The project the chat lives in, or `null` for the General (no-project) scope. */
  project_id: string | null
}

/**
 * Recover the delivery scope from the app-ws topic the message was delivered to.
 *
 * `app:<user_id>` is General; `app:<user_id>:<project_id>` is that project
 * (`wire-types/topic-id.ts` — `appWsTopicId` / `appWsProjectTopicId`). Anything
 * else (a `web:` topic, a Telegram topic, a malformed string) yields General,
 * because the mobile client only ever binds and hydrates an `app:` topic, so
 * there is no other chat a tap could open.
 *
 * WHAT THAT MEANS TODAY, stated plainly so nobody reads the project branch as a
 * live mode it is not: EVERY out-of-turn producer in the Open composer delivers to
 * the owner's BARE `app:<user>` topic — fired reminders and rituals
 * (`open/composer.ts` `reminderGeneralTopic`), the proactive brief + idle nudge
 * (`proactiveGeneralTopic`), the overnight report (`overnightBriefTopic`) — because
 * that is the one topic the mobile client binds and hydrates, and suffixing it is
 * the PR #105 deliver-to-nobody bug. So every notification the owner receives right
 * now is General-scoped, and that is CORRECT: the message really did land in his
 * General chat, which is where he asked the tap to take him.
 *
 * The project branch is not speculative either — `app:<user>:<project>` is a real
 * topic the mobile client binds when a project chat is open
 * (`app/lib/chat-core/use-mobile-chat.ts:300`). It is the answer for the first
 * producer that posts into one. It is covered by unit tests over this parser, and
 * deliberately NOT by an integration test, because there is nothing yet to
 * integrate — a test that claimed otherwise would be asserting a mode no call site
 * can reach.
 */
export function chatMessagePushScope(topic_id: string): ChatMessagePushScope {
  if (!topic_id.startsWith('app:')) return { project_id: null }
  const rest = topic_id.slice('app:'.length)
  const sep = rest.indexOf(':')
  if (sep < 0) return { project_id: null }
  const project_id = rest.slice(sep + 1)
  return { project_id: project_id.length > 0 ? project_id : null }
}

export interface ChatMessagePushInput {
  /** The project the message landed in, or `null` for General. */
  project_id: string | null
  /** The durable row id the tap anchors the transcript on. */
  message_id: string
  /** The message text as posted — excerpted here, never pre-truncated. */
  body: string
}

/** The Expo message shape `PushDispatcher.pushAll` takes. */
export interface ChatMessagePush {
  title: string
  body: string
  data: Record<string, unknown>
}

/**
 * Compose the notification for one delivered chat message.
 *
 * The TITLE names where the message is, so a glance at the shade answers "which
 * conversation is this?" without opening anything. The BODY is the message. The
 * DATA is only what the tap resolver needs — no owner slug, no reminder id, no
 * ritual id: an internal token in a notification payload is how `ritual:kaizen`
 * ended up on the owner's lock screen.
 */
export function buildChatMessagePush(input: ChatMessagePushInput): ChatMessagePush {
  return {
    title: input.project_id === null ? CHAT_PUSH_GENERAL_TITLE : input.project_id,
    body: chatPushExcerpt(input.body),
    data: {
      kind: PUSH_KIND_AGENT_MESSAGE,
      message_id: input.message_id,
      // ALWAYS a string, never omitted and never null — General names itself with
      // the shared sentinel. See the module docblock for why absence was the wrong
      // encoding: an already-installed app bundle treats a missing project as a
      // malformed payload and refuses to route at all.
      project_id: input.project_id ?? GENERAL_RAIL_ID,
    },
  }
}

/** The slice of `PushDispatcher` this sink needs. Narrow on purpose: a sink that
 *  could also prune tokens or fan per-user would be a second delivery policy. */
export interface ChatMessagePushFanOut {
  pushAll(
    project_slug: string,
    message: { title?: string; body: string; data?: Record<string, unknown> },
  ): Promise<unknown>
}

/**
 * A best-effort "notify the owner's devices that this landed in chat" sink.
 *
 * Best-effort in the same sense the live socket push is: the durable chat row is
 * the guarantee, and a failed notification must never turn into a failed
 * delivery — so every throw is swallowed here rather than at the producer, where
 * forgetting the try/catch once would make a fired reminder retry forever over an
 * Expo outage.
 */
export type ChatMessagePushSink = (input: ChatMessagePushInput) => Promise<void>

export interface BuildChatMessagePushSinkInput {
  fanOut: ChatMessagePushFanOut
  /** The instance slug the device-token rows are keyed by. */
  project_slug: string
  log?: (msg: string) => void
}

export function buildChatMessagePushSink(
  input: BuildChatMessagePushSinkInput,
): ChatMessagePushSink {
  return async (msg): Promise<void> => {
    const push = buildChatMessagePush(msg)
    // A body that excerpts to nothing carries no information — a buzz with no
    // words is worse than silence, and the durable row is already in chat.
    if (push.body.length === 0) return
    try {
      await input.fanOut.pushAll(input.project_slug, push)
    } catch (err) {
      input.log?.(
        `[push] chat-message push failed (the chat row is the guarantee): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
}
