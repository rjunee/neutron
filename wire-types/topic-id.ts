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

/**
 * The route id the NO-PROJECT General scope wears, owned in ONE place.
 *
 * General is not a project — it has no row and no id. But the mobile router's
 * chat path is `/projects/[id]/chat`, so General still needs a path segment, and
 * this sentinel is it.
 *
 * IT IS ALSO THE RESERVED SEGMENT ON THE REMINDERS ROUTE, added 2026-08-11. This
 * docblock used to say the gateway "rejects `~general` as a project id on every
 * `/api/app/projects/<id>/…` route" — true when written, and now true of every
 * route EXCEPT `…/reminders`, which reserves it for the no-project scope
 * (`gateway/http/app-reminders-surface.ts` `resolveScopeSegment`). That exception
 * exists because the alternative spelling, the literal `general`, is a legal
 * project id: the scope and a project of that name resolved to one
 * `app-project:general` topic, sharing a list AND its create / snooze / cancel.
 * What makes this sentinel the fix is the very property the paragraph above
 * describes — `~` is rejected by the project-id validator, so the segment a
 * project can wear and the segment the SCOPE wears are disjoint by construction.
 *
 * IT LIVES HERE, above both sides of the wire, because it is now spoken on both.
 * A push payload names the scope the tap must open, and a notification for a
 * General-scope message therefore has to carry this exact string — an older app
 * bundle (the store artifact, which cannot be upgraded in lockstep with a
 * gateway) reads a payload with no project as MALFORMED and refuses to route,
 * which is the owner's original "it opened the app but not the right place".
 * Spelling it in the gateway and again in the client is precisely the drift that
 * produced the `~general` / `#general` / `general` confusion of ISSUES #410/#411,
 * so there is one definition and everything imports it.
 */
export const GENERAL_RAIL_ID = '~general'

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
 * never share a transcript.
 *
 * MOBILE USES THIS TOO — corrected 2026-08-09. This docblock said mobile "does
 * NOT use this" and kept "the single `app:<user>` socket + `project_id`-field
 * switch model", which was true when it was written and has not been since:
 * `app/lib/chat-core/use-mobile-chat.ts:300` derives `appWsProjectTopicId(user.id,
 * projectId)` whenever the collapsed scope is non-empty, and only General (scope
 * `''`, via `railIdToScope`) falls back to the bare {@link appWsTopicId}. Read as
 * written, it would tell you a project-suffixed topic cannot occur on a phone —
 * which is exactly the kind of wrong that gets built on.
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
