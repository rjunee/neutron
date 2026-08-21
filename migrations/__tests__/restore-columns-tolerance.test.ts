/**
 * A migration may re-create a column an earlier repair rebuild deleted — and may
 * tolerate finding it already there. NOTHING ELSE.
 *
 * THE DEFECT. `0131_code_trident_runs_base_sha_repair.sql` rebuilds
 * `code_trident_runs` by naming its columns, and it only ever runs LATE: it is
 * pending exactly on the instances that skipped ordinal 125, which by now have
 * also applied 0136 (`brief_alert`) and 0137 (`parent_run_id`, `wave_task_id`,
 * and the wave-child UNIQUE index). A rebuild copies only the columns it names,
 * so on those instances 0131 SILENTLY DELETES all three and still reports
 * success. Nothing on main reads them after 0131, which is why it stayed quiet.
 * 0131 itself can never be edited — its content hash is recorded in every ledger
 * that ran it — and SQLite has no conditional `ADD COLUMN`, so the repair has to
 * come from a later migration that is allowed to find the column present.
 *
 * THE RISK THIS FILE GUARDS. Error tolerance inside the migration runner is the
 * most dangerous thing that could be added to it: a tolerance one word too wide
 * turns a failed migration into a silent one, which is the exact failure mode the
 * runner exists to prevent. So every test below is about the LIMIT, not the
 * feature — that it applies only inside the markers, only to ADD COLUMN, and only
 * to `duplicate column name`.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, splitRestoreColumnBlock } from '../runner.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mig-restore-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** A migration tree with no git metadata above it, so provenance is unverifiable. */
function bareTree(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name, 'migrations')
  mkdirSync(dir, { recursive: true })
  for (const [file, contents] of Object.entries(files)) writeFileSync(join(dir, file), contents)
  return dir
}

function columnsOf(db: Database, table: string): string[] {
  return (
    db.query(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>
  ).map((c) => c.name)
}

const BLOCK = (...alters: string[]) =>
  ['-- @neutron:restore-columns BEGIN', ...alters, '-- @neutron:restore-columns END'].join('\n')

// ------------------------------------------------- the parser and its refusals

test('a migration with no markers is passed through untouched', () => {
  const sql = 'ALTER TABLE t ADD COLUMN a TEXT;\nCREATE INDEX i ON t (a);'
  expect(splitRestoreColumnBlock(sql)).toEqual({ restore: [], body: sql })
})

test('the block is lifted out of the body, so its statements never run twice', () => {
  const sql = `-- header\n${BLOCK('ALTER TABLE t ADD COLUMN a TEXT;')}\nCREATE INDEX i ON t (a);`
  const { restore, body } = splitRestoreColumnBlock(sql)
  expect(restore).toEqual(['ALTER TABLE t ADD COLUMN a TEXT'])
  // The strict body still carries everything else, and no longer carries the ALTER.
  expect(body).toContain('CREATE INDEX i ON t (a);')
  expect(body).toContain('-- header')
  expect(body).not.toContain('ADD COLUMN')
  expect(body).not.toContain('@neutron:restore-columns')
})

test('a block may hold several ADD COLUMNs, comments and blank lines', () => {
  const { restore } = splitRestoreColumnBlock(
    BLOCK(
      '-- put back what 0131 dropped',
      'ALTER TABLE t ADD COLUMN a TEXT;',
      '',
      'ALTER TABLE t ADD COLUMN b INTEGER;',
    ),
  )
  expect(restore).toEqual(['ALTER TABLE t ADD COLUMN a TEXT', 'ALTER TABLE t ADD COLUMN b INTEGER'])
})

test('a statement that is not ADD COLUMN is REFUSED, never tolerated', () => {
  // The whole point: tolerance is granted per-statement by SHAPE, so a DROP or an
  // UPDATE cannot ride in on a block opened for a column restore.
  expect(() =>
    splitRestoreColumnBlock(BLOCK('ALTER TABLE t ADD COLUMN a TEXT;', 'DROP TABLE t;'), '0999_x.sql'),
  ).toThrow(/ONLY .*ADD COLUMN/s)
  expect(() => splitRestoreColumnBlock(BLOCK('DROP TABLE t;'), '0999_x.sql')).toThrow(/0999_x\.sql/)
})

test('an unbalanced marker pair is REFUSED — a restore that silently did not run is the bug', () => {
  expect(() => splitRestoreColumnBlock('-- @neutron:restore-columns BEGIN\nALTER TABLE t ADD COLUMN a TEXT;')).toThrow(
    /restore block must be exactly one/,
  )
  expect(() => splitRestoreColumnBlock('ALTER TABLE t ADD COLUMN a TEXT;\n-- @neutron:restore-columns END')).toThrow(
    /restore block must be exactly one/,
  )
  // END before BEGIN is two markers, and still not a block.
  expect(() =>
    splitRestoreColumnBlock('-- @neutron:restore-columns END\n-- @neutron:restore-columns BEGIN'),
  ).toThrow(/restore block must be exactly one/)
})

test('an empty block is REFUSED rather than granting tolerance to nothing', () => {
  expect(() => splitRestoreColumnBlock(BLOCK(), '0999_x.sql')).toThrow(/empty/)
  expect(() => splitRestoreColumnBlock(BLOCK('-- only a comment'), '0999_x.sql')).toThrow(/empty/)
})

// ------------------------------------------------------- the runner's behaviour

const BASE = '0001_base.sql'
const RESTORE = '0002_restore.sql'

test('the ADD COLUMN runs when the column is missing, and the rest of the migration runs after it', () => {
  const dir = bareTree('missing', {
    [BASE]: 'CREATE TABLE t (id INTEGER);',
    [RESTORE]: `${BLOCK('ALTER TABLE t ADD COLUMN a TEXT;')}\nCREATE INDEX i_t_a ON t (a);`,
  })
  const db = new Database(':memory:')
  expect(applyMigrations(db, dir).applied).toEqual([1, 2])
  expect(columnsOf(db, 't')).toContain('a')
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'i_t_a'").get()).not.toBeNull()
  db.close()
})

test('the SAME migration applies where the column already exists — this is the whole feature', () => {
  const dir = bareTree('present', {
    [BASE]: 'CREATE TABLE t (id INTEGER);',
    [RESTORE]: `${BLOCK('ALTER TABLE t ADD COLUMN a TEXT;')}\nCREATE INDEX i_t_a ON t (a);`,
  })
  const db = new Database(':memory:')
  // The instance that never lost the column: it was added out of band before 0002.
  applyMigrations(db, dir) // 0001 + 0002
  db.close()

  const db2 = new Database(':memory:')
  db2.exec('CREATE TABLE t (id INTEGER, a TEXT)')
  db2.exec("CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at REAL NOT NULL)")
  db2.run('INSERT INTO _migrations (version, name, applied_at) VALUES (1, ?, ?)', ['base', Date.now() / 1000])
  expect(applyMigrations(db2, dir).applied).toEqual([2])
  // Tolerated, and the strict remainder of the body still landed.
  expect(columnsOf(db2, 't')).toEqual(['id', 'a'])
  expect(db2.query("SELECT name FROM sqlite_master WHERE name = 'i_t_a'").get()).not.toBeNull()
  db2.close()
})

test('tolerance is scoped to duplicate-column: any OTHER failure still rolls the migration back', () => {
  const dir = bareTree('scoped', {
    [BASE]: 'CREATE TABLE t (id INTEGER);',
    // A table this tree never creates — `no such table`, not `duplicate column name`.
    [RESTORE]: `${BLOCK('ALTER TABLE absent_table ADD COLUMN a TEXT;')}\nCREATE INDEX i_t_id ON t (id);`,
  })
  const db = new Database(':memory:')
  expect(() => applyMigrations(db, dir)).toThrow(/no such table/)
  // Rolled back whole: the ledger does not claim 0002, and its index is absent.
  const applied = (db.query('SELECT version FROM _migrations ORDER BY version').all() as Array<{
    version: number
  }>).map((r) => r.version)
  expect(applied).toEqual([1])
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'i_t_id'").get()).toBeNull()
  db.close()
})

test('a duplicate column OUTSIDE the block is still fatal', () => {
  // The control that proves the tolerance is bought by the marker and not by the
  // error text: same error, no block, still a refusal.
  const dir = bareTree('unmarked', {
    [BASE]: 'CREATE TABLE t (id INTEGER, a TEXT);',
    [RESTORE]: 'ALTER TABLE t ADD COLUMN a TEXT;',
  })
  const db = new Database(':memory:')
  expect(() => applyMigrations(db, dir)).toThrow(/duplicate column name/)
  db.close()
})

// ------------------------------------------------------- the real tree's block

test('0138 still carries the restore block, naming all three columns 0131 deletes', () => {
  // A POSITIVE CONTROL on the shipped file. The eight tests that fail without this
  // block live in ordinal-identity.test.ts and would go green again if someone
  // "simplified" the file back — this one names what must be there and why.
  const sql = readFileSync(
    join(import.meta.dir, '..', '0138_code_trident_runs_review_not_run.sql'),
    'utf8',
  )
  const { restore } = splitRestoreColumnBlock(sql, '0138')
  expect(restore).toEqual([
    'ALTER TABLE code_trident_runs ADD COLUMN brief_alert TEXT',
    'ALTER TABLE code_trident_runs ADD COLUMN parent_run_id TEXT',
    'ALTER TABLE code_trident_runs ADD COLUMN wave_task_id TEXT',
  ])
})
