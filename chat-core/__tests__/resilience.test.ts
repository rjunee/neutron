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

    // Reconnect announce → the failed send is re-driven (idempotent).
    sockets[0]!.deliver(readyFrame())
    await tick()
    const bodies = sockets[0]!.frames('user_message').map((e) => e['body'])
    expect(bodies).toEqual(['important', 'important']) // resent
    expect(sockets[0]!.frames('user_message').every((e) => e['client_msg_id'] === 'cmid-x')).toBe(true)

    // The echo finally lands → reconciles to a single acked row (no dup).
    sockets[0]!.deliver({
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
})
