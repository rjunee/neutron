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
    /** Peek at (without removing) the next pending timer's callback. Used to
     *  model a timer that's already been dispatched to the callback queue at
     *  the instant a caller tries to cancel it — `clearTimeout` can't un-fire
     *  a callback already in flight, so grabbing the closure directly and
     *  invoking it later reproduces that race deterministically. */
    peekNextFn(): () => void {
      const t = timers[0]
      if (t === undefined) throw new Error('no pending timer')
      return t.fn
    },
  }
}

function setup() {
  const sockets: FakeSocket[] = []
  const timers = timerHarness()
  const statuses: string[] = []
  const opens: number[] = []
  let openCount = 0
  let closeCount = 0
  const client = new ChatWsClient({
    url: 'wss://test/ws/app/chat',
    createSocket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    onOpen: () => { openCount++; opens.push(openCount) },
    onClose: () => { closeCount++ },
    onStatus: (s) => statuses.push(s),
    minBackoffMs: 500,
    maxBackoffMs: 8000,
    jitter: () => 0, // deterministic: no jitter
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  })
  return { client, sockets, timers, statuses, opens: () => opens, closeCount: () => closeCount }
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

describe('ChatWsClient — connect() during backoff (zombie-socket regression)', () => {
  // A UI wires a manual "retry connection" button (or a remount calls
  // `session.start()` → `connect()`) while a reconnect backoff timer is still
  // armed. Pre-fix, `connect()` opened a new socket WITHOUT cancelling that
  // timer, so it fired later and opened a second socket, orphaning the
  // first — the server ends up holding two live sockets for one client.

  it('connect() cancels the still-armed backoff timer, so it can never fire and open a second socket', () => {
    const { client, sockets, timers } = setup()
    client.connect()
    sockets[0]!.fireOpen()
    sockets[0]!.fireClose() // unexpected drop → reconnecting, backoff timer armed
    expect(client.getStatus()).toBe('reconnecting')
    expect(timers.pendingCount()).toBe(1)

    // Manual retry / remount during backoff.
    client.connect()

    // The pending backoff timer must be cancelled — otherwise it's still
    // armed and will fire later, opening a zombie second socket.
    expect(timers.pendingCount()).toBe(0)
    expect(sockets.length).toBe(2)

    sockets[1]!.fireOpen()
    expect(client.getStatus()).toBe('open')
    // No further sockets ever get created — there's no leftover timer to
    // fire one.
    expect(sockets.length).toBe(2)
  })

  it('openSocket() closes any superseded socket instead of leaking it, even if a stale timer still fires', () => {
    const { client, sockets, timers, closeCount } = setup()
    client.connect()
    sockets[0]!.fireOpen()
    sockets[0]!.fireClose() // unexpected drop → reconnecting, backoff timer armed
    expect(timers.pendingCount()).toBe(1)

    // Grab the still-armed backoff timer's callback BEFORE `connect()` gets a
    // chance to cancel it — models the exact race the bug report describes:
    // "the still-armed backoff timer fires... opening socket B" even though
    // a cancel was attempted.
    const staleReconnectFn = timers.peekNextFn()

    // Manual retry / remount during backoff opens socket A (still mid-
    // handshake — it hasn't fired onopen yet).
    client.connect()
    const socketA = sockets[1]!
    expect(socketA.closed).toBe(false)
    const closesBeforeSupersede = closeCount()

    // The (already in-flight) backoff timer now fires anyway and calls
    // openSocket() again, exactly like the still-armed timer in the bug.
    staleReconnectFn()

    // Exactly one live socket may remain: the superseded one (A) must have
    // been closed by openSocket()'s defense-in-depth guard, not orphaned as
    // a zombie the server still thinks is a live session. Superseding a
    // socket is a real (if mid-handshake) close — `onClose` must fire for it,
    // same as a real unexpected close, so a surface can tear down any state.
    expect(sockets.length).toBe(3)
    const socketB = sockets[2]!
    expect(socketA.closed).toBe(true)
    expect(socketB.closed).toBe(false)
    expect(closeCount()).toBe(closesBeforeSupersede + 1)

    // A's late onopen (its handshake completing after supersession) must be
    // a stale no-op — it must NOT resurrect A as `this.socket` or fire onOpen
    // again for a socket the app never reads from.
    socketA.fireOpen()
    socketB.fireOpen()
    expect(client.getStatus()).toBe('open')
  })

  it('supersedes a FULLY OPEN socket cleanly: closes it, fires onClose to tear down per-open state, then opens fresh', () => {
    // Codex's exact repro: capture the stale backoff callback, call connect()
    // (opens A), let A actually finish its handshake (onOpen fires — a
    // surface would arm its resume-fallback here), THEN the stale callback
    // fires. The superseded-but-live A must be closed AND get its `onClose`
    // (the surface's only signal to tear down what `onOpen` armed) — not just
    // silently dropped.
    const { client, sockets, timers, opens, closeCount } = setup()
    client.connect()
    sockets[0]!.fireOpen()
    sockets[0]!.fireClose() // unexpected drop → reconnecting, backoff timer armed
    const staleReconnectFn = timers.peekNextFn()

    client.connect() // manual retry during backoff → opens socket A
    const socketA = sockets[1]!
    socketA.fireOpen() // A's handshake completes — fully open, onOpen fired
    expect(client.getStatus()).toBe('open')
    expect(opens().length).toBe(2) // socket[0]'s open + A's open

    const closesBeforeSupersede = closeCount()
    staleReconnectFn() // the stale timer fires anyway, superseding live A
    expect(socketA.closed).toBe(true)
    expect(closeCount()).toBe(closesBeforeSupersede + 1) // onClose fired for A

    const socketB = sockets[2]!
    expect(socketB.closed).toBe(false)
    socketB.fireOpen()
    expect(client.getStatus()).toBe('open')
    expect(opens().length).toBe(3) // B's open fires onOpen again, fresh

    // A's own (now-stale) close, if the real socket ever surfaces one, must
    // be a no-op — it must not double-fire onClose or re-schedule.
    const closesAfterBOpen = closeCount()
    socketA.fireClose()
    expect(closeCount()).toBe(closesAfterBOpen)
  })
})
