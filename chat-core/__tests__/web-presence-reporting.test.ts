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
import { WEB_PRESENCE_REFRESH_MS } from '@neutronai/wire-types/web-presence.ts'

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

function setup(): {
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
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  })
  return { session, sockets, advance: timers.advance }
}

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

    advance(WEB_PRESENCE_REFRESH_MS * 3 + 1)
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
    advance(WEB_PRESENCE_REFRESH_MS * 10)
    expect(sockets[0]!.presenceStates()).toEqual(['foreground', 'background'])
  })

  it('resumes repeating when the owner comes back to the tab', () => {
    const { session, sockets, advance } = setup()
    session.start()
    sockets[0]!.open()
    session.setActive(false)
    session.setActive(true)
    advance(WEB_PRESENCE_REFRESH_MS + 1)
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
    expect(sockets.length).toBeGreaterThan(1)
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
    advance(WEB_PRESENCE_REFRESH_MS * 5)
    expect(sockets[0]!.presenceStates()).toHaveLength(before)
  })

  it('stop() tears the repeat down', () => {
    const { session, sockets, advance } = setup()
    session.start()
    sockets[0]!.open()
    session.stop()
    const after = sockets[0]!.presenceStates().length
    advance(WEB_PRESENCE_REFRESH_MS * 5)
    expect(sockets[0]!.presenceStates()).toHaveLength(after)
  })
})
