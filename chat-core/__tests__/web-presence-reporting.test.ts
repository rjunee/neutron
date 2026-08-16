/**
 * The CLIENT half of web presence: does the browser actually keep telling the
 * server the owner is looking?
 *
 * The server forgets a `foreground` claim after `WEB_PRESENCE_TTL_MS` precisely
 * so a dead browser cannot silence the owner's phone forever — which means a
 * live browser that stops repeating itself gets forgotten too. That is the safe
 * direction (he gets a redundant buzz), but it also silently disables the
 * feature, so the repeat is asserted here rather than assumed.
 *
 * The other half — that the declaration is re-made on a RECONNECT — is not a
 * nicety: presence is keyed per connection on the server, so a fresh socket
 * starts with no knowledge of this tab at all. A client that only spoke on the
 * visibility EDGE would go quiet for the rest of its life after one network flap.
 */

import { describe, expect, it } from 'bun:test'

import { InMemoryStore } from '../store.ts'
import { WebChatSession } from '../web-session.ts'
import type { SocketLike } from '../ws-client.ts'
import { DEFAULT_PRESENCE_REFRESH_MS } from '../web-session.ts'
import {
  WEB_PRESENCE_REFRESH_MS,
  WEB_PRESENCE_TTL_MS,
} from '@neutronai/wire-types/web-presence.ts'

const TOPIC = 'app:sam'

class FakeSocket implements SocketLike {
  onopen: ((ev?: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev?: unknown) => void) | null = null
  onerror: ((ev?: unknown) => void) | null = null
  readonly sent: string[] = []
  closed = false
  send(data: string): void {
    if (this.closed) throw new Error('closed')
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
  }
  open(): void {
    this.onopen?.()
  }
  fireClose(): void {
    this.closed = true
    this.onclose?.()
  }
  presenceStates(): string[] {
    return this.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((e) => e['type'] === 'presence')
      .map((e) => String(e['state']))
  }
}

/** A hand-cranked timer queue, so the refresh cadence is asserted rather than waited out. */
function fakeTimers(): {
  setTimeoutFn: (fn: () => void, ms: number) => unknown
  clearTimeoutFn: (handle: unknown) => void
  /** Run every timer due at or before `now + ms`, advancing the clock. */
  advance: (ms: number) => void
} {
  let now = 0
  let nextId = 1
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimeoutFn: (fn, ms) => {
      const id = nextId++
      pending.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeoutFn: (handle) => void pending.delete(handle as number),
    advance: (ms) => {
      const target = now + ms
      // Re-scan after each fire: the presence refresh is a CHAINED single-shot,
      // so running one enqueues the next.
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | null = null
        for (const entry of pending) {
          if (entry[1].at <= target && (due === null || entry[1].at < due[1].at)) due = entry
        }
        if (due === null) break
        pending.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = target
    },
  }
}

function setup(over: { presenceRefreshMs?: number } = {}): {
  session: WebChatSession
  sockets: FakeSocket[]
  advance: (ms: number) => void
} {
  const sockets: FakeSocket[] = []
  const timers = fakeTimers()
  const session = new WebChatSession({
    url: 'wss://test/ws/app/chat',
    topic_id: TOPIC,
    store: new InMemoryStore(),
    createSocket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    // Off: this suite is about presence, and a resume frame on every open would
    // only add noise to the assertions.
    resumeFallbackMs: 0,
    ...(over.presenceRefreshMs !== undefined ? { presenceRefreshMs: over.presenceRefreshMs } : {}),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  })
  return { session, sockets, advance: timers.advance }
}

describe('the client cadence and the server window', () => {
  it('the client refreshes on exactly the interval the server derives its TTL from', () => {
    // The two numbers live in two files ON PURPOSE — `chat-core` must not take a
    // RUNTIME dependency on `@neutronai/wire-types` or the browser bundle
    // intermittently fails to build (see `DEFAULT_PRESENCE_REFRESH_MS` in
    // `web-session.ts` for the measurement). This assertion is what makes that
    // duplication safe: drift them and the refresh stops landing inside the
    // window the server believes, which ends in the owner's phone going quiet.
    expect(DEFAULT_PRESENCE_REFRESH_MS).toBe(WEB_PRESENCE_REFRESH_MS)
    // And the window must be strictly wider than one refresh, or a single
    // late tick would look like a departed browser.
    expect(WEB_PRESENCE_TTL_MS).toBeGreaterThan(WEB_PRESENCE_REFRESH_MS)
  })
})

describe('web presence reporting', () => {
  it('declares foreground as soon as the socket opens', () => {
    const { session, sockets } = setup()
    session.start()
    sockets[0]!.open()
    expect(sockets[0]!.presenceStates()).toEqual(['foreground'])
  })

  it('re-declares on the refresh cadence while foregrounded', () => {
    const { session, sockets, advance } = setup()
    session.start()
    sockets[0]!.open()
    expect(sockets[0]!.presenceStates()).toHaveLength(1) // control: the open declaration

    advance(DEFAULT_PRESENCE_REFRESH_MS * 3 + 1)
    expect(sockets[0]!.presenceStates()).toEqual([
      'foreground',
      'foreground',
      'foreground',
      'foreground',
    ])
  })

  it('reports background immediately on hide, and stops repeating', () => {
    const { session, sockets, advance } = setup()
    session.start()
    sockets[0]!.open()

    session.setActive(false)
    expect(sockets[0]!.presenceStates()).toEqual(['foreground', 'background'])

    // Nothing further, ever — the server would expire us anyway, but a client
    // that kept asserting `foreground` from a hidden tab would be the bug.
    advance(DEFAULT_PRESENCE_REFRESH_MS * 10)
    expect(sockets[0]!.presenceStates()).toEqual(['foreground', 'background'])
  })

  it('resumes repeating when the owner comes back to the tab', () => {
    const { session, sockets, advance } = setup()
    session.start()
    sockets[0]!.open()
    session.setActive(false)
    session.setActive(true)
    advance(DEFAULT_PRESENCE_REFRESH_MS + 1)
    expect(sockets[0]!.presenceStates()).toEqual([
      'foreground',
      'background',
      'foreground',
      'foreground',
    ])
  })

  it('re-declares on a RECONNECT — a new socket knows nothing about this tab', () => {
    const { session, sockets } = setup()
    session.start()
    sockets[0]!.open()
    // The same reconnect model `web-session.test.ts` uses: drop the live socket,
    // then toggle active to open a fresh one synchronously (the transport's own
    // backoff timer is not on this suite's injected clock).
    sockets[0]!.fireClose()
    session.setActive(false)
    session.setActive(true)
    // EXACTLY two, not "more than one". `toBeGreaterThan(1)` passed for any
    // number of accidental reconnects, and each extra socket is an extra
    // connection the server tracks presence for — precisely the leak this suite
    // would need to catch, hidden by inspecting only the last one.
    expect(sockets).toHaveLength(2)
    const reconnected = sockets.at(-1)!
    reconnected.open()
    // The declaration is made by the OPEN, not by the visibility toggle above:
    // the toggle ran while the socket was down, so both its frames were dropped
    // (`ChatWsClient.send` returns false on a closed socket).
    expect(reconnected.presenceStates()).toEqual(['foreground'])
  })

  it('does not keep repeating into a dead socket after it closes', () => {
    const { session, sockets, advance } = setup()
    session.start()
    sockets[0]!.open()
    const before = sockets[0]!.presenceStates().length
    sockets[0]!.fireClose()
    advance(DEFAULT_PRESENCE_REFRESH_MS * 5)
    expect(sockets[0]!.presenceStates()).toHaveLength(before)
  })

  it('stop() tears the repeat down', () => {
    const { session, sockets, advance } = setup()
    session.start()
    sockets[0]!.open()
    session.stop()
    const after = sockets[0]!.presenceStates().length
    advance(DEFAULT_PRESENCE_REFRESH_MS * 5)
    expect(sockets[0]!.presenceStates()).toHaveLength(after)
  })

  it('a NON-FINITE refresh disables the repeat instead of flooding frames', () => {
    // `NaN <= 0` is false, so a NaN sails past a bare `<= 0` disable check into
    // `setTimeout`, which coerces NaN to 0 — and because this timer re-arms from
    // its own callback that is not a fast timer but an unbounded loop of presence
    // frames, one per event-loop turn, for as long as the tab is open.
    const { session, sockets, advance } = setup({ presenceRefreshMs: Number.NaN })
    session.start()
    sockets[0]!.open()
    // The declaration on open still happens — only the REPEAT is disabled.
    expect(sockets[0]!.presenceStates()).toEqual(['foreground'])
    advance(DEFAULT_PRESENCE_REFRESH_MS * 10)
    expect(sockets[0]!.presenceStates()).toEqual(['foreground'])
  })

  it('CONTROL for the guard above: a FINITE refresh does repeat on the same harness', () => {
    // Without this, the NaN test would pass equally against a session that had
    // stopped sending presence frames altogether.
    const { session, sockets, advance } = setup({ presenceRefreshMs: 1_000 })
    session.start()
    sockets[0]!.open()
    advance(3_500)
    expect(sockets[0]!.presenceStates()).toHaveLength(4)
  })
})

describe('attention is a SEPARATE signal from transport activity', () => {
  it('an INATTENTIVE but visible tab reports background — "visible" is not "using"', () => {
    // The gap this closes: a chat tab parked on a second monitor is
    // `visibilityState === 'visible'` all day, so on visibility alone it
    // re-declares `foreground` every 20 s forever and the server's TTL never
    // fires. Presence would then protect only against a DEAD client, not against
    // the resting state of a live one.
    const { session, sockets, advance } = setup()
    session.start()
    sockets[0]!.open()
    expect(sockets[0]!.presenceStates()).toEqual(['foreground']) // control

    session.setAttentive(false)
    expect(sockets[0]!.presenceStates()).toEqual(['foreground', 'background'])
    // …and it stops repeating, so the server expires it rather than being told
    // `foreground` again on the next tick.
    advance(DEFAULT_PRESENCE_REFRESH_MS * 10)
    expect(sockets[0]!.presenceStates()).toEqual(['foreground', 'background'])
  })

  it('attention does NOT touch the transport — the socket stays open and connected', () => {
    // Load-bearing: folding attention into `setActive` would tear down the
    // connection of a tab that is sitting there waiting for the very message this
    // feature is about. An idle tab must keep receiving messages live; the only
    // thing that changes is that his phone starts buzzing again.
    const { session, sockets } = setup()
    session.start()
    sockets[0]!.open()
    session.setAttentive(false)
    expect(sockets).toHaveLength(1) // no reconnect
    expect(sockets[0]!.closed).toBe(false) // and no teardown
  })

  it('coming back re-declares foreground and resumes the repeat', () => {
    const { session, sockets, advance } = setup()
    session.start()
    sockets[0]!.open()
    session.setAttentive(false)
    session.setAttentive(true)
    advance(DEFAULT_PRESENCE_REFRESH_MS + 1)
    expect(sockets[0]!.presenceStates()).toEqual([
      'foreground',
      'background',
      'foreground',
      'foreground',
    ])
  })

  it('BOTH must hold — a hidden tab stays background however attentive it claims to be', () => {
    const { session, sockets } = setup()
    session.start()
    sockets[0]!.open()
    session.setActive(false)
    session.setAttentive(true)
    expect(sockets[0]!.presenceStates()).toEqual(['foreground', 'background', 'background'])
  })

  it('an inattentive session that RECONNECTS does not declare foreground on the new socket', () => {
    // The reconnect path re-states presence from scratch (a fresh socket carries
    // no server-side record). If it restated the visibility level only, a
    // network flap would silently re-silence the owner's phone while he was away.
    const { session, sockets } = setup()
    session.start()
    sockets[0]!.open()
    session.setAttentive(false)
    sockets[0]!.fireClose()
    session.setActive(false)
    session.setActive(true)
    expect(sockets).toHaveLength(2)
    const reconnected = sockets.at(-1)!
    reconnected.open()
    expect(reconnected.presenceStates()).toEqual(['background'])
  })
})
