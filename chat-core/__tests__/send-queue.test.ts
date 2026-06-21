import { describe, expect, it } from 'bun:test'

import { InMemoryStore } from '../store.ts'
import { SendQueue } from '../send-queue.ts'
import type { OutboundUserMessage } from '../types.ts'

const TOPIC = 'app:sam'

describe('SendQueue — idempotent enqueue', () => {
  it('generates a client_msg_id and persists the message as queued', async () => {
    const store = new InMemoryStore()
    const queue = new SendQueue(store, { generateId: () => 'gen-1', now: () => 42 })
    const msg = await queue.enqueue({ topic_id: TOPIC, body: 'hello' })
    expect(msg.client_msg_id).toBe('gen-1')
    expect(msg.status).toBe('queued')
    expect(msg.seq).toBeNull()
    expect(await queue.pendingCount(TOPIC)).toBe(1)
  })

  it('does NOT duplicate when enqueued twice with the same client_msg_id (double-tap)', async () => {
    const store = new InMemoryStore()
    const queue = new SendQueue(store)
    await queue.enqueue({ topic_id: TOPIC, body: 'hi', client_msg_id: 'cmid-x' })
    await queue.enqueue({ topic_id: TOPIC, body: 'hi', client_msg_id: 'cmid-x' })
    expect(await queue.pendingCount(TOPIC)).toBe(1)
    expect((await store.list(TOPIC)).length).toBe(1)
  })

  it('carries project_id + attachments onto the persisted message', async () => {
    const store = new InMemoryStore()
    const queue = new SendQueue(store, { generateId: () => 'g', now: () => 1 })
    const msg = await queue.enqueue({
      topic_id: TOPIC,
      body: 'with meta',
      project_id: 'proj-1',
      attachments: ['/api/app/upload/abc'],
    })
    expect(msg.project_id).toBe('proj-1')
    expect(msg.attachments).toEqual(['/api/app/upload/abc'])
  })
})

describe('SendQueue — flush', () => {
  it('drains every queued message to the socket and marks them sent', async () => {
    const store = new InMemoryStore()
    const queue = new SendQueue(store, { now: (() => { let t = 0; return () => ++t })() })
    await queue.enqueue({ topic_id: TOPIC, body: 'one', client_msg_id: 'c1' })
    await queue.enqueue({ topic_id: TOPIC, body: 'two', client_msg_id: 'c2' })
    const sent: OutboundUserMessage[] = []
    const flushed = await queue.flush((env) => { sent.push(env) }, TOPIC)
    expect(flushed.length).toBe(2)
    expect(sent.map((e) => e.body)).toEqual(['one', 'two'])
    expect(sent.every((e) => e.type === 'user_message' && e.v === 1)).toBe(true)
    expect(await queue.pendingCount(TOPIC)).toBe(0)
  })

  it('is idempotent across a redundant flush — already-sent messages are not re-sent', async () => {
    const store = new InMemoryStore()
    const queue = new SendQueue(store)
    await queue.enqueue({ topic_id: TOPIC, body: 'one', client_msg_id: 'c1' })
    let sendCount = 0
    await queue.flush(() => { sendCount++ }, TOPIC)
    await queue.flush(() => { sendCount++ }, TOPIC) // second reconnect races
    expect(sendCount).toBe(1)
  })

  it('stops on a send failure and leaves the rest queued for the next reconnect', async () => {
    const store = new InMemoryStore()
    const queue = new SendQueue(store, { now: (() => { let t = 0; return () => ++t })() })
    await queue.enqueue({ topic_id: TOPIC, body: 'one', client_msg_id: 'c1' })
    await queue.enqueue({ topic_id: TOPIC, body: 'two', client_msg_id: 'c2' })
    let calls = 0
    const flushed = await queue.flush(() => {
      calls++
      if (calls === 1) return // first ok
      throw new Error('socket died')
    }, TOPIC)
    expect(flushed.length).toBe(1)
    // 'two' stays queued; a later flush delivers it.
    expect(await queue.pendingCount(TOPIC)).toBe(1)
    let delivered: string[] = []
    await queue.flush((env) => { delivered.push(env.body) }, TOPIC)
    expect(delivered).toEqual(['two'])
  })
})

describe('SendQueue — flushUnacked (reconnect retry of sent-but-unacked)', () => {
  it('re-sends a message stuck `sent` (echo never arrived) on reconnect', async () => {
    const store = new InMemoryStore()
    const queue = new SendQueue(store, { now: () => 7 })
    await queue.enqueue({ topic_id: TOPIC, body: 'lost', client_msg_id: 'c1' })
    // First flush hands it to the socket → marked `sent` …
    await queue.flush(() => {}, TOPIC)
    expect((await store.list(TOPIC))[0]?.status).toBe('sent')
    // … but the connection dropped before the server echoed it. A plain flush
    // would never retry (only drains `queued`):
    let plain = 0
    await queue.flush(() => { plain++ }, TOPIC)
    expect(plain).toBe(0)
    // flushUnacked re-drives it on reconnect.
    const retried: string[] = []
    const flushed = await queue.flushUnacked((env) => { retried.push(env.body) }, TOPIC)
    expect(retried).toEqual(['lost'])
    expect(flushed.length).toBe(1)
  })

  it('never re-sends an acked message', async () => {
    const store = new InMemoryStore()
    const queue = new SendQueue(store, { now: () => 1 })
    await queue.enqueue({ topic_id: TOPIC, body: 'done', client_msg_id: 'c1' })
    await queue.flush(() => {}, TOPIC)
    // Simulate the server echo reconciling it to `acked` (what SyncEngine does).
    const row = (await store.list(TOPIC))[0]!
    await store.upsert({ ...row, message_id: 'srv-1', seq: 1, status: 'acked' })
    const retried: string[] = []
    await queue.flushUnacked((env) => { retried.push(env.body) }, TOPIC)
    expect(retried).toEqual([]) // acked → not re-sent
  })

  it('drains queued AND sent together, oldest first, on reconnect', async () => {
    const store = new InMemoryStore()
    const queue = new SendQueue(store, { now: (() => { let t = 0; return () => ++t })() })
    // 'one' gets sent, 'two' stays queued (socket died before its turn).
    await queue.enqueue({ topic_id: TOPIC, body: 'one', client_msg_id: 'c1' })
    await queue.flush(() => {}, TOPIC) // 'one' → sent
    await queue.enqueue({ topic_id: TOPIC, body: 'two', client_msg_id: 'c2' }) // queued
    const order: string[] = []
    await queue.flushUnacked((env) => { order.push(env.body) }, TOPIC)
    expect(order).toEqual(['one', 'two'])
    // 'two' is now sent too.
    expect((await queue.pendingCount(TOPIC))).toBe(0)
  })
})
