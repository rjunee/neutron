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

const MIGRATIONS_DIR = join(import.meta.dir, '..')
const MIGRATION_FILE = /^(\d{4})_.+\.sql$/

interface Repair {
  version: number
  recorded_name: string
  file_name: string
  note: string
  date: string
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'live-ledger-125-repair-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function realRepairs(): Repair[] {
  return JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'repairs.json'), 'utf8')) as Repair[]
}

function copyTree(
  name: string,
  include: (version: number) => boolean,
  repairs?: Repair[],
): string {
  const dir = join(tmp, name)
  mkdirSync(dir)
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    const match = file.match(MIGRATION_FILE)
    if (match && include(Number.parseInt(match[1] ?? '', 10))) {
      copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file))
    }
  }
  if (repairs) writeFileSync(join(dir, 'repairs.json'), `${JSON.stringify(repairs, null, 2)}\n`)
  return dir
}

function seedLiveReplica(name: string): Database {
  const db = new Database(join(tmp, `${name}.db`), { create: true })
  const seedDir = copyTree(`${name}-seed`, (version) => version <= 126 && version !== 125)
  applyMigrations(db, seedDir)

  db.run("UPDATE _migrations SET name = 'work_board_items_pr' WHERE version = 122")
  db.run("UPDATE _migrations SET name = 'dispatch_dependencies_and_claims' WHERE version = 124")
  db.run(
    "INSERT INTO _migrations (version, name, applied_at) VALUES (125, 'code_trident_runs_fix_round_contract', ?)",
    [Math.floor(Date.now() / 1000)],
  )

  db.run('ALTER TABLE code_trident_runs ADD COLUMN claimed_paths TEXT')
  db.run('ALTER TABLE work_board_items ADD COLUMN pr INTEGER')
  db.run('ALTER TABLE work_board_items ADD COLUMN pr_url TEXT')
  db.run('ALTER TABLE work_board_items ADD COLUMN blockers TEXT')
  return db
}

function columnNames(db: Database, table: string): string[] {
  return (db.query(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>)
    .map((row) => row.name)
}

test('the live 0125 incident boots, applies 127/130/131, and leaves row 125 untouched', () => {
  const db = seedLiveReplica('positive')
  const before = db
    .query<{ version: number; name: string }, []>(
      'SELECT version, name FROM _migrations WHERE version IN (122, 124, 125) ORDER BY version',
    )
    .all()
  const fullDir = copyTree('positive-full', () => true, realRepairs())

  const result = applyMigrations(db, fullDir)

  expect(result.applied).toEqual([127, 130, 131])
  expect(result.skipped).toContain(125)
  const columns = columnNames(db, 'code_trident_runs')
  expect(columns).toContain('base_sha')
  expect(columns).toContain('base_behind')
  expect(columns).toContain('agent_waked_at')
  expect(columns).not.toContain('claimed_paths')
  expect(
    db
      .query<{ version: number; name: string }, []>(
        'SELECT version, name FROM _migrations WHERE version IN (122, 124, 125) ORDER BY version',
      )
      .all(),
  ).toEqual(before)
  expect(db.query<{ name: string }, []>('SELECT name FROM _migrations WHERE version = 125').get())
    .toEqual({ name: 'code_trident_runs_fix_round_contract' })
  expect(
    db
      .query<
        { version: number; recorded_name: string; file_name: string },
        []
      >(
        'SELECT version, recorded_name, file_name FROM _migration_repairs WHERE version = 125',
      )
      .get(),
  ).toEqual({
    version: 125,
    recorded_name: 'code_trident_runs_fix_round_contract',
    file_name: 'code_trident_runs_base_sha',
  })
  db.close()
})

test('without the 125 entry the run refuses and writes nothing', () => {
  const db = seedLiveReplica('negative')
  const fullDir = copyTree(
    'negative-full',
    () => true,
    realRepairs().filter((repair) => repair.version !== 125),
  )
  const beforeName = db
    .query<{ name: string }, []>('SELECT name FROM _migrations WHERE version = 125')
    .get()

  expect(() => applyMigrations(db, fullDir)).toThrow(
    /version 125[\s\S]*code_trident_runs_base_sha/,
  )

  expect(columnNames(db, 'code_trident_runs')).not.toContain('base_sha')
  expect(db.query<{ name: string }, []>('SELECT name FROM _migrations WHERE version = 125').get())
    .toEqual(beforeName)
  expect(
    db.query<{ version: number }, []>(
      'SELECT version FROM _migrations WHERE version IN (127, 130, 131)',
    ).all(),
  ).toEqual([])
  db.close()
})

test('the live 0125 incident acknowledgment is pinned', () => {
  expect(realRepairs()).toContainEqual(expect.objectContaining({
    version: 125,
    recorded_name: 'code_trident_runs_fix_round_contract',
    file_name: 'code_trident_runs_base_sha',
  }))
})

test('a fresh install gets base_sha exactly once', () => {
  const db = new Database(':memory:')
  const result = applyMigrations(db)

  expect(result.applied).toContain(125)
  expect(result.applied).toContain(131)
  expect(
    db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM pragma_table_info('code_trident_runs') WHERE name = 'base_sha'",
      )
      .get(),
  ).toEqual({ count: 1 })
  db.close()
})
