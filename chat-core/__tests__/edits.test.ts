/**
 * Track B Phase 4 (message edit/delete) in the chat-core engine.
 *
 * Covers the client half: decoding an `edit_update` frame, the rev-based
 * last-writer-wins merge in the Store ({@link pickEditState}, which owns the
 * merged body so an edit/delete replaces it and a plain re-delivery never
 * resurrects the original), and the SyncEngine's `applyEditUpdate`
 * (apply / stale / not-found / delete tombstone). Pure engine semantics — no
 * transport, no UI.
 */

import { describe, expect, it } from 'bun:test'

import { InMemoryStore, pickEditState } from '../store.ts'
import { SyncEngine } from '../sync-engine.ts'
import { normalizeEditUpdate, type ChatMessage } from '../types.ts'

const TOPIC = 'app:sam'

function baseMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    topic_id: TOPIC,
    client_msg_id: 'c1',
    message_id: 'm1',
    seq: 1,
    role: 'user',
    body: 'original',
    project_id: null,
    attachments: null,
    created_at: 1,
    status: 'acked',
    ...over,
  }
}

describe('normalizeEditUpdate', () => {
  it('parses a well-formed edit_update', () => {
    const u = normalizeEditUpdate({
      v: 1,
      type: 'edit_update',
      message_id: 'm1',
      seq: 4,
      rev: 3,
      body: 'edited body',
      deleted: false,
      edited_at: 1234,
      ts: 1,
    })
    expect(u).toEqual({
      message_id: 'm1',
      seq: 4,
      rev: 3,
      body: 'edited body',
      deleted: false,
      edited_at: 1234,
    })
  })

  it('normalizes a delete update to an empty body regardless of any body field', () => {
    const u = normalizeEditUpdate({
      type: 'edit_update',
      message_id: 'm1',
      rev: 2,
      deleted: true,
      body: 'should be ignored',
      edited_at: 9,
    })
    expect(u).toEqual({ message_id: 'm1', seq: null, rev: 2, body: '', deleted: true, edited_at: 9 })
  })

  it('drops the wrong type / missing message_id; defaults rev 0', () => {
    expect(normalizeEditUpdate({ type: 'agent_message', message_id: 'm' })).toBeNull()
    expect(normalizeEditUpdate({ type: 'edit_update' })).toBeNull()
    const u = normalizeEditUpdate({ type: 'edit_update', message_id: 'm1' })
    expect(u).toEqual({ message_id: 'm1', seq: null, rev: 0, body: '', deleted: false, edited_at: null })
  })
})

describe('pickEditState — rev-LWW (owns the merged body)', () => {
  it('takes the incoming edit when its rev >= existing', () => {
    const out = pickEditState(
      { body: 'original', edited_at: null, deleted: false, edit_rev: null },
      { body: 'edited', edited_at: 5, deleted: false, edit_rev: 1 },
    )
    expect(out).toEqual({ body: 'edited', edited_at: 5, deleted: false, edit_rev: 1 })
  })

  it('a delete (higher rev) clears the body to a tombstone', () => {
    const out = pickEditState(
      { body: 'edited', edited_at: 5, deleted: false, edit_rev: 1 },
      { body: '', edited_at: 9, deleted: true, edit_rev: 2 },
    )
    expect(out).toEqual({ body: '', edited_at: 9, deleted: true, edit_rev: 2 })
  })

  it('keeps existing when the incoming edit is stale (lower rev)', () => {
    const out = pickEditState(
      { body: 'edited-v5', edited_at: 50, deleted: false, edit_rev: 5 },
      { body: 'edited-v2', edited_at: 20, deleted: false, edit_rev: 2 },
    )
    expect(out).toEqual({ body: 'edited-v5', edited_at: 50, deleted: false, edit_rev: 5 })
  })

  it('a re-delivery (no edit info) does NOT resurrect the original over an edit', () => {
    const out = pickEditState(
      { body: 'edited', edited_at: 5, deleted: false, edit_rev: 1 },
      { body: 'original', edited_at: null, deleted: false, edit_rev: null },
    )
    expect(out).toEqual({ body: 'edited', edited_at: 5, deleted: false, edit_rev: 1 })
  })

  it('falls back to the normal body merge when nothing was ever edited', () => {
    // optimistic placeholder (empty) ← server echo (real body)
    const out = pickEditState(
      { body: '', edited_at: null, deleted: false, edit_rev: null },
      { body: 'server body', edited_at: null, deleted: false, edit_rev: null },
    )
    expect(out).toEqual({ body: 'server body', edited_at: null, deleted: false, edit_rev: null })
  })
})

describe('Store merge — edits replace body by rev (and survive re-delivery)', () => {
  it('a re-delivered message (no edit info) does not clobber an edited body', async () => {
    const store = new InMemoryStore()
    await store.upsert(baseMessage({ body: 'edited', edited_at: 5, edit_rev: 1 }))
    // Re-deliver the same message with its ORIGINAL body + no edit fields.
    await store.upsert(baseMessage({ body: 'original' }))
    const [row] = await store.list(TOPIC)
    expect(row?.body).toBe('edited')
    expect(row?.edit_rev).toBe(1)
    expect(row?.edited_at).toBe(5)
  })
})

describe('SyncEngine.applyEditUpdate', () => {
  it('applies an edit onto an existing message (body + edited_at + rev)', async () => {
    const store = new InMemoryStore()
    const engine = new SyncEngine(store)
    await store.upsert(baseMessage())
    const res = await engine.applyEditUpdate(TOPIC, {
      message_id: 'm1',
      seq: 1,
      rev: 1,
      body: 'corrected',
      deleted: false,
      edited_at: 42,
    })
    expect(res.applied).toBe(true)
    const [row] = await store.list(TOPIC)
    expect(row?.body).toBe('corrected')
    expect(row?.edited_at).toBe(42)
    expect(row?.edit_rev).toBe(1)
    expect(row?.deleted ?? false).toBe(false)
  })

  it('a delete tombstones the message (deleted true, empty body, higher rev)', async () => {
    const store = new InMemoryStore()
    const engine = new SyncEngine(store)
    await store.upsert(baseMessage())
    await engine.applyEditUpdate(TOPIC, {
      message_id: 'm1',
      seq: 1,
      rev: 1,
      body: 'corrected',
      deleted: false,
      edited_at: 42,
    })
    const del = await engine.applyEditUpdate(TOPIC, {
      message_id: 'm1',
      seq: 1,
      rev: 2,
      body: '',
      deleted: true,
      edited_at: 99,
    })
    expect(del.applied).toBe(true)
    const [row] = await store.list(TOPIC)
    expect(row?.deleted).toBe(true)
    expect(row?.body).toBe('')
    expect(row?.edit_rev).toBe(2)
  })

  it('drops a stale (lower-rev) edit', async () => {
    const store = new InMemoryStore()
    const engine = new SyncEngine(store)
    await store.upsert(baseMessage({ body: 'edited-v5', edited_at: 50, edit_rev: 5 }))
    const res = await engine.applyEditUpdate(TOPIC, {
      message_id: 'm1',
      seq: 1,
      rev: 2,
      body: 'edited-v2',
      deleted: false,
      edited_at: 20,
    })
    expect(res.applied).toBe(false)
    const [row] = await store.list(TOPIC)
    expect(row?.body).toBe('edited-v5')
    expect(row?.edit_rev).toBe(5)
  })

  it('is a no-op when the message is not in the store yet', async () => {
    const engine = new SyncEngine(new InMemoryStore())
    const res = await engine.applyEditUpdate(TOPIC, {
      message_id: 'ghost',
      seq: 9,
      rev: 1,
      body: 'x',
      deleted: false,
      edited_at: 1,
    })
    expect(res.applied).toBe(false)
  })
})
