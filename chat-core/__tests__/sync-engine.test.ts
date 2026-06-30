import { describe, expect, it } from 'bun:test'

import { InMemoryStore, type Store } from '../store.ts'
import { SyncEngine } from '../sync-engine.ts'
import { SendQueue } from '../send-queue.ts'
import type { ChatMessage, InboundChatMessage } from '../types.ts'

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

describe('SyncEngine — stale-store reset detection (M1)', () => {
  it('clears the topic when the server seq regressed below the local cursor', async () => {
    const store = new InMemoryStore()
    const engine = new SyncEngine(store)
    // Local store holds a transcript from the OLD server (cursor at 40).
    await engine.applyInbound(TOPIC, inbound({ message_id: 'old1', seq: 39, body: 'old a' }))
    await engine.applyInbound(TOPIC, inbound({ message_id: 'old2', seq: 40, body: 'old b' }))
    expect(await engine.cursor(TOPIC)).toBe(40)
    // Server reinstalled: its high-water seq is now 2 (fresh welcome messages).
    const { reset } = await engine.reconcileServerReset(TOPIC, 2)
    expect(reset).toBe(true)
    // Stale transcript wiped; cursor reset so the resume re-syncs from 0.
    expect(await engine.messages(TOPIC)).toEqual([])
    expect(await engine.cursor(TOPIC)).toBe(0)
    expect(await engine.resumeRequest(TOPIC)).toEqual({ v: 1, type: 'resume', after_seq: 0 })
  })

  it('does NOT clear on a normal reconnect (server seq >= local cursor)', async () => {
    const engine = new SyncEngine(new InMemoryStore())
    await engine.applyInbound(TOPIC, inbound({ message_id: 'm1', seq: 1, body: 'a' }))
    await engine.applyInbound(TOPIC, inbound({ message_id: 'm2', seq: 2, body: 'b' }))
    // Server is at the same seq (idle reconnect) — no regression.
    const same = await engine.reconcileServerReset(TOPIC, 2)
    expect(same.reset).toBe(false)
    // Server is ahead (it has new messages to replay) — no regression.
    const ahead = await engine.reconcileServerReset(TOPIC, 9)
    expect(ahead.reset).toBe(false)
    expect((await engine.messages(TOPIC)).length).toBe(2)
    expect(await engine.cursor(TOPIC)).toBe(2)
  })

  it('does NOT clear when the server reported no seq (null) — no-durable-log deployment', async () => {
    const engine = new SyncEngine(new InMemoryStore())
    await engine.applyInbound(TOPIC, inbound({ message_id: 'm1', seq: 5, body: 'a' }))
    // An absent last_seen_seq normalizes to null; clearing here would destroy
    // the only copy of the transcript, so it must be a no-op.
    const { reset } = await engine.reconcileServerReset(TOPIC, null)
    expect(reset).toBe(false)
    expect((await engine.messages(TOPIC)).length).toBe(1)
    expect(await engine.cursor(TOPIC)).toBe(5)
  })

  it('clears a stale client when the server reports an empty durable log (seq 0)', async () => {
    const store = new InMemoryStore()
    const engine = new SyncEngine(store)
    // Stale client (cursor 40) connects to a freshly reinstalled server whose
    // durable log is still empty → it affirmatively reports last_seen_seq = 0.
    await engine.applyInbound(TOPIC, inbound({ message_id: 'old', seq: 40, body: 'stale' }))
    const { reset } = await engine.reconcileServerReset(TOPIC, 0)
    expect(reset).toBe(true)
    expect(await engine.messages(TOPIC)).toEqual([])
    expect(await engine.cursor(TOPIC)).toBe(0)
  })

  it('preserves un-acked local sends across a reset (never loses a queued message)', async () => {
    const store = new InMemoryStore()
    const engine = new SyncEngine(store)
    const queue = new SendQueue(store, { generateId: () => 'cmid-keep', now: () => 1 })
    // An old acked transcript (cursor 40) + a user message queued offline.
    await engine.applyInbound(TOPIC, inbound({ message_id: 'old', seq: 40, body: 'stale' }))
    await queue.enqueue({ topic_id: TOPIC, body: 'undelivered note' })
    // Server reinstalled (regressed to seq 1).
    const { reset } = await engine.reconcileServerReset(TOPIC, 1)
    expect(reset).toBe(true)
    const msgs = await engine.messages(TOPIC)
    // Stale acked row dropped; the queued send survives so the flush re-drives it.
    expect(msgs.map((m) => m.body)).toEqual(['undelivered note'])
    expect(msgs[0]?.status).toBe('queued')
    expect(msgs[0]?.seq).toBeNull()
    expect(await store.pendingSends(TOPIC)).toHaveLength(1)
    // Cursor is back to 0 (the un-acked send carries no seq) → resume from 0.
    expect(await engine.cursor(TOPIC)).toBe(0)
  })

  it('does NOT clear a fresh client (local cursor 0) even if the server reports a lower seq', async () => {
    const engine = new SyncEngine(new InMemoryStore())
    // Brand-new client connecting to an established server. Nothing to wipe.
    const { reset } = await engine.reconcileServerReset(TOPIC, 0)
    expect(reset).toBe(false)
    expect(await engine.cursor(TOPIC)).toBe(0)
  })

  it('ignores un-sequenced optimistic sends (null seq) when computing the cursor', async () => {
    const store = new InMemoryStore()
    const engine = new SyncEngine(store)
    const queue = new SendQueue(store, { generateId: () => 'cmid-1', now: () => 1 })
    // A queued offline send has no seq → cursor stays 0 → no false reset.
    await queue.enqueue({ topic_id: TOPIC, body: 'pending' })
    const { reset } = await engine.reconcileServerReset(TOPIC, 0)
    expect(reset).toBe(false)
    expect((await engine.messages(TOPIC)).length).toBe(1)
  })
})

describe('SyncEngine — resume replay is bounded (no O(N²) list scan)', () => {
  // A Store that counts how the engine resolves existing rows: the old apply
  // path called `list(topic)` (a full scan + sort) per message → O(N²) over a
  // resume tail. The fix routes agent-message lookups through the indexed
  // `getByMessageId` point lookup, so `list()` must NOT be hit on apply.
  function countingStore(): { store: Store; listCalls: () => number; byMidCalls: () => number } {
    const inner = new InMemoryStore()
    let listCalls = 0
    let byMidCalls = 0
    const store: Store = {
      upsert: (m: ChatMessage) => inner.upsert(m),
      list: (t: string) => {
        listCalls += 1
        return inner.list(t)
      },
      getByClientMsgId: (t: string, c: string) => inner.getByClientMsgId(t, c),
      getByMessageId: (t: string, m: string) => {
        byMidCalls += 1
        return inner.getByMessageId(t, m)
      },
      lastSeenSeq: (t: string) => inner.lastSeenSeq(t),
      pendingSends: (t: string) => inner.pendingSends(t),
      clear: (t: string) => inner.clear(t),
      clearAckedTranscript: (t: string) => inner.clearAckedTranscript(t),
      searchMessages: (q, opts) => inner.searchMessages(q, opts),
    }
    return { store, listCalls: () => listCalls, byMidCalls: () => byMidCalls }
  }

  it('resolves replayed agent messages via the message_id index, never a full list scan', async () => {
    const { store, listCalls, byMidCalls } = countingStore()
    const engine = new SyncEngine(store)
    // Replay a tail of agent messages (no client_msg_id), as on reconnect.
    for (const s of [1, 2, 3, 4, 5]) {
      await engine.applyInbound(TOPIC, inbound({ message_id: `m${s}`, seq: s }))
    }
    // Each apply did exactly one indexed point lookup...
    expect(byMidCalls()).toBe(5)
    // ...and the apply path never fell back to a whole-topic `list()` scan.
    expect(listCalls()).toBe(0)
    // Correctness still holds: ordered + de-duped.
    expect((await engine.messages(TOPIC)).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('still de-dups a re-delivered agent message through the point lookup', async () => {
    const { store, byMidCalls } = countingStore()
    const engine = new SyncEngine(store)
    const first = await engine.applyInbound(TOPIC, inbound({ message_id: 'm9', seq: 9 }))
    expect(first.applied).toBe(true)
    const again = await engine.applyInbound(TOPIC, inbound({ message_id: 'm9', seq: 9 }))
    expect(again.applied).toBe(false) // de-duped via getByMessageId, not a scan
    expect(byMidCalls()).toBe(2)
    expect((await engine.messages(TOPIC)).length).toBe(1)
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
