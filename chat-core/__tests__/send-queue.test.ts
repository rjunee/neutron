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
