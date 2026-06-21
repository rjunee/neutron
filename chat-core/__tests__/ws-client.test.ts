import { describe, expect, it } from 'bun:test'

import { ChatWsClient, type SocketLike } from '../ws-client.ts'

/** A controllable fake socket + a manual timer queue so the reconnect/backoff
 *  machine is driven deterministically with no real network or wall clock. */
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
  fireOpen(): void {
    this.onopen?.()
  }
  fireMessage(data: unknown): void {
    this.onmessage?.({ data })
  }
  fireClose(): void {
    this.onclose?.()
  }
}

interface PendingTimer {
  fn: () => void
  ms: number
  handle: number
}

function timerHarness() {
  const timers: PendingTimer[] = []
  let nextHandle = 1
  return {
    setTimeoutFn: (fn: () => void, ms: number): unknown => {
      const handle = nextHandle++
      timers.push({ fn, ms, handle })
      return handle
    },
    clearTimeoutFn: (handle: unknown): void => {
      const idx = timers.findIndex((t) => t.handle === handle)
      if (idx >= 0) timers.splice(idx, 1)
    },
    /** Run the single pending timer (the scheduled reconnect). */
    runNext(): number {
      const t = timers.shift()
      if (t === undefined) throw new Error('no pending timer')
      t.fn()
      return t.ms
    },
    pendingCount(): number {
      return timers.length
    },
  }
}

function setup() {
  const sockets: FakeSocket[] = []
  const timers = timerHarness()
  const statuses: string[] = []
  const opens: number[] = []
  let openCount = 0
  const client = new ChatWsClient({
    url: 'wss://test/ws/app/chat',
    createSocket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    onOpen: () => { openCount++; opens.push(openCount) },
    onStatus: (s) => statuses.push(s),
    minBackoffMs: 500,
    maxBackoffMs: 8000,
    jitter: () => 0, // deterministic: no jitter
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  })
  return { client, sockets, timers, statuses, opens: () => opens }
}

describe('ChatWsClient — connect + open', () => {
  it('opens a socket on connect and fires onOpen', () => {
    const { client, sockets, statuses } = setup()
    client.connect()
    expect(sockets.length).toBe(1)
    expect(client.getStatus()).toBe('connecting')
    sockets[0]!.fireOpen()
    expect(client.getStatus()).toBe('open')
    expect(statuses).toContain('open')
  })

  it('parses inbound JSON frames and forwards the object', () => {
    const messages: unknown[] = []
    const sockets: FakeSocket[] = []
    const client = new ChatWsClient({
      url: 'wss://x',
      createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      onMessage: (d) => messages.push(d),
    })
    client.connect()
    sockets[0]!.fireOpen()
    sockets[0]!.fireMessage(JSON.stringify({ v: 1, type: 'agent_message', seq: 4 }))
    expect(messages).toEqual([{ v: 1, type: 'agent_message', seq: 4 }])
  })

  it('send returns false when not open and true once open', () => {
    const { client, sockets } = setup()
    expect(client.send({ hi: 1 })).toBe(false)
    client.connect()
    sockets[0]!.fireOpen()
    expect(client.send({ v: 1, type: 'resume', after_seq: 0 })).toBe(true)
    expect(sockets[0]!.sent.length).toBe(1)
  })
})

describe('ChatWsClient — reconnect with exponential backoff', () => {
  it('schedules a reconnect on unexpected close with growing backoff', () => {
    const { client, sockets, timers } = setup()
    client.connect()
    sockets[0]!.fireOpen()
    // Unexpected drop.
    sockets[0]!.fireClose()
    expect(client.getStatus()).toBe('reconnecting')
    expect(timers.pendingCount()).toBe(1)
    // First reconnect delay = 500 * 2^0.
    const d1 = timers.runNext()
    expect(d1).toBe(500)
    expect(sockets.length).toBe(2)
    // That socket also fails to open and closes → next backoff doubles.
    sockets[1]!.fireClose()
    const d2 = timers.runNext()
    expect(d2).toBe(1000)
    // And again.
    sockets[2]!.fireClose()
    const d3 = timers.runNext()
    expect(d3).toBe(2000)
  })

  it('caps backoff at maxBackoffMs', () => {
    const { client, sockets, timers } = setup()
    client.connect()
    sockets[0]!.fireOpen()
    // Drive many failed reconnects; delay must never exceed 8000.
    sockets[0]!.fireClose()
    let lastDelay = 0
    for (let i = 0; i < 8; i++) {
      lastDelay = timers.runNext()
      const latest = sockets[sockets.length - 1]!
      latest.fireClose()
    }
    expect(lastDelay).toBeLessThanOrEqual(8000)
    expect(lastDelay).toBe(8000)
  })

  it('resets backoff to base after a successful open', () => {
    const { client, sockets, timers } = setup()
    client.connect()
    sockets[0]!.fireOpen()
    sockets[0]!.fireClose()
    timers.runNext() // 500 → socket[1]
    sockets[1]!.fireClose()
    timers.runNext() // 1000 → socket[2]
    sockets[2]!.fireOpen() // success resets attempt
    sockets[2]!.fireClose()
    const d = timers.runNext()
    expect(d).toBe(500) // back to base
  })

  it('fires onOpen on every reconnect so resume + flush re-run', () => {
    const { client, sockets, timers, opens } = setup()
    client.connect()
    sockets[0]!.fireOpen()
    sockets[0]!.fireClose()
    timers.runNext()
    sockets[1]!.fireOpen()
    expect(opens().length).toBe(2)
  })
})

describe('ChatWsClient — AppState awareness', () => {
  it('stops reconnecting when backgrounded and reconnects immediately on foreground', () => {
    const { client, sockets, timers } = setup()
    client.connect()
    sockets[0]!.fireOpen()
    // Background: cancel any reconnect, stop flapping.
    sockets[0]!.fireClose()
    expect(timers.pendingCount()).toBe(1)
    client.setActive(false)
    expect(timers.pendingCount()).toBe(0)
    // Foreground: reconnect immediately with reset backoff (no timer wait).
    client.setActive(true)
    expect(sockets.length).toBe(2)
    expect(client.getAttempt()).toBe(0)
  })

  it('does not reconnect after an explicit close', () => {
    const { client, sockets, timers } = setup()
    client.connect()
    sockets[0]!.fireOpen()
    client.close()
    expect(client.getStatus()).toBe('closed')
    sockets[0]!.fireClose()
    expect(timers.pendingCount()).toBe(0)
    expect(sockets.length).toBe(1)
  })
})
