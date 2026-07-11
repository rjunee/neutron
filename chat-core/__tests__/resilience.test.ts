/**
 * W5 — chat-core connection resilience (Telegram-bar hardening).
 *
 * Drives the four socket-lifecycle gaps deterministically with a fake socket +
 * a virtual clock (no real network, no wall clock):
 *   GAP-1  half-open socket (no `onclose`) → heartbeat detects it → force-close
 *          → reconnect fires; a pong (or any inbound) keeps a live socket alive.
 *   GAP-2  network flap → `notifyReachable()` → immediate reconnect, backoff reset.
 *   GAP-4  an ack that never arrives → `sent` → `failed` → re-queue + resend on
 *          reconnect (idempotent on client_msg_id, no dup in the store).
 *   GAP-5  every (re)open resumes from the MAX seq cursor AND drains the queue on
 *          the SAME open — via session_ready, or the onOpen fallback if it never
 *          comes; a normal connect never double-resumes.
 *
 * The through-line assertion: the client NEVER shows a permanently-stuck clock.
 */

import { describe, expect, it } from 'bun:test'

import { InMemoryStore } from '../store.ts'
import { WebChatSession } from '../web-session.ts'
import { ChatWsClient, type SocketLike } from '../ws-client.ts'

const TOPIC = 'app:sam'

/** A fake socket whose lifecycle callbacks are fired by the test. */
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
  /** Deliver a parsed object as an inbound frame (JSON-encoded on the wire). */
  deliver(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
  fireClose(): void {
    this.onclose?.()
  }
  frames(type: string): Array<Record<string, unknown>> {
    return this.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((e) => e['type'] === type)
  }
}

/** A virtual clock: single-shot timers fired by `advance`, re-queried each step
 *  so rescheduled timers (the idle heartbeat) fire correctly. */
class VirtualClock {
  now = 0
  private nextId = 1
  private timers: Array<{ id: number; at: number; fn: () => void }> = []
  readonly set = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++
    this.timers.push({ id, at: this.now + ms, fn })
    return id
  }
  readonly clear = (h: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== h)
  }
  /** Advance the clock by `ms`, firing every timer that comes due, in order. */
  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (due === undefined) break
      this.timers = this.timers.filter((t) => t.id !== due.id)
      this.now = due.at
      due.fn()
    }
    this.now = target
  }
  pending(): number {
    return this.timers.length
  }
}

/** Let queued microtasks (async handleInbound / flush / ack-timeout) settle. */
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function readyFrame(last_seen_seq?: number): Record<string, unknown> {
  const f: Record<string, unknown> = {
    v: 1,
    type: 'session_ready',
    user_id: 'sam',
    topic_id: TOPIC,
    ts: 0,
  }
  if (last_seen_seq !== undefined) f['last_seen_seq'] = last_seen_seq
  return f
}

// ===========================================================================
// GAP-1 — heartbeat / half-open detection (ChatWsClient)
// ===========================================================================
describe('W5 GAP-1 — heartbeat detects a half-open socket', () => {
  function setup() {
    const clock = new VirtualClock()
    const sockets: FakeSocket[] = []
    const statuses: string[] = []
    const client = new ChatWsClient({
      url: 'wss://test/ws/app/chat',
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      onStatus: (s) => statuses.push(s),
      minBackoffMs: 500,
      maxBackoffMs: 8000,
      jitter: () => 0,
      heartbeatIntervalMs: 25_000,
      heartbeatTimeoutMs: 10_000,
      setTimeoutFn: clock.set,
      clearTimeoutFn: clock.clear,
    })
    return { client, sockets, clock, statuses }
  }

  it('force-closes a half-open socket after a missed pong and reconnects', () => {
    const { client, sockets, clock } = setup()
    client.connect()
    sockets[0]!.fireOpen()
    expect(client.getStatus()).toBe('open')

    // No traffic, no onclose (the half-open case). After the idle window the
    // client pings.
    clock.advance(25_000)
    expect(sockets[0]!.frames('ping').length).toBe(1)
    // Still no pong → after the deadline the socket is force-closed …
    clock.advance(10_000)
    expect(sockets[0]!.closed).toBe(true)
    expect(client.getStatus()).toBe('reconnecting')

    // … and a reconnect is scheduled. Run it → a fresh socket opens.
    clock.advance(500)
    expect(sockets.length).toBe(2)

    // The dead socket's onclose arriving late must NOT double-schedule.
    const pendingBefore = clock.pending()
    sockets[0]!.fireClose()
    expect(clock.pending()).toBe(pendingBefore)
  })

  it('a pong (or any inbound) keeps a live socket alive — no false close', () => {
    const { client, sockets, clock } = setup()
    client.connect()
    sockets[0]!.fireOpen()

    clock.advance(25_000) // idle → ping
    expect(sockets[0]!.frames('ping').length).toBe(1)
    sockets[0]!.deliver({ v: 1, type: 'pong', ts: 1 }) // liveness proof

    clock.advance(10_000) // past the old deadline …
    expect(sockets[0]!.closed).toBe(false) // … not closed
    expect(sockets.length).toBe(1)
    expect(client.getStatus()).toBe('open')

    // The idle countdown restarted, so a fresh silence pings again.
    clock.advance(25_000)
    expect(sockets[0]!.frames('ping').length).toBe(2)
  })
})

// ===========================================================================
// GAP-2 — network-reachability reconnect trigger (ChatWsClient)
// ===========================================================================
describe('W5 GAP-2 — notifyReachable reconnects now + resets backoff', () => {
  it('reconnects immediately with backoff reset instead of waiting out the timer', () => {
    const clock = new VirtualClock()
    const sockets: FakeSocket[] = []
    const client = new ChatWsClient({
      url: 'wss://test/ws/app/chat',
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      minBackoffMs: 500,
      maxBackoffMs: 15_000,
      jitter: () => 0,
      heartbeatIntervalMs: 0, // isolate: no heartbeat noise
      setTimeoutFn: clock.set,
      clearTimeoutFn: clock.clear,
    })
    client.connect()
    sockets[0]!.fireOpen()

    // Drop → reconnect → drop again: backoff has grown (attempt climbing).
    sockets[0]!.fireClose()
    clock.advance(500) // reconnect #1 → socket[1]
    sockets[1]!.fireClose()
    expect(client.getStatus()).toBe('reconnecting')
    expect(client.getAttempt()).toBeGreaterThan(1)

    // Network comes back: don't wait out the (now ~1s+) backoff — reconnect NOW.
    const before = sockets.length
    client.notifyReachable()
    expect(sockets.length).toBe(before + 1) // opened immediately
    expect(client.getAttempt()).toBe(0) // backoff reset to base

    // The reachable-triggered socket opens cleanly.
    sockets.at(-1)!.fireOpen()
    expect(client.getStatus()).toBe('open')
  })

  it('leaves an ALREADY-IN-FLIGHT retry handshake alone instead of tearing it down', () => {
    // Per Codex review: `status === 'reconnecting'` is ambiguous — it also
    // covers a retry socket actively mid-handshake (a backoff timer already
    // fired, `openSocket()` ran, but `onopen` hasn't landed yet), not just
    // "waiting on the timer". `notifyReachable()` only special-cased `'open'`
    // and `'connecting'` as busy, so a reachability signal arriving mid-retry
    // would tear down a handshake that might well succeed on its own and
    // open a redundant replacement — needless churn on the exact "network
    // just came back" signal this method exists to react to quickly.
    const clock = new VirtualClock()
    const sockets: FakeSocket[] = []
    let closeCount = 0
    const client = new ChatWsClient({
      url: 'wss://test/ws/app/chat',
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      onClose: () => { closeCount++ },
      minBackoffMs: 500,
      maxBackoffMs: 15_000,
      jitter: () => 0,
      heartbeatIntervalMs: 0, // isolate: no heartbeat noise
      setTimeoutFn: clock.set,
      clearTimeoutFn: clock.clear,
    })
    client.connect()
    sockets[0]!.fireOpen()
    sockets[0]!.fireClose() // unexpected drop → backoff timer armed
    clock.advance(500) // timer fires → socket[1] created, actively mid-handshake
    expect(client.getStatus()).toBe('reconnecting') // retry in flight, not yet open
    expect(clock.pending()).toBe(0) // no timer armed — a live socket is in flight

    const inFlight = sockets[1]!
    const closesBefore = closeCount

    client.notifyReachable() // reachability fires while the retry is mid-handshake

    // Must be a true no-op on the in-flight socket: not closed, no spurious
    // onClose, no redundant replacement socket opened.
    expect(sockets.length).toBe(2)
    expect(inFlight.closed).toBe(false)
    expect(closeCount).toBe(closesBefore)

    inFlight.fireOpen()
    expect(client.getStatus()).toBe('open')
    expect(sockets.length).toBe(2)
  })
})

// ===========================================================================
// FIX 7 — a deactivated client stays quiescent even if an in-flight socket
// opens LATE (ChatWsClient)
// ===========================================================================
describe('W5 FIX 7 — a late onopen while inactive must not wake the client', () => {
  it('ignores a late open while backgrounded, then reconnects cleanly on reactivation', () => {
    const clock = new VirtualClock()
    const sockets: FakeSocket[] = []
    let opens = 0
    const client = new ChatWsClient({
      url: 'wss://test/ws/app/chat',
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      onOpen: () => {
        opens++
      },
      minBackoffMs: 500,
      maxBackoffMs: 15_000,
      jitter: () => 0,
      heartbeatIntervalMs: 25_000,
      heartbeatTimeoutMs: 10_000,
      setTimeoutFn: clock.set,
      clearTimeoutFn: clock.clear,
    })

    client.connect() // socket[0] in flight (status connecting)
    client.setActive(false) // backgrounded BEFORE it opened
    sockets[0]!.fireOpen() // the connect resolves LATE, while inactive

    // Must stay quiescent: not open, onOpen never fired (no resume-fallback
    // armed), and the just-opened socket was closed.
    expect(client.getStatus()).not.toBe('open')
    expect(opens).toBe(0)
    expect(sockets[0]!.closed).toBe(true)
    // No heartbeat started: advancing past the interval sends no ping.
    clock.advance(25_000)
    expect(sockets[0]!.frames('ping').length).toBe(0)

    // Reactivation re-establishes the socket (the guard didn't strand us offline).
    client.setActive(true)
    expect(sockets.length).toBe(2) // a fresh socket opened
    sockets[1]!.fireOpen()
    expect(client.getStatus()).toBe('open')
    expect(opens).toBe(1) // now onOpen fires normally → resume/drain resume
  })

  it('FIX 8 — re-arms the heartbeat when foregrounding an already-open socket', () => {
    const clock = new VirtualClock()
    const sockets: FakeSocket[] = []
    const client = new ChatWsClient({
      url: 'wss://test/ws/app/chat',
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      minBackoffMs: 500,
      maxBackoffMs: 15_000,
      jitter: () => 0,
      heartbeatIntervalMs: 25_000,
      heartbeatTimeoutMs: 10_000,
      setTimeoutFn: clock.set,
      clearTimeoutFn: clock.clear,
    })

    client.connect()
    sockets[0]!.fireOpen() // live socket, heartbeat armed
    // Background a LIVE socket (stays open), then foreground it.
    client.setActive(false)
    client.setActive(true)
    expect(client.getStatus()).toBe('open') // same socket, not reconnected
    expect(sockets.length).toBe(1)

    // Heartbeat must have resumed: after the idle interval a ping is sent again.
    clock.advance(25_000)
    expect(sockets[0]!.frames('ping').length).toBe(1)
  })
})

// ===========================================================================
// GAP-4 — ack-timeout → failed → resend on reconnect (WebChatSession)
// ===========================================================================
describe('W5 GAP-4 — a never-acked send flips to failed, never a stuck clock', () => {
  it('sent → failed on ack-timeout, then idempotently resends + reconciles on reconnect', async () => {
    const clock = new VirtualClock()
    const sockets: FakeSocket[] = []
    const session = new WebChatSession({
      url: 'wss://test/ws/app/chat',
      topic_id: TOPIC,
      store: new InMemoryStore(),
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      generateId: () => 'cmid-x',
      now: (() => {
        let t = 0
        return () => ++t
      })(),
      ackTimeoutMs: 15_000,
      resumeFallbackMs: 0, // isolate GAP-5 fallback; session_ready drives resume
      setTimeoutFn: clock.set,
      clearTimeoutFn: clock.clear,
    })
    session.start()
    sockets[0]!.fireOpen()
    sockets[0]!.deliver(readyFrame())
    await tick()

    // Send while open → delivered, marked `sent` (the 🕓 clock).
    await session.send('important', { client_msg_id: 'cmid-x' })
    await tick()
    expect(sockets[0]!.frames('user_message').map((e) => e['body'])).toEqual(['important'])
    expect((await session.messages())[0]?.status).toBe('sent')

    // The server echo never arrives. After the ack-timeout the clock is NOT
    // stuck — it flips to `failed` so the UI can show a retry affordance.
    clock.advance(15_000)
    await tick()
    expect((await session.messages())[0]?.status).toBe('failed')

    // Reconnect: a FRESH socket opens (the realistic model — one session_ready
    // per connection) and the failed send is re-driven idempotently on it.
    sockets[0]!.fireClose()
    session.setActive(false) // cancel the auto-reconnect timer
    session.setActive(true) // synchronously open a fresh socket
    const s2 = sockets[1]!
    s2.fireOpen()
    s2.deliver(readyFrame())
    await tick()
    const bodies = s2.frames('user_message').map((e) => e['body'])
    expect(bodies).toEqual(['important']) // resent on the new socket
    expect(s2.frames('user_message').every((e) => e['client_msg_id'] === 'cmid-x')).toBe(true)

    // The echo finally lands → reconciles to a single acked row (no dup).
    s2.deliver({
      v: 1,
      type: 'user_message',
      message_id: 'srv-1',
      seq: 7,
      body: 'important',
      client_msg_id: 'cmid-x',
      ts: 9,
    })
    await tick()
    const msgs = await session.messages()
    expect(msgs.length).toBe(1) // reconciled, not duplicated
    expect(msgs[0]?.status).toBe('acked') // clock fully resolved
    expect(msgs[0]?.seq).toBe(7)
  })
})

// ===========================================================================
// GAP-5 — resume + queue-drain on every re-open (WebChatSession)
// ===========================================================================
describe('W5 GAP-5 — every re-open resumes from MAX seq and drains the queue', () => {
  function makeSession(resumeFallbackMs: number, store = new InMemoryStore()) {
    const clock = new VirtualClock()
    const sockets: FakeSocket[] = []
    let id = 0
    const session = new WebChatSession({
      url: 'wss://test/ws/app/chat',
      topic_id: TOPIC,
      store,
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      generateId: () => `cmid-${++id}`,
      now: (() => {
        let t = 0
        return () => ++t
      })(),
      ackTimeoutMs: 0, // isolate GAP-4
      resumeFallbackMs,
      setTimeoutFn: clock.set,
      clearTimeoutFn: clock.clear,
    })
    return { session, sockets, clock, store }
  }

  it('onOpen fallback resumes from the MAX seq cursor AND drains the queue when session_ready never comes', async () => {
    const store = new InMemoryStore()
    // Pre-seed an acked transcript so the resume cursor sits at seq 5.
    await store.upsert({
      topic_id: TOPIC,
      client_msg_id: '',
      message_id: 'srv-5',
      seq: 5,
      role: 'agent',
      body: 'earlier',
      project_id: null,
      attachments: null,
      created_at: 1,
      status: 'acked',
    })
    const { session, sockets, clock } = makeSession(2_000, store)
    session.start()
    // A message typed while offline (queued, never delivered).
    await session.send('drain me', { client_msg_id: 'q1' })
    await tick()

    // Socket opens but the server NEVER announces session_ready.
    sockets[0]!.fireOpen()
    await tick()
    expect(sockets[0]!.frames('resume').length).toBe(0) // nothing yet

    // The onOpen fallback fires → resume from MAX seq (5) AND drain the queue,
    // both on this SAME open.
    clock.advance(2_000)
    await tick()
    expect(sockets[0]!.frames('resume').at(-1)).toEqual({ v: 1, type: 'resume', after_seq: 5 })
    expect(sockets[0]!.frames('user_message').map((e) => e['body'])).toEqual(['drain me'])
  })

  it('a normal session_ready connect resumes exactly once (fallback cancelled, no double-resume)', async () => {
    const { session, sockets, clock } = makeSession(2_000)
    session.start()
    sockets[0]!.fireOpen()
    sockets[0]!.deliver(readyFrame()) // fast path resumes + cancels the fallback
    await tick()
    expect(sockets[0]!.frames('resume').length).toBe(1)

    // Advancing well past the fallback window fires nothing more.
    clock.advance(10_000)
    await tick()
    expect(sockets[0]!.frames('resume').length).toBe(1)
  })

  it('FIX 1 — a late session_ready AFTER the fallback fired does NOT double-resume/resend', async () => {
    const store = new InMemoryStore()
    // Cursor at seq 5 so the (single) resume is after_seq=5.
    await store.upsert({
      topic_id: TOPIC,
      client_msg_id: '',
      message_id: 'srv-5',
      seq: 5,
      role: 'agent',
      body: 'earlier',
      project_id: null,
      attachments: null,
      created_at: 1,
      status: 'acked',
    })
    const { session, sockets, clock } = makeSession(2_000, store)
    session.start()
    await session.send('drain me', { client_msg_id: 'q1' }) // queued while offline
    await tick()

    sockets[0]!.fireOpen()
    // Fallback fires first (no session_ready yet): resume #1 + resend #1.
    clock.advance(2_000)
    await tick()
    expect(sockets[0]!.frames('resume').length).toBe(1)
    expect(sockets[0]!.frames('user_message').length).toBe(1)

    // session_ready arrives LATE (no seq regression → no reset). It must NOT
    // resume or resend a second time on this same open.
    sockets[0]!.deliver(readyFrame(5))
    await tick()
    expect(sockets[0]!.frames('resume').length).toBe(1) // still exactly one
    expect(sockets[0]!.frames('user_message').length).toBe(1) // no duplicate resend
  })

  it('FIX 1 — a late session_ready that RESETS the store DOES re-resume from 0', async () => {
    const store = new InMemoryStore()
    // Stale transcript from a now-dead server: cursor at seq 40.
    await store.upsert({
      topic_id: TOPIC,
      client_msg_id: '',
      message_id: 'old40',
      seq: 40,
      role: 'agent',
      body: 'stale',
      project_id: null,
      attachments: null,
      created_at: 1,
      status: 'acked',
    })
    const { session, sockets, clock, store: s } = makeSession(2_000, store)
    session.start()
    sockets[0]!.fireOpen()
    // Fallback fires: resume #1 from the stale MAX (after_seq=40).
    clock.advance(2_000)
    await tick()
    expect(sockets[0]!.frames('resume').at(-1)).toEqual({ v: 1, type: 'resume', after_seq: 40 })

    // A late session_ready reports a REGRESSED high-water seq (fresh server) →
    // stale-store reset → a fresh resume-from-0 is mandatory even though the
    // fallback already resumed.
    sockets[0]!.deliver(readyFrame(2))
    await tick()
    expect(await s.lastSeenSeq(TOPIC)).toBe(0) // stale transcript wiped
    const resumes = sockets[0]!.frames('resume')
    expect(resumes.length).toBe(2)
    expect(resumes.at(-1)).toEqual({ v: 1, type: 'resume', after_seq: 0 })
  })

  it('FIX 2 — the fallback never fires on a closed socket (no throw / unhandled rejection)', async () => {
    const { session, sockets, clock } = makeSession(2_000)
    session.start()
    await session.send('queued while offline', { client_msg_id: 'q1' }) // would throw if flushed on a dead socket
    await tick()

    sockets[0]!.fireOpen() // arms the 2s fallback …
    sockets[0]!.fireClose() // … but the socket drops before session_ready
    await tick()

    // Past the fallback window: it was cancelled on close (onClose), so no resume
    // is attempted on the dead socket and nothing rejects.
    clock.advance(5_000)
    await tick()
    expect(sockets[0]!.frames('resume').length).toBe(0)
    expect(sockets[0]!.frames('user_message').length).toBe(0)
    session.stop() // cancel the transport's pending reconnect (real-timer hygiene)
  })
})
