import { describe, expect, it } from 'bun:test'

import { InMemoryStore, compareForDisplay, type Store } from '../store.ts'
import { createWebStore } from '../stores/opfs-store.ts'
import type { ChatMessage } from '../types.ts'

const TOPIC = 'app:sam'

function msg(p: Partial<ChatMessage> & { client_msg_id: string }): ChatMessage {
  return {
    topic_id: TOPIC,
    message_id: null,
    seq: null,
    role: 'user',
    body: 'x',
    project_id: null,
    attachments: null,
    created_at: 0,
    status: 'queued',
    ...p,
  }
}

async function storeContract(store: Store): Promise<void> {
  await store.upsert(msg({ client_msg_id: 'c1', seq: 2, message_id: 'm2', body: 'two', status: 'acked' }))
  await store.upsert(msg({ client_msg_id: 'c2', seq: 1, message_id: 'm1', body: 'one', status: 'acked' }))
  const list = await store.list(TOPIC)
  expect(list.map((m) => m.body)).toEqual(['one', 'two']) // seq order
  expect(await store.lastSeenSeq(TOPIC)).toBe(2)
  // Idempotent upsert by identity — no duplicate.
  await store.upsert(msg({ client_msg_id: 'c1', seq: 2, message_id: 'm2', body: 'two', status: 'acked' }))
  expect((await store.list(TOPIC)).length).toBe(2)
  // Pending queue isolation.
  await store.upsert(msg({ client_msg_id: 'c3', body: 'pending', status: 'queued' }))
  expect((await store.pendingSends(TOPIC)).map((m) => m.body)).toEqual(['pending'])
  // Lookup + clear.
  expect((await store.getByClientMsgId(TOPIC, 'c2'))?.body).toBe('one')
  // Point lookup by server message_id (the indexed resume-replay path).
  expect((await store.getByMessageId(TOPIC, 'm1'))?.body).toBe('one')
  expect(await store.getByMessageId(TOPIC, 'no-such-id')).toBeNull()
  // Stale-store reset (M1): clearAckedTranscript drops the acked transcript
  // (c1/c2) but keeps the un-acked local send (c3), and the cursor falls to 0.
  await store.clearAckedTranscript(TOPIC)
  const afterReset = await store.list(TOPIC)
  expect(afterReset.map((m) => m.body)).toEqual(['pending'])
  expect(afterReset[0]?.status).toBe('queued')
  expect(await store.lastSeenSeq(TOPIC)).toBe(0)
  await store.clear(TOPIC)
  expect((await store.list(TOPIC)).length).toBe(0)
}

describe('InMemoryStore — Store contract', () => {
  it('satisfies the ordering / idempotency / pending / lookup contract', async () => {
    await storeContract(new InMemoryStore())
  })

  it('reconciles an optimistic row keyed by client_msg_id with a server echo', async () => {
    const store = new InMemoryStore()
    await store.upsert(msg({ client_msg_id: 'c1', body: 'hi', status: 'queued' }))
    await store.upsert(
      msg({ client_msg_id: 'c1', message_id: 'srv', seq: 9, body: 'hi', status: 'acked' }),
    )
    const list = await store.list(TOPIC)
    expect(list.length).toBe(1)
    expect(list[0]?.seq).toBe(9)
    expect(list[0]?.status).toBe('acked')
  })

  it('sorts optimistic (un-sequenced) messages after sequenced ones', () => {
    const sequenced = msg({ client_msg_id: 'a', seq: 5, created_at: 1 })
    const optimistic = msg({ client_msg_id: 'b', seq: null, created_at: 2 })
    expect(compareForDisplay(sequenced, optimistic)).toBeLessThan(0)
    expect(compareForDisplay(optimistic, sequenced)).toBeGreaterThan(0)
  })
})

describe('createWebStore — graceful degradation', () => {
  it('returns a working Store even when OPFS is unavailable (no navigator.storage)', async () => {
    // In the bun:test env there is no OPFS, so this exercises the fallback
    // path: createWebStore must NEVER throw and must hand back a usable Store.
    const store = await createWebStore()
    await storeContract(store)
  })
})

// W5 GAP-4 — the `failed` send status must round-trip through EVERY Store impl:
// a persisted failed row read back as `queued` would revert a retry affordance to
// a false pending clock. InMemoryStore + the opfs snapshot both round-trip the
// full ChatMessage (no status allow-list), so this locks that in; SqliteChatStore
// has an explicit allow-list, covered in app/__tests__/chat-core-sqlite-store.test.ts.
describe('failed-status round-trip (W5 GAP-4)', () => {
  async function assertFailedRoundTrips(store: Store): Promise<void> {
    await store.upsert(msg({ client_msg_id: 'c-fail', body: 'never acked', status: 'failed' }))
    expect((await store.getByClientMsgId(TOPIC, 'c-fail'))?.status).toBe('failed')
    expect((await store.list(TOPIC))[0]?.status).toBe('failed')
    // A failed row is NOT a pending (queued) send.
    expect((await store.pendingSends(TOPIC)).length).toBe(0)
    // Status stays monotonic: a late echo (born acked) still wins over failed …
    await store.upsert(msg({ client_msg_id: 'c-fail', message_id: 'srv', seq: 3, body: 'never acked', status: 'acked' }))
    expect((await store.getByClientMsgId(TOPIC, 'c-fail'))?.status).toBe('acked')
  }

  it('InMemoryStore round-trips failed', async () => {
    await assertFailedRoundTrips(new InMemoryStore())
  })

  it('createWebStore round-trips failed', async () => {
    await assertFailedRoundTrips(await createWebStore())
  })
})
