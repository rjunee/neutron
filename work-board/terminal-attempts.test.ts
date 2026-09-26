import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { reconcileInstanceScope } from '@neutronai/migrations/scope-rekey.ts'
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

test('instance rekey moves General card and terminal history together while preserving a distinct project across restart', async () => {
  const before = 'owner-before'
  const after = 'owner-after'
  const project = 'distinct-project'
  const store = new WorkBoardStore(db)
  const generalCard = await store.create(before, { title: 'General attempt' })
  const projectCard = await store.create(project, { title: 'Project attempt' })
  await store.attachRun(before, generalCard.id, 'general-run')
  await store.detachRun(before, 'general-run', 'failed')
  await store.attachRun(project, projectCard.id, 'project-run')
  await store.detachRun(project, 'project-run', 'blocked')
  const generalHistory = store.get(before, generalCard.id)!.attempts!
  const projectHistory = store.get(project, projectCard.id)!.attempts!
  expect(generalHistory).toHaveLength(1)
  expect(projectHistory).toHaveLength(1)
  db.close()
  const dbPath = join(dir, 'project.db')
  const raw = new Database(dbPath)
  try {
    raw.run('INSERT INTO instance_scope_ledger (id, project_slug, updated_at) VALUES (1, ?, 1)', [before])
    raw.run("INSERT INTO tasks (id, project_slug, title, created_at, updated_at) VALUES ('instance-task', ?, 'Task', '2026-01-01', '2026-01-01')", [before])
    expect(reconcileInstanceScope(raw, after, { dbPath, currentSlugIsFallback: false }).action).toBe('rekeyed')
    expect(raw.query("SELECT project_slug FROM tasks WHERE id = 'instance-task'").get()).toEqual({ project_slug: after })
    expect(raw.query('SELECT project_slug, item_id, run_id FROM work_board_terminal_attempts ORDER BY run_id').all()).toEqual([
      { project_slug: after, item_id: generalCard.id, run_id: 'general-run' },
      { project_slug: project, item_id: projectCard.id, run_id: 'project-run' },
    ])
  } finally {
    raw.close()
    db = ProjectDb.open(dbPath)
  }
  const restarted = new WorkBoardStore(db)
  expect(restarted.get(after, generalCard.id)?.attempts).toEqual(generalHistory)
  expect(restarted.get(before, generalCard.id)).toBeNull()
  expect(restarted.get(project, projectCard.id)?.attempts).toEqual(projectHistory)
  expect(restarted.get(after, projectCard.id)).toBeNull()
  expect(restarted.get(project, generalCard.id)).toBeNull()
});

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
  const sql = readFileSync(new URL('../migrations/0160_work_board_terminal_attempts.sql', import.meta.url), 'utf8')
  db.raw().exec(sql)
  db.raw().exec(sql)
  const rows = db.prepare('SELECT run_id, outcome, pr, pr_url, recorded_at FROM work_board_terminal_attempts ORDER BY outcome').all()
  expect(rows).toEqual(['blocked', 'done', 'failed'].map(outcome => ({
    run_id: `run-${outcome}`, outcome, pr: 7, pr_url: 'https://example.test/pull/7', recorded_at: '2026-09-20T00:00:00Z',
  })))
})

for (const originalOrdinal of [159, 160]) {
  test(`real runner applies terminal backfill at ${originalOrdinal} below a recorded higher ordinal and preserves name identity after renumber`, () => {
    const tree = join(dir, 'migration-tree')
    mkdirSync(tree)
    const fixture = new Database(join(dir, 'ordinal.db'), { create: true })
    try {
      fixture.exec(`CREATE TABLE work_board_items (
        id TEXT PRIMARY KEY, project_slug TEXT, linked_run_id TEXT, status TEXT,
        pr INTEGER, pr_url TEXT, updated_at TEXT
      );
      INSERT INTO work_board_items VALUES
        ('failed', 'board', 'run-failed', 'failed', 12, 'https://example.test/pull/12', '2026-09-20'),
        ('blocked', 'board', 'run-blocked', 'blocked', NULL, NULL, '2026-09-20'),
        ('done', 'board', 'run-done', 'done', NULL, NULL, '2026-09-20'),
        ('active', 'board', 'run-active', 'in_progress', NULL, NULL, '2026-09-20'),
        ('unlinked', 'board', NULL, 'failed', NULL, NULL, '2026-09-20');`)
      writeFileSync(join(tree, '0170_fixture_marker.sql'), 'CREATE TABLE fixture_marker (id INTEGER);')
      expect(applyMigrations(fixture, tree).applied).toEqual([170])
      const filename = `0${originalOrdinal}_work_board_terminal_attempts.sql`
      writeFileSync(join(tree, filename), readFileSync(new URL('../migrations/0160_work_board_terminal_attempts.sql', import.meta.url)))
      expect(applyMigrations(fixture, tree).applied).toEqual([originalOrdinal])
      const observations = fixture.query('SELECT * FROM work_board_terminal_attempts ORDER BY run_id').all()
      expect(observations.map(row => (row as { run_id: string }).run_id)).toEqual(['run-blocked', 'run-done', 'run-failed'])
      const ledger = fixture.query("SELECT * FROM _migrations WHERE name = 'work_board_terminal_attempts'").get()
      expect(ledger).toMatchObject({ version: originalOrdinal })
      // This new terminal card would be backfilled if the renamed SQL ran again.
      fixture.exec("UPDATE work_board_items SET status = 'failed' WHERE id = 'active'")
      if (originalOrdinal === 159) renameSync(join(tree, filename), join(tree, '0160_work_board_terminal_attempts.sql'))
      expect(applyMigrations(fixture, tree)).toEqual({ applied: [], skipped: [160, 170] })
      expect(fixture.query("SELECT * FROM _migrations WHERE name = 'work_board_terminal_attempts'").get()).toEqual(ledger)
      expect(fixture.query('SELECT * FROM work_board_terminal_attempts ORDER BY run_id').all()).toEqual(observations)
    } finally { fixture.close() }
  })
}
