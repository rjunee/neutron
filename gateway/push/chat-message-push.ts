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
 * and it is deliberately ABSENT for the no-project General scope — the client
 * owns General's route spelling (`app/lib/project-rail-view.ts` `GENERAL_PROJECT_ID`),
 * and inventing a second copy of that sentinel here is how the `~general` /
 * `#general` / `general` confusion of ISSUES #410/#411 happened in the first place.
 */

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
  const clipped = flat.slice(0, max)
  const lastSpace = clipped.lastIndexOf(' ')
  // A single word longer than the whole budget has no boundary to cut on — take
  // the hard clip rather than returning nothing.
  const head = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped
  return `${head.replace(/[\s,;:.!?-]+$/, '')}…`
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
      // Omitted for General — see the module docblock. The resolver reads absence
      // as "the no-project scope", which is why this is a conditional spread and
      // not a `null`.
      ...(input.project_id !== null ? { project_id: input.project_id } : {}),
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
