/**
 * `AppChatEventLogCore` at the core level, for the one thing no store suite can
 * reach: the `row`-shaped branch of `aggregatesAfterPage`. Neither row-shaped
 * store (messages, edits) exposes `aggregatesAfterPage`, so that branch has no
 * caller in the tree — and its docblock promises output IDENTICAL to
 * `aggregatesAfter`'s. Without a test, the two copies of the replay window were
 * free to drift, which is exactly how the capped page ends up ordered one way in
 * one method and the other way in the other.
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
  it('caps aggregatesAfterPage to the NEWEST rows, ascending, with a null cursor', () => {
    seed(10)
    const page = core.aggregatesAfterPage(TOPIC, 0, 4)
    expect(page.aggregates.map((a) => a.seq)).toEqual([7, 8, 9, 10])
    // A row-shaped log's omitted rows lie BEFORE its page, and this cursor only
    // walks forward — so there is genuinely no continuation to hand back.
    expect(page.next_cursor).toBeNull()
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
    // defaultReplayLimit is 4 here, and the newest four are 7..10.
    expect(core.aggregatesAfter(TOPIC, 0, Number.NaN).map((a) => a.seq)).toEqual([7, 8, 9, 10])
  })

  it('returns everything, ascending, when the backlog fits the limit', () => {
    seed(3)
    expect(core.aggregatesAfter(TOPIC, 0, 4).map((a) => a.seq)).toEqual([1, 2, 3])
  })
})
