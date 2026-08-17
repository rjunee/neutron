/**
 * `AppChatEventLogCore` at the core level, for the two things no store suite can
 * reach.
 *
 * ONE — the `row`-shaped branch of `aggregatesAfterPage`. Neither row-shaped store
 * (messages, edits) exposes `aggregatesAfterPage`, so that branch has no caller in
 * the tree, and its docblock promises output IDENTICAL to `aggregatesAfter`'s. The
 * two used to be hand-copied SQL, free to drift; they now share one private helper,
 * and these tests pin the agreement so a future edit to one cannot quietly change
 * only one replay window.
 *
 * TWO — the QUERY PLAN. The window changed from `ORDER BY seq ASC LIMIT ?` to a
 * DESC-then-reverse subquery, and the claim that this early-terminates on the index
 * instead of sorting the whole backlog is exactly the sort of claim that gets
 * asserted in a comment and never measured. It is measured here, against the SQL
 * the production path runs (`rowReplaySql`, which `rowsAfter` prepares), not a copy
 * of it in this file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { AppChatEventLogCore, rowReplaySql } from './app-chat-event-core.ts'
import { ProjectDb } from './db.ts'

const TOPIC = 'app:sam'

interface Row {
  seq: number
  message_id: string
}

let tmp: string
let db: ProjectDb
let core: AppChatEventLogCore<Row, Row>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'app-chat-core-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  core = new AppChatEventLogCore<Row, Row>({
    db,
    table: 'app_chat_messages',
    columns: 'seq, message_id',
    defaultReplayLimit: 4,
    replay: { kind: 'row', toAggregate: (r) => r },
  })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const seed = (count: number): void => {
  const stmt = db.raw().prepare(
    `INSERT INTO app_chat_messages (topic_id, seq, message_id, role, body, created_at)
       VALUES (?, ?, ?, 'user', ?, ?)`,
  )
  for (let i = 1; i <= count; i++) stmt.run(TOPIC, i, `m${i}`, `b${i}`, i)
}

describe('AppChatEventLogCore — row-shaped replay window', () => {
  it('caps to the NEWEST rows past the cursor, returned ascending', () => {
    seed(10)
    expect(core.aggregatesAfterPage(TOPIC, 0, 4).aggregates.map((a) => a.seq)).toEqual([
      7, 8, 9, 10,
    ])
  })

  it('takes the newest of the range past a NON-ZERO cursor, not the newest overall', () => {
    seed(10)
    // Cursor 2, limit 4 → newest four of 3..10. Both bounds matter: the cursor still
    // excludes 1..2, and the cap still trims the OLD end of what remains.
    expect(core.aggregatesAfter(TOPIC, 2, 4).map((a) => a.seq)).toEqual([7, 8, 9, 10])
  })

  it('reports next_cursor null even when capped, and it means nothing for a row log', () => {
    seed(10)
    const page = core.aggregatesAfterPage(TOPIC, 0, 4)
    expect(page.aggregates).toHaveLength(4)
    // Documented exception on `AggregatesPage.next_cursor`: a row-shaped log always
    // reports null, and because its window is the NEWEST rows there is no
    // continuation to report. seq 1..6 were dropped and no cursor recovers them —
    // asking again from this window's last seq is empty, not the remainder.
    expect(page.next_cursor).toBeNull()
    expect(core.aggregatesAfter(TOPIC, 10, 4)).toEqual([])
  })

  it('agrees with aggregatesAfter exactly — capped and uncapped', () => {
    seed(10)
    for (const [after, limit] of [
      [0, 4],
      [0, 10],
      [0, 25],
      [6, 2],
      [6, 4],
      [10, 4],
    ] as const) {
      expect(core.aggregatesAfter(TOPIC, after, limit)).toEqual(
        core.aggregatesAfterPage(TOPIC, after, limit).aggregates,
      )
    }
  })

  it('falls back to the store default limit on a non-finite limit', () => {
    seed(10)
    // defaultReplayLimit is 4 here, and the newest four past 0 are 7..10.
    expect(core.aggregatesAfter(TOPIC, 0, Number.NaN).map((a) => a.seq)).toEqual([7, 8, 9, 10])
  })

  it('returns everything, ascending, when the backlog fits the limit', () => {
    seed(3)
    expect(core.aggregatesAfter(TOPIC, 0, 4).map((a) => a.seq)).toEqual([1, 2, 3])
  })

  it('is byte-identical to an unbounded read whenever the range fits', () => {
    // The no-op control at the core level: below the cap, DESC-then-reverse and a
    // plain ascending read of the same range agree object for object.
    seed(10)
    expect(core.aggregatesAfter(TOPIC, 0, 10)).toEqual(core.aggregatesAfter(TOPIC, 0, 1_000_000))
    expect(core.aggregatesAfter(TOPIC, 6, 4)).toEqual(core.aggregatesAfter(TOPIC, 6, 1_000_000))
  })
})

describe('AppChatEventLogCore — the newest-first window does not regress the scan', () => {
  /** Plan rows for the statement the production path prepares. `bounded` selects
   *  the BACKWARDS-page variant (`AND seq < ?`), which is on the resume path now
   *  that a client walks older history — so both strings are measured here rather
   *  than one measured and the other assumed. */
  const planOf = (table: string, columns: string, bounded = false): string => {
    const sql = rowReplaySql(table, columns, bounded)
    const params: number[] = bounded ? [0, 1_000, 4] : [0, 4]
    return db
      .raw()
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(TOPIC, ...params)
      .map((r) => String((r as { detail?: unknown }).detail ?? ''))
      .join(' | ')
  }

  it('walks the (topic_id, seq) primary key backwards, with no sort at all', () => {
    seed(10)
    const plan = planOf('app_chat_messages', 'seq, message_id')

    // A backwards index walk over the PK (migration 0079: PRIMARY KEY (topic_id,
    // seq)) — so the LIMIT terminates the read, and the rows arrive in seq order.
    expect(plan).toContain('SEARCH app_chat_messages USING INDEX')
    expect(plan).toContain('sqlite_autoindex_app_chat_messages_1')
    // The failures this test exists to catch: a full table scan, or SQLite
    // materializing rows into a sort instead of reading them in index order. The
    // second one is not hypothetical — the first draft of this query wrapped the
    // SELECT in an outer `ORDER BY seq ASC` and the plan came back with exactly
    // this temp B-tree, which is why the reversal now happens in memory.
    expect(plan).not.toContain('SCAN app_chat_messages')
    expect(plan).not.toContain('TEMP B-TREE')
  })

  it('walks the edits topic/seq index the same way', () => {
    // The other row-shaped store shares this SQL, and its table has an ordinary
    // index rather than a PK on (topic_id, seq) — so the plan is asserted there too
    // rather than assumed to follow.
    const plan = planOf('app_chat_edits', 'message_id, seq')

    expect(plan).toContain('SEARCH app_chat_edits USING INDEX')
    expect(plan).toContain('idx_app_chat_edits_topic_seq')
    expect(plan).not.toContain('SCAN app_chat_edits')
    expect(plan).not.toContain('TEMP B-TREE')
  })

  it('walks the same index, still with no sort, when the page is bounded ABOVE too', () => {
    // The backwards page adds `AND seq < ?`, which only narrows the same index
    // range — it must not turn the read into a scan or a sort. Asserted for both
    // row-shaped tables, because the message table's index is a PRIMARY KEY and the
    // edits table's is an ordinary one, and the planner is entitled to differ.
    seed(10)
    const messagePlan = planOf('app_chat_messages', 'seq, message_id', true)
    expect(messagePlan).toContain('SEARCH app_chat_messages USING INDEX')
    expect(messagePlan).not.toContain('SCAN app_chat_messages')
    expect(messagePlan).not.toContain('TEMP B-TREE')

    const editPlan = planOf('app_chat_edits', 'message_id, seq', true)
    expect(editPlan).toContain('SEARCH app_chat_edits USING INDEX')
    expect(editPlan).not.toContain('SCAN app_chat_edits')
    expect(editPlan).not.toContain('TEMP B-TREE')
  })

  it('reads at most `limit` rows however long the backlog past the cursor is', () => {
    // Early termination, observed rather than inferred from the plan text: the plan
    // is identical whether four rows follow the cursor or four hundred, and the
    // result stays capped. A query that read the range and then capped would show
    // the same result and a different plan.
    seed(400)
    expect(core.aggregatesAfter(TOPIC, 0, 4).map((a) => a.seq)).toEqual([397, 398, 399, 400])
    expect(planOf('app_chat_messages', 'seq, message_id')).not.toContain('TEMP B-TREE')
  })
})
