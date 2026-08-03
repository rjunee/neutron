/**
 * Tell the owner his Claude credential has lapsed BEFORE he discovers it by
 * typing.
 *
 * THE GAP THIS CLOSES. The only credential notice on the box was REACTIVE: it
 * lives inside the terminal-failure handler of a real user turn
 * (`gateway/wiring/build-live-agent-turn.ts`, `AUTH_RECONNECT_BODY`), so it
 * requires him to have already sent a message and watched it fail. But a lapsed
 * credential does not announce itself that way. It kills every PROACTIVE surface
 * first — the morning brief, rituals, nudges, fired reminders — and those
 * produce no turn to fail, so they die quietly and the reactive bubble never
 * gets a chance to fire. The box looks alive (it serves, it boots, `/healthz`
 * answers) while every scheduled thing it was supposed to do silently does not
 * happen, until hours later he types something and finds out.
 *
 * The probe that would have noticed was ALREADY RUNNING. `credential-usage-
 * monitor.ts` polls Anthropic every 60 s and has classified 401/403 as
 * `unauthorized` all along — it just used the answer to blank a utilization bar
 * and told nobody. This module is the missing consumer: it turns that reading
 * into the same actionable bubble the reactive path posts, delivered durably.
 *
 * THREE PROPERTIES, EACH LOAD-BEARING.
 *
 * 1. IT ONLY FIRES ON A LAPSE, NEVER ON A BLIP. The observer takes a
 *    three-valued {@link CredentialStanding}; only `lapsed` (upstream REJECTED
 *    the token we hold) alerts. A timeout, a 5xx or a dropped packet is
 *    `indeterminate` and does nothing at all — it neither alerts nor counts as
 *    recovery. This is not a nicety: a false "reconnect your account" is WORSE
 *    than silence, because it trains him to swipe past the message, and then the
 *    real one lands on a reader who has already learned it means nothing. It
 *    also means a lapse flickering behind a flaky network stays ONE lapse.
 *
 * 2. IT IS DURABLE, so it is waiting for him with nothing connected. The lapse
 *    is noticed by a tick loop, i.e. precisely when nobody is looking — the same
 *    reason the fired-reminder path is durable. It posts through the ONE
 *    out-of-turn delivery seam (`gateway/http/deliver.ts`) with
 *    `durability: 'reply'` + the reconnect option, which is byte-for-byte the
 *    shape `sendAuthReconnect` persists on the reactive path: a resolvable
 *    `allow_freeform` row carrying the same words and the same tappable
 *    `RECONNECT_AUTH_VALUE`. So the message reads identically wherever he meets
 *    it, and the tap does exactly what it already does — routes back through the
 *    turn pipeline, which mints a fresh install-token handoff and replies with
 *    the copy-paste reconnect command. No second notification path, no second
 *    copy, no second affordance to keep in sync.
 *
 * 3. EXACTLY ONCE PER LAPSE. The probe runs every minute and a lapse persists
 *    until he acts, so the naive version is 60 identical bubbles an hour. The
 *    latch is {@link IncidentEdgeTracker}, the same rising-edge dedup the
 *    watchdog uses for exactly this shape (it exists because that subsystem
 *    already shipped the alert storm once). Its commit-on-success semantics are
 *    the reason it is reused rather than replaced by a boolean: the incident is
 *    marked delivered ONLY after the durable row is actually written, so a DB
 *    hiccup re-attempts next tick instead of permanently suppressing the one
 *    notice that mattered. Recovery clears the latch, so a LATER lapse alerts
 *    again.
 */

import { AUTH_RECONNECT_BODY, AUTH_RECONNECT_OPTIONS } from '@neutronai/gateway/wiring/build-live-agent-turn.ts'
import type { Deliver } from '@neutronai/gateway/http/deliver.ts'
import { createLogger } from '@neutronai/logger'
import { IncidentEdgeTracker } from '@neutronai/watchdog/index.ts'

import type { CredentialStanding, CredentialStandingObserver } from './credential-usage-monitor.ts'

const moduleLog = createLogger('credential-lapse')

/**
 * The single condition this tracker follows. `IncidentEdgeTracker` is keyed
 * because the watchdog watches many conditions at once; here there is exactly
 * one, and naming it keeps the reuse honest rather than clever.
 */
export const CREDENTIAL_LAPSE_KEY = 'credential-lapsed'

export interface CredentialLapseNoticeInput {
  /** The ONE out-of-turn delivery seam, wired at the composition root. */
  deliver: Deliver
  /** The owner's bare `app:<owner>` topic — what the client binds and hydrates. */
  topic_id: string
  now?: () => number
}

/**
 * Build the observer the credential monitor reports each tick's standing to.
 *
 * Returns a plain function rather than a class because it has exactly one verb
 * and all of its state is the latch.
 */
export function createCredentialLapseNotifier(
  input: CredentialLapseNoticeInput,
): CredentialStandingObserver {
  const { deliver, topic_id } = input
  const now = input.now ?? ((): number => Date.now())
  const incidents = new IncidentEdgeTracker()
  // Incident identity must be unique per LAPSE, and a wall-clock stamp alone is
  // not: two lapses separated by a recovery inside the same millisecond mint the
  // same id, and the idempotency key below then collapses the second notice into
  // the first. Rare on a 60 s loop, certain under test — and "rare" is the wrong
  // bar for the one message that says the box has stopped working.
  let sequence = 0

  return async (standing: CredentialStanding): Promise<void> => {
    // Learned nothing. Do NOT touch the tracker: passing an empty firing set
    // here would read as recovery and clear a latch that a real, still-active
    // lapse is holding — turning one lapse plus one dropped packet into two
    // identical bubbles.
    if (standing === 'indeterminate') return

    // `candidates` both CLEARS the latch when the key stops firing (recovery, so
    // a future lapse is a fresh incident) and returns the rising edge when it
    // starts. It does not commit — that happens below, only on a real delivery.
    const firing = standing === 'lapsed' ? [CREDENTIAL_LAPSE_KEY] : []
    // The id is minted ONCE per incident and reused across retries of it
    // (`candidates` caches it until the incident is committed or clears), which
    // is what makes the idempotency key below a retry collapser rather than a
    // suppressor.
    const rising = incidents.candidates(firing, (key) => `${key}:${now()}:${++sequence}`)
    const incident = rising[0]
    // Either nothing is firing, or the notice for this lapse already landed.
    if (incident === undefined) return

    const result = await deliver(topic_id, {
      body: AUTH_RECONNECT_BODY,
      durability: 'reply',
      options: [...AUTH_RECONNECT_OPTIONS],
      // Belt to the latch's braces on the RETRY path specifically: when a
      // persist half-succeeds and the incident stays uncommitted, the next tick
      // re-attempts the same incident id and `ButtonStore.emit` returns the
      // existing row instead of a duplicate bubble. (It does not survive a
      // process restart — the tracker is in-memory and a fresh process mints a
      // fresh id, so a reboot while lapsed re-tells him once. That is the
      // watchdog's documented behaviour and the right side to err on: repeating
      // a true "your box is not working" after a restart beats swallowing it.)
      idempotency_key: incident.id,
    })

    if (!result.persisted) {
      // `deliver` swallows a 'reply' persist failure into `persisted: false`
      // rather than throwing. Leaving the incident uncommitted is the whole
      // point of commit-on-success: the next tick re-attempts the SAME incident
      // id instead of the owner silently never being told.
      moduleLog.warn('credential_lapse_notice_undelivered', { incident: incident.id })
      return
    }
    incidents.commitById(incident.id)
    moduleLog.info('credential_lapse_notified', {
      incident: incident.id,
      delivered_live: result.delivered_live,
    })
  }
}
