/**
 * `AppChatEventLogCore` at the core level, for the one thing no store suite can
 * reach: the `row`-shaped branch of `aggregatesAfterPage`. Neither row-shaped
 * store (messages, edits) exposes `aggregatesAfterPage`, so that branch has no
 * caller in the tree — and its docblock promises output IDENTICAL to
 * `aggregatesAfter`'s. The two used to be hand-copied SQL, free to drift; they now
 * share one private helper, and these tests pin the agreement so a future edit to
 * one cannot quietly change only one replay window.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { AppChatEventLogCore } from './app-chat-event-core.ts'
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
  it('caps a page to the OLDEST rows past the cursor, ascending', () => {
    seed(10)
    expect(core.aggregatesAfterPage(TOPIC, 0, 4).aggregates.map((a) => a.seq)).toEqual([1, 2, 3, 4])
  })

  it('a capped page is a PREFIX, so paging from its last seq reaches the remainder', () => {
    seed(10)
    // The property the resume drain depends on: page, take the last seq, page
    // again — and arrive at the whole backlog with nothing skipped or repeated.
    const seqs: number[] = []
    let cursor = 0
    for (let guard = 0; guard < 20; guard++) {
      const page = core.aggregatesAfterPage(TOPIC, cursor, 4).aggregates
      if (page.length === 0) break
      for (const a of page) seqs.push(a.seq)
      const last = page[page.length - 1]!
      if (last.seq <= cursor) break
      cursor = last.seq
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('reports next_cursor null even when capped — complete PAGE, not drained backlog', () => {
    seed(10)
    const page = core.aggregatesAfterPage(TOPIC, 0, 4)
    expect(page.aggregates).toHaveLength(4)
    // Documented exception on `AggregatesPage.next_cursor`: for a row-shaped log
    // null means "this page is complete". Six rows remain, and they are reachable
    // via the plain seq cursor (asserted above) rather than through this field.
    expect(page.next_cursor).toBeNull()
    expect(core.aggregatesAfter(TOPIC, 4, 4).map((a) => a.seq)).toEqual([5, 6, 7, 8])
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
    // defaultReplayLimit is 4 here, and the oldest four past 0 are 1..4.
    expect(core.aggregatesAfter(TOPIC, 0, Number.NaN).map((a) => a.seq)).toEqual([1, 2, 3, 4])
  })

  it('returns everything, ascending, when the backlog fits the limit', () => {
    seed(3)
    expect(core.aggregatesAfter(TOPIC, 0, 4).map((a) => a.seq)).toEqual([1, 2, 3])
  })
})
