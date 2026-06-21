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
  it('sends a resume request from the local cursor on session_ready', async () => {
    const { session, sockets } = setup()
    session.start()
    sockets[0]!.open()
    // First connect: apply seq 1,2 so the cursor advances.
    sockets[0]!.deliver(readyFrame())
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'm1', seq: 1, body: 'a', ts: 1 })
    sockets[0]!.deliver({ v: 1, type: 'agent_message', message_id: 'm2', seq: 2, body: 'b', ts: 2 })
    await new Promise((r) => setTimeout(r, 0))
    // Simulate a reconnect announce — the session must resume after_seq=2.
    sockets[0]!.deliver(readyFrame(2))
    await new Promise((r) => setTimeout(r, 0))
    const resumes = sockets[0]!.resumeFrames()
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
