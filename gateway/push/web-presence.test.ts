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
 *
 * EVERY BOUND HAS A CONTROL. An assertion that something is absent proves
 * nothing unless the same test has shown it can be present — a suite full of
 * `toBe(false)` passes perfectly against a tracker that records nothing at all.
 * Where a test asserts an expiry, a scope miss or a bound, the line above it
 * demonstrates the positive case with the same machinery.
 */

import { describe, expect, test } from 'bun:test'
import {
  createWebPresenceTracker,
  suppressPushWhileWebForeground,
  WEB_PRESENCE_TTL_MS,
} from './web-presence.ts'
import { WEB_PRESENCE_REFRESH_MS } from '@neutronai/wire-types/web-presence.ts'
import { GENERAL_RAIL_ID } from '@neutronai/wire-types/topic-id.ts'
import type { ChatMessagePushInput, ChatMessagePushSink } from './chat-message-push.ts'

const OWNER = 'owner'
/** General scope — `project_id: null` is how `chatMessagePushScope` spells it. */
const MSG: ChatMessagePushInput = { project_id: null, message_id: 'm1', body: 'a message' }
const MSG_IN_PROJECT: ChatMessagePushInput = {
  project_id: 'proj-a',
  message_id: 'm2',
  body: 'a message in a project',
}

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
function fakeClock(start = 1_000_000): {
  now: () => number
  advance: (ms: number) => void
  set: (t: number) => void
} {
  let t = start
  return { now: () => t, advance: (ms) => void (t += ms), set: (v) => void (t = v) }
}

describe('createWebPresenceTracker', () => {
  test('a declared foreground web client reads as present', () => {
    const tracker = createWebPresenceTracker()
    expect(tracker.isForeground(OWNER, null)).toBe(false) // control: nothing declared yet
    tracker.foreground(OWNER, 'conn-1', null)
    expect(tracker.isForeground(OWNER, null)).toBe(true)
  })

  test('presence EXPIRES on its own — a browser that dies without a close frame cannot silence the owner forever', () => {
    const clock = fakeClock()
    const tracker = createWebPresenceTracker({ now: clock.now })
    tracker.foreground(OWNER, 'conn-1', null)

    // Control: still inside the window, still present. Without this the test
    // below would pass against a tracker that never records anything at all.
    clock.advance(WEB_PRESENCE_TTL_MS - 1)
    expect(tracker.isForeground(OWNER, null)).toBe(true)

    // The browser is gone; no close frame ever arrived, so nothing called `drop`.
    clock.advance(2)
    expect(tracker.isForeground(OWNER, null)).toBe(false)
  })

  test('a BACKWARD clock step expires rather than freezing the entry as present forever', () => {
    // The bug this pins: expiry is a subtraction, so an NTP correction or a
    // suspend/resume that moves the clock backward makes `now - at` negative,
    // `>= ttl` never fires, and "expires after a minute" silently becomes
    // "believed until the process dies". The default clock is monotonic
    // (`performance.now`) precisely so this cannot happen in production; this
    // test drives the pathological clock directly to prove the tracker survives
    // one anyway.
    const clock = fakeClock(1_000_000)
    const tracker = createWebPresenceTracker({ now: clock.now })
    tracker.foreground(OWNER, 'conn-1', null)
    expect(tracker.isForeground(OWNER, null)).toBe(true) // control: recorded

    clock.set(1_000_000 - 60 * 60 * 1000) // the clock jumps an hour into the past
    expect(tracker.isForeground(OWNER, null)).toBe(false)
    // …and it is FORGOTTEN, not merely reported absent, so it can never come
    // back when the clock catches up again.
    expect(tracker.size()).toBe(0)
  })

  test('the default clock is monotonic, so a wall-clock step cannot reach the expiry maths', () => {
    // A control on the DEFAULT, not on an injected fake: the property only holds
    // in production if the shipped clock is the monotonic one. `performance.now`
    // counts from process start, so it is always far below a `Date.now` epoch
    // reading — that gap is the observable difference between the two.
    const tracker = createWebPresenceTracker()
    tracker.foreground(OWNER, 'conn-1', null)
    expect(tracker.isForeground(OWNER, null)).toBe(true)
    expect(performance.now()).toBeLessThan(Date.now() / 2)
  })

  test('the TTL leaves room for a missed refresh — a refresh that lands keeps the window open indefinitely', () => {
    const clock = fakeClock()
    const tracker = createWebPresenceTracker({ now: clock.now })
    // A live tab re-declaring on its normal cadence stays present across many
    // multiples of the TTL. If the TTL were ever set below the refresh interval
    // this loop would fail on the first iteration.
    for (let i = 0; i < 20; i++) {
      tracker.foreground(OWNER, 'conn-1', null)
      clock.advance(WEB_PRESENCE_REFRESH_MS)
      expect(tracker.isForeground(OWNER, null)).toBe(true)
    }
    // ONE missed refresh is tolerated; the second is not. (The prune is `>=`, so
    // the entry dies at exactly 3× refresh — see WEB_PRESENCE_TTL_MS's docblock,
    // which used to claim two.)
    clock.advance(WEB_PRESENCE_REFRESH_MS)
    expect(tracker.isForeground(OWNER, null)).toBe(true)
    clock.advance(WEB_PRESENCE_REFRESH_MS)
    expect(tracker.isForeground(OWNER, null)).toBe(false)
  })

  test('expired entries are FORGOTTEN ON WRITE — the map is bounded without anyone calling size()', () => {
    // The earlier version of this test asserted the bound by calling `size()`,
    // which performs the very prune it claimed to verify: it demonstrated that
    // reading prunes, not that the map is bounded. The bound has to hold for a
    // tracker nobody reads — a box with no notifications flowing is exactly the
    // box that would accumulate — so writes prune too, and this drives writes
    // only.
    const clock = fakeClock()
    const tracker = createWebPresenceTracker({ now: clock.now })

    // CONTROL: without the clock moving, 50 distinct connections really are all
    // retained. If this were not 50 the assertion below would be vacuous.
    for (let i = 0; i < 50; i++) tracker.foreground(OWNER, `conn-${i}`, null)
    expect(tracker.size()).toBe(50)

    // Now age every one of them out and keep WRITING, never reading. A thousand
    // short-lived sockets over a long uptime must not leave a thousand entries.
    for (let i = 0; i < 1000; i++) {
      clock.advance(WEB_PRESENCE_TTL_MS)
      tracker.foreground(OWNER, `churn-${i}`, null)
    }
    // Exactly one survivor: the write that just happened. Anything else means
    // the map grew.
    expect(tracker.size()).toBe(1)
  })

  test('background clears that screen', () => {
    const tracker = createWebPresenceTracker()
    tracker.foreground(OWNER, 'conn-1', null)
    expect(tracker.isForeground(OWNER, null)).toBe(true)
    tracker.background('conn-1')
    expect(tracker.isForeground(OWNER, null)).toBe(false)
  })

  test('drop clears that screen (socket close)', () => {
    const tracker = createWebPresenceTracker()
    tracker.foreground(OWNER, 'conn-1', null)
    tracker.drop('conn-1')
    expect(tracker.isForeground(OWNER, null)).toBe(false)
  })

  test('two tabs are two screens — closing one does not mark the owner absent', () => {
    const tracker = createWebPresenceTracker()
    tracker.foreground(OWNER, 'conn-1', null)
    tracker.foreground(OWNER, 'conn-2', null)
    tracker.drop('conn-1')
    expect(tracker.isForeground(OWNER, null)).toBe(true)
    tracker.drop('conn-2')
    expect(tracker.isForeground(OWNER, null)).toBe(false)
  })

  test("another user's foregrounded tab is not the owner's presence", () => {
    const tracker = createWebPresenceTracker()
    tracker.foreground('guest', 'conn-guest', null)
    expect(tracker.isForeground('guest', null)).toBe(true) // control: it was recorded
    expect(tracker.isForeground(OWNER, null)).toBe(false)
  })

  test('an empty user or connection id is refused rather than recorded', () => {
    const tracker = createWebPresenceTracker()
    tracker.foreground('', 'conn-1', null)
    tracker.foreground(OWNER, '', null)
    expect(tracker.size()).toBe(0)
    expect(tracker.isForeground('', null)).toBe(false)
    expect(tracker.isForeground(OWNER, null)).toBe(false)
  })

  test('a nonsense TTL falls back to the shared default instead of meaning "believe forever"', () => {
    const clock = fakeClock()
    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const tracker = createWebPresenceTracker({ now: clock.now, ttl_ms: ttl })
      tracker.foreground(OWNER, 'conn-1', null)
      expect(tracker.isForeground(OWNER, null)).toBe(true)
      clock.advance(WEB_PRESENCE_TTL_MS)
      expect(tracker.isForeground(OWNER, null)).toBe(false)
      clock.advance(1)
    }
  })
})

describe('presence is scoped to the conversation on screen', () => {
  test("a tab open on one project does not silence ANOTHER project's notifications", () => {
    // The failure this pins is the one nobody would ever report: with a global
    // check, leaving a single tab open on any project silenced the phone for
    // EVERY other conversation for as long as that tab stayed open.
    const tracker = createWebPresenceTracker()
    tracker.foreground(OWNER, 'conn-a', 'proj-a')
    expect(tracker.isForeground(OWNER, 'proj-a')).toBe(true) // control: recorded
    expect(tracker.isForeground(OWNER, 'proj-b')).toBe(false)
    expect(tracker.isForeground(OWNER, null)).toBe(false)
  })

  test('a General tab does not silence a project, and a project tab does not silence General', () => {
    const tracker = createWebPresenceTracker()
    tracker.foreground(OWNER, 'conn-general', null)
    expect(tracker.isForeground(OWNER, null)).toBe(true)
    expect(tracker.isForeground(OWNER, 'proj-a')).toBe(false)

    const other = createWebPresenceTracker()
    other.foreground(OWNER, 'conn-a', 'proj-a')
    expect(other.isForeground(OWNER, 'proj-a')).toBe(true)
    expect(other.isForeground(OWNER, null)).toBe(false)
  })

  test('every spelling of General is ONE scope — null, empty string and the rail id', () => {
    // `app/lib/push-foreground-policy.ts` carries the incident this mirrors: the
    // General scope answers to three names and the two sides of the comparison
    // do not agree on which. Comparing raw would buzz him while he reads a
    // General message — or, worse, treat an empty project id as General and
    // silence it.
    for (const declared of [null, '', GENERAL_RAIL_ID]) {
      for (const asked of [null, '', GENERAL_RAIL_ID]) {
        const tracker = createWebPresenceTracker()
        tracker.foreground(OWNER, 'conn-1', declared)
        expect(tracker.isForeground(OWNER, asked)).toBe(true)
      }
    }
  })

  test('two tabs on two projects each answer only for their own', () => {
    const tracker = createWebPresenceTracker()
    tracker.foreground(OWNER, 'conn-a', 'proj-a')
    tracker.foreground(OWNER, 'conn-b', 'proj-b')
    expect(tracker.isForeground(OWNER, 'proj-a')).toBe(true)
    expect(tracker.isForeground(OWNER, 'proj-b')).toBe(true)
    expect(tracker.isForeground(OWNER, 'proj-c')).toBe(false)
    tracker.drop('conn-a')
    expect(tracker.isForeground(OWNER, 'proj-a')).toBe(false)
    expect(tracker.isForeground(OWNER, 'proj-b')).toBe(true)
  })

  test('a connection that SWITCHES scope stops answering for the old one', () => {
    // The web client reconnects to switch projects, so in practice a new scope
    // arrives on a new conn_id — but a client that reused the id must not leave
    // a stale claim behind on the conversation it left.
    const tracker = createWebPresenceTracker()
    tracker.foreground(OWNER, 'conn-1', 'proj-a')
    expect(tracker.isForeground(OWNER, 'proj-a')).toBe(true)
    tracker.foreground(OWNER, 'conn-1', 'proj-b')
    expect(tracker.isForeground(OWNER, 'proj-b')).toBe(true)
    expect(tracker.isForeground(OWNER, 'proj-a')).toBe(false)
    expect(tracker.size()).toBe(1)
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

  test('the presence question is asked ABOUT THE MESSAGE, not in the abstract', async () => {
    // The signature takes the message so that a global predicate cannot be
    // written by accident. This asserts the wiring actually passes it.
    const seen: ChatMessagePushInput[] = []
    const wrapped = suppressPushWhileWebForeground({
      sink: async () => true,
      isWebForeground: (msg) => {
        seen.push(msg)
        return false
      },
    })
    await wrapped(MSG)
    await wrapped(MSG_IN_PROJECT)
    expect(seen).toEqual([MSG, MSG_IN_PROJECT])
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

  test('a suppressed push answers FALSE — it reached no device and says so', async () => {
    // NOTE what this does and does not prove. It is the honest return value, and
    // it keeps the `notified` arm of deliver's stamp condition false. It does NOT
    // by itself keep the row unstamped, because that condition is
    // `notified || delivered` — see `deliver-web-presence.test.ts`, which drives
    // both together and is the only place that seam is visible.
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
      isWebForeground: (msg) => tracker.isForeground(OWNER, msg.project_id),
    })

    // Nothing declared: he gets notified. (Control — absence means notify.)
    expect(await wrapped(MSG)).toBe(true)
    expect(calls).toHaveLength(1)

    // A tab says it is foregrounded: quiet.
    tracker.foreground(OWNER, 'conn-1', null)
    expect(await wrapped(MSG)).toBe(false)
    expect(calls).toHaveLength(1)

    // The tab dies without a close frame. The TTL is the only thing that saves
    // him, and it does.
    clock.advance(WEB_PRESENCE_TTL_MS + 1)
    expect(await wrapped(MSG)).toBe(true)
    expect(calls).toHaveLength(2)
  })

  test('end to end over the real tracker: the OTHER conversation still notifies', async () => {
    const tracker = createWebPresenceTracker()
    const { sink, calls } = recordingSink()
    const wrapped = suppressPushWhileWebForeground({
      sink,
      isWebForeground: (msg) => tracker.isForeground(OWNER, msg.project_id),
    })

    tracker.foreground(OWNER, 'conn-a', 'proj-a')
    // The conversation he is reading: quiet.
    expect(await wrapped({ ...MSG_IN_PROJECT, project_id: 'proj-a' })).toBe(false)
    expect(calls).toHaveLength(0)
    // A different project, and General: still buzz. He cannot see either.
    expect(await wrapped({ ...MSG_IN_PROJECT, project_id: 'proj-b' })).toBe(true)
    expect(await wrapped(MSG)).toBe(true)
    expect(calls).toHaveLength(2)
  })
})
