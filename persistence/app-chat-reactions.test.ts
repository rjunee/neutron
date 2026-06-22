/**
 * Track B Phase 4 (message reactions) — durable reaction log over REAL SQLite
 * (bun:sqlite via ProjectDb). Covers add/remove (tombstone), per-message `rev`
 * monotonicity across removes, seq resolution from the message log, the
 * aggregate, and the resume `aggregatesAfter` range scan.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../migrations/runner.ts'
import { AppChatReactionStore } from './app-chat-reactions.ts'
import { AppChatStore } from './app-chat-store.ts'
import { ProjectDb } from './db.ts'

const TOPIC = 'app:sam'
let tmp: string
let db: ProjectDb
let messages: AppChatStore
let reactions: AppChatReactionStore

async function appendMessage(message_id: string): Promise<number> {
  const r = await messages.append({ topic_id: TOPIC, message_id, role: 'user', body: 'x', created_at: 1 })
  return r.row.seq
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'app-chat-reactions-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  messages = new AppChatStore({ db })
  reactions = new AppChatReactionStore({ db })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('AppChatReactionStore — record add/remove', () => {
  it('adds a reaction, resolving the message seq + bumping rev', async () => {
    await appendMessage('m1') // seq 1
    const agg = await reactions.record({
      topic_id: TOPIC,
      message_id: 'm1',
      device_id: 'devA',
      emoji: '👍',
      action: 'add',
      at: 100,
    })
    expect(agg.seq).toBe(1)
    expect(agg.rev).toBe(1)
    expect(agg.reactions).toEqual([{ emoji: '👍', device_id: 'devA' }])
  })

  it('removes a reaction (tombstone) — set clears but rev keeps advancing', async () => {
    await appendMessage('m1')
    await reactions.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', emoji: '👍', action: 'add', at: 1 })
    const removed = await reactions.record({
      topic_id: TOPIC,
      message_id: 'm1',
      device_id: 'devA',
      emoji: '👍',
      action: 'remove',
      at: 2,
    })
    expect(removed.reactions).toEqual([])
    // rev advanced across the remove (monotonic) so a client can order the
    // clearing update after the add.
    expect(removed.rev).toBe(2)
  })

  it('a re-add after a remove brings the reaction back at a higher rev', async () => {
    await appendMessage('m1')
    await reactions.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', emoji: '👍', action: 'add', at: 1 })
    await reactions.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', emoji: '👍', action: 'remove', at: 2 })
    const readded = await reactions.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', emoji: '👍', action: 'add', at: 3 })
    expect(readded.reactions).toEqual([{ emoji: '👍', device_id: 'devA' }])
    expect(readded.rev).toBe(3)
  })

  it('aggregates distinct (emoji, device) reactions, sorted', async () => {
    await appendMessage('m1')
    await reactions.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devB', emoji: '👍', action: 'add', at: 1 })
    await reactions.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', emoji: '👍', action: 'add', at: 2 })
    await reactions.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', emoji: '❤️', action: 'add', at: 3 })
    const agg = await reactions.aggregate(TOPIC, 'm1')
    expect(agg.reactions).toEqual([
      { emoji: '❤️', device_id: 'devA' },
      { emoji: '👍', device_id: 'devA' },
      { emoji: '👍', device_id: 'devB' },
    ])
  })

  it('records seq 0 when the message is unknown (defensive)', async () => {
    const agg = await reactions.record({ topic_id: TOPIC, message_id: 'ghost', device_id: 'devA', emoji: '👍', action: 'add', at: 1 })
    expect(agg.seq).toBe(0)
  })
})

describe('AppChatReactionStore — aggregatesAfter (resume replay)', () => {
  it('returns per-message aggregates with seq > cursor, ascending', async () => {
    await appendMessage('m1') // seq 1
    await appendMessage('m2') // seq 2
    await appendMessage('m3') // seq 3
    await reactions.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', emoji: '👍', action: 'add', at: 1 })
    await reactions.record({ topic_id: TOPIC, message_id: 'm3', device_id: 'devB', emoji: '🎉', action: 'add', at: 1 })

    const after0 = await reactions.aggregatesAfter(TOPIC, 0)
    expect(after0.map((a) => a.seq)).toEqual([1, 3])
    expect(after0[0]?.reactions).toEqual([{ emoji: '👍', device_id: 'devA' }])

    const after1 = await reactions.aggregatesAfter(TOPIC, 1)
    expect(after1.map((a) => a.seq)).toEqual([3])
  })

  it('a fully-removed message still replays (empty set) so a client clears it', async () => {
    await appendMessage('m1')
    await reactions.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', emoji: '👍', action: 'add', at: 1 })
    await reactions.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', emoji: '👍', action: 'remove', at: 2 })
    const after0 = await reactions.aggregatesAfter(TOPIC, 0)
    expect(after0).toHaveLength(1)
    expect(after0[0]?.reactions).toEqual([])
    expect(after0[0]?.rev).toBe(2)
  })

  it('isolates topics', async () => {
    await messages.append({ topic_id: 'app:kim', message_id: 'k1', role: 'user', body: 'x', created_at: 1 })
    await reactions.record({ topic_id: 'app:kim', message_id: 'k1', device_id: 'devA', emoji: '👍', action: 'add', at: 1 })
    expect(await reactions.aggregatesAfter(TOPIC, 0)).toEqual([])
  })
})
