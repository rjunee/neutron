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

import { applyMigrations } from '@neutronai/migrations/runner.ts'
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

  it('the limit caps DISTINCT messages, not reaction rows', async () => {
    await appendMessage('m1') // seq 1
    await appendMessage('m2') // seq 2
    await appendMessage('m3') // seq 3
    // m1 carries TWO reaction rows — they must not eat the message budget.
    await reactions.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devA', emoji: '👍', action: 'add', at: 1 })
    await reactions.record({ topic_id: TOPIC, message_id: 'm1', device_id: 'devB', emoji: '🎉', action: 'add', at: 2 })
    await reactions.record({ topic_id: TOPIC, message_id: 'm2', device_id: 'devA', emoji: '👍', action: 'add', at: 3 })
    await reactions.record({ topic_id: TOPIC, message_id: 'm3', device_id: 'devA', emoji: '👍', action: 'add', at: 4 })

    const capped = await reactions.aggregatesAfter(TOPIC, 0, 2)
    expect(capped.map((a) => a.message_id)).toEqual(['m1', 'm2'])
    expect(capped[0]?.reactions).toEqual([
      { emoji: '🎉', device_id: 'devB' },
      { emoji: '👍', device_id: 'devA' },
    ])
  })
})

describe('AppChatReactionStore — aggregatesAfter bounded scan + continuation (regression)', () => {
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
    // Substantiates the bounded-scan claim at the query-plan level (see the
    // receipt suite's twin): the migration-0101 (topic_id, seq, message_id)
    // index makes the `DISTINCT seq, message_id` probe an index-only search
    // that early-terminates at LIMIT instead of a `USE TEMP B-TREE FOR DISTINCT`
    // full materialization.
    const plan = db
      .raw()
      .query(
        `EXPLAIN QUERY PLAN
           SELECT DISTINCT seq, message_id FROM app_chat_reactions
            WHERE topic_id = ? AND seq > ?
            ORDER BY seq ASC, message_id ASC
            LIMIT ?`,
      )
      .all(TOPIC, 0, 6) as Array<{ detail: string }>
    const detail = plan.map((r) => r.detail).join(' | ')
    expect(detail).toContain('idx_app_chat_reactions_topic_seq_msg')
    expect(detail).not.toContain('TEMP B-TREE')
  })

  it('bounds the SQL scan to the page instead of materializing every row after the cursor', async () => {
    // 40 messages, 2 reaction rows each (devA's 👍 tombstoned by the remove —
    // an upsert on the same (message, device, emoji) row — plus devB's active
    // 🎉) = 80 reaction rows total, but the replay only wants a page of 5
    // DISTINCT messages. Pre-fix, the message-group branch ran one unconditional
    // `WHERE seq > ?` scan that returned all 80 rows before capping to 5
    // messages in JS.
    const N = 40
    for (let i = 1; i <= N; i++) {
      const id = `m${i}`
      await appendMessage(id)
      await reactions.record({ topic_id: TOPIC, message_id: id, device_id: 'devA', emoji: '👍', action: 'add', at: i })
      await reactions.record({ topic_id: TOPIC, message_id: id, device_id: 'devB', emoji: '🎉', action: 'add', at: i })
      await reactions.record({ topic_id: TOPIC, message_id: id, device_id: 'devA', emoji: '👍', action: 'remove', at: i })
    }

    const { calls, restore } = instrumentRowCounts()
    let capped: Awaited<ReturnType<typeof reactions.aggregatesAfter>>
    try {
      capped = await reactions.aggregatesAfter(TOPIC, 0, 5)
    } finally {
      restore()
    }

    expect(capped.map((a) => a.message_id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    // Explicit query COUNT + per-query row counts (not a vacuous loop): the
    // message-group page issues EXACTLY two queries — a DISTINCT `(seq,
    // message_id)` probe capped at limit+1, then a row scan bounded to the
    // page's messages. Neither materializes anywhere near the full 80-row table.
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBe(6) // limit(5) + 1 has-more probe
    expect(calls[1]).toBe(10) // 5 messages × 2 rows
  })

  it('is snapshot-consistent across probe+scan: a concurrent late OLDER-seq reaction cannot displace the boundary message', async () => {
    // See the receipt suite's twin. Seed m02..m10 WITH reactions, leave m01
    // (seq 1) reactionless, so the page-of-5 probe selects m02..m06 (boundary
    // m06). Inject a late reaction for the OLDER m01 between probe and scan; the
    // id-pinned scan must keep the page = exactly m02..m06 (not evict m06).
    for (let i = 1; i <= 10; i++) {
      await appendMessage(`m${String(i).padStart(2, '0')}`)
    }
    for (let i = 2; i <= 10; i++) {
      await reactions.record({ topic_id: TOPIC, message_id: `m${String(i).padStart(2, '0')}`, device_id: 'devA', emoji: '👍', action: 'add', at: i })
    }

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
          db.raw()
            .prepare(
              `INSERT INTO app_chat_reactions (topic_id, message_id, device_id, emoji, seq, active, rev, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(TOPIC, 'm01', 'devA', '👍', 1, 1, 1, 1)
        }
        return rows
      }
      return stmt
    }
    let page: Awaited<ReturnType<typeof reactions.aggregatesAfterPage>>
    try {
      page = await reactions.aggregatesAfterPage(TOPIC, 0, 5)
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(db as any).prepare = originalPrepare
    }

    expect(injected).toBe(true)
    expect(page.aggregates.map((a) => a.message_id)).toEqual(['m02', 'm03', 'm04', 'm05', 'm06'])
    expect(page.next_cursor).toMatchObject({ message_id: 'm06' })
  })

  it('returns a continuation cursor so over-cap reaction state is fetchable on a follow-up, not silently lost', async () => {
    const N = 12
    for (let i = 1; i <= N; i++) {
      const id = `m${i}`
      await appendMessage(id)
      await reactions.record({ topic_id: TOPIC, message_id: id, device_id: 'devA', emoji: '👍', action: 'add', at: i })
    }

    const page1 = await reactions.aggregatesAfterPage(TOPIC, 0, 5)
    expect(page1.aggregates.map((a) => a.message_id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    expect(page1.next_cursor).not.toBeNull()

    const page2 = await reactions.aggregatesAfterPage(
      TOPIC,
      page1.next_cursor!.seq,
      5,
      page1.next_cursor!.message_id,
    )
    expect(page2.aggregates.map((a) => a.message_id)).toEqual(['m6', 'm7', 'm8', 'm9', 'm10'])
    expect(page2.next_cursor).not.toBeNull()

    const page3 = await reactions.aggregatesAfterPage(
      TOPIC,
      page2.next_cursor!.seq,
      5,
      page2.next_cursor!.message_id,
    )
    expect(page3.aggregates.map((a) => a.message_id)).toEqual(['m11', 'm12'])
    // The last page is not full, so there is nothing left to fetch.
    expect(page3.next_cursor).toBeNull()

    // Walking the cursor reproduces the same data as one uncapped call.
    const uncapped = await reactions.aggregatesAfter(TOPIC, 0, 1000)
    expect([...page1.aggregates, ...page2.aggregates, ...page3.aggregates]).toEqual(uncapped)
  })

  it('exact page-size boundaries: EXACTLY limit terminates with a null cursor (no spurious empty page); an exact multiple ends each FULL page correctly', async () => {
    // See the receipt suite's twin — a FULL final page (exactly `limit`, or a
    // multiple) must report next_cursor = null, not a cursor onto an empty page.
    for (let i = 1; i <= 10; i++) {
      const id = `m${String(i).padStart(2, '0')}`
      await appendMessage(id)
      await reactions.record({ topic_id: TOPIC, message_id: id, device_id: 'devA', emoji: '👍', action: 'add', at: i })
    }

    const exact = await reactions.aggregatesAfterPage(TOPIC, 5, 5, 'm05')
    expect(exact.aggregates.map((a) => a.message_id)).toEqual(['m06', 'm07', 'm08', 'm09', 'm10'])
    expect(exact.next_cursor).toBeNull()

    const p1 = await reactions.aggregatesAfterPage(TOPIC, 0, 5)
    expect(p1.aggregates.map((a) => a.message_id)).toEqual(['m01', 'm02', 'm03', 'm04', 'm05'])
    expect(p1.next_cursor).not.toBeNull()
    const p2 = await reactions.aggregatesAfterPage(TOPIC, p1.next_cursor!.seq, 5, p1.next_cursor!.message_id)
    expect(p2.aggregates.map((a) => a.message_id)).toEqual(['m06', 'm07', 'm08', 'm09', 'm10'])
    expect(p2.next_cursor).toBeNull() // full final page terminates — no empty page3
    const ids = [...p1.aggregates, ...p2.aggregates].map((a) => a.message_id)
    expect(new Set(ids).size).toBe(10)
  })

  it('pages by MESSAGE IDENTITY, not raw seq: colliding seqs across messages neither drop a message nor report a premature null cursor', async () => {
    // Two messages living in DIFFERENT topics each get seq 1 (seq is monotonic
    // PER TOPIC). Their reactions are recorded under a THIRD topic — the store
    // resolves seq from the globally-keyed message log, so both rows land under
    // `COLLIDE` carrying seq 1. A raw-seq cursor would see ONE distinct seq,
    // fold both into a page capped at 1 message (dropping the second), and
    // report `null` (claiming done). The identity cursor must page correctly.
    const COLLIDE = 'app:collide'
    await messages.append({ topic_id: 'app:topicA', message_id: 'mA', role: 'user', body: 'x', created_at: 1 }) // seq 1 in A
    await messages.append({ topic_id: 'app:topicB', message_id: 'mB', role: 'user', body: 'x', created_at: 1 }) // seq 1 in B
    await reactions.record({ topic_id: COLLIDE, message_id: 'mA', device_id: 'devA', emoji: '👍', action: 'add', at: 1 })
    await reactions.record({ topic_id: COLLIDE, message_id: 'mB', device_id: 'devB', emoji: '🎉', action: 'add', at: 2 })

    // Both rows share seq 1 under COLLIDE — the pathological collision.
    const bothSeqs = (await reactions.aggregatesAfter(COLLIDE, 0, 100)).map((a) => a.seq)
    expect(bothSeqs).toEqual([1, 1])

    const page1 = await reactions.aggregatesAfterPage(COLLIDE, 0, 1)
    // At most `limit` DISTINCT messages, and NOT a premature done-signal.
    expect(page1.aggregates).toHaveLength(1)
    expect(page1.next_cursor).not.toBeNull()

    const page2 = await reactions.aggregatesAfterPage(
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
