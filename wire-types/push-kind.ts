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
 * (`gateway/push/chat-message-push.ts`). `reminder` has no sender left and is gone
 * from this list.
 *
 * IT IS NOT GONE FROM THE RESOLVER, and that is deliberate: a DECODE-ONLY branch
 * stays in `app/lib/push-deep-link-dispatch.ts` so taps keep working on
 * notifications already delivered to a device and on a gateway a self-hoster has not
 * upgraded. Being absent HERE is what matters — this list is what the system SENDS,
 * and the exhaustiveness test beside it must not be paddable by a kind nothing emits.
 * (Said explicitly because this sentence read "gone from this list and from the
 * resolver", which a reader could act on by deleting a live compatibility path.)
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
   * `project_id`, which is ALWAYS A STRING — never omitted and never null. The
   * no-project General scope names itself with the `GENERAL_RAIL_ID` sentinel from
   * `topic-id.ts` (the one definition both sides import).
   *
   * Absence was the encoding for one round of review, on the argument that the
   * client should own General's spelling. It was retracted: a payload with no
   * project is MALFORMED to every app bundle already installed, whose
   * `resolvePushRoute` warns and refuses to route — and a store artifact cannot be
   * upgraded in lockstep with a self-hosted gateway, so the silent encoding would
   * have preserved the very "the app opens and nothing routes" it was meant to
   * end. See `gateway/push/chat-message-push.ts`, which is the sender.
   */
  'agent_message',
  /**
   * The Calendar Core's pre-meeting brief. Carries `event_id` + `project_id`.
   *
   * ⚠️ HAS A SENDER, BUT NOTHING CURRENTLY REACHES IT — see the note under
   * `email_daily_triage`, which is in the identical state.
   */
  'calendar_pre_meeting_brief',
  /**
   * The Email Core's daily triage. Carries `project_id`.
   *
   * ⚠️ THE SAME WIRING GAP, AND IT QUALIFIES THE INVARIANT ABOVE. This list is
   * documented as "what the system SENDS", and these two entries do not currently
   * send: both call sites are gated on `input.pushDispatcher !== null`
   * (`gateway/cores/calendar-wiring.ts`, `gateway/cores/email-managed-wiring.ts`)
   * and the ONLY places that supply the field pass `null`
   * (`gateway/cores/mount-cores-scribe-fan-out.ts` — grep-verified repo-wide
   * 2026-08-10: two assignment sites, both `null`). So the sender code exists, is
   * typed, and is unreachable.
   *
   * They are LISTED ANYWAY, deliberately, and the distinction matters: unlike
   * `wow_fired` (no sender code at all) these have a real sender awaiting a real
   * dispatcher, so the resolver must keep handling them or wiring the dispatcher
   * would silently reintroduce the disjoint-lists defect this file exists to
   * prevent. The exhaustiveness test beside it is therefore doing something
   * narrower than it looks for these two: it proves the RESOLVER is ready, not
   * that a notification is being sent.
   *
   * Closing the gap is a Cores wiring change, not a change here. Recorded rather
   * than left for a reader to trip over, because "it is in PUSH_KINDS" reads as
   * "it is live" and for these two it is not.
   */
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
