import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, applyProjectScopedMigrations } from '../runner.ts'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ordinal-collision-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function tree(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name)
  mkdirSync(dir)
  for (const [file, contents] of Object.entries(files)) writeFileSync(join(dir, file), contents)
  return dir
}

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null
}

test('a recorded migration this build does not contain refuses and preserves its record', () => {
  const db = new Database(':memory:')
  const a = tree('a', { '0001_alpha.sql': 'CREATE TABLE t1 (id INTEGER);' })
  const b = tree('b', { '0001_beta.sql': 'CREATE TABLE t2 (id INTEGER);' })
  applyMigrations(db, a)

  // Not because the two share ordinal 1 — that is irrelevant now — but because
  // `alpha` ran here and tree `b` describes it nowhere.
  expect(() => applyMigrations(db, b)).toThrow(/NO migration file in this build/)
  expect(tableExists(db, 't2')).toBe(false)
  expect(db.query('SELECT version, name FROM _migrations').all()).toEqual([{ version: 1, name: 'alpha' }])
})

test('the unexplained-row refusal applies no later migrations', () => {
  const db = new Database(':memory:')
  const a = tree('a', { '0001_alpha.sql': 'CREATE TABLE t1 (id INTEGER);' })
  const b = tree('b', {
    '0001_beta.sql': 'CREATE TABLE t2 (id INTEGER);',
    '0002_gamma.sql': 'CREATE TABLE t3 (id INTEGER);',
  })
  applyMigrations(db, a)
  expect(() => applyMigrations(db, b)).toThrow()
  expect(tableExists(db, 't2')).toBe(false)
  expect(tableExists(db, 't3')).toBe(false)
  expect(db.query('SELECT version FROM _migrations WHERE version = 2').get()).toBeNull()
})

test('same-name re-run skips without throwing', () => {
  const db = new Database(':memory:')
  const a = tree('a', { '0001_alpha.sql': 'CREATE TABLE t1 (id INTEGER);' })
  applyMigrations(db, a)
  expect(applyMigrations(db, a)).toEqual({ applied: [], skipped: [1] })
})

test('a migration recorded at ANOTHER ordinal is skipped, not re-applied', () => {
  // The renumber case, which the ordinal-keyed runner got wrong in the harmless
  // direction and then in the harmful one: `alpha` merged at 0002 after running here
  // as 0001. Re-running it would fail on the duplicate table.
  const db = new Database(':memory:')
  applyMigrations(db, tree('before', { '0001_alpha.sql': 'CREATE TABLE t1 (id INTEGER);' }))
  const after = tree('after', {
    '0002_alpha.sql': 'CREATE TABLE t1 (id INTEGER);',
    '0003_gamma.sql': 'CREATE TABLE t3 (id INTEGER);',
  })
  expect(applyMigrations(db, after)).toEqual({ applied: [3], skipped: [2] })
  // The original row keeps the ordinal it was written with. Nothing is renumbered.
  expect(db.query("SELECT version FROM _migrations WHERE name = 'alpha'").get()).toEqual({ version: 1 })
})

test('an acknowledged repair suppresses its named migration, audits, and never rewrites', () => {
  // The live ordinal-122 shape: a migration whose schema change was applied BY HAND
  // and never recorded, beside a ledger row naming something else entirely. The
  // entry's `file_name` is what stops the hand-applied migration running again.
  const db = new Database(':memory:')
  const a = tree('a', { '0001_alpha.sql': 'CREATE TABLE t1 (id INTEGER);' })
  const b = tree('b', {
    '0001_beta.sql': 'CREATE TABLE t2 (id INTEGER);',
    '0002_gamma.sql': 'CREATE TABLE t3 (id INTEGER);',
    'repairs.json': JSON.stringify([{ version: 1, recorded_name: 'alpha', file_name: 'beta', note: 'verified', date: '2026-08-16' }]),
  })
  applyMigrations(db, a)
  expect(applyMigrations(db, b)).toEqual({ applied: [2], skipped: [1] })
  expect(tableExists(db, 't2')).toBe(false)
  expect(tableExists(db, 't3')).toBe(true)
  expect(db.query('SELECT name FROM _migrations WHERE version = 1').get()).toEqual({ name: 'alpha' })
  expect(db.query('SELECT version, recorded_name, file_name, note FROM _migration_repairs').all()).toEqual([
    { version: 1, recorded_name: 'alpha', file_name: 'beta', note: 'verified' },
  ])
})

test('a repair whose row is absent stays inert — a fresh install applies everything', () => {
  // THE PROPERTY THAT MAKES `repairs.json` SAFE TO SHIP IN A PUBLIC REPOSITORY.
  // Entry 122 says `trident_checkpoint_head` is already applied on the one instance
  // where it was applied by hand; on every new database that migration must run.
  const db = new Database(':memory:')
  const dir = tree('fresh', {
    '0001_beta.sql': 'CREATE TABLE t2 (id INTEGER);',
    'repairs.json': JSON.stringify([{ version: 1, recorded_name: 'alpha', file_name: 'beta', note: 'v', date: '2026-08-16' }]),
  })
  expect(applyMigrations(db, dir)).toEqual({ applied: [1], skipped: [] })
  expect(tableExists(db, 't2')).toBe(true)
  expect(tableExists(db, '_migration_repairs')).toBe(false)
})

test('two files sharing a migration NAME refuse, naming both', () => {
  // The name is the ledger identity, so a duplicate slug makes one of the two read
  // as already-applied forever and its statements never run — the same silent
  // missing-schema failure the ordinal used to cause, one level over.
  const db = new Database(':memory:')
  const dir = tree('dupname', {
    '0001_same.sql': 'CREATE TABLE a (id INTEGER);',
    '0002_same.sql': 'CREATE TABLE b (id INTEGER);',
  })
  expect(() => applyMigrations(db, dir)).toThrow(/name collision on "same".*0001_same\.sql.*0002_same\.sql/s)
  expect(db.query('SELECT name FROM sqlite_master').all()).toEqual([])
})

test('duplicate ordinals name both files and apply nothing', () => {
  const db = new Database(':memory:')
  const dir = tree('dupe', {
    '0001_a.sql': 'CREATE TABLE a (id INTEGER);',
    '0001_b.sql': 'CREATE TABLE b (id INTEGER);',
  })
  expect(() => applyMigrations(db, dir)).toThrow(/1.*0001_a\.sql.*0001_b\.sql/)
  expect(tableExists(db, 'a')).toBe(false)
  expect(tableExists(db, 'b')).toBe(false)
  // Nothing at all was written — not even the ledger. `_migrations` is created on
  // the path that writes a row and on no other, so every refusal in this runner
  // leaves the database exactly as it found it. (Stronger than the empty-ledger
  // assertion this replaced, which a created-then-unused table also satisfied.)
  expect(db.query('SELECT name FROM sqlite_master').all()).toEqual([])
})

test('the live 0122 incident acknowledgment is pinned', () => {
  const repairs = JSON.parse(readFileSync(join(import.meta.dir, '..', 'repairs.json'), 'utf8'))
  expect(repairs).toContainEqual(expect.objectContaining({
    version: 122,
    recorded_name: 'work_board_items_pr',
    file_name: 'trident_checkpoint_head',
  }))
})

test('the real migration tree still applies cleanly', () => {
  const db = new Database(':memory:')
  expect(() => applyMigrations(db)).not.toThrow()
})

test('sidecar trees without a repairs ledger remain unaffected', () => {
  const db = new Database(':memory:')
  expect(() => applyProjectScopedMigrations(db, join(import.meta.dir, '..', 'comments'))).not.toThrow()
})
