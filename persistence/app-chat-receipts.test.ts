/**
 * Track B Phase 4 — durable receipt log over REAL SQLite (bun:sqlite via
 * ProjectDb). Covers recording (delivered/read, read-implies-delivered),
 * monotonicity, seq resolution from the message log, the per-message
 * aggregate, and the resume `aggregatesAfter` range scan.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../migrations/runner.ts'
import { AppChatReceiptStore } from './app-chat-receipts.ts'
import { AppChatStore } from './app-chat-store.ts'
import { ProjectDb } from './db.ts'

const TOPIC = 'app:sam'
let tmp: string
let db: ProjectDb
let messages: AppChatStore
let receipts: AppChatReceiptStore

/** Append a message so the receipt store can resolve its seq. */
async function appendMessage(message_id: string): Promise<number> {
  const r = await messages.append({ topic_id: TOPIC, message_id, role: 'user', body: 'x', created_at: 1 })
  return r.row.seq
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'app-chat-receipts-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  messages = new AppChatStore({ db })
  receipts = new AppChatReceiptStore({ db })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('AppChatReceiptStore — record', () => {
  it('records delivered, resolving the message seq from the message log', async () => {
    await appendMessage('m1') // seq 1
    const agg = await receipts.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', state: 'delivered', at: 100 })
    expect(agg).toEqual({ message_id: 'm1', seq: 1, delivered_by: ['devA'], read_by: [] })
  })

  it('read implies delivered (backfills delivered_at)', async () => {
    await appendMessage('m1')
    const agg = await receipts.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', state: 'read', at: 100 })
    expect(agg.delivered_by).toEqual(['devA'])
    expect(agg.read_by).toEqual(['devA'])
  })

  it('is monotonic + idempotent: delivered then read advances; re-delivered never un-reads', async () => {
    await appendMessage('m1')
    await receipts.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', state: 'delivered', at: 100 })
    await receipts.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', state: 'read', at: 200 })
    // A late re-delivered ack must not regress the read.
    const agg = await receipts.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', state: 'delivered', at: 300 })
    expect(agg.read_by).toEqual(['devA'])
  })

  it('aggregates multiple devices (sorted, deduped)', async () => {
    await appendMessage('m1')
    await receipts.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devB', state: 'delivered', at: 1 })
    await receipts.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', state: 'read', at: 2 })
    const agg = await receipts.aggregate(TOPIC, 'm1')
    expect(agg.delivered_by).toEqual(['devA', 'devB'])
    expect(agg.read_by).toEqual(['devA'])
  })

  it('records seq 0 when the message is unknown (defensive)', async () => {
    const agg = await receipts.record({ topic_id: TOPIC, message_id: 'ghost', device_id: 'devA', state: 'read', at: 1 })
    expect(agg.seq).toBe(0)
  })
})

describe('AppChatReceiptStore — aggregatesAfter (resume replay)', () => {
  it('returns per-message aggregates with seq > cursor, ascending', async () => {
    await appendMessage('m1') // seq 1
    await appendMessage('m2') // seq 2
    await appendMessage('m3') // seq 3
    await receipts.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', state: 'read', at: 1 })
    await receipts.record({ topic_id: TOPIC, message_id: 'm3', device_id: 'devB', state: 'delivered', at: 1 })

    const after0 = await receipts.aggregatesAfter(TOPIC, 0)
    expect(after0.map((a) => a.seq)).toEqual([1, 3])
    expect(after0[0]).toMatchObject({ message_id: 'm1', read_by: ['devA'] })

    const after1 = await receipts.aggregatesAfter(TOPIC, 1)
    expect(after1.map((a) => a.seq)).toEqual([3])
  })

  it('isolates topics', async () => {
    await messages.append({ topic_id: 'app:kim', message_id: 'k1', role: 'user', body: 'x', created_at: 1 })
    await receipts.record({ topic_id: 'app:kim', message_id: 'k1', device_id: 'devA', state: 'read', at: 1 })
    expect(await receipts.aggregatesAfter(TOPIC, 0)).toEqual([])
  })
})
