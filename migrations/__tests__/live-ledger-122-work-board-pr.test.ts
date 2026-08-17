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
  tmp = mkdtempSync(join(tmpdir(), 'live-ledger-122-work-board-pr-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function realRepairs(): Repair[] {
  return JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'repairs.json'), 'utf8')) as Repair[]
}

function copyTree(name: string, include: (version: number) => boolean): string {
  const dir = join(tmp, name)
  mkdirSync(dir)
  for (const file of readdirSync(MIGRATIONS_DIR)) {
    const match = file.match(MIGRATION_FILE)
    if (match && include(Number.parseInt(match[1] ?? '', 10))) {
      copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file))
    }
  }
  writeFileSync(join(dir, 'repairs.json'), `${JSON.stringify(realRepairs(), null, 2)}\n`)
  return dir
}

test('the live v122 work_board_items_pr row skips renumbered 0133 by name', () => {
  const db = new Database(join(tmp, 'live-replica.db'), { create: true })
  const withoutBranchMigration = copyTree('without-0133', (version) => version !== 133)
  applyMigrations(db, withoutBranchMigration)

  // Model the 2026-08-14 incident exactly: the schema landed by hand and the
  // pre-provenance ledger recorded this migration under the already-spent v122.
  db.run('ALTER TABLE work_board_items ADD COLUMN pr INTEGER')
  db.run('ALTER TABLE work_board_items ADD COLUMN pr_url TEXT')
  db.run(
    `INSERT INTO _migrations
       (version, name, applied_at, content_sha256, applied_by_commit, tree_provenance)
     VALUES (122, 'work_board_items_pr', ?, NULL, NULL, NULL)`,
    [Math.floor(Date.now() / 1000)],
  )

  const fullDir = copyTree('with-0133', () => true)
  let result: ReturnType<typeof applyMigrations> | undefined
  // The red condition is `duplicate column name: pr`: an ordinal-keyed runner, or
  // changing the migration slug, would try to apply 0133 and throw here.
  expect(() => {
    result = applyMigrations(db, fullDir)
  }).not.toThrow()

  expect(result).toBeDefined()
  expect(result!.applied).toEqual([])
  expect(result!.skipped).toContain(133)
  expect(
    db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('work_board_items')")
      .all()
      .map((row) => row.name),
  ).toEqual(expect.arrayContaining(['pr', 'pr_url']))
  expect(
    db
      .query<{ version: number }, []>(
        "SELECT version FROM _migrations WHERE name = 'work_board_items_pr'",
      )
      .all(),
  ).toEqual([{ version: 122 }])

  db.close()
})
