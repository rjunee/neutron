import { describe, expect, it } from 'bun:test'

import { InMemoryStore } from '../store.ts'
import { WebChatSession } from '../web-session.ts'
import type { SocketLike } from '../ws-client.ts'

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
  deliver(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
  /** The user_message frames this socket sent (parsed). */
  sentUserMessages(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((e) => e['type'] === 'user_message')
  }
  resumeFrames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>).filter((e) => e['type'] === 'resume')
  }
}

function setup() {
  const sockets: FakeSocket[] = []
  let changes = 0
  let id = 0
  const session = new WebChatSession({
    url: 'wss://test/ws/app/chat',
    topic_id: TOPIC,
    store: new InMemoryStore(),
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    onChange: () => { changes++ },
    generateId: () => `cmid-${++id}`,
    now: (() => { let t = 0; return () => ++t })(),
  })
  return { session, sockets, changes: () => changes }
}

function readyFrame(last_seen_seq?: number): Record<string, unknown> {
  const f: Record<string, unknown> = { v: 1, type: 'session_ready', user_id: 'sam', topic_id: TOPIC, ts: 0 }
  if (last_seen_seq !== undefined) f['last_seen_seq'] = last_seen_seq
  return f
}

/**
 * Model a real reconnect: the live socket drops and a FRESH one opens (a new
 * `session_ready` announce follows on the new socket). A reconnect is ALWAYS a
 * new socket in production — the server emits exactly one `session_ready` per
 * connection — so a bare second `session_ready` on the same socket is not a
 * reconnect. The setActive toggle reopens synchronously (bypassing the transport's
 * backoff timer). Returns the new socket. `open()` it, then deliver its
 * `session_ready`.
 */
function reconnect(session: WebChatSession, sockets: FakeSocket[]): FakeSocket {
  sockets.at(-1)!.fireClose()
  session.setActive(false) // cancel the auto-reconnect timer
  session.setActive(true) // synchronously open a fresh socket
  return sockets.at(-1)!
}

describe('WebChatSession — optimistic send + offline queue', () => {
  it('renders a send immediately (queued) even before the socket opens', async () => {
    const { session, sockets } = setup()
    session.start()
    await session.send('hello') // socket not open yet
    const msgs = await session.messages()
    expect(msgs.length).toBe(1)
    expect(msgs[0]?.body).toBe('hello')
    expect(msgs[0]?.status).toBe('queued')
    expect(await session.pendingCount()).toBe(1)
    // Nothing delivered while offline.
    expect(sockets[0]!.sentUserMessages().length).toBe(0)
  })

  it('flushes queued sends on connect (session_ready) and marks them sent', async () => {
    const { session, sockets } = setup()
    session.start()
    await session.send('one')
    await session.send('two')
    // Connect.
    sockets[0]!.open()
    sockets[0]!.deliver(readyFrame())
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    const delivered = sockets[0]!.sentUserMessages()
    expect(delivered.map((e) => e['body'])).toEqual(['one', 'two'])
    expect(await session.pendingCount()).toBe(0)
  })
})

describe('WebChatSession — gap-free reconnect (resume)', () => {
  it('sends a resume request from the local cursor on reconnect', async () => {
    const { session, sockets } = setup()
    session.start()
    sockets[0]!.open()
    // First connect: apply seq 1,2 so the cursor advances.
    sockets[0]!.deliver(readyFrame())
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'm1', seq: 1, body: 'a', ts: 1 })
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'm2', seq: 2, body: 'b', ts: 2 })
    await new Promise((r) => setTimeout(r, 0))
    // Reconnect: a fresh socket opens and announces session_ready — the session
    // must resume after_seq=2 (its local cursor) on the NEW socket.
    const s2 = reconnect(session, sockets)
    s2.open()
    s2.deliver(readyFrame(2))
    await new Promise((r) => setTimeout(r, 0))
    const resumes = s2.resumeFrames()
    expect(resumes.at(-1)).toEqual({ v: 1, type: 'resume', after_seq: 2 })
  })

  it('applies the replayed tail in seq order and de-dups overlap', async () => {
    const { session, sockets } = setup()
    session.start()
    sockets[0]!.open()
    sockets[0]!.deliver(readyFrame())
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'm1', seq: 1, body: 'one', ts: 1 })
    await new Promise((r) => setTimeout(r, 0))
    // Reconnect replay: server resends 1 (overlap) then the missed 2,3.
    sockets[0]!.deliver(readyFrame(3))
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'm1', seq: 1, body: 'one', ts: 1 })
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'm2', seq: 2, body: 'two', ts: 2 })
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'm3', seq: 3, body: 'three', ts: 3 })
    await new Promise((r) => setTimeout(r, 0))
    const msgs = await session.messages()
    expect(msgs.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(msgs.map((m) => m.body)).toEqual(['one', 'two', 'three'])
  })

  it('retries a sent-but-unacked message on reconnect (no lost send)', async () => {
    const { session, sockets } = setup()
    session.start()
    sockets[0]!.open()
    sockets[0]!.deliver(readyFrame())
    await new Promise((r) => setTimeout(r, 0))
    // Send while open → flushed immediately, marked `sent`.
    await session.send('important', { client_msg_id: 'cmid-keep' })
    await new Promise((r) => setTimeout(r, 0))
    expect(sockets[0]!.sentUserMessages().map((e) => e['body'])).toEqual(['important'])
    // The connection drops before the server echoes it (no user_message echo
    // applied → row stays `sent`, never `acked`). A fresh socket reconnects.
    const s2 = reconnect(session, sockets)
    s2.open()
    s2.deliver(readyFrame())
    await new Promise((r) => setTimeout(r, 0))
    // The send is retried on the new socket (idempotent server-side on client_msg_id).
    const bodies = s2.sentUserMessages().map((e) => e['body'])
    expect(bodies).toEqual(['important'])
    expect(s2.sentUserMessages().every((e) => e['client_msg_id'] === 'cmid-keep')).toBe(true)
  })

  it('forwards every raw inbound frame to onFrame without affecting persistence', async () => {
    const captured: FakeSocket[] = []
    const frames: unknown[] = []
    const session = new WebChatSession({
      url: 'wss://test/ws/app/chat',
      topic_id: TOPIC,
      store: new InMemoryStore(),
      createSocket: () => { const s = new FakeSocket(); captured.push(s); return s },
      onFrame: (f) => { frames.push(f) },
      generateId: () => 'cmid-y',
      now: () => 1,
    })
    session.start()
    captured[0]!.open()
    // Streaming partials (NOT persisted messages) reach onFrame so the UI can
    // render the live token stream; only the final agent_message persists.
    captured[0]!.deliver(readyFrame())
    captured[0]!.deliver({ v: 1, type: 'agent_message_partial', message_id: 'm9', body_delta: 'Hel', ts: 1 })
    captured[0]!.deliver({ v: 1, type: 'agent_message_partial', message_id: 'm9', body_delta: 'lo', ts: 2 })
    captured[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'm9', seq: 1, body: 'Hello', ts: 3 })
    await new Promise((r) => setTimeout(r, 0))
    const types = frames.map((f) => (f as Record<string, unknown>)['type'])
    expect(types).toEqual(['session_ready', 'agent_message_partial', 'agent_message_partial', 'agent_message'])
    // Persistence is unchanged: only the final agent_message lands in the store.
    const msgs = await session.messages()
    expect(msgs.map((m) => m.body)).toEqual(['Hello'])
    expect(msgs.length).toBe(1)
  })

  it('reconciles the optimistic bubble when its server echo (with seq) arrives', async () => {
    const { session, sockets } = setup()
    session.start()
    await session.send('typed', { client_msg_id: 'cmid-fixed' })
    sockets[0]!.open()
    sockets[0]!.deliver(readyFrame())
    await new Promise((r) => setTimeout(r, 0))
    // Server echoes the user message with a seq + server id.
    sockets[0]!.deliver({
      v: 1, type: 'user_message', message_id: 'srv-9', seq: 9, body: 'typed', client_msg_id: 'cmid-fixed', ts: 5,
    })
    await new Promise((r) => setTimeout(r, 0))
    const msgs = await session.messages()
    expect(msgs.length).toBe(1) // reconciled, not duplicated
    expect(msgs[0]?.seq).toBe(9)
    expect(msgs[0]?.status).toBe('acked')
  })
})

describe('WebChatSession — stale-store reset on server reinstall (M1)', () => {
  // A store pre-seeded with a transcript from a now-dead server, simulating the
  // OPFS snapshot that survives a server uninstall+reinstall behind the same
  // browser origin. The session is constructed over THIS store.
  async function seededSession(): Promise<{
    session: WebChatSession
    sockets: FakeSocket[]
    store: InMemoryStore
  }> {
    const store = new InMemoryStore()
    // Old transcript: cursor sits at seq 40.
    await store.upsert({
      topic_id: TOPIC, client_msg_id: '', message_id: 'old1', seq: 39, role: 'agent',
      body: 'stale: skip it', project_id: null, attachments: null, created_at: 1, status: 'acked',
    })
    await store.upsert({
      topic_id: TOPIC, client_msg_id: '', message_id: 'old2', seq: 40, role: 'agent',
      body: 'stale: Tabs, Amascence, Pristine', project_id: null, attachments: null, created_at: 2, status: 'acked',
    })
    const sockets: FakeSocket[] = []
    let id = 0
    const session = new WebChatSession({
      url: 'wss://test/ws/app/chat',
      topic_id: TOPIC,
      store,
      createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      generateId: () => `cmid-${++id}`,
      now: (() => { let t = 0; return () => ++t })(),
    })
    return { session, sockets, store }
  }

  it('clears the stale transcript + resumes from 0 when the fresh server seq regressed', async () => {
    const { session, sockets, store } = await seededSession()
    session.start()
    sockets[0]!.open()
    // Fresh server announces a LOWER high-water seq (2 welcome messages).
    sockets[0]!.deliver(readyFrame(2))
    await new Promise((r) => setTimeout(r, 0))
    // Stale rows wiped before the replay; resume requested from after_seq=0.
    expect(await store.lastSeenSeq(TOPIC)).toBe(0)
    expect(sockets[0]!.resumeFrames().at(-1)).toEqual({ v: 1, type: 'resume', after_seq: 0 })
    // The fresh server then replays its real transcript, which renders cleanly.
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'new1', seq: 1, body: 'Welcome to Neutron', ts: 3 })
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'new2', seq: 2, body: "What's your name?", ts: 4 })
    await new Promise((r) => setTimeout(r, 0))
    const msgs = await session.messages()
    expect(msgs.map((m) => m.body)).toEqual(['Welcome to Neutron', "What's your name?"])
    expect(msgs.some((m) => m.body.startsWith('stale:'))).toBe(false)
  })

  it('preserves a queued offline send across the reset and re-drives it on the fresh server', async () => {
    const { session, sockets, store } = await seededSession()
    session.start()
    // User types a message while offline (queued, never delivered to old server).
    await session.send('please keep me', { client_msg_id: 'cmid-keep' })
    sockets[0]!.open()
    // Fresh server announces a regressed seq → reset.
    sockets[0]!.deliver(readyFrame(2))
    await new Promise((r) => setTimeout(r, 0))
    // Stale acked rows gone, but the queued send survives the wipe …
    const msgs = await session.messages()
    expect(msgs.some((m) => m.body.startsWith('stale:'))).toBe(false)
    expect(msgs.map((m) => m.body)).toContain('please keep me')
    // … and is re-driven to the fresh server (idempotent on client_msg_id).
    expect(await store.lastSeenSeq(TOPIC)).toBe(0)
    expect(sockets[0]!.sentUserMessages().map((e) => e['body'])).toContain('please keep me')
  })

  it('does NOT clear on a normal reconnect (server seq >= local cursor)', async () => {
    const { session, sockets, store } = await seededSession()
    session.start()
    sockets[0]!.open()
    // Same server, reconnecting: it reports its true high-water seq (40).
    sockets[0]!.deliver(readyFrame(40))
    await new Promise((r) => setTimeout(r, 0))
    // Transcript preserved; resume continues forward from the existing cursor.
    expect(await store.lastSeenSeq(TOPIC)).toBe(40)
    expect((await session.messages()).length).toBe(2)
    expect(sockets[0]!.resumeFrames().at(-1)).toEqual({ v: 1, type: 'resume', after_seq: 40 })
  })

  it('does NOT clear when the server omits last_seen_seq (absent → never a wipe)', async () => {
    const { session, sockets, store } = await seededSession()
    session.start()
    sockets[0]!.open()
    // No last_seen_seq on the frame (e.g. no durable log): must not destroy the
    // local store, which could be the only copy of the transcript.
    sockets[0]!.deliver(readyFrame())
    await new Promise((r) => setTimeout(r, 0))
    expect(await store.lastSeenSeq(TOPIC)).toBe(40)
    expect((await session.messages()).length).toBe(2)
    expect(sockets[0]!.resumeFrames().at(-1)).toEqual({ v: 1, type: 'resume', after_seq: 40 })
  })
})

describe('WebChatSession — W5 GAP-4 per-message retry (FIX 10)', () => {
  function failedRow(client_msg_id: string, body: string, created_at: number) {
    return {
      topic_id: TOPIC,
      client_msg_id,
      message_id: null,
      seq: null,
      role: 'user' as const,
      body,
      project_id: null,
      attachments: null,
      created_at,
      status: 'failed' as const,
    }
  }

  it('re-drives ONLY the tapped message, never its siblings', async () => {
    const store = new InMemoryStore()
    // Two sends that both timed out awaiting their ack (status `failed`).
    await store.upsert(failedRow('A', 'alpha', 1))
    await store.upsert(failedRow('B', 'beta', 2))
    const sockets: FakeSocket[] = []
    const session = new WebChatSession({
      url: 'wss://test/ws/app/chat',
      topic_id: TOPIC,
      store,
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      // Open the socket WITHOUT a session_ready + no fallback, so the reconnect
      // resume path (which re-drives ALL unacked) can't confound this — isolating
      // the manual per-message retry.
      resumeFallbackMs: 0,
      ackTimeoutMs: 0,
    })
    session.start()
    sockets[0]!.open()
    await new Promise((r) => setTimeout(r, 0))
    // Nothing auto-flushed (no session_ready, no fallback).
    expect(sockets[0]!.sentUserMessages().length).toBe(0)

    // Tap retry on A only → ONLY A is re-driven; B is untouched.
    await session.retry('A')
    await new Promise((r) => setTimeout(r, 0))
    const sent = sockets[0]!.sentUserMessages()
    expect(sent.map((e) => e['body'])).toEqual(['alpha'])
    expect(sent[0]?.['client_msg_id']).toBe('A')
    // B remains failed + un-sent (its own affordance still available).
    expect((await session.messages()).find((m) => m.client_msg_id === 'B')?.status).toBe('failed')
  })

  it('is idempotent (client_msg_id) and a re-drive keeps a single store row', async () => {
    const store = new InMemoryStore()
    await store.upsert(failedRow('A', 'alpha', 1))
    const sockets: FakeSocket[] = []
    const session = new WebChatSession({
      url: 'wss://test/ws/app/chat',
      topic_id: TOPIC,
      store,
      createSocket: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      resumeFallbackMs: 0,
      ackTimeoutMs: 0,
    })
    session.start()
    sockets[0]!.open()
    await session.retry('A')
    await session.retry('A') // tapped twice
    await new Promise((r) => setTimeout(r, 0))
    // Same client_msg_id every time (the server de-dupes); one local row.
    expect(sockets[0]!.sentUserMessages().every((e) => e['client_msg_id'] === 'A')).toBe(true)
    // The server echo reconciles to a single acked row.
    sockets[0]!.deliver({
      v: 1,
      type: 'user_message',
      message_id: 'srv-A',
      client_msg_id: 'A',
      seq: 3,
      body: 'alpha',
      ts: 9,
    })
    await new Promise((r) => setTimeout(r, 0))
    const msgs = await session.messages()
    expect(msgs.length).toBe(1)
    expect(msgs[0]?.status).toBe('acked')
  })
})
