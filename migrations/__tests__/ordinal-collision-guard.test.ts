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

test('a recorded version under a different name refuses and preserves its record', () => {
  const db = new Database(':memory:')
  const a = tree('a', { '0001_alpha.sql': 'CREATE TABLE t1 (id INTEGER);' })
  const b = tree('b', { '0001_beta.sql': 'CREATE TABLE t2 (id INTEGER);' })
  applyMigrations(db, a)

  expect(() => applyMigrations(db, b)).toThrow(/1.*alpha.*beta|1.*beta.*alpha/)
  expect(tableExists(db, 't2')).toBe(false)
  expect(db.query('SELECT version, name FROM _migrations').all()).toEqual([{ version: 1, name: 'alpha' }])
})

test('mismatch refusal applies no later migrations', () => {
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

test('an acknowledged mismatch is skipped, audited, and never rewritten', () => {
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

test('duplicate ordinals name both files and apply nothing', () => {
  const db = new Database(':memory:')
  const dir = tree('dupe', {
    '0001_a.sql': 'CREATE TABLE a (id INTEGER);',
    '0001_b.sql': 'CREATE TABLE b (id INTEGER);',
  })
  expect(() => applyMigrations(db, dir)).toThrow(/1.*0001_a\.sql.*0001_b\.sql/)
  expect(tableExists(db, 'a')).toBe(false)
  expect(tableExists(db, 'b')).toBe(false)
  expect(db.query('SELECT * FROM _migrations').all()).toEqual([])
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
