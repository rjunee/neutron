/**
 * @neutronai/open — the app-ws send MARKER, parsed in one place.
 *
 * `AppWsAdapter.send` answers a string that encodes two different facts at once:
 *
 *   `app-ws:<id>`          the row persisted AND a live socket received it
 *   `app-ws:dropped:<id>`  the row persisted, no live socket was listening
 *   `app-ws:lost:<id>`     the chat_log append FAILED — captured nowhere
 *
 * Every consumer had been re-deriving those facts with its own `startsWith`
 * pair — `open/composer.ts` for `delivered_live`, `open/wiring/app-ws.ts` twice
 * for `was_new` — and each copy independently discarded the `<id>`, because a
 * boolean was all any of them wanted at the time. That is why the notification
 * for an ordinary reply looked like it needed the send contract widened: the id
 * it has to anchor on was in the return value the whole time, thrown away three
 * lines after it arrived.
 *
 * ⚠️ THE TWO NOT-LIVE MARKERS ARE OPPOSITES AND THE `startsWith` PAIR HID IT.
 * `dropped` means "durable, nobody was listening" — the case a push notification
 * exists FOR. `lost` means "not durable" — there is no row for a tap to open. A
 * predicate written as "not live" treats them identically, which is correct for
 * `delivered_live` and wrong for anything that has to decide whether a message
 * still exists. Parsing once, into named fields, is what stops the next consumer
 * inheriting that flattening.
 */

const LIVE_PREFIX = 'app-ws:'
const DROPPED_PREFIX = 'app-ws:dropped:'
const LOST_PREFIX = 'app-ws:lost:'

export interface AppWsSendMarker {
  /** A live socket received it. */
  delivered_live: boolean
  /** A durable chat_log row exists — so a transcript or a tap can find it. */
  durable: boolean
  /** The row id, or `null` when the marker carried none. */
  message_id: string | null
}

/** Nothing was sent, or the adapter was not bound yet. */
const NONE: AppWsSendMarker = { delivered_live: false, durable: false, message_id: null }

/**
 * Parse an adapter marker.
 *
 * A non-string (the adapter not yet bound — `deref` answers `undefined`) reads
 * as nothing sent, which is what every previous copy of this logic did by
 * failing its `typeof` check.
 *
 * ORDER MATTERS: `app-ws:dropped:<id>` also starts with `app-ws:`, so the
 * qualified prefixes have to be tested FIRST or every dropped row would parse
 * as live with a `message_id` of `dropped:<id>`.
 */
export function parseAppWsSendMarker(marker: unknown): AppWsSendMarker {
  if (typeof marker !== 'string') return NONE
  if (marker.startsWith(DROPPED_PREFIX)) {
    return { delivered_live: false, durable: true, message_id: idOrNull(marker.slice(DROPPED_PREFIX.length)) }
  }
  if (marker.startsWith(LOST_PREFIX)) {
    return { delivered_live: false, durable: false, message_id: idOrNull(marker.slice(LOST_PREFIX.length)) }
  }
  if (marker.startsWith(LIVE_PREFIX)) {
    return { delivered_live: true, durable: true, message_id: idOrNull(marker.slice(LIVE_PREFIX.length)) }
  }
  return NONE
}

/** An empty id is an absent id — never the empty string. */
function idOrNull(value: string): string | null {
  return value.length > 0 ? value : null
}

/** What the send knows when it decides whether to notify his devices. */
export interface NotifyDecisionInput {
  /**
   * Does THIS call site own the notification?
   *
   * The send has two callers and they are not peers: a live agent turn calls it
   * directly, and `deliver` calls it as its live fan-out — and `deliver`
   * notifies from its own seam, with the dedup and the `delivered_at` stamp that
   * belong there. Without this flag a delivered post buzzes TWICE, which is not
   * a hypothetical: the push E2E caught exactly that (expected 1, received 2).
   */
  owns_notify: boolean
  /** A transient live-only pill — never persisted, so nothing to open. */
  system_notice: boolean
  /** The parsed adapter marker. */
  sent: AppWsSendMarker
}

/**
 * Whether an app-ws send should notify the owner's devices.
 *
 * Extracted from the composer closure because a decision that can only be
 * exercised by booting a 6000-line composer is a decision nothing tests — the
 * same reason `push-observability.ts` and `push-foreground-policy.ts` exist.
 *
 * ⚠️ THE DURABILITY TEST IS `durable`, NOT `!delivered_live`, and the difference
 * is the whole point: `app-ws:dropped:<id>` is durable-but-nobody-listening, the
 * case a notification exists FOR, while `app-ws:lost:<id>` has no row for a tap
 * to open. The predicate this replaced could not tell them apart.
 */
export function shouldNotifyForSend(input: NotifyDecisionInput): boolean {
  if (!input.owns_notify) return false
  if (input.system_notice) return false
  if (!input.sent.durable) return false
  return input.sent.message_id !== null
}
