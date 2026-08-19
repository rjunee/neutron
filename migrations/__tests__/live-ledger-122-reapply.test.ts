import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../runner.ts'
import { encodeIndex } from './git-index-fixture.ts'

const MIGRATIONS_DIR = join(import.meta.dir, '..')
const MIGRATION_FILE = /^\d{4}_.+\.sql$/
const STAND_IN_FILE = '0133_work_board_items_pr.sql'
const STAND_IN_SQL = `-- Stand-in for #269's migration; classification is by name, so byte parity is not required.
ALTER TABLE work_board_items ADD COLUMN pr INTEGER;
ALTER TABLE work_board_items ADD COLUMN pr_url TEXT;
`
const REAPPLY_KEY = {
  version: 122,
  recorded_name: 'work_board_items_pr',
  file_name: 'work_board_items_pr',
} as const
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

interface Repair {
  version: number
  recorded_name: string
  file_name: string
  reapply?: true
  note: string
  date: string
}

interface LedgerRow {
  version: number
  name: string
  applied_at: number
  content_sha256: string | null
  applied_by_commit: string | null
  tree_provenance: string | null
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'live-ledger-122-reapply-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function realRepairs(): Repair[] {
  return JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'repairs.json'), 'utf8')) as Repair[]
}

function copyTree(name: string, repairs: Repair[], standIn = false): string {
  const dir = join(tmp, name)
  mkdirSync(dir)
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    if (MIGRATION_FILE.test(file)) copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file))
  }
  writeFileSync(join(dir, 'repairs.json'), `${JSON.stringify(repairs, null, 2)}\n`)
  if (standIn) writeStandIn(dir)
  return dir
}

function writeStandIn(dir: string): void {
  writeFileSync(join(dir, STAND_IN_FILE), STAND_IN_SQL)
}

/**
 * A full real-tree install, then the measured live scar: 0122's schema remains,
 * its ledger identity becomes work_board_items_pr, and all provenance is absent.
 * Because real 0130 rebuilds work_board_items from an explicit column list, this
 * replica correctly has neither pr nor pr_url after the full tree has landed.
 */
function seedLiveReplica(name: string): Database {
  const db = new Database(join(tmp, `${name}.db`), { create: true })
  applyMigrations(db, copyTree(`${name}-seed`, realRepairs()))
  db.run(
    `UPDATE _migrations
        SET name = 'work_board_items_pr',
            content_sha256 = NULL,
            applied_by_commit = NULL,
            tree_provenance = NULL
      WHERE name = 'trident_checkpoint_head'`,
  )
  expect(columnCount(db, 'pr')).toBe(0)
  expect(columnCount(db, 'pr_url')).toBe(0)
  return db
}

function columnCount(db: Database, name: string): number {
  return (
    db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM pragma_table_info('work_board_items') WHERE name = ?",
      )
      .get(name)?.count ?? 0
  )
}

function scarRow(db: Database): LedgerRow {
  const row = db
    .query<LedgerRow, []>("SELECT * FROM _migrations WHERE name = 'work_board_items_pr'")
    .get()
  if (row === null) throw new Error('fixture did not create the row-122 scar')
  return row
}

function tableExists(db: Database, name: string): boolean {
  return (
    db
      .query<{ ok: number }, [string]>(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== null
  )
}

function reapplyAcknowledgements(db: Database): number {
  if (!tableExists(db, '_migration_repairs')) return 0
  return (
    db
      .query<
        { count: number },
        [number, string, string]
      >(
        `SELECT COUNT(*) AS count
           FROM _migration_repairs
          WHERE version = ? AND recorded_name = ? AND file_name = ?`,
      )
      .get(REAPPLY_KEY.version, REAPPLY_KEY.recorded_name, REAPPLY_KEY.file_name)?.count ?? 0
  )
}

function untrackedTree(name: string): string {
  const root = join(tmp, name)
  const dir = join(root, 'migrations')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'neutron' }))
  mkdirSync(join(root, '.git'))
  writeFileSync(join(root, '.git', 'HEAD'), `${HEAD_SHA}\n`)

  const tracked: string[] = []
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    if (!MIGRATION_FILE.test(file)) continue
    copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file))
    tracked.push(`migrations/${file}`)
  }
  writeFileSync(join(dir, 'repairs.json'), `${JSON.stringify(realRepairs(), null, 2)}\n`)
  writeStandIn(dir)
  writeFileSync(
    join(root, '.git', 'index'),
    encodeIndex([{ path: 'package.json' }, ...tracked.map((path) => ({ path }))]),
  )
  return dir
}

test('RED control: without reapply the recorded name silently skips 0133', () => {
  const db = seedLiveReplica('red-control')
  const repairs = realRepairs().filter((repair) => repair.reapply !== true)
  const result = applyMigrations(db, copyTree('red-control-full', repairs, true))

  expect(result.applied).not.toContain(133)
  expect(result.skipped).toContain(133)
  expect(columnCount(db, 'pr')).toBe(0)
  expect(columnCount(db, 'pr_url')).toBe(0)
  db.close()
})

test('reapply lands the missing columns, preserves row 122, and is idempotent', () => {
  const db = seedLiveReplica('green')
  const before = scarRow(db)
  const dir = copyTree('green-full', realRepairs(), true)

  const first = applyMigrations(db, dir)

  expect(first.applied).toContain(133)
  expect(columnCount(db, 'pr')).toBe(1)
  expect(columnCount(db, 'pr_url')).toBe(1)
  expect(scarRow(db)).toEqual(before)
  expect(reapplyAcknowledgements(db)).toBe(1)

  const second = applyMigrations(db, dir)
  expect(second.applied).toEqual([])
  expect(columnCount(db, 'pr')).toBe(1)
  expect(columnCount(db, 'pr_url')).toBe(1)
  expect(scarRow(db)).toEqual(before)
  expect(reapplyAcknowledgements(db)).toBe(1)
  db.close()
})

test('the deployed repair does not acknowledge before the future file arrives', () => {
  const db = seedLiveReplica('deploy-window')
  const dir = copyTree('deploy-window-full', realRepairs())

  expect(applyMigrations(db, dir).applied).toEqual([])
  expect(reapplyAcknowledgements(db)).toBe(0)

  writeStandIn(dir)
  expect(applyMigrations(db, dir).applied).toEqual([133])
  expect(columnCount(db, 'pr')).toBe(1)
  expect(columnCount(db, 'pr_url')).toBe(1)
  expect(reapplyAcknowledgements(db)).toBe(1)
  db.close()
})

test('the entry is inert on a fresh install and 0133 applies ordinarily once', () => {
  const db = new Database(':memory:')
  const dir = copyTree('fresh', realRepairs(), true)

  const first = applyMigrations(db, dir)
  expect(first.applied).toContain(133)
  expect(
    db
      .query<{ version: number }, []>(
        "SELECT version FROM _migrations WHERE name = 'work_board_items_pr'",
      )
      .get(),
  ).toEqual({ version: 133 })
  expect(reapplyAcknowledgements(db)).toBe(0)
  expect(columnCount(db, 'pr')).toBe(1)
  expect(columnCount(db, 'pr_url')).toBe(1)

  expect(applyMigrations(db, dir).applied).toEqual([])
  expect(columnCount(db, 'pr')).toBe(1)
  db.close()
})

test('reapply is strict and does not probe or swallow duplicate-column failures', () => {
  const db = seedLiveReplica('strict')
  db.exec('ALTER TABLE work_board_items ADD COLUMN pr INTEGER')
  db.exec('ALTER TABLE work_board_items ADD COLUMN pr_url TEXT')
  const before = scarRow(db)

  expect(() => applyMigrations(db, copyTree('strict-full', realRepairs(), true))).toThrow(
    /duplicate column name: pr/i,
  )
  expect(scarRow(db)).toEqual(before)
  expect(reapplyAcknowledgements(db)).toBe(0)
  expect(columnCount(db, 'pr')).toBe(1)
  expect(columnCount(db, 'pr_url')).toBe(1)
  db.close()
})

test('an active reapply never executes an untracked migration file', () => {
  const db = seedLiveReplica('untracked')
  const before = scarRow(db)

  expect(() => applyMigrations(db, untrackedTree('untracked-checkout'))).toThrow(
    /0133_work_board_items_pr\.sql[\s\S]*NOT part of the deployed tree/,
  )
  expect(columnCount(db, 'pr')).toBe(0)
  expect(columnCount(db, 'pr_url')).toBe(0)
  expect(scarRow(db)).toEqual(before)
  expect(reapplyAcknowledgements(db)).toBe(0)
  db.close()
})

test('the live row-122 reapply entry is pinned', () => {
  expect(realRepairs()).toContainEqual(expect.objectContaining({
    version: 122,
    recorded_name: 'work_board_items_pr',
    file_name: 'work_board_items_pr',
    reapply: true,
  }))
})
