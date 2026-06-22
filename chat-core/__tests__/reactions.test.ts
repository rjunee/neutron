/**
 * Track B Phase 4 (message reactions) in the chat-core engine.
 *
 * Covers the client half: decoding a `reaction_update` frame, the rev-based
 * last-writer-wins merge in the Store (which — unlike receipts — must let a
 * removal CLEAR a reaction), the SyncEngine's `applyReactionUpdate`
 * (found / not-found / stale / clear), and the `groupReactions` render helper.
 * Pure engine semantics — no transport, no UI.
 */

import { describe, expect, it } from 'bun:test'

import { groupReactions, InMemoryStore, pickReactionState } from '../store.ts'
import { SyncEngine } from '../sync-engine.ts'
import { normalizeReactionUpdate, parseReactions, type ChatMessage } from '../types.ts'

const TOPIC = 'app:sam'

function baseMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
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
    ...over,
  }
}

describe('normalizeReactionUpdate', () => {
  it('parses a well-formed reaction_update', () => {
    const u = normalizeReactionUpdate({
      v: 1,
      type: 'reaction_update',
      message_id: 'm1',
      seq: 4,
      rev: 3,
      reactions: [{ emoji: '👍', device_id: 'devA' }],
      ts: 1,
    })
    expect(u).toEqual({
      message_id: 'm1',
      seq: 4,
      rev: 3,
      reactions: [{ emoji: '👍', device_id: 'devA' }],
    })
  })

  it('drops the wrong type / missing message_id; defaults rev 0 + empty set', () => {
    expect(normalizeReactionUpdate({ type: 'agent_message', message_id: 'm' })).toBeNull()
    expect(normalizeReactionUpdate({ type: 'reaction_update' })).toBeNull()
    const u = normalizeReactionUpdate({ type: 'reaction_update', message_id: 'm1' })
    expect(u).toEqual({ message_id: 'm1', seq: null, rev: 0, reactions: [] })
  })
})

describe('parseReactions', () => {
  it('drops malformed entries, de-dups, and sorts canonically', () => {
    const r = parseReactions([
      { emoji: '👍', device_id: 'devB' },
      { emoji: '👍', device_id: 'devA' },
      { emoji: '👍', device_id: 'devA' }, // dup
      { emoji: '', device_id: 'x' }, // bad emoji
      { emoji: '🎉' }, // missing device
      'nope',
    ])
    expect(r).toEqual([
      { emoji: '👍', device_id: 'devA' },
      { emoji: '👍', device_id: 'devB' },
    ])
  })
})

describe('pickReactionState — rev-LWW (NOT a union; removable)', () => {
  it('takes the incoming aggregate when its rev >= existing', () => {
    const out = pickReactionState(
      { reactions: [{ emoji: '👍', device_id: 'devA' }], reactions_rev: 1 },
      { reactions: [{ emoji: '❤️', device_id: 'devB' }], reactions_rev: 2 },
    )
    expect(out).toEqual({ reactions: [{ emoji: '❤️', device_id: 'devB' }], reactions_rev: 2 })
  })

  it('a higher-rev EMPTY set clears reactions (removal works)', () => {
    const out = pickReactionState(
      { reactions: [{ emoji: '👍', device_id: 'devA' }], reactions_rev: 1 },
      { reactions: [], reactions_rev: 2 },
    )
    expect(out).toEqual({ reactions: null, reactions_rev: 2 })
  })

  it('keeps existing when the incoming update is stale (lower rev)', () => {
    const out = pickReactionState(
      { reactions: [{ emoji: '👍', device_id: 'devA' }], reactions_rev: 5 },
      { reactions: [], reactions_rev: 2 },
    )
    expect(out).toEqual({ reactions: [{ emoji: '👍', device_id: 'devA' }], reactions_rev: 5 })
  })

  it('keeps existing when the incoming carries no reaction info (rev absent)', () => {
    const out = pickReactionState(
      { reactions: [{ emoji: '👍', device_id: 'devA' }], reactions_rev: 3 },
      {}, // a plain message re-delivery
    )
    expect(out).toEqual({ reactions: [{ emoji: '👍', device_id: 'devA' }], reactions_rev: 3 })
  })
})

describe('Store merge — reactions replace by rev (and survive re-delivery)', () => {
  it('a re-delivered message (no reaction info) does not clobber stored reactions', async () => {
    const store = new InMemoryStore()
    await store.upsert(
      baseMessage({ reactions: [{ emoji: '👍', device_id: 'devA' }], reactions_rev: 1 }),
    )
    // Re-deliver the same message with NO reaction fields (e.g. a resume replay).
    await store.upsert(baseMessage())
    const [row] = await store.list(TOPIC)
    expect(row?.reactions).toEqual([{ emoji: '👍', device_id: 'devA' }])
    expect(row?.reactions_rev).toBe(1)
  })
})

describe('SyncEngine.applyReactionUpdate', () => {
  it('applies the aggregate onto an existing message', async () => {
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
    const res = await engine.applyReactionUpdate(TOPIC, {
      message_id: 'm1',
      seq: 1,
      rev: 1,
      reactions: [{ emoji: '👍', device_id: 'devA' }],
    })
    expect(res.applied).toBe(true)
    const [row] = await store.list(TOPIC)
    expect(row?.reactions).toEqual([{ emoji: '👍', device_id: 'devA' }])
    expect(row?.reactions_rev).toBe(1)
  })

  it('a higher-rev empty set clears the reaction (removal end-to-end)', async () => {
    const store = new InMemoryStore()
    const engine = new SyncEngine(store)
    await store.upsert(baseMessage())
    await engine.applyReactionUpdate(TOPIC, {
      message_id: 'm1',
      seq: 1,
      rev: 1,
      reactions: [{ emoji: '👍', device_id: 'devA' }],
    })
    const cleared = await engine.applyReactionUpdate(TOPIC, {
      message_id: 'm1',
      seq: 1,
      rev: 2,
      reactions: [],
    })
    expect(cleared.applied).toBe(true)
    const [row] = await store.list(TOPIC)
    expect(row?.reactions ?? null).toBeNull()
    expect(row?.reactions_rev).toBe(2)
  })

  it('drops a stale (lower-rev) update', async () => {
    const store = new InMemoryStore()
    const engine = new SyncEngine(store)
    await store.upsert(
      baseMessage({ reactions: [{ emoji: '👍', device_id: 'devA' }], reactions_rev: 5 }),
    )
    const res = await engine.applyReactionUpdate(TOPIC, {
      message_id: 'm1',
      seq: 1,
      rev: 2,
      reactions: [],
    })
    expect(res.applied).toBe(false)
    const [row] = await store.list(TOPIC)
    expect(row?.reactions).toEqual([{ emoji: '👍', device_id: 'devA' }])
  })

  it('is a no-op when the message is not in the store yet', async () => {
    const engine = new SyncEngine(new InMemoryStore())
    const res = await engine.applyReactionUpdate(TOPIC, {
      message_id: 'ghost',
      seq: 9,
      rev: 1,
      reactions: [{ emoji: '👍', device_id: 'devA' }],
    })
    expect(res.applied).toBe(false)
  })
})

describe('groupReactions', () => {
  it('groups by emoji with counts + self flag, ordered by count desc', () => {
    const chips = groupReactions(
      [
        { emoji: '👍', device_id: 'devA' },
        { emoji: '👍', device_id: 'devB' },
        { emoji: '❤️', device_id: 'devC' },
        { emoji: '👍', device_id: 'self' },
      ],
      'self',
    )
    expect(chips).toEqual([
      { emoji: '👍', count: 3, reactedBySelf: true },
      { emoji: '❤️', count: 1, reactedBySelf: false },
    ])
  })

  it('returns [] for null / empty reactions', () => {
    expect(groupReactions(null)).toEqual([])
    expect(groupReactions([])).toEqual([])
  })
})
