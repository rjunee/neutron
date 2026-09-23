import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../runner.ts'

const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

test('historical live rows, accounting children, retry events and migration ledger survive and reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strategy-migration-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const source = join(import.meta.dir, '..')
  for (const name of readdirSync(source)) {
    if ((/^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) < 157) || name === 'repairs.json') {
      copyFileSync(join(source, name), join(dir, name))
    }
  }
  const path = join(dir, 'historical.db')
  let db = new Database(path)
  cleanups.push(() => db.close())
  applyMigrations(db, dir)
  db.run(`INSERT INTO overnight_queue (id,project_slug,description,ralph,created_at)
    VALUES ('old-sequence','p','queued sequence',1,'now'),('old-single','p','queued single',0,'now')`)
  for (const [id, ralph, phase, checkpoint] of [
    ['sequence', 1, 'ralph-task', 'ralph-task-built'],
    ['single', 0, 'forge-init', 'forge-done'],
    ['deviated', 1, 'ralph-plan', 'ralph-task-built-deviated'],
  ] as const) {
    db.run(`INSERT INTO code_trident_runs
      (id,slug,project_slug,repo_path,task,started_at,last_advanced_at,ralph,phase,inner_checkpoint,
       ralph_round,max_ralph_rounds,ralph_task_total,inner_checkpoint_head,base_sha,infra_retries,
       crash_recoveries,workflow_run_id,inner_result,claimed_paths,resume_note,agent_waked_at)
      VALUES (?,?, 'p','/repo','task','now','now',?,?,?,4,7,9,?, ?,2,3,'workflow','result','["file"]','resumed',123)`,
      [id, id, ralph, phase, checkpoint, 'a'.repeat(40), 'b'.repeat(40)])
    db.run(`INSERT INTO work_board_items
      (id,project_slug,title,status,sort_order,created_at,updated_at,linked_run_id,ralph_round,max_ralph_rounds)
      VALUES (?, 'p', 'card', 'in_progress',1,'now','now',?,2,6)`, [id, id])
  }
  db.run(`INSERT INTO work_board_items
    (id,project_slug,title,status,sort_order,created_at,updated_at,ralph_round,max_ralph_rounds)
    VALUES ('cleared','p','card','upcoming',2,'now','now',5,5)`)
  db.run(`INSERT INTO code_trident_stage_events (run_id,stage,at,meta)
    VALUES ('sequence','build-mode-state','now','{"checkpoint":{"stage":"ralph-built"},"iteration":4}')`)
  db.run(`INSERT INTO code_trident_stage_events (run_id,stage,at,meta)
    VALUES ('sequence','build-retry-source','now','{"sourceRunId":"single","eventId":1}')`)
  db.run(`UPDATE code_trident_phase_usage SET status='partial',input_tokens=42,source='provider',observed_at=1
    WHERE run_id='sequence' AND phase='build'`)
  db.run(`INSERT INTO code_trident_attempts
    (run_id,step_id,attempt_id,phase,task_id,head_sha,role,provider,requested_model,resolved_model,placement,queued_at)
    VALUES ('sequence','step','attempt','build','task','head','build','provider','model','model','headless',1)`)
  db.run(`INSERT INTO code_trident_attempt_receipts
    (run_id,step_id,attempt_id,receipt_id,source,observed_at,input_tokens)
    VALUES ('sequence','step','attempt','receipt','provider',2,42)`)
  const tables = ['code_trident_stage_events', 'code_trident_phase_usage', 'code_trident_attempts', 'code_trident_attempt_receipts', '_migrations']
  const before = tables.map(table => db.query(`SELECT * FROM ${table}`).all())
  const beforeRuns = db.query('SELECT * FROM code_trident_runs ORDER BY id').all() as Record<string, unknown>[]
  copyFileSync(join(source, '0157_planner_selected_execution_strategy.sql'), join(dir, '0157_planner_selected_execution_strategy.sql'))
  applyMigrations(db, dir)
  expect(db.query('SELECT id, legacy_execution_mode FROM overnight_queue ORDER BY id').all()).toEqual([
    { id: 'old-sequence', legacy_execution_mode: 1 }, { id: 'old-single', legacy_execution_mode: 0 },
  ])
  for (let i = 0; i < tables.length - 1; i++) expect(db.query(`SELECT * FROM ${tables[i]}`).all()).toEqual(before[i]!)
  const ledger = db.query('SELECT * FROM _migrations').all()
  expect(ledger.slice(0, -1)).toEqual(before.at(-1)!)
  expect(ledger).toHaveLength(before.at(-1)!.length + 1)
  const after = db.prepare('SELECT * FROM code_trident_runs ORDER BY id').all() as Record<string, unknown>[]
  for (let i = 0; i < beforeRuns.length; i++) {
    const old = beforeRuns[i]!
    const expected: Record<string, unknown> = { ...old,
      execution_strategy: old.ralph === 1 ? 'task_sequence' : 'single',
      strategy_rationale: `Migrated from legacy ralph=${old.ralph}.`, strategy_plan: null, strategy_source: 'legacy',
      task_iteration: old.ralph_round, max_task_iterations: old.max_ralph_rounds, task_total: old.ralph_task_total,
      phase: String(old.phase).replace('ralph-plan', 'task-plan').replace('ralph-task', 'task-build'),
      inner_checkpoint: String(old.inner_checkpoint).replace('ralph-task-built', 'task-built'),
    }
    for (const key of ['ralph','ralph_round','max_ralph_rounds','ralph_task_total']) delete expected[key]
    expect(after[i]).toEqual(expected)
  }
  expect(db.query("SELECT execution_strategy, task_iteration, max_task_iterations FROM work_board_items WHERE id='sequence'").get())
    .toEqual({ execution_strategy: 'task_sequence', task_iteration: 4, max_task_iterations: 6 })
  expect(db.query("SELECT execution_strategy, task_iteration, max_task_iterations FROM work_board_items WHERE id='cleared'").get())
    .toEqual({ execution_strategy: 'task_sequence', task_iteration: 5, max_task_iterations: 5 })
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
  db.close()
  db = new Database(path)
  applyMigrations(db, dir)
  expect(db.query('SELECT * FROM code_trident_runs ORDER BY id').all()).toEqual(after)
  expect(db.query('SELECT * FROM _migrations').all()).toEqual(ledger)
})

test('fresh schema keeps pending distinct from either selected strategy and seeds usage', () => {
  const db = new Database(':memory:')
  cleanups.push(() => db.close())
  applyMigrations(db)
  for (const strategy of [null, 'single', 'task_sequence']) {
    const id = strategy ?? 'pending'
    db.run(`INSERT INTO code_trident_runs
      (id,slug,project_slug,repo_path,task,started_at,last_advanced_at,execution_strategy)
      VALUES (?,?,'p','/repo','task','now','now',?)`, [id, id, strategy])
    expect(db.query('SELECT execution_strategy FROM code_trident_runs WHERE id=?').get(id)).toEqual({ execution_strategy: strategy })
    expect((db.query('SELECT COUNT(*) AS n FROM code_trident_phase_usage WHERE run_id=?').get(id) as {n:number}).n).toBeGreaterThan(0)
  }
  expect(() => db.run("UPDATE code_trident_runs SET execution_strategy='single' WHERE id='task_sequence'")).toThrow('immutable')
  expect(() => db.run("UPDATE code_trident_runs SET execution_strategy='invented' WHERE id='pending'")).toThrow()
  expect(() => db.run("UPDATE code_trident_runs SET phase='ralph-task' WHERE id='pending'")).toThrow()
  db.run("UPDATE code_trident_runs SET phase='task-build' WHERE id='pending'")
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([])
})

test('a known late-rebuild card schema hole restores zero allowance while an intact sibling retains its allowance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'strategy-hole-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const source = join(import.meta.dir, '..')
  for (const name of readdirSync(source)) {
    if ((/^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) < 157) || name === 'repairs.json') {
      copyFileSync(join(source, name), join(dir, name))
    }
  }
  const damaged = new Database(':memory:')
  const intact = new Database(':memory:')
  const partial = new Database(':memory:')
  cleanups.push(() => { damaged.close(); intact.close(); partial.close() })
  for (const db of [damaged, intact, partial]) {
    applyMigrations(db, dir)
    db.run(`INSERT INTO code_trident_runs
      (id,slug,project_slug,repo_path,task,started_at,last_advanced_at,brief_alert,parent_run_id,wave_task_id)
      VALUES ('child','child','p','/repo','task','now','now','alert','parent','T1')`)
    db.run(`INSERT INTO work_board_items
      (id,project_slug,title,status,sort_order,created_at,updated_at,ralph_round,max_ralph_rounds)
      VALUES ('cleared','p','card','upcoming',1,'now','now',4,7)`)
  }
  // The exact columns omitted by a historical board rebuild, with their
  // additive migrations already in the ledger and the prior-run link cleared.
  damaged.exec('ALTER TABLE work_board_items DROP COLUMN ralph_round')
  damaged.exec('ALTER TABLE work_board_items DROP COLUMN max_ralph_rounds')
  damaged.exec('ALTER TABLE work_board_items DROP COLUMN ralph_task_total')
  damaged.exec('DROP INDEX idx_code_trident_runs_wave_child')
  for (const column of ['brief_alert', 'parent_run_id', 'wave_task_id']) {
    damaged.exec(`ALTER TABLE code_trident_runs DROP COLUMN ${column}`)
  }
  partial.exec('ALTER TABLE work_board_items DROP COLUMN ralph_round')
  copyFileSync(join(source, '0157_planner_selected_execution_strategy.sql'), join(dir, '0157_planner_selected_execution_strategy.sql'))
  applyMigrations(damaged, dir)
  applyMigrations(intact, dir)
  applyMigrations(partial, dir)
  const read = (db: Database) => db.query('SELECT task_iteration, max_task_iterations, execution_strategy, strategy_source FROM work_board_items').get()
  expect(read(damaged)).toEqual({ task_iteration: 0, max_task_iterations: 0, execution_strategy: 'task_sequence', strategy_source: 'legacy' })
  expect(read(intact)).toEqual({ task_iteration: 4, max_task_iterations: 7, execution_strategy: 'task_sequence', strategy_source: 'legacy' })
  expect(read(partial)).toEqual({ task_iteration: 0, max_task_iterations: 0, execution_strategy: 'task_sequence', strategy_source: 'legacy' })
  expect(damaged.query('SELECT brief_alert,parent_run_id,wave_task_id FROM code_trident_runs').get())
    .toEqual({ brief_alert: null, parent_run_id: null, wave_task_id: null })
  expect(intact.query('SELECT brief_alert,parent_run_id,wave_task_id FROM code_trident_runs').get())
    .toEqual({ brief_alert: 'alert', parent_run_id: 'parent', wave_task_id: 'T1' })
  for (const db of [damaged, intact]) {
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_code_trident_runs_wave_child'").get())
      .toEqual({ name: 'idx_code_trident_runs_wave_child' })
    db.run(`INSERT INTO code_trident_runs
      (id,slug,project_slug,repo_path,task,started_at,last_advanced_at,parent_run_id,wave_task_id)
      VALUES ('sibling','sibling','p','/repo','task','now','now','parent','T2')`)
    expect(() => db.run(`INSERT INTO code_trident_runs
      (id,slug,project_slug,repo_path,task,started_at,last_advanced_at,parent_run_id,wave_task_id)
      VALUES ('duplicate','duplicate','p','/repo','task','now','now','parent','T2')`)).toThrow()
  }
})
