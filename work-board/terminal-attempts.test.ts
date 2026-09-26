import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { seedMigratedDb } from '../tests/support/migrated-db.ts'
import { WorkBoardStore, WorkBoardRunStillLiveError } from './store.ts'

let dir: string
let db: ProjectDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'board-attempts-'))
  seedMigratedDb(join(dir, 'project.db'))
  db = ProjectDb.open(join(dir, 'project.db'))
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('terminal evidence survives retry, shelving, restart and unshelving without borrowing PRs', async () => {
  const store = new WorkBoardStore(db)
  const card = await store.create('board', { title: 'Build' })
  await store.attachRun('board', card.id, 'first')
  const first = await store.detachRun('board', 'first', 'failed', { pr: 12, pr_url: 'https://example.test/pull/12' })
  await store.detachRun('board', 'first', 'failed')
  expect(store.get('board', card.id)?.attempts).toEqual(first?.attempts)
  const retry = await store.attachRun('board', card.id, 'second')
  expect(retry?.linked_run_id).toBe('second')
  expect(retry?.pr).toBeNull()
  expect(await store.detachRun('board', 'first', 'done')).toBeNull()
  await store.detachRun('board', 'second', 'blocked')
  const attempts = store.get('board', card.id)!.attempts!
  expect(attempts.map(({ run_id, outcome, pr, pr_url }) => ({ run_id, outcome, pr, pr_url }))).toEqual([
    { run_id: 'first', outcome: 'failed', pr: 12, pr_url: 'https://example.test/pull/12' },
    { run_id: 'second', outcome: 'blocked', pr: null, pr_url: null },
  ])
  await store.update('board', card.id, { status: 'archived' })
  expect(store.listCompleted('board')).toEqual([])
  expect(store.listArchived('board')[0]?.attempts).toEqual(attempts)
  expect(store.get('foreign', card.id)).toBeNull()
  expect(store.listArchived('foreign')).toEqual([])
  db.close()
  db = ProjectDb.open(join(dir, 'project.db'))
  const restarted = new WorkBoardStore(db)
  expect(restarted.get('board', card.id)?.attempts).toEqual(attempts)
  await restarted.update('board', card.id, { status: 'upcoming' })
  expect(restarted.get('board', card.id)?.attempts).toEqual(attempts)
  await restarted.attachRun('board', card.id, 'third')
  await restarted.detachRun('board', 'third', 'done')
  expect(restarted.listCompleted('board')[0]?.attempts).toHaveLength(3)
  await restarted.delete('foreign', card.id)
  expect(restarted.get('board', card.id)?.attempts).toHaveLength(3)
  await restarted.delete('board', card.id)
  expect(db.prepare('SELECT * FROM work_board_terminal_attempts').all()).toEqual([])
})

test('live shelving refuses and active runs do not acquire terminal evidence', async () => {
  const store = new WorkBoardStore(db, { isRunLive: () => true })
  const card = await store.create('board', { title: 'Live' })
  await store.attachRun('board', card.id, 'live')
  await expect(store.update('board', card.id, { status: 'archived' })).rejects.toBeInstanceOf(WorkBoardRunStillLiveError)
  expect(store.get('board', card.id)?.attempts).toEqual([])
  expect(await store.detachRun('foreign', 'live', 'failed')).toBeNull()
  expect(store.get('board', card.id)?.linked_run_id).toBe('live')
})

test('upgrade backfills only linked terminal observations and is idempotent', async () => {
  const store = new WorkBoardStore(db)
  for (const status of ['failed', 'blocked', 'done', 'in_progress', 'upcoming', 'archived'] as const) {
    const card = await store.create('board', { title: status })
    await db.run('UPDATE work_board_items SET status = ?, linked_run_id = ?, pr = 7, pr_url = ?, updated_at = ? WHERE id = ?',
      [status, `run-${status}`, 'https://example.test/pull/7', '2026-09-20T00:00:00Z', card.id])
  }
  await store.create('board', { title: 'Unlinked terminal', status: 'done' })
  // Recreate the pre-upgrade boundary with existing card rows, then run the exact migration.
  db.raw().exec('DROP TABLE work_board_terminal_attempts')
  const sql = readFileSync(new URL('../migrations/0159_work_board_terminal_attempts.sql', import.meta.url), 'utf8')
  db.raw().exec(sql)
  db.raw().exec(sql)
  const rows = db.prepare('SELECT run_id, outcome, pr, pr_url, recorded_at FROM work_board_terminal_attempts ORDER BY outcome').all()
  expect(rows).toEqual(['blocked', 'done', 'failed'].map(outcome => ({
    run_id: `run-${outcome}`, outcome, pr: 7, pr_url: 'https://example.test/pull/7', recorded_at: '2026-09-20T00:00:00Z',
  })))
})
