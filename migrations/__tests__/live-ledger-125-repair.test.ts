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

/**
 * WHAT THIS TEST USED TO ASSERT, AND WHY IT NOW ASSERTS THE OPPOSITE.
 *
 * It used to require that removing the ordinal-125 entry from `repairs.json` made the
 * boot REFUSE — the acknowledgment was a PRECONDITION for coming up, and a missing one
 * was an outage whose only remedy was an operator verifying the live schema by hand at
 * the moment the instance was down. That refusal came from comparing the ledger's
 * recorded NAME at ordinal 125 against the file that happens to sit at 125 in this
 * build, and that comparison is gone: the ordinal is a filename prefix, not an
 * identity, so the runner asks whether THIS MIGRATION has run rather than whether its
 * NUMBER has. See `runner.ts`, `migrationIsRecorded`.
 *
 * So with no entry, `code_trident_runs_base_sha` is simply not recorded, and it
 * applies. The boot succeeds and the schema is correct by a second, independent route
 * — which is strictly better than refusing, and it is why the inversion is the point
 * rather than a regression.
 *
 * THE ENTRY IS NOT NOW POINTLESS, and this test still earns its place. It remains the
 * record of what happened to that instance, `_migration_repairs` still audits it, and
 * it still SKIPS an `ALTER` that `0131` would rebuild anyway. What changed is its
 * status: an optimisation and an incident record, not the thing standing between the
 * owner and a booting instance.
 *
 * The fail-closed half is untouched, and `ordinal-identity.test.ts` CASE 4 pins it: a
 * recorded migration NO file in this build corresponds to still refuses.
 */
test('without the 125 entry the run no longer needs one — it applies 0125 and boots', () => {
  const db = seedLiveReplica('negative')
  const fullDir = copyTree(
    'negative-full',
    () => true,
    realRepairs().filter((repair) => repair.version !== 125),
  )
  const beforeName = db
    .query<{ name: string }, []>('SELECT name FROM _migrations WHERE version = 125')
    .get()
  // Control on the fixture: the columns really are absent before the run, so their
  // presence afterwards is this run's doing.
  expect(columnNames(db, 'code_trident_runs')).not.toContain('base_sha')

  const result = applyMigrations(db, fullDir)

  // It applied the migration itself, instead of demanding to be told about it.
  expect(result.applied).toEqual([125, 127, 130, 131])
  expect(columnNames(db, 'code_trident_runs')).toContain('base_sha')
  expect(columnNames(db, 'code_trident_runs')).toContain('base_behind')
  // The incident row is untouched — never renamed, never renumbered, never deleted.
  expect(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM _migrations WHERE version = 125 AND name = 'code_trident_runs_fix_round_contract'",
      )
      .get(),
  ).toEqual(beforeName)
  // Ordinal 125 now carries both migrations that were ever written as 0125, which is
  // only expressible because the ledger is keyed on the name.
  expect(
    db
      .query<{ name: string }, []>('SELECT name FROM _migrations WHERE version = 125 ORDER BY name')
      .all()
      .map((r) => r.name),
  ).toEqual(['code_trident_runs_base_sha', 'code_trident_runs_fix_round_contract'])
  // NOTHING WAS ACKNOWLEDGED FOR 125, because nothing needed to be — while the 122 and
  // 124 entries this fixture's ledger does still match were acknowledged as before.
  // Asserting the table is absent would be wrong and would prove too much: those two
  // rows are genuinely acknowledged here, and the claim worth pinning is the narrow one.
  expect(
    db
      .query<{ version: number }, []>('SELECT version FROM _migration_repairs ORDER BY version')
      .all()
      .map((r) => r.version),
  ).toEqual([122, 124])
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
