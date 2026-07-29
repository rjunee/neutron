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

import { applyMigrations } from '@neutronai/migrations/runner.ts'
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

  it('the limit caps DISTINCT messages, not receipt rows', async () => {
    await appendMessage('m1') // seq 1
    await appendMessage('m2') // seq 2
    await appendMessage('m3') // seq 3
    // m1 carries TWO receipt rows — they must not eat the message budget.
    await receipts.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', state: 'read', at: 1 })
    await receipts.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devB', state: 'delivered', at: 2 })
    await receipts.record({ topic_id: TOPIC, message_id: 'm2', device_id: 'devA', state: 'delivered', at: 3 })
    await receipts.record({ topic_id: TOPIC, message_id: 'm3', device_id: 'devA', state: 'delivered', at: 4 })

    const capped = await receipts.aggregatesAfter(TOPIC, 0, 2)
    expect(capped.map((a) => a.message_id)).toEqual(['m1', 'm2'])
    expect(capped[0]).toMatchObject({ delivered_by: ['devA', 'devB'], read_by: ['devA'] })
  })
})

describe('AppChatReceiptStore — aggregatesAfter bounded scan + continuation (regression)', () => {
  /** Wrap `db.prepare` to record the row count every `.all()` call returns,
   *  so a test can assert the SQL scan stayed bounded to the page instead of
   *  materializing every row after the cursor before capping in JS. */
  function instrumentRowCounts(): { calls: number[]; restore: () => void } {
    const calls: number[] = []
    const originalPrepare = db.prepare.bind(db)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(db as any).prepare = (sql: string) => {
      const stmt = (originalPrepare as any)(sql)
      const originalAll = stmt.all.bind(stmt)
      stmt.all = (...args: unknown[]) => {
        const rows = originalAll(...args)
        calls.push(rows.length)
        return rows
      }
      return stmt
    }
    return {
      calls,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      restore: () => {
        ;(db as any).prepare = originalPrepare
      },
    }
  }

  it('the DISTINCT-message probe is index-satisfied (covering index, no temp B-tree) so LIMIT early-terminates', async () => {
    // Substantiates the bounded-scan claim at the query-plan level, not just by
    // counting returned rows: without the (topic_id, seq, message_id) index the
    // `DISTINCT seq, message_id ... ORDER BY seq, message_id` probe forces
    // `USE TEMP B-TREE FOR DISTINCT`, letting SQLite materialize the whole
    // backlog before LIMIT. The migration-0101 covering index makes the probe
    // an index-only search that stops at LIMIT.
    const plan = db
      .raw()
      .query(
        `EXPLAIN QUERY PLAN
           SELECT DISTINCT seq, message_id FROM app_chat_receipts
            WHERE topic_id = ? AND seq > ?
            ORDER BY seq ASC, message_id ASC
            LIMIT ?`,
      )
      .all(TOPIC, 0, 6) as Array<{ detail: string }>
    const detail = plan.map((r) => r.detail).join(' | ')
    expect(detail).toContain('idx_app_chat_receipts_topic_seq_msg')
    expect(detail).not.toContain('TEMP B-TREE')
  })

  it('bounds the SQL scan to the page instead of materializing every row after the cursor', async () => {
    // 40 messages, 3 receipt device-rows each = 120 receipt rows total, but
    // the replay only wants a page of 5 DISTINCT messages. Pre-fix, the
    // message-group branch ran one unconditional `WHERE seq > ?` scan that
    // returned all 120 rows before capping to 5 messages in JS.
    const N = 40
    for (let i = 1; i <= N; i++) {
      const id = `m${i}`
      await appendMessage(id)
      await receipts.record({ topic_id: TOPIC, message_id: id, device_id: 'devA', state: 'read', at: i })
      await receipts.record({ topic_id: TOPIC, message_id: id, device_id: 'devB', state: 'delivered', at: i })
      await receipts.record({ topic_id: TOPIC, message_id: id, device_id: 'devC', state: 'delivered', at: i })
    }

    const { calls, restore } = instrumentRowCounts()
    let capped: Awaited<ReturnType<typeof receipts.aggregatesAfter>>
    try {
      capped = await receipts.aggregatesAfter(TOPIC, 0, 5)
    } finally {
      restore()
    }

    expect(capped.map((a) => a.message_id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    // Explicit query COUNT + per-query row counts (not a vacuous loop): the
    // message-group page issues EXACTLY two queries — a DISTINCT `(seq,
    // message_id)` probe capped at limit+1, then a row scan bounded to the
    // page's messages. Neither materializes anywhere near the full 120-row
    // table (the pre-fix single unbounded scan returned all 120).
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBe(6) // limit(5) + 1 has-more probe
    expect(calls[1]).toBe(15) // 5 messages × 3 device rows
  })

  it('is snapshot-consistent across probe+scan: a concurrent late OLDER-seq receipt cannot displace the boundary message', async () => {
    // The probe and the row scan are separate statements. Seed messages m02..m10
    // WITH receipts but leave m01 (seq 1) receiptless, so the probe for a page
    // of 5 selects m02..m06 (boundary m06). Simulate a concurrent write landing
    // BETWEEN probe and scan: a late receipt for the OLDER m01 (seq 1), which
    // sorts before the boundary. A re-derived `(seq,message_id) <= boundary`
    // range scan would then pull m01 in, the distinct-message cap would evict
    // m06, and next_cursor would still advance past m06 — dropping it forever.
    // The id-pinned scan must keep the page = exactly the probed m02..m06.
    for (let i = 1; i <= 10; i++) {
      await appendMessage(`m${String(i).padStart(2, '0')}`)
    }
    for (let i = 2; i <= 10; i++) {
      await receipts.record({ topic_id: TOPIC, message_id: `m${String(i).padStart(2, '0')}`, device_id: 'devA', state: 'read', at: i })
    }

    // Inject the concurrent older-seq receipt right after the DISTINCT probe
    // returns, before the row scan runs, by wrapping db.prepare.
    const originalPrepare = db.prepare.bind(db)
    let injected = false
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(db as any).prepare = (sql: string) => {
      const stmt = (originalPrepare as any)(sql)
      const originalAll = stmt.all.bind(stmt)
      stmt.all = (...args: unknown[]) => {
        const rows = originalAll(...args)
        if (!injected && sql.includes('DISTINCT')) {
          injected = true
          // A committed concurrent write on the same DB (seq 1 = older than the
          // page's boundary seq 6).
          db.raw()
            .prepare(
              `INSERT INTO app_chat_receipts (topic_id, message_id, device_id, seq, delivered_at, read_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(TOPIC, 'm01', 'devA', 1, 1, 1)
        }
        return rows
      }
      return stmt
    }
    let page: Awaited<ReturnType<typeof receipts.aggregatesAfterPage>>
    try {
      page = await receipts.aggregatesAfterPage(TOPIC, 0, 5)
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(db as any).prepare = originalPrepare
    }

    expect(injected).toBe(true) // the race was actually simulated
    // The page is EXACTLY the probed messages — the boundary m06 is present, and
    // the late older m01 did NOT sneak in and evict it.
    expect(page.aggregates.map((a) => a.message_id)).toEqual(['m02', 'm03', 'm04', 'm05', 'm06'])
    expect(page.next_cursor).toMatchObject({ message_id: 'm06' })
  })

  it('returns a continuation cursor so over-cap receipt state is fetchable on a follow-up, not silently lost', async () => {
    const N = 12
    for (let i = 1; i <= N; i++) {
      const id = `m${i}`
      await appendMessage(id)
      await receipts.record({ topic_id: TOPIC, message_id: id, device_id: 'devA', state: 'read', at: i })
    }

    const page1 = await receipts.aggregatesAfterPage(TOPIC, 0, 5)
    expect(page1.aggregates.map((a) => a.message_id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    expect(page1.next_cursor).not.toBeNull()

    const page2 = await receipts.aggregatesAfterPage(
      TOPIC,
      page1.next_cursor!.seq,
      5,
      page1.next_cursor!.message_id,
    )
    expect(page2.aggregates.map((a) => a.message_id)).toEqual(['m6', 'm7', 'm8', 'm9', 'm10'])
    expect(page2.next_cursor).not.toBeNull()

    const page3 = await receipts.aggregatesAfterPage(
      TOPIC,
      page2.next_cursor!.seq,
      5,
      page2.next_cursor!.message_id,
    )
    expect(page3.aggregates.map((a) => a.message_id)).toEqual(['m11', 'm12'])
    // The last page is not full, so there is nothing left to fetch.
    expect(page3.next_cursor).toBeNull()

    // Walking the cursor reproduces the same data as one uncapped call.
    const uncapped = await receipts.aggregatesAfter(TOPIC, 0, 1000)
    expect([...page1.aggregates, ...page2.aggregates, ...page3.aggregates]).toEqual(uncapped)
  })

  it('exact page-size boundaries: EXACTLY limit terminates with a null cursor (no spurious empty page); an exact multiple ends each FULL page correctly', async () => {
    // has_more hinges on `idRows.length > safeLimit` with a `LIMIT limit+1`
    // probe. The dangerous boundary is a FULL final page: exactly `limit` (or a
    // multiple) items must report next_cursor = null, not a cursor that then
    // fetches an empty page.
    for (let i = 1; i <= 10; i++) {
      const id = `m${String(i).padStart(2, '0')}`
      await appendMessage(id)
      await receipts.record({ topic_id: TOPIC, message_id: id, device_id: 'devA', state: 'read', at: i })
    }

    // Exactly `limit` after a mid-stream cursor (5 items, page size 5) → one
    // full page, done.
    const exact = await receipts.aggregatesAfterPage(TOPIC, 5, 5, 'm05')
    expect(exact.aggregates.map((a) => a.message_id)).toEqual(['m06', 'm07', 'm08', 'm09', 'm10'])
    expect(exact.next_cursor).toBeNull()

    // Exact multiple (10 items, page size 5): page1 is full WITH a cursor;
    // page2 is the FULL final page and MUST terminate (null), not yield an
    // empty page3.
    const p1 = await receipts.aggregatesAfterPage(TOPIC, 0, 5)
    expect(p1.aggregates.map((a) => a.message_id)).toEqual(['m01', 'm02', 'm03', 'm04', 'm05'])
    expect(p1.next_cursor).not.toBeNull()
    const p2 = await receipts.aggregatesAfterPage(TOPIC, p1.next_cursor!.seq, 5, p1.next_cursor!.message_id)
    expect(p2.aggregates.map((a) => a.message_id)).toEqual(['m06', 'm07', 'm08', 'm09', 'm10'])
    expect(p2.next_cursor).toBeNull() // full final page terminates — no empty page3
    // No duplicates across the two full pages.
    const ids = [...p1.aggregates, ...p2.aggregates].map((a) => a.message_id)
    expect(new Set(ids).size).toBe(10)
  })

  it('pages by MESSAGE IDENTITY, not raw seq: colliding seqs across messages neither drop a message nor report a premature null cursor', async () => {
    // Two messages living in DIFFERENT topics each get seq 1 (seq is monotonic
    // PER TOPIC). Their receipts are recorded under a THIRD topic — the store
    // resolves seq from the globally-keyed message log, so both rows land under
    // `COLLIDE` carrying seq 1. A raw-seq cursor would see ONE distinct seq,
    // fold both into a page capped at 1 message (dropping the second), and
    // report `null` (claiming done). The identity cursor must page correctly.
    const COLLIDE = 'app:collide'
    await messages.append({ topic_id: 'app:topicA', message_id: 'mA', role: 'user', body: 'x', created_at: 1 }) // seq 1 in A
    await messages.append({ topic_id: 'app:topicB', message_id: 'mB', role: 'user', body: 'x', created_at: 1 }) // seq 1 in B
    await receipts.record({ topic_id: COLLIDE, message_id: 'mA', device_id: 'devA', state: 'read', at: 1 })
    await receipts.record({ topic_id: COLLIDE, message_id: 'mB', device_id: 'devB', state: 'read', at: 2 })

    // Both rows share seq 1 under COLLIDE — the pathological collision.
    const bothSeqs = (await receipts.aggregatesAfter(COLLIDE, 0, 100)).map((a) => a.seq)
    expect(bothSeqs).toEqual([1, 1])

    const page1 = await receipts.aggregatesAfterPage(COLLIDE, 0, 1)
    // At most `limit` DISTINCT messages, and NOT a premature done-signal.
    expect(page1.aggregates).toHaveLength(1)
    expect(page1.next_cursor).not.toBeNull()

    const page2 = await receipts.aggregatesAfterPage(
      COLLIDE,
      page1.next_cursor!.seq,
      1,
      page1.next_cursor!.message_id,
    )
    expect(page2.aggregates).toHaveLength(1)
    expect(page2.next_cursor).toBeNull()

    // The two pages together cover BOTH messages exactly once — nothing dropped,
    // nothing double-counted.
    const seen = [...page1.aggregates, ...page2.aggregates].map((a) => a.message_id).sort()
    expect(seen).toEqual(['mA', 'mB'])
  })
})
