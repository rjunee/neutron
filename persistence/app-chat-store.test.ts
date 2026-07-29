import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { AppChatStore } from './app-chat-store.ts'
import { ProjectDb } from './db.ts'

const TOPIC = 'app:sam'
let tmp: string
let db: ProjectDb
let store: AppChatStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'app-chat-store-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new AppChatStore({ db })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('AppChatStore — monotonic per-topic seq', () => {
  it('assigns 1,2,3… per topic on append', async () => {
    const a = await store.append({ topic_id: TOPIC, message_id: 'm1', role: 'user', body: 'a', created_at: 1 })
    const b = await store.append({ topic_id: TOPIC, message_id: 'm2', role: 'agent', body: 'b', created_at: 2 })
    const c = await store.append({ topic_id: TOPIC, message_id: 'm3', role: 'user', body: 'c', created_at: 3 })
    expect([a.row.seq, b.row.seq, c.row.seq]).toEqual([1, 2, 3])
    expect(a.was_new && b.was_new && c.was_new).toBe(true)
    expect(await store.maxSeq(TOPIC)).toBe(3)
  })

  it('keeps seq independent across topics', async () => {
    await store.append({ topic_id: 'app:sam', message_id: 'm1', role: 'user', body: 'a', created_at: 1 })
    const other = await store.append({ topic_id: 'app:kim', message_id: 'm2', role: 'user', body: 'b', created_at: 1 })
    expect(other.row.seq).toBe(1)
    expect(await store.maxSeq('app:sam')).toBe(1)
    expect(await store.maxSeq('app:kim')).toBe(1)
  })
})

describe('AppChatStore — client_msg_id idempotency', () => {
  it('collapses a re-sent client_msg_id to the existing row without advancing seq', async () => {
    const first = await store.append({
      topic_id: TOPIC, message_id: 'm1', role: 'user', body: 'hi', client_msg_id: 'c1', created_at: 1,
    })
    expect(first.was_new).toBe(true)
    expect(first.row.seq).toBe(1)
    // Re-send (offline-queue flush / HTTP-fallback racing the WS echo).
    const again = await store.append({
      topic_id: TOPIC, message_id: 'm1-dup', role: 'user', body: 'hi', client_msg_id: 'c1', created_at: 2,
    })
    expect(again.was_new).toBe(false)
    expect(again.row.seq).toBe(1) // same row, no new seq
    expect(again.row.message_id).toBe('m1') // canonical id preserved
    expect(await store.maxSeq(TOPIC)).toBe(1)
  })
})

describe('AppChatStore — resume replay (WHERE seq > N ORDER BY seq)', () => {
  it('replays only the tail after the cursor, ascending', async () => {
    for (let i = 1; i <= 5; i++) {
      await store.append({ topic_id: TOPIC, message_id: `m${i}`, role: 'user', body: `msg-${i}`, created_at: i })
    }
    const replay = await store.replayAfter(TOPIC, 2)
    expect(replay.map((r) => r.seq)).toEqual([3, 4, 5])
    expect(replay.map((r) => r.body)).toEqual(['msg-3', 'msg-4', 'msg-5'])
  })

  it('after_seq=0 replays the whole transcript', async () => {
    await store.append({ topic_id: TOPIC, message_id: 'm1', role: 'user', body: 'a', created_at: 1 })
    await store.append({ topic_id: TOPIC, message_id: 'm2', role: 'agent', body: 'b', created_at: 2 })
    const replay = await store.replayAfter(TOPIC, 0)
    expect(replay.map((r) => r.seq)).toEqual([1, 2])
  })

  it('clamps a negative / fractional cursor and honours the limit', async () => {
    for (let i = 1; i <= 4; i++) {
      await store.append({ topic_id: TOPIC, message_id: `m${i}`, role: 'user', body: `${i}`, created_at: i })
    }
    expect((await store.replayAfter(TOPIC, -10)).map((r) => r.seq)).toEqual([1, 2, 3, 4])
    expect((await store.replayAfter(TOPIC, 2.9)).map((r) => r.seq)).toEqual([3, 4]) // trunc, not round
    expect((await store.replayAfter(TOPIC, 0, 2)).map((r) => r.seq)).toEqual([1, 2])
    expect((await store.replayAfter(TOPIC, 0, Number.NaN)).map((r) => r.seq)).toEqual([1, 2, 3, 4]) // falls back to default
  })

  it('round-trips project_id + attachments through a replay', async () => {
    await store.append({
      topic_id: TOPIC, message_id: 'm1', role: 'user', body: 'pic',
      project_id: 'proj-9', attachments: ['/api/app/upload/abc', '/api/app/upload/def'], created_at: 1,
    })
    const [row] = await store.replayAfter(TOPIC, 0)
    expect(row?.project_id).toBe('proj-9')
    expect(row?.attachments).toEqual(['/api/app/upload/abc', '/api/app/upload/def'])
  })
})

describe('AppChatStore — W3a structured agent meta', () => {
  it('round-trips the opaque meta blob through a replay', async () => {
    const meta = {
      prompt_id: '00000000-0000-4000-8000-000000000abc',
      kind: 'buttons',
      options: [{ label: 'Yes', body: 'Yes', value: 'yes' }],
      citations: [{ title: 'Docs', url: 'https://example.test/d' }],
    }
    await store.append({
      topic_id: TOPIC, message_id: 'm1', role: 'agent', body: 'pick', meta, created_at: 1,
    })
    const [row] = await store.replayAfter(TOPIC, 0)
    expect(row?.meta).toEqual(meta)
  })

  it('persists NULL meta for a message that carries none', async () => {
    await store.append({ topic_id: TOPIC, message_id: 'm1', role: 'agent', body: 'plain', created_at: 1 })
    // An empty-object meta collapses to NULL (matches the PRESENT predicate).
    await store.append({ topic_id: TOPIC, message_id: 'm2', role: 'agent', body: 'also plain', meta: {}, created_at: 2 })
    const rows = await store.replayAfter(TOPIC, 0)
    expect(rows.map((r) => r.meta)).toEqual([null, null])
  })

  it('degrades a corrupt / non-object meta_json to null on replay (never throws)', async () => {
    await store.append({ topic_id: TOPIC, message_id: 'bad-json', role: 'agent', body: 'a', created_at: 1 })
    await store.append({ topic_id: TOPIC, message_id: 'array', role: 'agent', body: 'b', created_at: 2 })
    await store.append({ topic_id: TOPIC, message_id: 'scalar', role: 'agent', body: 'c', created_at: 3 })
    // Corrupt the durable column out-of-band to simulate a bad / older write.
    db.raw().query('UPDATE app_chat_messages SET meta_json = ? WHERE message_id = ?').run('{not json', 'bad-json')
    db.raw().query('UPDATE app_chat_messages SET meta_json = ? WHERE message_id = ?').run('[1,2,3]', 'array')
    db.raw().query('UPDATE app_chat_messages SET meta_json = ? WHERE message_id = ?').run('"just a string"', 'scalar')
    const rows = await store.replayAfter(TOPIC, 0)
    expect(rows.map((r) => r.meta)).toEqual([null, null, null])
  })
})
