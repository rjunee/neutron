/**
 * Web presence — the SAFETY properties, not the happy path.
 *
 * The happy path here is one line ("declared foreground ⇒ don't push") and it is
 * not what can hurt the owner. Every test below exists because a plausible
 * implementation of that one line produces PERMANENT SILENCE — no push, no
 * error, nothing on any screen to notice — and silence is the one bug he would
 * never report, because there is nothing to report.
 *
 * So the suite is written from the failure end: for each way presence could get
 * stuck "on", assert the notification still happens.
 */

import { describe, expect, test } from 'bun:test'
import {
  createWebPresenceTracker,
  suppressPushWhileWebForeground,
  WEB_PRESENCE_TTL_MS,
} from './web-presence.ts'
import { WEB_PRESENCE_REFRESH_MS } from '@neutronai/wire-types/web-presence.ts'
import type { ChatMessagePushInput, ChatMessagePushSink } from './chat-message-push.ts'

const OWNER = 'owner'
const MSG: ChatMessagePushInput = { project_id: null, message_id: 'm1', body: 'a message' }

/** A sink that records every call and reports a real delivery. */
function recordingSink(): { sink: ChatMessagePushSink; calls: ChatMessagePushInput[] } {
  const calls: ChatMessagePushInput[] = []
  return {
    calls,
    sink: async (input): Promise<boolean> => {
      calls.push(input)
      return true
    },
  }
}

/** A hand-cranked clock so the TTL is asserted rather than waited out. */
function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: (ms) => void (t += ms) }
}

describe('createWebPresenceTracker', () => {
  test('a declared foreground web client reads as present', () => {
    const tracker = createWebPresenceTracker()
    expect(tracker.isForeground(OWNER)).toBe(false) // control: nothing declared yet
    tracker.foreground(OWNER, 'conn-1')
    expect(tracker.isForeground(OWNER)).toBe(true)
  })

  test('presence EXPIRES on its own — a browser that dies without a close frame cannot silence the owner forever', () => {
    const clock = fakeClock()
    const tracker = createWebPresenceTracker({ now: clock.now })
    tracker.foreground(OWNER, 'conn-1')

    // Control: still inside the window, still present. Without this the test
    // below would pass against a tracker that never records anything at all.
    clock.advance(WEB_PRESENCE_TTL_MS - 1)
    expect(tracker.isForeground(OWNER)).toBe(true)

    // The browser is gone; no close frame ever arrived, so nothing called `drop`.
    clock.advance(2)
    expect(tracker.isForeground(OWNER)).toBe(false)
  })

  test('the TTL leaves room for missed refreshes — a refresh that lands keeps the window open indefinitely', () => {
    const clock = fakeClock()
    const tracker = createWebPresenceTracker({ now: clock.now })
    // A live tab re-declaring on its normal cadence stays present across many
    // multiples of the TTL. If the TTL were ever set below the refresh interval
    // this loop would fail on the first iteration.
    for (let i = 0; i < 20; i++) {
      tracker.foreground(OWNER, 'conn-1')
      clock.advance(WEB_PRESENCE_REFRESH_MS)
      expect(tracker.isForeground(OWNER)).toBe(true)
    }
    // Two consecutive misses are tolerated; the third is not.
    clock.advance(WEB_PRESENCE_REFRESH_MS * 2)
    expect(tracker.isForeground(OWNER)).toBe(false)
  })

  test('an expired entry is FORGOTTEN, not just ignored — the map cannot grow without bound', () => {
    const clock = fakeClock()
    const tracker = createWebPresenceTracker({ now: clock.now })
    for (let i = 0; i < 50; i++) tracker.foreground(OWNER, `conn-${i}`)
    expect(tracker.size()).toBe(50) // control: they really were recorded
    clock.advance(WEB_PRESENCE_TTL_MS)
    expect(tracker.size()).toBe(0)
  })

  test('background clears that screen', () => {
    const tracker = createWebPresenceTracker()
    tracker.foreground(OWNER, 'conn-1')
    expect(tracker.isForeground(OWNER)).toBe(true)
    tracker.background('conn-1')
    expect(tracker.isForeground(OWNER)).toBe(false)
  })

  test('drop clears that screen (socket close)', () => {
    const tracker = createWebPresenceTracker()
    tracker.foreground(OWNER, 'conn-1')
    tracker.drop('conn-1')
    expect(tracker.isForeground(OWNER)).toBe(false)
  })

  test('two tabs are two screens — closing one does not mark the owner absent', () => {
    const tracker = createWebPresenceTracker()
    tracker.foreground(OWNER, 'conn-1')
    tracker.foreground(OWNER, 'conn-2')
    tracker.drop('conn-1')
    expect(tracker.isForeground(OWNER)).toBe(true)
    tracker.drop('conn-2')
    expect(tracker.isForeground(OWNER)).toBe(false)
  })

  test("another user's foregrounded tab is not the owner's presence", () => {
    const tracker = createWebPresenceTracker()
    tracker.foreground('guest', 'conn-guest')
    expect(tracker.isForeground('guest')).toBe(true) // control: it was recorded
    expect(tracker.isForeground(OWNER)).toBe(false)
  })

  test('an empty user or connection id is refused rather than recorded', () => {
    const tracker = createWebPresenceTracker()
    tracker.foreground('', 'conn-1')
    tracker.foreground(OWNER, '')
    expect(tracker.size()).toBe(0)
    expect(tracker.isForeground('')).toBe(false)
    expect(tracker.isForeground(OWNER)).toBe(false)
  })

  test('a nonsense TTL falls back to the shared default instead of meaning "believe forever"', () => {
    const clock = fakeClock()
    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const tracker = createWebPresenceTracker({ now: clock.now, ttl_ms: ttl })
      tracker.foreground(OWNER, 'conn-1')
      expect(tracker.isForeground(OWNER)).toBe(true)
      clock.advance(WEB_PRESENCE_TTL_MS)
      expect(tracker.isForeground(OWNER)).toBe(false)
      clock.advance(1)
    }
  })
})

describe('suppressPushWhileWebForeground', () => {
  test('suppresses the push while the owner is foregrounded on the web', async () => {
    const { sink, calls } = recordingSink()
    const wrapped = suppressPushWhileWebForeground({ sink, isWebForeground: () => true })
    expect(await wrapped(MSG)).toBe(false)
    expect(calls).toHaveLength(0)
  })

  test('sends the push when he is not — and passes the message through UNCHANGED', async () => {
    const { sink, calls } = recordingSink()
    const wrapped = suppressPushWhileWebForeground({ sink, isWebForeground: () => false })
    expect(await wrapped(MSG)).toBe(true)
    expect(calls).toEqual([MSG])
  })

  test('a THROWING presence check notifies rather than silences', async () => {
    const { sink, calls } = recordingSink()
    const logs: string[] = []
    const wrapped = suppressPushWhileWebForeground({
      sink,
      isWebForeground: () => {
        throw new Error('tracker exploded')
      },
      log: (m) => logs.push(m),
    })
    expect(await wrapped(MSG)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(logs.join('\n')).toContain('notifying anyway')
  })

  test('a suppressed push answers FALSE, so the durable row is never stamped delivered', async () => {
    // The stamp is what tells a later idempotent re-emit "he already got this".
    // Answering `true` here would silence the phone permanently for a message
    // that was never sent to it — the exact bug the wrapper exists to avoid
    // creating. Asserted directly because it is invisible from the call site.
    const { sink } = recordingSink()
    const wrapped = suppressPushWhileWebForeground({ sink, isWebForeground: () => true })
    expect(await wrapped(MSG)).toBe(false)
  })

  test('the underlying sink still owns the outcome — a push that reached nobody is not reported as delivered', async () => {
    const wrapped = suppressPushWhileWebForeground({
      sink: async () => false,
      isWebForeground: () => false,
    })
    expect(await wrapped(MSG)).toBe(false)
  })

  test('the decision is re-taken per message, not captured once', async () => {
    const { sink, calls } = recordingSink()
    let present = true
    const wrapped = suppressPushWhileWebForeground({ sink, isWebForeground: () => present })
    await wrapped(MSG)
    expect(calls).toHaveLength(0)
    present = false // he shut the laptop
    await wrapped(MSG)
    expect(calls).toHaveLength(1)
  })

  test('end to end over the real tracker: foreground silences, expiry restores', async () => {
    const clock = fakeClock()
    const tracker = createWebPresenceTracker({ now: clock.now })
    const { sink, calls } = recordingSink()
    const wrapped = suppressPushWhileWebForeground({
      sink,
      isWebForeground: () => tracker.isForeground(OWNER),
    })

    // Nothing declared: he gets notified. (Control — absence means notify.)
    expect(await wrapped(MSG)).toBe(true)
    expect(calls).toHaveLength(1)

    // A tab says it is foregrounded: quiet.
    tracker.foreground(OWNER, 'conn-1')
    expect(await wrapped(MSG)).toBe(false)
    expect(calls).toHaveLength(1)

    // The tab dies without a close frame. The TTL is the only thing that saves
    // him, and it does.
    clock.advance(WEB_PRESENCE_TTL_MS + 1)
    expect(await wrapped(MSG)).toBe(true)
    expect(calls).toHaveLength(2)
  })
})
