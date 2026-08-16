/**
 * The app-ws send marker.
 *
 * The parser exists because three consumers each re-derived "was it live?" with
 * their own `startsWith` pair and each threw the `<id>` away — which is why
 * notifying for an ordinary reply looked like it needed the send contract
 * widened, when the id was in the return value all along.
 */
import { describe, expect, test } from 'bun:test'

import { parseAppWsSendMarker, shouldNotifyForSend } from '../wiring/app-ws-marker.ts'

describe('parseAppWsSendMarker', () => {
  test('a live marker is delivered, durable, and carries its id', () => {
    expect(parseAppWsSendMarker('app-ws:msg-1')).toEqual({
      delivered_live: true,
      durable: true,
      message_id: 'msg-1',
    })
  })

  test('DROPPED is durable but not live — the case a notification exists for', () => {
    // Nobody was listening. The row is real, so a tap has somewhere to land.
    expect(parseAppWsSendMarker('app-ws:dropped:msg-2')).toEqual({
      delivered_live: false,
      durable: true,
      message_id: 'msg-2',
    })
  })

  test('LOST is neither live NOR durable — there is no row to open', () => {
    // The append failed; a notification pointing at it would open nothing.
    expect(parseAppWsSendMarker('app-ws:lost:msg-3')).toEqual({
      delivered_live: false,
      durable: false,
      message_id: 'msg-3',
    })
  })

  test('dropped and lost DIFFER on durability — the distinction the old predicate flattened', () => {
    // `!live` treated these as the same fact. That is right for delivered_live
    // and wrong for anything deciding whether the message still exists.
    const dropped = parseAppWsSendMarker('app-ws:dropped:a')
    const lost = parseAppWsSendMarker('app-ws:lost:a')
    expect(dropped.delivered_live).toBe(lost.delivered_live)
    expect(dropped.durable).not.toBe(lost.durable)
  })

  test('the qualified prefixes are tested BEFORE the bare one', () => {
    // `app-ws:dropped:x` also starts with `app-ws:`. Wrong order parses it as
    // live with an id of `dropped:x` — plausible-looking and completely wrong.
    const m = parseAppWsSendMarker('app-ws:dropped:x')
    expect(m.delivered_live).toBe(false)
    expect(m.message_id).toBe('x')
  })

  test('a non-string (adapter not yet bound) is nothing sent', () => {
    for (const v of [undefined, null, 42, {}]) {
      expect(parseAppWsSendMarker(v)).toEqual({
        delivered_live: false,
        durable: false,
        message_id: null,
      })
    }
  })

  test('an unrecognised string is nothing sent, never a half-parse', () => {
    expect(parseAppWsSendMarker('telegram:99')).toEqual({
      delivered_live: false,
      durable: false,
      message_id: null,
    })
  })

  test('an empty id is absent, not the empty string', () => {
    // `''` would sail into a push payload as a message_id and anchor a tap on
    // nothing.
    expect(parseAppWsSendMarker('app-ws:').message_id).toBeNull()
    expect(parseAppWsSendMarker('app-ws:dropped:').message_id).toBeNull()
  })

  test('the live reading matches what composer computed before it', () => {
    // Characterisation: whatever else changes, `delivered_live` must stay the
    // predicate the deliver seam already reports.
    const live = (m: string): boolean =>
      typeof m === 'string' && !m.startsWith('app-ws:dropped:') && !m.startsWith('app-ws:lost:')
    for (const m of ['app-ws:1', 'app-ws:dropped:1', 'app-ws:lost:1']) {
      expect(parseAppWsSendMarker(m).delivered_live).toBe(live(m))
    }
  })
})

/**
 * Whether a send notifies. Extracted from the composer because a decision only
 * reachable by booting a 6000-line composer is a decision nothing tests.
 */
describe('shouldNotifyForSend', () => {
  const live = parseAppWsSendMarker('app-ws:m1')
  const dropped = parseAppWsSendMarker('app-ws:dropped:m2')
  const lost = parseAppWsSendMarker('app-ws:lost:m3')
  const none = parseAppWsSendMarker(undefined)
  const base = { owns_notify: true, system_notice: false }

  test('a live reply notifies', () => {
    expect(shouldNotifyForSend({ ...base, sent: live })).toBe(true)
  })

  test('a DROPPED reply notifies — nobody was listening, which is the point', () => {
    expect(shouldNotifyForSend({ ...base, sent: dropped })).toBe(true)
  })

  test('a LOST reply does NOT — there is no row for the tap to open', () => {
    expect(shouldNotifyForSend({ ...base, sent: lost })).toBe(false)
  })

  test('nothing sent does not notify', () => {
    expect(shouldNotifyForSend({ ...base, sent: none })).toBe(false)
  })

  test('a call site that does NOT own the notification stays silent', () => {
    // `deliver` notifies from its own seam. Without this the E2E saw 2 pushes
    // for one delivered post.
    expect(shouldNotifyForSend({ ...base, owns_notify: false, sent: live })).toBe(false)
    expect(shouldNotifyForSend({ ...base, owns_notify: false, sent: dropped })).toBe(false)
  })

  test('a transient system notice never notifies, even when it owns the send', () => {
    expect(shouldNotifyForSend({ ...base, system_notice: true, sent: live })).toBe(false)
  })

  test('a durable marker with no id does not notify — an anchor of null opens nothing', () => {
    expect(
      shouldNotifyForSend({ ...base, sent: { delivered_live: true, durable: true, message_id: null } }),
    ).toBe(false)
  })
})
