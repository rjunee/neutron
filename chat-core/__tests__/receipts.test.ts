/**
 * Track B Phase 4 — delivery + read receipts in the chat-core engine.
 *
 * Covers the client half: decoding a `receipt_update` frame, the inline
 * receipt fields on a message envelope, the set-union merge in the Store, and
 * the SyncEngine's `applyReceiptUpdate` (found / not-found / idempotent /
 * monotonic). No transport, no UI — pure engine semantics.
 */

import { describe, expect, it } from 'bun:test'

import { InMemoryStore, unionDeviceIds } from '../store.ts'
import { SyncEngine } from '../sync-engine.ts'
import { normalizeInbound, normalizeReceiptUpdate } from '../types.ts'

const TOPIC = 'app:sam'

describe('unionDeviceIds', () => {
  it('unions, de-dups, sorts, and tolerates null/undefined', () => {
    expect(unionDeviceIds(['b', 'a'], ['a', 'c'])).toEqual(['a', 'b', 'c'])
    expect(unionDeviceIds(null, ['x'])).toEqual(['x'])
    expect(unionDeviceIds(undefined, undefined)).toBeNull()
    expect(unionDeviceIds(['', 'a'], null)).toEqual(['a'])
  })
})

describe('normalizeReceiptUpdate', () => {
  it('parses a well-formed receipt_update', () => {
    const u = normalizeReceiptUpdate({
      v: 1,
      type: 'receipt_update',
      message_id: 'm1',
      seq: 4,
      delivered_by: ['devA', 'devB'],
      read_by: ['agent'],
      ts: 1,
    })
    expect(u).toEqual({ message_id: 'm1', seq: 4, delivered_by: ['devA', 'devB'], read_by: ['agent'] })
  })

  it('drops the wrong type / missing message_id, defaults arrays to empty', () => {
    expect(normalizeReceiptUpdate({ type: 'agent_message', message_id: 'm' })).toBeNull()
    expect(normalizeReceiptUpdate({ type: 'receipt_update' })).toBeNull()
    const u = normalizeReceiptUpdate({ type: 'receipt_update', message_id: 'm1' })
    expect(u).toEqual({ message_id: 'm1', seq: null, delivered_by: [], read_by: [] })
  })
})

describe('normalizeInbound — inline receipts', () => {
  it('carries delivered_by / read_by from the message envelope', () => {
    const m = normalizeInbound({
      type: 'user_message',
      message_id: 'm1',
      body: 'hi',
      delivered_by: ['devA'],
      read_by: ['agent'],
    })
    expect(m?.delivered_to).toEqual(['devA'])
    expect(m?.read_by).toEqual(['agent'])
  })

  it('omits the fields when absent', () => {
    const m = normalizeInbound({ type: 'agent_message', message_id: 'm1', body: 'yo' })
    expect(m?.delivered_to).toBeUndefined()
    expect(m?.read_by).toBeUndefined()
  })
})

describe('Store merge — receipts accumulate', () => {
  it('set-unions delivered_to / read_by across upserts (idempotent + monotonic)', async () => {
    const store = new InMemoryStore()
    await store.upsert({
      topic_id: TOPIC,
      client_msg_id: 'c1',
      message_id: 'm1',
      seq: 1,
      role: 'user',
      body: 'hi',
      project_id: null,
      attachments: null,
      created_at: 1,
      status: 'acked',
      delivered_to: ['devA'],
    })
    // A later partial adds devB delivered + agent read — neither regresses devA.
    await store.upsert({
      topic_id: TOPIC,
      client_msg_id: 'c1',
      message_id: 'm1',
      seq: 1,
      role: 'user',
      body: 'hi',
      project_id: null,
      attachments: null,
      created_at: 1,
      status: 'acked',
      delivered_to: ['devB'],
      read_by: ['agent'],
    })
    const [row] = await store.list(TOPIC)
    expect(row?.delivered_to).toEqual(['devA', 'devB'])
    expect(row?.read_by).toEqual(['agent'])
  })
})

describe('SyncEngine.applyReceiptUpdate', () => {
  it('merges the aggregate onto an existing message', async () => {
    const store = new InMemoryStore()
    const engine = new SyncEngine(store)
    await engine.applyInbound(TOPIC, {
      role: 'user',
      message_id: 'm1',
      seq: 1,
      body: 'hi',
      client_msg_id: 'c1',
      project_id: null,
      attachments: null,
      created_at: 1,
    })
    const res = await engine.applyReceiptUpdate(TOPIC, {
      message_id: 'm1',
      seq: 1,
      delivered_by: ['devA'],
      read_by: ['agent'],
    })
    expect(res.applied).toBe(true)
    const [row] = await store.list(TOPIC)
    expect(row?.delivered_to).toEqual(['devA'])
    expect(row?.read_by).toEqual(['agent'])
  })

  it('is a no-op when the message is not in the store yet', async () => {
    const engine = new SyncEngine(new InMemoryStore())
    const res = await engine.applyReceiptUpdate(TOPIC, {
      message_id: 'ghost',
      seq: 9,
      delivered_by: ['devA'],
      read_by: [],
    })
    expect(res.applied).toBe(false)
  })

  it('reconciles a receipt onto the sender’s optimistic→acked bubble', async () => {
    const store = new InMemoryStore()
    const engine = new SyncEngine(store)
    // Optimistic local send (no message_id yet).
    await store.upsert({
      topic_id: TOPIC,
      client_msg_id: 'c1',
      message_id: null,
      seq: null,
      role: 'user',
      body: 'hi',
      project_id: null,
      attachments: null,
      created_at: 1,
      status: 'queued',
    })
    // Server echo reconciles it (stamps message_id + seq, status acked) and
    // carries the inline delivered set.
    await engine.applyInbound(TOPIC, {
      role: 'user',
      message_id: 'm1',
      seq: 1,
      body: 'hi',
      client_msg_id: 'c1',
      project_id: null,
      attachments: null,
      created_at: 1,
      delivered_to: ['devSelf'],
    })
    // Agent read arrives as a receipt_update.
    await engine.applyReceiptUpdate(TOPIC, {
      message_id: 'm1',
      seq: 1,
      delivered_by: [],
      read_by: ['agent'],
    })
    const [row] = await store.list(TOPIC)
    expect(row?.status).toBe('acked')
    expect(row?.delivered_to).toEqual(['devSelf'])
    expect(row?.read_by).toEqual(['agent'])
  })
})
