/**
 * @neutronai/gateway/cores — tell the owner a Google grant died, in chat.
 *
 * THE GAP THIS CLOSES. `OAuthTokenManager` has detected a dead grant all along:
 * a refresh exchange that comes back `invalid_grant` fires `onInvalidGrant`
 * (`./oauth-token-manager.ts:599`). The one thing that callback did was mark
 * every affected Core `install_failed_runtime`
 * (`../composition/wire-cores-surfaces.ts:66`) — internal state, visible only to
 * someone who goes looking at the Integrations list. Nobody told the owner. So
 * the failure mode was: a Core silently stops working, and he finds out days
 * later by noticing that a thing he relies on has quietly not been happening.
 * That is the same shape as the lapsed-Claude-credential gap
 * (`open/credential-lapse-notice.ts`), and this module is the same answer: turn
 * a reading the system ALREADY had into a durable message in his chat.
 *
 * It matters more than a once-a-year edge case sounds, because a Google OAuth
 * client left in Testing has its refresh tokens expired by Google on a ~7-day
 * cycle. The dead grant is not an anomaly to be debugged; it is a routine event
 * with a routine fix, and the only thing missing was being told.
 *
 * ── ONE MESSAGE PER DEAD GRANT, NEVER A DIGEST ────────────────────────────────
 * Two grants that die in the same hour produce two messages. This is deliberate
 * and owner-specified: each message names ONE account and carries ONE reconnect
 * link, so acting on it is a single unambiguous act. Grouping would make the
 * common case (one grant) read worse to save nothing.
 *
 * ── WHY THE LINK IS THE INTEGRATIONS PAGE, NOT A CONSENT URL ──────────────────
 * The obvious build is to mint a Google consent URL here and put it in the
 * message. It does not work, and the reason is a hard deadline in the data:
 * starting a grant writes a `cores_oauth_pending` row whose TTL is TEN MINUTES
 * (`./oauth-pending-store.ts:18`), and a sweep cron deletes it on expiry
 * (`./oauth-pending-sweep-cron.ts`). But this notice exists precisely BECAUSE
 * the owner is not looking when the grant dies — a refresh fires from a Core's
 * scheduled run. A URL minted at notice time is therefore almost always dead by
 * the time he reads the message, and it fails in the worst possible way: a link
 * that looks like the fix, and errors.
 *
 * So the message links to the instance's own connected-accounts view —
 * `INTEGRATIONS_RETURN_PATH` (`../http/cores-oauth-broker-surface.ts:135`), the
 * SAME destination a completed grant already returns him to. That URL never
 * expires, and the Connect control on that page mints a fresh consent URL at the
 * moment he taps it, which is the only time a ten-minute window is survivable.
 * One extra tap buys a link that is still correct next Tuesday.
 *
 * ── WHY A MARKDOWN LINK AND NOT A BUTTON ──────────────────────────────────────
 * A tapped `ButtonOption` sends its `value` back as a chat turn, and — apart
 * from two hardcoded sentinels (`../wiring/build-live-agent-turn.ts:960,975`) —
 * that value is handed to the model as `user_text`. There is no registry that
 * routes a button value to a server-side function, so a "Reconnect" button would
 * either need a third hardcoded sentinel or would depend on the model choosing
 * to call the right tool. A markdown link needs neither: both clients render
 * `[text](https://…)` as a real tappable link (mobile:
 * `app/lib/markdown-render.tsx:456-475` → `Linking.openURL`; web:
 * `landing/chat-react/Markdown.tsx:203-219` → a `target="_blank"` anchor), so
 * one tap opens the page in a browser with no model turn in between. Options
 * also ride ONLY on `durability: 'reply'` (`../http/deliver.ts:163`), which
 * is the wrong durability here — see below.
 *
 * ── DURABILITY IS `'inert'` ───────────────────────────────────────────────────
 * The notice is the system stating a fact, not asking a question, so it persists
 * as an already-resolved agent turn (`ButtonStore.persistInertAgentTurn`) and
 * never becomes the topic's active prompt that his next message attaches to —
 * the same reasoning `../http/system-notice-surface.ts` documents. `'none'`
 * would be wrong for the obvious reason: it writes no row, so a notice fired
 * while nothing is connected would simply never have happened.
 *
 * ── EXACTLY ONCE PER DEAD GRANT ───────────────────────────────────────────────
 * `onInvalidGrant` fires on a REFRESH ATTEMPT, and every Core that touches the
 * grant retries, so the naive join buries the chat. The latch is
 * {@link IncidentEdgeTracker} — the same rising-edge dedup the watchdog and the
 * credential-lapse notifier use for exactly this shape — keyed by grant label.
 * Its COMMIT-ON-SUCCESS semantics are why it is reused rather than replaced by a
 * boolean: the label is marked notified only after the durable row is actually
 * written, so a persist failure re-attempts on the next refresh instead of
 * permanently swallowing the one message that mattered.
 *
 * {@link OAuthReconnectNotifier.onGrantHealthy} is the RESET ARM and is not
 * optional garnish: without it the latch never clears, and the feature would
 * notify once and then go silent forever — including for next week's expiry.
 * A successful token write (a reconnect, or a refresh that worked) drops the
 * label from the firing set, so the NEXT death is a fresh incident.
 *
 * TWO HONEST LIMITS, both inherited from the precedent and both the right side
 * to err on:
 *   - The latch is in-memory, so a gateway restart while a grant is still dead
 *     re-tells him once. Repeating a true "this stopped working" after a restart
 *     beats swallowing it.
 *   - Unlike the credential-lapse notifier, this one is driven by CONCURRENT
 *     event callbacks rather than a serialized tick loop: two Cores can hit the
 *     same dead grant in the same instant, and `candidates` would hand the same
 *     rising incident to both before either commits. {@link inFlight} closes
 *     that window with a synchronous check-and-set (single-threaded JS makes it
 *     atomic), which the tick-driven precedent never needed.
 */

import type { Deliver } from '../http/deliver.ts'
import { INTEGRATIONS_RETURN_PATH } from '../http/cores-oauth-broker-surface.ts'
import { createLogger } from '@neutronai/logger'
import { IncidentEdgeTracker } from '@neutronai/watchdog/index.ts'

import { parseGrantLabel } from './oauth-token-manager.ts'

const moduleLog = createLogger('oauth-reconnect-notice')

export interface OAuthReconnectNoticeInput {
  /**
   * The ONE out-of-turn delivery seam (`../http/deliver.ts`), read LAZILY. The
   * notifier is built before `createDeliver` runs at the composition root, the
   * same forward-reference the substrate notice sinks take; it is only deref'd
   * at fire time, long after boot.
   */
  deliver: () => Deliver | undefined
  /** The owner's bare `app:<owner>` topic — what the live client binds + hydrates. */
  owner_topic_id: string
  /**
   * The connected address for a grant label, read from its encrypted `:meta`
   * row. Injected rather than reading the SecretsStore here so this module owns
   * message-shaping and nothing else.
   */
  readAccountEmail: (label: string) => Promise<string | null>
  /**
   * This instance's own public origin. The reconnect link is built from it; when
   * it is absent (no Google OAuth client configured on this deployment) the
   * message degrades to naming the page rather than linking to it.
   */
  owner_base_url: string | null
  now?: () => number
}

export interface OAuthReconnectNotifier {
  /** Wire as `OAuthTokenManager.onInvalidGrant`. */
  onInvalidGrant: (label: string) => Promise<void>
  /** Wire as `OAuthTokenManager.onGrantHealthy` — the latch's reset arm. */
  onGrantHealthy: (label: string) => void
}

/**
 * Human title for a service label. `gmail_compose` → `Gmail Compose`.
 *
 * The account key is a HEX DIGEST, so the raw label would put
 * `google_calendar#a1b2c3d4` in front of the owner. Same transform as
 * `oauthServiceTitle` in `landing/chat-react/integrations-oauth-view.ts`,
 * re-declared rather than imported for the reason that module documents: the
 * browser bundle and the gateway do not import across each other's workspace
 * edge.
 */
export function serviceTitle(label: string): string {
  return parseGrantLabel(label)
    .service.replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * The message the owner reads. Exported for the test that asserts it names the
 * account — "a token expired" is useless when several accounts are connected,
 * and naming the SERVICE is the degrade when the address cannot be read, never
 * an anonymous notice.
 */
export function buildReconnectNoticeBody(input: {
  label: string
  email: string | null
  integrations_url: string | null
}): string {
  const title = serviceTitle(input.label)
  const who = input.email !== null && input.email.length > 0 ? ` for ${input.email}` : ''
  const lead = `**${title}** stopped working${who} — Google expired the connection and it needs reconnecting.`
  return input.integrations_url !== null
    ? `${lead}\n\n[Reconnect ${title}](${input.integrations_url})`
    : `${lead}\n\nOpen Integrations to reconnect it.`
}

/**
 * Build the notifier wired into every `OAuthTokenManager` on this instance.
 *
 * Both managers share ONE notifier instance on purpose: the latch and the
 * in-flight guard are only correct if every grant death on the box passes
 * through the same maps.
 */
export function createOAuthReconnectNotifier(
  input: OAuthReconnectNoticeInput,
): OAuthReconnectNotifier {
  const { deliver, owner_topic_id, readAccountEmail } = input
  const now = input.now ?? ((): number => Date.now())
  const integrations_url =
    input.owner_base_url !== null && input.owner_base_url.length > 0
      ? `${new URL(input.owner_base_url).origin}${INTEGRATIONS_RETURN_PATH}`
      : null

  const incidents = new IncidentEdgeTracker()
  /** Labels believed dead right now — the firing set `candidates` snapshots. */
  const dead = new Set<string>()
  /**
   * Labels with a delivery in flight. `candidates` hands the same uncommitted
   * incident to every concurrent caller, so without this two Cores hitting one
   * dead grant in the same instant would each post the message.
   */
  const inFlight = new Set<string>()
  let sequence = 0

  const mintId = (key: string): string => `${key}:${now()}:${++sequence}`

  return {
    onInvalidGrant: async (label: string): Promise<void> => {
      dead.add(label)
      // Synchronous check-and-set — must not straddle an await, or it stops
      // being a guard.
      if (inFlight.has(label)) return
      const rising = incidents.candidates(dead, mintId)
      const incident = rising.find((r) => r.key === label)
      // Already delivered for this death — the retry storm this feature exists
      // to survive.
      if (incident === undefined) return
      const send = deliver()
      if (send === undefined) {
        moduleLog.warn('oauth_reconnect_notice_no_deliver', { service: parseGrantLabel(label).service })
        return
      }
      inFlight.add(label)
      try {
        const email = await readAccountEmail(label)
        const body = buildReconnectNoticeBody({ label, email, integrations_url })
        // `'inert'` SURFACES a persist failure as a throw (`../http/deliver.ts`),
        // which is the contract we want: leaving the incident uncommitted is the
        // whole point of commit-on-success, so the next refresh re-attempts
        // instead of the owner silently never being told.
        const result = await send(owner_topic_id, { body, durability: 'inert' })
        incidents.commitById(incident.id)
        moduleLog.info('oauth_reconnect_notified', {
          // The label carries a hashed account key and the address is the
          // owner's — neither belongs in a log line. The service does not
          // identify anyone.
          service: parseGrantLabel(label).service,
          delivered_live: result.delivered_live,
        })
      } catch (err) {
        moduleLog.warn('oauth_reconnect_notice_undelivered', {
          service: parseGrantLabel(label).service,
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        inFlight.delete(label)
      }
    },

    onGrantHealthy: (label: string): void => {
      if (!dead.delete(label)) return
      // Re-snapshotting the firing set is what CLEARS the latch for the
      // recovered label (`candidates` drops keys that stopped firing), so the
      // next death of this grant is a fresh incident rather than silence.
      incidents.candidates(dead, mintId)
    },
  }
}
