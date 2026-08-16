/**
 * `open/wiring` — build the ONE chat-message push sink, presence-aware.
 *
 * ── WHY THIS IS A MODULE AND NOT SIX LINES IN THE COMPOSER ─────────────────
 *
 * It was six lines in the composer, and that is precisely the shape that cannot
 * be defended. The composition it performs carries two claims —
 *
 *   (a) the presence check wraps the real sink, so a push is skipped while the
 *       owner is reading that chat on the web; and
 *   (b) the question is asked ABOUT THE MESSAGE, so a tab open on one project
 *       cannot silence another;
 *
 * — and while it lived inline, both were reachable only by booting the
 * 6000-line `open/composer.ts`. Nothing tested them. Deleting the wrapper, or
 * quietly changing the predicate to ignore its argument, left every test in the
 * repo green while the owner's phone went quiet. That is the persona-gen failure
 * ("built but never wired") with the wiring present and the guard absent, and it
 * is the same reason `open/wiring/app-ws-marker.ts` and
 * `app/lib/push-foreground-policy.ts` exist as modules rather than as expressions.
 *
 * ── ONE SINK, TWO CALL SITES ───────────────────────────────────────────────
 *
 * The result feeds BOTH pushing paths: `createDeliver({ notify: … })` for
 * out-of-turn posts (reminders, rituals, the proactive brief) and the
 * `ownsNotify` branch of the app-ws send path for ordinary in-turn replies (#300).
 * They must not answer the presence question differently, and they cannot: the
 * wrapper goes on at this single construction, above both. Moving the decision to
 * either call site would be two chances to drift.
 */

import { buildChatMessagePushSink } from '@neutronai/gateway/push/chat-message-push.ts'
import type {
  ChatMessagePushFanOut,
  ChatMessagePushSink,
} from '@neutronai/gateway/push/chat-message-push.ts'
import { suppressPushWhileWebForeground } from '@neutronai/gateway/push/web-presence.ts'
import type { WebPresenceTracker } from '@neutronai/gateway/push/web-presence.ts'

export interface BuildPresenceAwareChatPushSinkInput {
  /** The Expo fan-out the underlying sink pushes through. */
  fanOut: ChatMessagePushFanOut
  /** The owner's project slug — the key registrations are read and written under. */
  project_slug: string
  /** Where web clients' foreground/background declarations are recorded. */
  presence: WebPresenceTracker
  /**
   * The owner, and ONLY the owner.
   *
   * Presence is per-user, so passing anything broader would let a guest with a
   * tab open silence the owner's phone. Passed in rather than read from a
   * constant so the test can prove the sink asks about the identity it was given
   * and not some other one.
   */
  owner_user_id: string
  log?: (msg: string) => void
}

/**
 * The real push sink, wrapped so it stays quiet while the owner is reading THAT
 * conversation on the web.
 *
 * The predicate takes the message and reads `msg.project_id`, which is the whole
 * of the conversation scope: `chatMessagePushScope` derives it from the topic the
 * message was delivered to, and the tracker holds the scope each web socket
 * declared. A predicate that ignored its argument would be the global suppression
 * this signature exists to make hard to write by accident — one open tab
 * silencing every other chat.
 */
export function buildPresenceAwareChatPushSink(
  input: BuildPresenceAwareChatPushSinkInput,
): ChatMessagePushSink {
  return suppressPushWhileWebForeground({
    sink: buildChatMessagePushSink({
      fanOut: input.fanOut,
      project_slug: input.project_slug,
    }),
    isWebForeground: (msg) => input.presence.isForeground(input.owner_user_id, msg.project_id),
    ...(input.log !== undefined ? { log: input.log } : {}),
  })
}
