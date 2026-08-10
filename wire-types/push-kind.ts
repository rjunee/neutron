/**
 * @neutronai/wire-types — the push payload `kind`s, owned in ONE place.
 *
 * WHY THIS EXISTS, and it is not a tidiness argument. The gateway chooses a
 * `kind` string when it builds a push, and the mobile client switches on that
 * string to decide where a tap lands. Those two lists were written independently
 * and had drifted until they were **disjoint except for one entry**:
 *
 *   SENT by the gateway        KNOWN to the tap resolver
 *   -------------------        -------------------------
 *   reminder                   reminder            ← the only overlap
 *   calendar_pre_meeting_brief wow_fired           ← nothing sends this
 *   email_daily_triage         agent_message       ← nothing sends this
 *
 * So tapping a pre-meeting brief or an email triage hit the resolver's
 * "unknown kind" branch, which warns and returns null — the app opened, and
 * nothing routed. That is exactly what the owner reported: *"it opens the app,
 * but it doesn't open in the right project."* Meanwhile two of the three kinds
 * the client carefully handled could never arrive.
 *
 * NEITHER SIDE COULD SEE THE PROBLEM ALONE. The sender's tests asserted the
 * payload it builds; the resolver's tests asserted the payloads it was given.
 * Both were green, and the union of them was broken. A shared list plus the
 * exhaustiveness test beside it is what makes the two halves check each other —
 * add a kind here without teaching the resolver and CI reds.
 *
 * ── 2026-08-09: `reminder` RETIRED, `agent_message` PROMOTED ────────────────
 *
 * The owner's report: *"the notification that comes in on Android says
 * 'ritual:kaizen'. I don't need a special case notification for rituals. I should
 * just get notifications of chat messages, and a ritual posting is just a chat
 * message."*
 *
 * `reminder` was composed from the reminder ROW, not from the message the fire
 * actually posted. For a ritual the row's `message` IS the dispatch token
 * `ritual:<id>` (`reminders/ritual-registration.ts:982`), so the notification
 * could only ever show a routing token, and its `project_slug` was the OWNER
 * slug rather than a project id — so the tap could not resolve a project either.
 * A fired reminder is a chat message, so it now sends the SAME
 * `agent_message` every other agent post will: composed from the delivered text,
 * carrying the durable row id, routing to the chat that holds it
 * (`gateway/push/chat-message-push.ts`). `reminder` has no sender left and is
 * gone from this list and from the resolver.
 *
 * `agent_message` was the reverse defect — a resolver branch with no sender,
 * kept OUT of this list precisely so the exhaustiveness test could not be padded
 * by a kind nothing emitted. Now something emits it, so it is listed, and the
 * test covers it.
 */

/** Every `kind` a push payload may carry. */
export const PUSH_KINDS = [
  /**
   * A message posted into a project's chat by an agent, a fired reminder, or a
   * ritual. Carries `message_id` (the durable row the tap anchors on) and
   * `project_id` — ABSENT when the message landed in the no-project General
   * scope, which is the one kind for which absence is meaningful rather than a
   * payload bug.
   */
  'agent_message',
  /** The Calendar Core's pre-meeting brief. Carries `event_id` + `project_id`. */
  'calendar_pre_meeting_brief',
  /** The Email Core's daily triage. Carries `project_id`. */
  'email_daily_triage',
] as const

export type PushKind = (typeof PUSH_KINDS)[number]

/**
 * Named constants for the senders. A sender importing one of these cannot ship a
 * kind the list does not contain, which is the half of the drift a shared TYPE
 * alone would not have caught — the old senders used string literals.
 */
export const PUSH_KIND_AGENT_MESSAGE = 'agent_message' satisfies PushKind
export const PUSH_KIND_CALENDAR_BRIEF = 'calendar_pre_meeting_brief' satisfies PushKind
export const PUSH_KIND_EMAIL_TRIAGE = 'email_daily_triage' satisfies PushKind

/** Is this string a kind the system actually sends? */
export function isPushKind(value: unknown): value is PushKind {
  return typeof value === 'string' && (PUSH_KINDS as readonly string[]).includes(value)
}
