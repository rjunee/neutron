import { describe, expect, it } from 'bun:test'

import { InMemoryStore } from '../store.ts'
import { SyncEngine } from '../sync-engine.ts'
import { SendQueue } from '../send-queue.ts'
import type { InboundChatMessage } from '../types.ts'

const TOPIC = 'app:sam'

function inbound(partial: Partial<InboundChatMessage> & { message_id: string }): InboundChatMessage {
  return {
    role: 'agent',
    seq: null,
    body: 'hi',
    client_msg_id: null,
    project_id: null,
    attachments: null,
    created_at: 0,
    ...partial,
  }
}

describe('SyncEngine — apply + cursor', () => {
  it('advances the resume cursor to the max applied seq', async () => {
    const engine = new SyncEngine(new InMemoryStore())
    await engine.applyInbound(TOPIC, inbound({ message_id: 'm1', seq: 1, body: 'a' }))
    await engine.applyInbound(TOPIC, inbound({ message_id: 'm2', seq: 2, body: 'b' }))
    expect(await engine.cursor(TOPIC)).toBe(2)
    const resume = await engine.resumeRequest(TOPIC)
    expect(resume).toEqual({ v: 1, type: 'resume', after_seq: 2 })
  })

  it('orders by seq, never by clock (later seq with earlier ts still sorts last)', async () => {
    const engine = new SyncEngine(new InMemoryStore())
    await engine.applyInbound(TOPIC, inbound({ message_id: 'm1', seq: 1, body: 'first', created_at: 9999 }))
    await engine.applyInbound(TOPIC, inbound({ message_id: 'm2', seq: 2, body: 'second', created_at: 1 }))
    const msgs = await engine.messages(TOPIC)
    expect(msgs.map((m) => m.body)).toEqual(['first', 'second'])
  })
})

describe('SyncEngine — out-of-order delivery + dedup', () => {
  it('applies out-of-order seqs and renders them in seq order', async () => {
    const engine = new SyncEngine(new InMemoryStore())
    await engine.applyInbound(TOPIC, inbound({ message_id: 'm3', seq: 3, body: 'three' }))
    await engine.applyInbound(TOPIC, inbound({ message_id: 'm1', seq: 1, body: 'one' }))
    await engine.applyInbound(TOPIC, inbound({ message_id: 'm2', seq: 2, body: 'two' }))
    const msgs = await engine.messages(TOPIC)
    expect(msgs.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(msgs.map((m) => m.body)).toEqual(['one', 'two', 'three'])
  })

  it('de-dups a re-delivered message (same seq + message_id) — no duplicate row', async () => {
    const engine = new SyncEngine(new InMemoryStore())
    const first = await engine.applyInbound(TOPIC, inbound({ message_id: 'm3', seq: 3 }))
    expect(first.applied).toBe(true)
    const again = await engine.applyInbound(TOPIC, inbound({ message_id: 'm3', seq: 3 }))
    expect(again.applied).toBe(false)
    const msgs = await engine.messages(TOPIC)
    expect(msgs.length).toBe(1)
  })

  it('reconciles an optimistic row (client_msg_id) with its server echo carrying the seq', async () => {
    const store = new InMemoryStore()
    const queue = new SendQueue(store, { generateId: () => 'cmid-1', now: () => 100 })
    const engine = new SyncEngine(store)
    // Optimistic local send — no seq yet.
    await queue.enqueue({ topic_id: TOPIC, body: 'hello' })
    let msgs = await engine.messages(TOPIC)
    expect(msgs.length).toBe(1)
    expect(msgs[0]?.seq).toBeNull()
    expect(msgs[0]?.status).toBe('queued')
    // Server echo for the same client_msg_id arrives with a seq.
    const result = await engine.applyInbound(
      TOPIC,
      inbound({ role: 'user', message_id: 'srv-1', seq: 5, body: 'hello', client_msg_id: 'cmid-1' }),
    )
    expect(result.reconciled).toBe(true)
    msgs = await engine.messages(TOPIC)
    // Still ONE row — reconciled, not duplicated.
    expect(msgs.length).toBe(1)
    expect(msgs[0]?.seq).toBe(5)
    expect(msgs[0]?.message_id).toBe('srv-1')
    expect(msgs[0]?.status).toBe('acked')
  })
})

describe('SyncEngine — reconnect replay fills the gap', () => {
  it('resumes from the cursor and applies the replayed tail', async () => {
    const engine = new SyncEngine(new InMemoryStore())
    // Device received seq 1 before going offline.
    await engine.applyInbound(TOPIC, inbound({ message_id: 'm1', seq: 1, body: 'one' }))
    // It missed 2 and 3 while the socket was down.
    const resume = await engine.resumeRequest(TOPIC)
    expect(resume.after_seq).toBe(1)
    // Server replays WHERE seq > 1 on reconnect.
    const replay = [
      inbound({ message_id: 'm2', seq: 2, body: 'two' }),
      inbound({ message_id: 'm3', seq: 3, body: 'three' }),
    ]
    for (const env of replay) await engine.applyInbound(TOPIC, env)
    const msgs = await engine.messages(TOPIC)
    expect(msgs.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(await engine.cursor(TOPIC)).toBe(3)
  })

  it('a redundant replay (overlapping the cursor) de-dups rather than duplicating', async () => {
    const engine = new SyncEngine(new InMemoryStore())
    for (const s of [1, 2, 3]) {
      await engine.applyInbound(TOPIC, inbound({ message_id: `m${s}`, seq: s }))
    }
    // Reconnect raced: client resumed after_seq=1 but already had 2,3.
    await engine.applyInbound(TOPIC, inbound({ message_id: 'm2', seq: 2 }))
    await engine.applyInbound(TOPIC, inbound({ message_id: 'm3', seq: 3 }))
    const msgs = await engine.messages(TOPIC)
    expect(msgs.length).toBe(3)
  })
})

describe('SyncEngine — multi-device two-cursor convergence', () => {
  it('two devices with independent cursors converge on identical transcripts', async () => {
    const deviceA = new SyncEngine(new InMemoryStore())
    const deviceB = new SyncEngine(new InMemoryStore())
    // The server fans the same sequenced stream to both devices.
    const stream = [
      inbound({ role: 'user', message_id: 's1', seq: 1, body: 'from-A', client_msg_id: 'a-1' }),
      inbound({ role: 'agent', message_id: 's2', seq: 2, body: 'agent-reply' }),
      inbound({ role: 'user', message_id: 's3', seq: 3, body: 'from-B', client_msg_id: 'b-1' }),
    ]
    // Device A applies in order; Device B receives them OUT of order
    // (different network timing) — convergence must not depend on arrival order.
    for (const env of stream) await deviceA.applyInbound(TOPIC, env)
    for (const env of [stream[2]!, stream[0]!, stream[1]!]) await deviceB.applyInbound(TOPIC, env)

    const a = (await deviceA.messages(TOPIC)).map((m) => ({ seq: m.seq, body: m.body, role: m.role }))
    const b = (await deviceB.messages(TOPIC)).map((m) => ({ seq: m.seq, body: m.body, role: m.role }))
    expect(a).toEqual(b)
    expect(a.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(await deviceA.cursor(TOPIC)).toBe(3)
    expect(await deviceB.cursor(TOPIC)).toBe(3)
  })

  it('a device that sent a message also receives it via fan-out without duplicating it', async () => {
    const store = new InMemoryStore()
    const queue = new SendQueue(store, { generateId: () => 'dev-a-1', now: () => 1 })
    const deviceA = new SyncEngine(store)
    // Device A optimistically sends.
    await queue.enqueue({ topic_id: TOPIC, body: 'hi from A' })
    // Server assigns seq 7 and fans the echo back to A (and to B).
    await deviceA.applyInbound(
      TOPIC,
      inbound({ role: 'user', message_id: 'srv-7', seq: 7, body: 'hi from A', client_msg_id: 'dev-a-1' }),
    )
    const msgs = await deviceA.messages(TOPIC)
    expect(msgs.length).toBe(1)
    expect(msgs[0]?.seq).toBe(7)
    expect(msgs[0]?.status).toBe('acked')
  })
})
