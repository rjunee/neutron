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
 */

/** Every `kind` a push payload may carry. */
export const PUSH_KINDS = [
  /** A fired reminder. Carries `reminder_id`, and a project only when the
   *  reminder was scoped to one; an unscoped reminder belongs to General. */
  'reminder',
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
export const PUSH_KIND_REMINDER = 'reminder' satisfies PushKind
export const PUSH_KIND_CALENDAR_BRIEF = 'calendar_pre_meeting_brief' satisfies PushKind
export const PUSH_KIND_EMAIL_TRIAGE = 'email_daily_triage' satisfies PushKind

/** Is this string a kind the system actually sends? */
export function isPushKind(value: unknown): value is PushKind {
  return typeof value === 'string' && (PUSH_KINDS as readonly string[]).includes(value)
}
