/**
 * 0143 — what a terminal run that predates the wake path means.
 *
 * `agent_waked_at IS NULL` had two readings the moment anything acted on it:
 * "this run went terminal and still owes a decision turn" and "this run was
 * already terminal before the column existed". Nothing read the column until the
 * terminal-decision sweep shipped, and the sweep can only act on the first. On
 * the repo of record the second reading covered 152 rows — oldest 2026-08-07,
 * newest 2026-08-22, none from the last day — so the first boot after the sweep
 * shipped would have driven an owner decision turn for each.
 *
 * These two cases pin the separation itself: already-terminal rows are settled by
 * the migration, and rows that go terminal afterwards are not touched by it. A
 * migration that stamped everything would pass the first alone.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../runner.ts'

const MIGRATIONS_DIR = join(import.meta.dir, '..')
const BACKFILL = '0143_backfill_agent_waked_at.sql'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'backfill-agent-waked-at-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** The real tree with the backfill held back, so the boot under test is an
 *  instance that ran every migration up to the one being measured. */
function treeWithoutBackfill(): string {
  const dir = join(tmp, 'migrations')
  mkdirSync(dir, { recursive: true })
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    if (!/^\d{4}_.+\.sql$/.test(file) && file !== 'repairs.json') continue
    if (file === BACKFILL) continue
    cpSync(join(MIGRATIONS_DIR, file), join(dir, file))
  }
  return dir
}

function insertRun(db: Database, id: string, phase: string): void {
  db.run(
    `INSERT INTO code_trident_runs (id, slug, project_slug, phase, repo_path, task, chat_id, started_at, last_advanced_at)
     VALUES (?, ?, 't1', ?, '/r', 't', 'app:owner:t1', '2026-08-07T23:26:14.251Z', '2026-08-07T23:26:14.251Z')`,
    [id, id, phase],
  )
}

test('a run already terminal when the backfill runs is settled, and is never announced', () => {
  const dir = treeWithoutBackfill()
  const db = new Database(join(tmp, 'p.db'), { create: true })
  applyMigrations(db, dir)

  insertRun(db, 'old-done', 'done')
  insertRun(db, 'old-failed', 'failed')
  insertRun(db, 'old-stopped', 'stopped')
  // The control: a live run is NOT terminal, so the backfill has nothing to say
  // about it and must leave it to be announced when it finishes.
  insertRun(db, 'still-running', 'forge-init')

  cpSync(join(MIGRATIONS_DIR, BACKFILL), join(dir, BACKFILL))
  expect(applyMigrations(db, dir).applied).toEqual([143])

  const stamped = (id: string): number | null =>
    db.query<{ agent_waked_at: number | null }, [string]>(
      'SELECT agent_waked_at FROM code_trident_runs WHERE id = ?',
    ).get(id)?.agent_waked_at ?? null

  expect(stamped('old-done')).not.toBeNull()
  expect(stamped('old-failed')).not.toBeNull()
  expect(stamped('old-stopped')).not.toBeNull()
  expect(stamped('still-running')).toBeNull()
  db.close()
})

test('a run that goes terminal after the backfill is still owed its decision turn', () => {
  const dir = treeWithoutBackfill()
  const db = new Database(join(tmp, 'p.db'), { create: true })
  applyMigrations(db, dir)
  insertRun(db, 'old-done', 'done')

  cpSync(join(MIGRATIONS_DIR, BACKFILL), join(dir, BACKFILL))
  applyMigrations(db, dir)

  // Everything after this point is what the sweep exists for.
  insertRun(db, 'new-done', 'done')

  const pending = db
    .query<{ id: string }, []>(
      `SELECT id FROM code_trident_runs
        WHERE phase IN ('done','failed','stopped') AND agent_waked_at IS NULL AND chat_id <> ''`,
    )
    .all()
    .map((r) => r.id)
  expect(pending).toEqual(['new-done'])
  db.close()
})
