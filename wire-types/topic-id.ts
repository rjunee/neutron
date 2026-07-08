/**
 * @neutronai/wire-types — app-ws topic-id derivation (L6).
 *
 * The synthetic `channel_topic_id` derivation for an Expo / web-React
 * session. Extracted out of `channels/adapters/app-ws/envelope.ts` (which
 * re-exports these for its server consumers) so the BROWSER bundle can derive
 * the same topic string WITHOUT pulling in the (node-only) channels package.
 * This kills the hand mirror that used to live inline in
 * `landing/chat-react/config.ts` (`appWsTopicId` / `appWsProjectTopicId`).
 *
 * Node-free: pure string math.
 */

/** Synthetic `channel_topic_id` for an Expo/web session — `app:<user_id>`. */
export function appWsTopicId(user_id: string): string {
  return `app:${user_id}`
}

/**
 * Per-project `channel_topic_id` for a web session — `app:<user_id>:<project_id>`.
 * The web React client opens ONE socket per active project (reconnecting on a
 * project switch) so persistence + seq + resume + fan-out all scope to this
 * per-project topic string; General stays on the user-scoped {@link appWsTopicId}.
 * User-scoped (NOT a bare `wow-shell-<id>`) so two users opening the same project
 * never share a transcript. Mobile keeps the single `app:<user>` socket +
 * `project_id`-field switch model (it does NOT use this), so per-project binding
 * is gated on `platform === 'web'` at the surface.
 */
export function appWsProjectTopicId(user_id: string, project_id: string): string {
  return `app:${user_id}:${project_id}`
}

/** Parse `app:<user_id>` back to `user_id`. Returns `null` on mismatch. */
export function parseAppWsTopicId(topic_id: string): string | null {
  if (!topic_id.startsWith('app:')) return null
  const user_id = topic_id.slice('app:'.length)
  return user_id.length > 0 ? user_id : null
}
