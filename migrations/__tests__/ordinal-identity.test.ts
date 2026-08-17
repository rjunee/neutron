/**
 * AN ORDINAL IS NOT AN IDENTITY — the four states the runner has to get right,
 * each as a real SQLite database driven by the real runner over the real migration
 * tree in this directory.
 *
 * WHY THIS FILE USES THE REAL TREE rather than synthetic `0001_alpha.sql` fixtures
 * (which `ordinal-collision-guard.test.ts` keeps, for the mechanics in isolation):
 * the failure being fixed is not a shape, it is a specific history. A live instance
 * ran a build whose branch numbered `code_trident_runs_fix_round_contract` as 0125;
 * that migration later merged as 0124, and 0125 went to a different migration,
 * `code_trident_runs_base_sha`. So on that database ordinal 125 is spent, the
 * migration numbered 0125 in this tree has never run, and its two columns are
 * genuinely absent. A fixture cannot show that the fix produces the right SCHEMA at
 * the end, because the schema is what was wrong.
 *
 * NO LEDGER ROW IS HAND-WRITTEN. The prior state is produced by running the real
 * runner over a copy of this tree renumbered the way the branch had it — the same
 * mechanism that produced it in the first place. Two things are not the current
 * runner, because the current runner cannot produce them and the point of both
 * states is that a PREVIOUS RELEASE did: the ledger's SHAPE
 * (`asPreviousReleaseWroteIt`), and `versionKeyedRunner`, which is the shipped
 * runner's own algorithm from before this change — dedup on the ORDINAL. Its rows
 * are still not hand-written: every value comes from a real migration file, and it
 * really executes each file's SQL, so the schema it leaves behind is genuine.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, loadMigrations, splitPragmaPreamble } from '../runner.ts'
import { migrationContentHash } from '../provenance.ts'
import { encodeIndex } from './git-index-fixture.ts'

const REAL_TREE = join(import.meta.dir, '..')

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ordinal-identity-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** `[version, name]` for every ledger row, oldest ordinal first. */
function ledger(db: Database): Array<{ version: number; name: string }> {
  return db
    .query<{ version: number; name: string }, []>(
      'SELECT version, name FROM _migrations ORDER BY version, name',
    )
    .all()
}

/** A table's stored DDL text, exactly as `sqlite_master` holds it. */
function ddlOf(db: Database, table: string): string {
  return (
    db
      .query<{ sql: string }, [string]>('SELECT sql FROM sqlite_master WHERE name = ?')
      .get(table)?.sql ?? '(no such table)'
  )
}

/**
 * The `_migrations` DDL a FRESH install writes — the text a rekeyed instance has to
 * reproduce exactly.
 *
 * Built by the real runner over a one-file tree, because the ledger's shape does not
 * depend on the migration tree at all: `ledgerDdl` plus the provenance `ALTER`s is the
 * whole of it, which also makes the reference cheap enough to take inline.
 */
function freshLedgerDdl(): string {
  const dir = mkdtempSync(join(tmp, 'ddl-reference-'))
  writeFileSync(join(dir, '0001_reference.sql'), 'CREATE TABLE IF NOT EXISTS ref (id TEXT);\n')
  const fresh = new Database(':memory:')
  applyMigrations(fresh, dir)
  const ddl = ddlOf(fresh, '_migrations')
  fresh.close()
  return ddl
}

function columnsOf(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, [string]>('SELECT name FROM pragma_table_info(?)')
    .all(table)
    .map((r) => r.name)
}

/**
 * A copy of the real tree, renumbered the way the branch the live instance ran had
 * it: `fix_round_contract` at 0125 instead of 0124, an unmerged migration occupying
 * 0124, and no `base_sha` / `agent_waked_at` / `archived_status` at all.
 *
 * The stand-in for the unmerged 0124 creates its own table, so it cannot collide
 * with anything in the real tree. Its identity — that it is NOT a migration this
 * build contains — is the whole point of it.
 */
function branchTree(): string {
  const dir = join(tmp, 'branch-migrations')
  mkdirSync(dir, { recursive: true })
  for (const file of readdirSync(REAL_TREE)) {
    if (!/^\d{4}_.+\.sql$/.test(file) && file !== 'repairs.json') continue
    cpSync(join(REAL_TREE, file), join(dir, file))
  }
  // Never existed on the branch.
  for (const file of [
    '0125_code_trident_runs_base_sha.sql',
    '0127_code_trident_runs_agent_waked_at.sql',
    '0130_work_board_items_archived_status.sql',
    ...REBUILD_FILES,
  ]) {
    rmSync(join(dir, file))
  }
  // The ordinal shift: what merged as 0124 was 0125 on the branch.
  renameSync(
    join(dir, '0124_code_trident_runs_fix_round_contract.sql'),
    join(dir, '0125_code_trident_runs_fix_round_contract.sql'),
  )
  writeFileSync(
    join(dir, '0124_dispatch_dependencies_and_claims.sql'),
    'CREATE TABLE IF NOT EXISTS branch_only_dispatch_claims (id TEXT PRIMARY KEY);\n',
  )
  return dir
}

/**
 * Put the ledger back into the shape the SHIPPED release writes: keyed on
 * `version`, and (when `provenance` is false) without the columns that record what
 * applied each row.
 *
 * This is the state every existing instance is actually in, and the current runner
 * cannot produce it, so it is built here. `version`-keyed is the shape that made the
 * outage unrecoverable: with `version` as the primary key there is no value the
 * runner could write for a migration whose ordinal another migration already spent.
 */
function asPreviousReleaseWroteIt(db: Database, options: { provenance: boolean }): void {
  const provenance = options.provenance
    ? ',\n     content_sha256 TEXT,\n     applied_by_commit TEXT,\n     tree_provenance TEXT'
    : ''
  const columns = options.provenance
    ? 'version, name, applied_at, content_sha256, applied_by_commit, tree_provenance'
    : 'version, name, applied_at'
  db.exec('ALTER TABLE _migrations RENAME TO _migrations_old')
  db.exec(`CREATE TABLE _migrations (
     version INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     applied_at REAL NOT NULL${provenance}
   )`)
  db.exec(`INSERT INTO _migrations (${columns}) SELECT ${columns} FROM _migrations_old`)
  db.exec('DROP TABLE _migrations_old')
}

/**
 * A copy of the real tree standing in for an EARLIER RELEASE: `0127` removed (so it
 * is left PENDING for the runner under test), and the given files renumbered.
 *
 * `REBUILD_FILES` come out too, and not for convenience. Each REBUILDS
 * `code_trident_runs`, and each `INSERT ... SELECT` names `agent_waked_at` — the column
 * `0127` adds. A tree that holds `0127` back and keeps one of them is not a release that
 * ever existed; it is a tree that cannot apply, and it fails with `no such column:
 * agent_waked_at` from inside the fixture rather than from the code under test. Holding
 * back the tail of a dependent chain means holding back the whole tail.
 */
function treeWithoutPendingFile(renames: Array<[string, string]> = []): string {
  const dir = mkdtempSync(join(tmp, 'release-'))
  for (const file of readdirSync(REAL_TREE)) {
    if (!/^\d{4}_.+\.sql$/.test(file)) continue
    cpSync(join(REAL_TREE, file), join(dir, file))
  }
  rmSync(join(dir, PENDING_FILE))
  for (const file of REBUILD_FILES) rmSync(join(dir, file))
  for (const [from, to] of renames) renameSync(join(dir, from), join(dir, to))
  return dir
}

/** The migration held back so the boot under test always has something to apply. */
const PENDING_FILE = '0127_code_trident_runs_agent_waked_at.sql'
const PENDING_NAME = 'code_trident_runs_agent_waked_at'

/**
 * The ordinal-125 repair migration (#391), which rebuilds `code_trident_runs` so
 * `base_sha`/`base_behind` exist whether or not `0125` was applied. Every fixture
 * here is a tree from BEFORE it existed, so every fixture drops it — and the runner
 * under test then applies it, which is exactly the interaction worth pinning.
 */
const REPAIR_FILE = '0131_code_trident_runs_base_sha_repair.sql'
const REPAIR_NAME = 'code_trident_runs_base_sha_repair'

/**
 * EVERY migration that REBUILDS `code_trident_runs` — and therefore every migration
 * that no fixture tree here may contain.
 *
 * SQLite cannot ALTER a CHECK constraint, so widening one means create-copy-drop-rename,
 * and the copy names each column ONE BY ONE. That makes a rebuild depend on the whole
 * column chain before it: hold ANY earlier column-adding migration back and the rebuild
 * dies inside the fixture with `no such column`, from the tree-builder rather than from
 * the code under test. Every fixture in this file holds something back on purpose, so
 * every fixture drops all of these.
 *
 * `0138` cost 9 tests when it landed on the branch: it names `base_sha` / `base_behind`
 * (from `0125`, absent in `branchTree`) and `agent_waked_at` (from `0127`, held back by
 * `treeWithoutPendingFile`). `rebuildFilesInRealTree` below fails loudly the next time
 * this list goes stale, instead of leaving the next author the same `no such column`.
 */
const REBUILD_FILES = [REPAIR_FILE, '0138_code_trident_runs_review_not_run.sql']

/**
 * The second rebuild, and the one that has to survive a LATE `0131`. Held back by
 * every fixture with the rest of `REBUILD_FILES`, so the runner under test applies it
 * after the repair has just dropped three of the columns it names — see its restore
 * block, and `restore-columns-tolerance.test.ts`.
 */
const REVIEW_NOT_RUN_NAME = 'code_trident_runs_review_not_run'

/** The marker that identifies a rebuild, measured from the tree rather than assumed. */
function rebuildFilesInRealTree(): string[] {
  return readdirSync(REAL_TREE)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .filter((file) => readFileSync(join(REAL_TREE, file), 'utf8').includes('code_trident_runs_new'))
    .sort()
}

/**
 * The name whose duplicate the collapse has to resolve, and its two ordinals.
 *
 * The branch ordinal is deliberately ABOVE every ordinal the real tree uses, so this
 * fixture cannot collide with a real file — it collided with `0131` the moment the
 * repair migration landed, which turned a name-collapse test into an ordinal-collision
 * failure that said nothing about the collapse.
 */
const RENUMBERED_NAME = 'work_board_items_archived_status'
const RENUMBERED_FILE = '0130_work_board_items_archived_status.sql'
const BRANCH_ORDINAL = 141
const MERGED_ORDINAL = 130

/**
 * THE SHIPPED RUNNER, AS IT BEHAVED BEFORE THIS CHANGE: dedup on the ORDINAL.
 *
 * This is what wrote every ledger in the field, and it is the only thing that can
 * produce the state CASE 5 is about. Feed it two trees in sequence, the second having
 * renumbered an already-applied file to an unspent ordinal, and it re-applies that
 * file (legal — migrations are idempotent, see AGENTS.md) and records a SECOND row for
 * it. One name, two ordinals, nothing corrupt and nothing missing.
 *
 * `appliedAt` is passed rather than read from the clock so the two releases are
 * ordered by more than a millisecond of luck — a real fleet's releases are days
 * apart, and the collapse's tie-break must not be what the assertions rest on.
 */
function versionKeyedRunner(
  db: Database,
  dir: string,
  options: {
    provenance: boolean
    appliedAt: number
    /**
     * What the release recorded for `applied_by_commit` / `tree_provenance`.
     *
     * `null` is a REAL SHAPE, not a convenience: a tarball or container install has no
     * git metadata, so the runner records the hash and leaves both of these NULL (see
     * `NO_BUILD_IDENTITY` and `migration-provenance.test.ts`). CASE 5c needs it,
     * because a row with a hash and no commit is what makes an independent
     * column-by-column collapse observable.
     */
    commit?: string | null
  },
): void {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
     version INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     applied_at REAL NOT NULL
   )`)
  if (options.provenance) {
    const present = new Set(columnsOf(db, '_migrations'))
    for (const column of ['content_sha256', 'applied_by_commit', 'tree_provenance']) {
      if (!present.has(column)) db.exec(`ALTER TABLE _migrations ADD COLUMN ${column} TEXT`)
    }
  }
  const recorded = new Set(
    db.query<{ version: number }, []>('SELECT version FROM _migrations').all().map((r) => r.version),
  )
  for (const migration of loadMigrations(dir)) {
    if (recorded.has(migration.version)) continue
    const { preamble, body } = splitPragmaPreamble(migration.sql)
    if (preamble.trim().length > 0) db.exec(preamble)
    db.exec('BEGIN')
    db.exec(body)
    if (options.provenance) {
      db.run(
        `INSERT INTO _migrations
           (version, name, applied_at, content_sha256, applied_by_commit, tree_provenance)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          migration.version,
          migration.name,
          options.appliedAt,
          migrationContentHash(migration.sql),
          options.commit === undefined ? 'c'.repeat(40) : options.commit,
          options.commit === null ? null : 'tracked-in-deployed-tree',
        ],
      )
    } else {
      db.run('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        options.appliedAt,
      ])
    }
    db.exec('COMMIT')
    db.exec('PRAGMA foreign_keys = ON')
  }
}

/**
 * An instance carrying ONE migration name at TWO ordinals, written entirely by the
 * old version-keyed runner across two releases, with `0127` still pending.
 *
 * Release 1 predates provenance and numbered the file 0131. Release 2 ships
 * provenance and carries the file at its merged number, 0130 — an ordinal release 1
 * never spent, so the ordinal-keyed dedup re-applies and re-records it. The EARLIEST
 * row is therefore the one with NO provenance, which is exactly the case where a
 * "first row wins, drop the rest" collapse would discard the only hash the instance
 * has.
 */
function instanceWithOneNameAtTwoOrdinals(): Database {
  const db = new Database(join(tmp, 'renumbered.db'), { create: true })
  versionKeyedRunner(db, treeWithoutPendingFile([[RENUMBERED_FILE, `0${BRANCH_ORDINAL}_${RENUMBERED_NAME}.sql`]]), {
    provenance: false,
    appliedAt: 1_700_000_000,
  })
  versionKeyedRunner(db, treeWithoutPendingFile(), {
    provenance: true,
    appliedAt: 1_760_000_000,
  })
  return db
}

/** The live instance's prior state: the branch's ledger, in the old release's shape. */
function liveInstanceBefore(options: { provenance: boolean }): Database {
  const db = new Database(join(tmp, 'live.db'), { create: true })
  applyMigrations(db, branchTree())
  asPreviousReleaseWroteIt(db, options)
  return db
}

// ------------------------------------------------- 0. the fixtures are buildable

test('every table rebuild in the real tree is held back by the fixtures', () => {
  // Positive control: the marker really does find something, so a rename that broke the
  // detector could never read as "no rebuilds exist, list is trivially complete".
  const found = rebuildFilesInRealTree()
  expect(found.length).toBeGreaterThan(0)
  expect(found).toEqual([...REBUILD_FILES].sort())

  // And the fixtures really removed them, rather than the list merely being right.
  for (const dir of [branchTree(), treeWithoutPendingFile()]) {
    const present = readdirSync(dir)
    for (const file of REBUILD_FILES) expect(present).not.toContain(file)
  }
})

// ------------------------------------------------------- 1. the live instance

test('CASE 1 — an ordinal spent by another migration still boots, and the schema converges', () => {
  const db = liveInstanceBefore({ provenance: false })

  // THE PRECONDITION, MEASURED RATHER THAN ASSUMED. Ordinal 125 is recorded under
  // another name, and the two columns 0125 adds are absent.
  expect(ledger(db).find((r) => r.version === 125)?.name).toBe(
    'code_trident_runs_fix_round_contract',
  )
  const before = columnsOf(db, 'code_trident_runs')
  expect(before).not.toContain('base_sha')
  expect(before).not.toContain('base_behind')
  expect(before).toContain('reviewed_head') // positive control: the table IS readable

  const result = applyMigrations(db)

  // THE COLUMNS EXIST, WHICH IS THE ONLY THING THE OWNER CARES ABOUT — and note WHICH
  // migration puts them there now. The shipped `repairs.json` acknowledges ordinal 125
  // and names `code_trident_runs_base_sha` as already-applied, so identity
  // reconciliation honours that and SKIPS 0125; `0131`, the repair migration, rebuilds
  // the table and converges the schema on every path. Both fixes are on `main` and
  // this is the assertion that they compose rather than fight.
  const after = columnsOf(db, 'code_trident_runs')
  expect(after).toContain('base_sha')
  expect(after).toContain('base_behind')
  expect(result.skipped).toContain(125)
  expect(result.applied).not.toContain(125)
  expect(result.applied).toContain(131)
  // Everything else that the instance had never seen ran too, in one pass.
  expect(result.applied).toContain(127)
  expect(result.applied).toContain(130)
  // And nothing it HAD seen ran again — including the two migrations whose recorded
  // ordinal differs from their number in this tree.
  expect(result.applied).not.toContain(124)
  expect(result.applied).not.toContain(126)
  expect(result.skipped).toContain(124)
  expect(result.skipped).toContain(126)

  // No row was renamed, renumbered or removed. The branch migration's row survives
  // as the incident record, at the ordinal it was written under.
  expect(ledger(db).find((r) => r.name === 'dispatch_dependencies_and_claims')?.version).toBe(124)
  expect(ledger(db).find((r) => r.version === 125)?.name).toBe(
    'code_trident_runs_fix_round_contract',
  )

  // Idempotent: a second boot is a no-op, which is what makes the deploy safe to
  // repeat and proves the applied migrations were actually recorded.
  expect(applyMigrations(db).applied).toEqual([])
  db.close()
})

test('CASE 1c — WITHOUT the shipped 125 acknowledgment the boot still succeeds', () => {
  // THE POINT OF THIS WHOLE CHANGE, stated as a test. Before it, an ordinal recorded
  // under another name refused the boot, and the ONLY way out was a hand-written
  // `repairs.json` entry — one per incident, each needing an operator to verify the
  // live schema by hand at the moment the instance is down. Reconciling by identity
  // removes the refusal: the migration is simply not recorded, so it applies.
  //
  // The acknowledgment therefore stops being a PRECONDITION for booting and becomes an
  // optimisation — it skips an `ALTER` whose columns `0131` would rebuild anyway. That
  // is the difference between the two fixes on `main`, and it is worth a test rather
  // than a paragraph.
  const db = liveInstanceBefore({ provenance: false })
  const tree = join(tmp, 'no-125-entry')
  mkdirSync(tree, { recursive: true })
  for (const file of readdirSync(REAL_TREE)) {
    if (!/^\d{4}_.+\.sql$/.test(file)) continue
    cpSync(join(REAL_TREE, file), join(tree, file))
  }
  const withoutThe125Entry = (
    JSON.parse(readFileSync(join(REAL_TREE, 'repairs.json'), 'utf8')) as Array<{ version: number }>
  ).filter((repair) => repair.version !== 125)
  // Control on the fixture: the entry really was there to remove.
  expect(withoutThe125Entry).toHaveLength(
    (JSON.parse(readFileSync(join(REAL_TREE, 'repairs.json'), 'utf8')) as unknown[]).length - 1,
  )
  writeFileSync(join(tree, 'repairs.json'), JSON.stringify(withoutThe125Entry, null, 2))

  const result = applyMigrations(db, tree)

  // It applied 0125 itself this time, and the schema is the same either way.
  expect(result.applied).toContain(125)
  expect(columnsOf(db, 'code_trident_runs')).toContain('base_sha')
  expect(columnsOf(db, 'code_trident_runs')).toContain('base_behind')
  // Ordinal 125 now carries TWO rows: what the branch put there, and what this tree
  // numbers 0125. That is the truth about a fleet where two different migrations were
  // both written as 0125, and it is only expressible because the key is the name.
  expect(
    ledger(db)
      .filter((r) => r.version === 125)
      .map((r) => r.name)
      .sort(),
  ).toEqual(['code_trident_runs_base_sha', 'code_trident_runs_fix_round_contract'])
  expect(applyMigrations(db, tree).applied).toEqual([])
  db.close()
})

test('CASE 1b — the same instance with provenance recorded boots on the shipped repair', () => {
  // The variant where the branch build recorded content hashes. Ordinal 124's row
  // then names a migration this build does not contain AND can be adjudicated, so
  // the fail-closed guard has something to say about it — and the entry already in
  // migrations/repairs.json is what answers. This is the check that the shipped
  // repairs file still does its job after the semantics changed underneath it.
  const db = liveInstanceBefore({ provenance: true })
  expect(
    db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM _migrations WHERE content_sha256 IS NOT NULL AND name = 'dispatch_dependencies_and_claims'",
      )
      .get()?.n,
  ).toBe(1)

  const result = applyMigrations(db)
  // Same convergence as CASE 1, and by the same route: the shipped `repairs.json`
  // entry marks ordinal 125's migration already-applied, so it is SKIPPED, and `0131`
  // rebuilds the table so the columns exist either way.
  expect(result.skipped).toContain(125)
  expect(result.applied).toContain(131)
  expect(columnsOf(db, 'code_trident_runs')).toContain('base_sha')
  expect(columnsOf(db, 'code_trident_runs')).toContain('base_behind')
  // The acknowledgement was audited rather than applied silently.
  expect(
    db
      .query<{ recorded_name: string }, []>(
        'SELECT recorded_name FROM _migration_repairs ORDER BY version',
      )
      .all()
      .map((r) => r.recorded_name),
  ).toContain('dispatch_dependencies_and_claims')
  db.close()
})

// ---------------------------------------------------- 2. a healthy instance

test('CASE 2 — an instance where 0125 DID apply boots and does not re-apply it', () => {
  // The other side of the trade the obvious fix gets wrong. Renumbering 0125 would
  // fix the instance above and break this one: it would see an ordinal recorded with
  // no matching file plus a pending copy re-ALTERing a column that already exists.
  const db = new Database(join(tmp, 'healthy.db'), { create: true })
  const first = applyMigrations(db)
  expect(first.applied).toContain(125)
  asPreviousReleaseWroteIt(db, { provenance: true })
  expect(ledger(db).find((r) => r.version === 125)?.name).toBe('code_trident_runs_base_sha')

  const second = applyMigrations(db)
  expect(second.applied).toEqual([])
  expect(second.skipped).toEqual(first.applied)
  // Still exactly one row at 125, and the columns are untouched.
  expect(ledger(db).filter((r) => r.version === 125)).toHaveLength(1)
  expect(columnsOf(db, 'code_trident_runs')).toContain('base_sha')
  // Nothing pending means nothing written: the ledger was not even rekeyed.
  expect(
    db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = '_migrations'").get()
      ?.sql,
  ).toContain('version INTEGER PRIMARY KEY')
  db.close()
})

test('CASE 2b — a healthy instance with a PENDING migration is rekeyed, losing no rows', () => {
  // The rekey has to happen for real on some boot, and this is it: an instance in
  // the old shape that has something to apply. Every row must survive, with its
  // ordinal and its provenance intact.
  const db = new Database(join(tmp, 'rekey.db'), { create: true })
  applyMigrations(db, branchTree())
  asPreviousReleaseWroteIt(db, { provenance: true })
  const before = ledger(db)
  const hashesBefore = db
    .query<{ name: string; content_sha256: string | null }, []>(
      'SELECT name, content_sha256 FROM _migrations ORDER BY name',
    )
    .all()

  applyMigrations(db)

  expect(
    db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = '_migrations'").get()
      ?.sql,
  ).toContain('name TEXT NOT NULL PRIMARY KEY')
  // BYTE-IDENTICAL TO A FRESH INSTALL'S, not merely equivalent — which is the claim
  // `rekeyLedgerOnName` makes for renaming the old table out of the way BEFORE creating
  // the new one (`ALTER TABLE ... RENAME TO` rewrites `sqlite_master` with the table
  // name quoted). Asserted rather than argued, because the schema snapshot only ever
  // sees the FRESH path: a later create-then-rename refactor would drift every rekeyed
  // instance in the fleet with CI green, and `toContain` on one clause cannot see that.
  expect(ddlOf(db, '_migrations')).toBe(freshLedgerDdl())
  // Every pre-existing row is still there, unchanged, ordinal included.
  for (const row of before) expect(ledger(db)).toContainEqual(row)
  for (const row of hashesBefore) {
    expect(
      db
        .query<{ content_sha256: string | null }, [string]>(
          'SELECT content_sha256 FROM _migrations WHERE name = ?',
        )
        .get(row.name),
    ).toEqual({ content_sha256: row.content_sha256 })
  }
  // The scratch table the rekey uses does not leak.
  expect(
    db.query("SELECT 1 FROM sqlite_master WHERE name LIKE '_migrations_%'").get(),
  ).toBeNull()
  db.close()
})

// -------------------------------------------------------- 3. a fresh install

test('CASE 3 — a fresh install applies the whole tree in order and boots', () => {
  const db = new Database(join(tmp, 'fresh.db'), { create: true })
  const result = applyMigrations(db)

  expect(result.skipped).toEqual([])
  expect(result.applied.length).toBeGreaterThan(100)
  // In ascending ordinal order, which is the one thing the ordinal IS for.
  expect([...result.applied].sort((a, b) => a - b)).toEqual(result.applied)
  expect(columnsOf(db, 'code_trident_runs')).toContain('base_sha')
  // repairs.json is inert here. Its entries describe rows this database does not
  // have, so nothing was acknowledged and nothing was suppressed — which is what
  // must be true, or a fresh install would silently skip migration 0122.
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = '_migration_repairs'").get()).toBeNull()
  expect(ledger(db).find((r) => r.name === 'trident_checkpoint_head')?.version).toBe(122)
  expect(applyMigrations(db).applied).toEqual([])
  db.close()
})

// ------------------------------------------------------- 4. genuine corruption

test('CASE 4 — a recorded migration this build cannot explain still FAILS CLOSED', () => {
  // The property that separates this change from a catastrophe. Reconciling by
  // identity means applying MORE than before, so a runner that simply booted
  // everything would pass cases 1-3 and silently accept a database carrying schema
  // changes no build describes. That is how the rows behind this whole incident
  // class came to exist.
  //
  // Built by the real mechanism: a migration that is not in this tree is applied
  // from a scratch directory, exactly as an unmerged branch migration would be.
  const ghostTree = join(tmp, 'ghost')
  mkdirSync(ghostTree, { recursive: true })
  writeFileSync(
    join(ghostTree, '0500_ghost_from_an_unmerged_branch.sql'),
    'CREATE TABLE IF NOT EXISTS ghost (id TEXT PRIMARY KEY);\n',
  )
  const db = new Database(join(tmp, 'corrupt.db'), { create: true })
  applyMigrations(db, ghostTree)
  expect(
    db
      .query<{ content_sha256: string | null }, []>('SELECT content_sha256 FROM _migrations')
      .get()?.content_sha256,
  ).toMatch(/^[0-9a-f]{64}$/)

  let message = ''
  try {
    applyMigrations(db)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }

  expect(message).toContain('NO migration file in this build corresponds to')
  expect(message).toContain('ghost_from_an_unmerged_branch')
  // NOTHING was written on the way out — the claim the message makes about itself.
  expect(ledger(db)).toEqual([{ version: 500, name: 'ghost_from_an_unmerged_branch' }])
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'sessions'").get()).toBeNull()
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = '_migration_repairs'").get()).toBeNull()
  db.close()
})

test('CASE 4b — the refusal is resolvable, and only by a hand-written acknowledgement', () => {
  // Fail-closed has to mean "refuses until an operator decides", not "refuses
  // forever": a guard with no remedy is an outage. The remedy is the entry the
  // message prints, and nothing else — an entry for a different row does not
  // launder this one.
  const ghostTree = join(tmp, 'ghost2')
  mkdirSync(ghostTree, { recursive: true })
  writeFileSync(join(ghostTree, '0501_ghost_two.sql'), 'CREATE TABLE IF NOT EXISTS ghost2 (id TEXT);\n')
  const db = new Database(join(tmp, 'corrupt2.db'), { create: true })
  applyMigrations(db, ghostTree)

  // A copy of the real tree, so an acknowledgement can be added without touching
  // the checked-in repairs.json.
  const acknowledged = join(tmp, 'acknowledged')
  mkdirSync(acknowledged, { recursive: true })
  for (const file of readdirSync(REAL_TREE)) {
    if (!/^\d{4}_.+\.sql$/.test(file)) continue
    cpSync(join(REAL_TREE, file), join(acknowledged, file))
  }

  // The wrong entry does not help.
  writeFileSync(
    join(acknowledged, 'repairs.json'),
    JSON.stringify([
      { version: 501, recorded_name: 'ghost_three', file_name: '', note: 'wrong row', date: '2026-08-17' },
    ]),
  )
  expect(() => applyMigrations(db, acknowledged)).toThrow(/NO migration file in this build/)

  // The right one does, and the row is neither renamed nor removed by it.
  writeFileSync(
    join(acknowledged, 'repairs.json'),
    JSON.stringify([
      {
        version: 501,
        recorded_name: 'ghost_two',
        file_name: '',
        note: 'hand-verified: the branch table is unused and stays',
        date: '2026-08-17',
      },
    ]),
  )
  expect(applyMigrations(db, acknowledged).applied).toContain(125)
  expect(ledger(db).find((r) => r.name === 'ghost_two')?.version).toBe(501)
  db.close()
})

// ------------------------- 5. a legitimate ledger the rekey must not choke on

test('CASE 5 — one migration name at TWO ordinals is collapsed, and the instance BOOTS', () => {
  // THE DEFECT CLASS THIS FILE EXISTS TO FIX, ONE LEVEL OVER. Keying the ledger on
  // the name is right, but the rekey that gets it there has to accept every ledger
  // the ORDINAL-keyed runner could legally write — and that runner could write one
  // name twice, because migrations are idempotent and it deduplicated on the number.
  // A rekey that refuses this bricks the boot of an instance that was healthy, which
  // is strictly worse than the bug being fixed.
  const db = instanceWithOneNameAtTwoOrdinals()

  // THE PRECONDITION, MEASURED. Two rows, one name, two ordinals — and the earlier
  // of the two is the one with no provenance.
  const before = db
    .query<{ version: number; content_sha256: string | null; applied_at: number }, [string]>(
      'SELECT version, content_sha256, applied_at FROM _migrations WHERE name = ? ORDER BY applied_at',
    )
    .all(RENUMBERED_NAME)
  expect(before.map((r) => r.version)).toEqual([BRANCH_ORDINAL, MERGED_ORDINAL])
  expect(before[0]?.content_sha256).toBeNull()
  expect(before[1]?.content_sha256).toMatch(/^[0-9a-f]{64}$/)
  const recordedHash = before[1]?.content_sha256
  // Nothing corrupt about it: every name in the ledger is a migration this tree has.
  const namesBefore = new Set(ledger(db).map((r) => r.name))
  expect(namesBefore.has(PENDING_NAME)).toBe(false) // the one pending migration
  expect(columnsOf(db, 'code_trident_runs')).not.toContain('agent_waked_at')

  const result = applyMigrations(db)

  // IT BOOTED, and the pending migration actually ran.
  // Every migration this fixture's release predates — `0127`, the `0131` repair, and
  // `0138`, which is the one that has to SURVIVE the repair: 0131 runs late here, and
  // its rebuild drops the columns 0136/0137 added, which 0138 then names.
  expect(result.applied).toEqual([127, 131, 138])
  expect(columnsOf(db, 'code_trident_runs')).toContain('agent_waked_at')
  // THE DEFECT THIS FIXTURE NOW PINS. A late 0131 deletes these three columns and the
  // wave-child UNIQUE index and still reports success; 0138's restore block puts the
  // columns back before its rebuild, and the rebuild re-issues the index. Without the
  // restore this whole case dies at `no such column: brief_alert`.
  const restored = columnsOf(db, 'code_trident_runs')
  expect(restored).toContain('brief_alert')
  expect(restored).toContain('parent_run_id')
  expect(restored).toContain('wave_task_id')
  expect(
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_code_trident_runs_wave_child'",
      )
      .get()?.name,
  ).toBe('idx_code_trident_runs_wave_child')
  expect(
    db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = '_migrations'").get()
      ?.sql,
  ).toContain('name TEXT NOT NULL PRIMARY KEY')

  // EXACTLY ONE ROW for the duplicated name, and it is the EARLIEST application —
  // when the schema change actually landed here — not the later re-record.
  const after = db
    .query<
      {
        version: number
        applied_at: number
        content_sha256: string | null
        applied_by_commit: string | null
        tree_provenance: string | null
      },
      [string]
    >(
      `SELECT version, applied_at, content_sha256, applied_by_commit, tree_provenance
       FROM _migrations WHERE name = ?`,
    )
    .all(RENUMBERED_NAME)
  expect(after).toHaveLength(1)
  expect(after[0]?.version).toBe(BRANCH_ORDINAL)
  expect(after[0]?.applied_at).toBe(before[0]?.applied_at)
  // AND ITS PROVENANCE SURVIVED. The row that won identity had none; the row that
  // lost had a real hash and commit. Collapsing to a NULL would have destroyed the
  // only forensic record this instance has of that migration.
  expect(after[0]?.content_sha256).toBe(recordedHash as string)
  expect(after[0]?.applied_by_commit).toBe('c'.repeat(40))
  expect(after[0]?.tree_provenance).toBe('tracked-in-deployed-tree')

  // No other row was collapsed, dropped or duplicated by the pass.
  const namesAfter = ledger(db).map((r) => r.name)
  expect(new Set(namesAfter)).toEqual(
    new Set([...namesBefore, PENDING_NAME, REPAIR_NAME, REVIEW_NOT_RUN_NAME]),
  )
  expect(namesAfter).toHaveLength(new Set(namesAfter).size)
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name LIKE '_migrations_%'").get()).toBeNull()

  // Idempotent: the collapsed ledger is a fixed point.
  expect(applyMigrations(db).applied).toEqual([])
  db.close()
})

test('CASE 5c — the collapse adopts provenance from ONE row, never a column at a time', () => {
  // WHAT CASE 5 ABOVE CANNOT SEE. There, the surviving row has NO provenance at all, so
  // filling the three columns independently and adopting the donor's triple whole
  // produce the same answer — the test passes either way and says nothing about which
  // rule is implemented.
  //
  // This is the shape that separates them. Release 1 was a TARBALL install: the runner
  // records the content hash and leaves `applied_by_commit` NULL, because there is no
  // git metadata to read (`migration-provenance.test.ts` pins that behaviour). Release 2
  // was a git checkout and recorded both. So the EARLIEST row — the one that wins
  // identity — has a hash and no commit, while the row that loses has a commit.
  //
  // Filling each column from whichever row happens to have it therefore emits release
  // 1's hash beside release 2's commit: a tuple NEITHER ROW EVER HAD, asserting that
  // those bytes were applied by a build that did not apply them. These three columns
  // exist so a later investigation can trust them, and a fabricated row is worse than a
  // NULL — it cannot be told apart from a true one.
  const db = new Database(join(tmp, 'donor.db'), { create: true })
  versionKeyedRunner(
    db,
    treeWithoutPendingFile([[RENUMBERED_FILE, `0${BRANCH_ORDINAL}_${RENUMBERED_NAME}.sql`]]),
    { provenance: true, appliedAt: 1_700_000_000, commit: null },
  )
  versionKeyedRunner(db, treeWithoutPendingFile(), {
    provenance: true,
    appliedAt: 1_760_000_000,
    commit: 'd'.repeat(40),
  })

  // THE PRECONDITION, MEASURED: two rows, one name; the earlier has a hash and no
  // commit, the later has both.
  const before = db
    .query<
      { version: number; content_sha256: string | null; applied_by_commit: string | null },
      [string]
    >(
      'SELECT version, content_sha256, applied_by_commit FROM _migrations WHERE name = ? ORDER BY applied_at',
    )
    .all(RENUMBERED_NAME)
  expect(before).toHaveLength(2)
  expect(before[0]?.version).toBe(BRANCH_ORDINAL)
  expect(before[0]?.content_sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(before[0]?.applied_by_commit).toBeNull()
  expect(before[1]?.applied_by_commit).toBe('d'.repeat(40))

  expect(applyMigrations(db).applied).toEqual([127, 131, 138])

  const after = db
    .query<
      {
        version: number
        content_sha256: string | null
        applied_by_commit: string | null
        tree_provenance: string | null
      },
      [string]
    >(
      'SELECT version, content_sha256, applied_by_commit, tree_provenance FROM _migrations WHERE name = ?',
    )
    .all(RENUMBERED_NAME)
  expect(after).toHaveLength(1)
  expect(after[0]?.version).toBe(BRANCH_ORDINAL)
  // Its own hash was kept, so nothing forensic was lost.
  expect(after[0]?.content_sha256).toBe(before[0]?.content_sha256 as string)
  // THE DISCRIMINATING ASSERTIONS. The winner recorded its own provenance, so NOTHING is
  // adopted — the commit stays NULL rather than borrowing release 2's, and
  // `tree_provenance` stays NULL with it. Independent per-column filling makes both of
  // these fail, and only these.
  expect(after[0]?.applied_by_commit).toBeNull()
  expect(after[0]?.tree_provenance).toBeNull()
  db.close()
})

// ------------------- 6. what the rekey's own failure message may claim

test('CASE 6 — when the rekey fails, the ledger really is unchanged as the message says', () => {
  // The message is an instruction to an operator at 3am, so it has to be true. It
  // used to be false: the provenance `ALTER TABLE`s ran BEFORE the rekey's
  // transaction, so they auto-committed, and a failed rekey left a ledger carrying
  // three new columns while telling the operator the database was untouched.
  //
  // THIS TEST CAN FAIL FOR THE REASON UNDER TEST, which is the only kind worth
  // having: the discriminating assertion is that the provenance columns are still
  // ABSENT afterwards. With the ALTERs back outside the transaction it goes red,
  // whatever else stays green.
  const db = new Database(join(tmp, 'rekey-fails.db'), { create: true })
  versionKeyedRunner(db, treeWithoutPendingFile(), {
    provenance: false,
    appliedAt: 1_700_000_000,
  })
  // The failure, and a realistic one: an operator inspected the ledger and left a
  // view behind on the name the rekey needs for its scratch table, so the rename
  // cannot take that name and the rekey dies on its first statement.
  //
  // A VIEW IS THE HARMLESS HALF OF THIS SHAPE, and saying so is the point of the
  // comment: SQLite will not let a table be renamed onto it, so the collision is
  // reported rather than resolved, whatever the runner intends. The dangerous half is a
  // real TABLE at that name, which the runner used to DROP — CASE 6b covers it, because
  // this test structurally cannot.
  db.exec('CREATE VIEW _migrations_version_keyed AS SELECT version, name FROM _migrations')

  const ddlBefore = db
    .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = '_migrations'")
    .get()?.sql
  const rowsBefore = ledger(db)
  expect(ddlBefore).toContain('version INTEGER PRIMARY KEY')
  expect(columnsOf(db, '_migrations')).not.toContain('content_sha256')

  let message = ''
  try {
    applyMigrations(db)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }

  // What the message claims.
  expect(message).toContain('could not be rekeyed')
  expect(message).toContain('ledger is unchanged')
  // Positive control on the diagnosis: it quotes what SQLite actually said, and names
  // the object, so the operator learns it was the leftover and not a mystery.
  expect(message).toContain('there is already another table or index with this name')
  expect(message).toContain('_migrations_version_keyed')

  // ...and the claim, verified. Same shape, same columns, same rows.
  expect(
    db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = '_migrations'").get()
      ?.sql,
  ).toBe(ddlBefore as string)
  // THE DISCRIMINATING ONE — the provenance ALTERs rolled back with everything else.
  expect(columnsOf(db, '_migrations')).not.toContain('content_sha256')
  expect(columnsOf(db, '_migrations')).not.toContain('applied_by_commit')
  expect(columnsOf(db, '_migrations')).not.toContain('tree_provenance')
  expect(ledger(db)).toEqual(rowsBefore)
  // Nothing was applied either, so the pending migration's column is still absent.
  expect(columnsOf(db, 'code_trident_runs')).not.toContain('agent_waked_at')

  // And the remedy the message points at actually works: drop the view, boot.
  db.exec('DROP VIEW _migrations_version_keyed')
  expect(applyMigrations(db).applied).toEqual([127, 131, 138])
  expect(columnsOf(db, 'code_trident_runs')).toContain('agent_waked_at')
  db.close()
})

test('CASE 6b — a real TABLE at the rekey scratch name is REFUSED, never dropped', () => {
  // THE CASE THE VIEW ABOVE CANNOT REACH, and the reason it matters more. The rekey
  // used to open with `DROP TABLE IF EXISTS _migrations_version_keyed` — a
  // data-destroying statement guarded by nothing, inside the transaction that goes on
  // to COMMIT. A view made that line THROW (SQLite refuses to DROP TABLE a view), which
  // is why every existing test passed while the table case, the only one where data
  // exists to lose, silently deleted it on a boot whose contract is that it loses no
  // row.
  const db = new Database(join(tmp, 'rekey-scratch-occupied.db'), { create: true })
  versionKeyedRunner(db, treeWithoutPendingFile(), {
    provenance: false,
    appliedAt: 1_700_000_000,
  })
  // Somebody else's table on that name, with a row in it that exists nowhere else.
  db.exec('CREATE TABLE _migrations_version_keyed (payload TEXT NOT NULL)')
  db.run('INSERT INTO _migrations_version_keyed (payload) VALUES (?)', ['irreplaceable'])

  const rowsBefore = ledger(db)
  let message = ''
  try {
    applyMigrations(db)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }

  // It refused, and it explained itself in the terms the operator needs: the name is
  // occupied, this cannot be our own leftover, and it was deliberately not dropped.
  expect(message).toContain('_migrations_version_keyed')
  expect(message).toContain('needs that name free')
  expect(message).toContain('NOTHING HAS BEEN APPLIED')
  expect(message).toContain('NOT a leftover from an interrupted rekey')
  expect(message).toContain('deliberately NOT')

  // THE DISCRIMINATING ASSERTION — the table and its row are still there. This is the
  // one that goes red if the DROP comes back, and nothing else in this file does.
  expect(
    db.query<{ payload: string }, []>('SELECT payload FROM _migrations_version_keyed').all(),
  ).toEqual([{ payload: 'irreplaceable' }])
  // And the refusal really did precede every write: the ledger is untouched, the
  // provenance columns never landed, and the pending migration never ran.
  expect(ledger(db)).toEqual(rowsBefore)
  expect(columnsOf(db, '_migrations')).not.toContain('content_sha256')
  expect(columnsOf(db, 'code_trident_runs')).not.toContain('agent_waked_at')

  // The remedy works, and note WHICH remedy: the operator moves their own table out of
  // the way. The runner never does it for them.
  db.exec('ALTER TABLE _migrations_version_keyed RENAME TO operator_kept_this')
  expect(applyMigrations(db).applied).toEqual([127, 131, 138])
  expect(columnsOf(db, 'code_trident_runs')).toContain('agent_waked_at')
  expect(
    db.query<{ payload: string }, []>('SELECT payload FROM operator_kept_this').all(),
  ).toEqual([{ payload: 'irreplaceable' }])
  db.close()
})

test('CASE 6c — a rekey that fails AFTER the provenance ALTERs also leaves the ledger unchanged', () => {
  // WHAT CASE 6 CANNOT REACH, in the other direction from 6b. CASE 6 kills the rekey on
  // its first statement, so it proves the provenance ALTERs never RAN — not that they
  // roll back. This is the case the function's docblock actually claims: execution
  // reaches the ALTERs, they succeed, and a LATER statement fails. If SQLite did not
  // roll DDL back with everything else, the ledger would come out of this carrying
  // three new columns while the message says its shape and columns are untouched, and
  // an operator who believed that sentence would not go looking for a half-changed
  // ledger.
  const db = new Database(join(tmp, 'rekey-fails-late.db'), { create: true })
  versionKeyedRunner(db, treeWithoutPendingFile(), {
    provenance: false,
    appliedAt: 1_700_000_000,
  })
  // DELIBERATE FAULT INJECTION, and the only hand-written ledger row in this file. A
  // legacy ledger whose `name` is nullable, carrying one NULL name, makes the ROW COPY
  // fail — the statement after the ALTERs — because the name-keyed table it copies into
  // declares `name TEXT NOT NULL`. This is not a claim that any instance has such a
  // row; it is the cheapest way to fail at a chosen point, and WHERE the failure landed
  // is asserted below rather than assumed.
  db.exec('ALTER TABLE _migrations RENAME TO _migrations_lax')
  db.exec(
    'CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at REAL NOT NULL)',
  )
  db.exec('INSERT INTO _migrations SELECT version, name, applied_at FROM _migrations_lax')
  db.exec('DROP TABLE _migrations_lax')
  db.run('INSERT INTO _migrations (version, name, applied_at) VALUES (9999, NULL, ?)', [
    1_700_000_000,
  ])

  const ddlBefore = ddlOf(db, '_migrations')
  const rowsBefore = db
    .query<{ version: number; name: string | null }, []>(
      'SELECT version, name FROM _migrations ORDER BY version',
    )
    .all()
  expect(columnsOf(db, '_migrations')).not.toContain('content_sha256')

  let message = ''
  try {
    applyMigrations(db)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }

  expect(message).toContain('could not be rekeyed')
  expect(message).toContain('ledger is unchanged')
  // WHERE THE FAILURE LANDED, asserted — this is what makes the test able to fail for
  // the reason under test rather than for CASE 6's reason. A NOT NULL violation on
  // `_migrations.name` can only come from the row copy, which runs after
  // `addProvenanceColumns`, so the ALTERs demonstrably executed inside the transaction
  // that then rolled back.
  expect(message).toContain('NOT NULL constraint failed: _migrations.name')

  // ...and the claim, verified: same DDL text, no provenance columns, same rows.
  expect(ddlOf(db, '_migrations')).toBe(ddlBefore)
  for (const column of ['content_sha256', 'applied_by_commit', 'tree_provenance']) {
    expect(columnsOf(db, '_migrations')).not.toContain(column)
  }
  expect(
    db
      .query<{ version: number; name: string | null }, []>(
        'SELECT version, name FROM _migrations ORDER BY version',
      )
      .all(),
  ).toEqual(rowsBefore)
  expect(
    db.query("SELECT 1 FROM sqlite_master WHERE name = '_migrations_version_keyed'").get(),
  ).toBeNull()
  // Nothing was applied either.
  expect(columnsOf(db, 'code_trident_runs')).not.toContain('agent_waked_at')
  db.close()
})

test('CASE 6d — the occupied-scratch refusal writes NOTHING, including the repair it used to acknowledge first', () => {
  // WHAT THIS PINS IS A SENTENCE, and the sentence was false in the shipped code. The
  // refusal for an occupied scratch name claimed nothing had been written, while being
  // thrown from `rekeyLedgerOnName` — which `applyMigrations` reached only AFTER creating
  // `_migration_repairs` and inserting this boot's acknowledgements. So on exactly the
  // instance the message is written for, one carrying repairs mid-incident, it denied a
  // row sitting in the database as the operator read it.
  //
  // THE FIRST FIX SOFTENED THE WORDING TO NAME THAT ROW. This one removes the row: the
  // guard is evaluated in the read-only preflight with the other five, on nothing but
  // pure reads (`ledgerExists`, `ledgerIsVersionKeyed`, `tableExists`), so the
  // unqualified claim is earned. A guard that has to disclose its own write is still a
  // guard that writes, and the whole ordering argument in `applyMigrations` rests on
  // there being no exception to it.
  //
  // THIS TEST CAN FAIL FOR THE REASON UNDER TEST: it asserts `_migration_repairs` does
  // NOT EXIST after the throw. Move the guard back inside the rekey and it goes red on
  // that line — the table appears, holding the acknowledgement.
  const ghost = (file: string): string => {
    const dir = mkdtempSync(join(tmp, 'ghost-'))
    writeFileSync(join(dir, file), 'CREATE TABLE IF NOT EXISTS ghost (id TEXT PRIMARY KEY);\n')
    return dir
  }
  const build = mkdtempSync(join(tmp, 'build-'))
  writeFileSync(join(build, '0001_beta.sql'), 'CREATE TABLE IF NOT EXISTS t2 (id INTEGER);\n')
  writeFileSync(join(build, '0002_gamma.sql'), 'CREATE TABLE IF NOT EXISTS t3 (id INTEGER);\n')
  writeFileSync(
    join(build, 'repairs.json'),
    JSON.stringify([
      {
        version: 500,
        recorded_name: 'ghost',
        file_name: 'beta',
        note: 'hand-verified: the branch table is unused, and beta already ran here',
        date: '2026-08-17',
      },
    ]),
  )

  const db = new Database(join(tmp, 'scratch-occupied-with-repairs.db'), { create: true })
  versionKeyedRunner(db, ghost('0500_ghost.sql'), {
    provenance: false,
    appliedAt: 1_700_000_000,
  })
  // Somebody else's table on the rekey's scratch name, so the rekey refuses — AFTER the
  // acknowledgement has been written.
  db.exec('CREATE TABLE _migrations_version_keyed (payload TEXT NOT NULL)')

  const ddlBefore = ddlOf(db, '_migrations')
  const rowsBefore = ledger(db)

  let message = ''
  try {
    applyMigrations(db, build)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }

  expect(message).toContain('needs that name free')
  expect(message).toContain('NOTHING HAS BEEN APPLIED and nothing has been written')
  expect(message).toContain('no repair was acknowledged')

  // THE DISCRIMINATING ASSERTION, and the only one in this file that can see the
  // difference: the acknowledgement table was never created. This is where the repair
  // write used to have landed already.
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = '_migration_repairs'").get()).toBeNull()
  // The rest of the claim, verified: the ledger's shape, columns and rows are untouched,
  // and no migration ran.
  expect(ddlOf(db, '_migrations')).toBe(ddlBefore)
  for (const column of ['content_sha256', 'applied_by_commit', 'tree_provenance']) {
    expect(columnsOf(db, '_migrations')).not.toContain(column)
  }
  expect(ledger(db)).toEqual(rowsBefore)
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 't2'").get()).toBeNull()
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 't3'").get()).toBeNull()

  // The remedy the message gives works, and the repair is still doing its job after it.
  // THE POSITIVE CONTROL for the assertion above: on the boot that is NOT refused, the
  // acknowledgement really is written — so its absence after the refusal is the guard's
  // ordering and not an entry that never activated at all.
  db.exec('ALTER TABLE _migrations_version_keyed RENAME TO operator_kept_this')
  expect(applyMigrations(db, build)).toEqual({ applied: [2], skipped: [1] })
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 't2'").get()).toBeNull()
  expect(
    db.query('SELECT version, recorded_name, file_name FROM _migration_repairs').all(),
  ).toEqual([{ version: 500, recorded_name: 'ghost', file_name: 'beta' }])
  db.close()
})

// --------------- 7. a tolerated collision, on the boot AFTER the upgrade worked

/**
 * The real tree inside a checkout whose `.git` index is laid out by hand, so the tree
 * verdict is `verified` and every file's tracked-ness is under the test's control.
 *
 * WHY THE OTHER FIXTURES HERE CANNOT BE USED FOR THIS. A tmp copy of the tree has no
 * git metadata above it, so `resolveDeployedTree` answers `unverifiable` and the
 * runner cannot tell a stray from a committed file at all — which is precisely the
 * distinction CASE 7 turns on. The index encoder is the one from
 * `git-index-fixture.ts` that `untracked-migration.test.ts` already uses, and the root
 * `package.json` is not decoration: it is the ownership test the resolver applies
 * before reading anything.
 */
function realTreeInCheckout(
  name: string,
  options: { files?: Record<string, string>; untracked?: readonly string[] } = {},
): string {
  const root = join(tmp, name)
  const dir = join(root, 'migrations')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'neutron' }))
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), `${'a'.repeat(40)}\n`)
  const fromRealTree = readdirSync(REAL_TREE).filter((f) => /^\d{4}_.+\.sql$/.test(f))
  for (const file of fromRealTree) cpSync(join(REAL_TREE, file), join(dir, file))
  cpSync(join(REAL_TREE, 'repairs.json'), join(dir, 'repairs.json'))
  for (const [file, contents] of Object.entries(options.files ?? {})) {
    writeFileSync(join(dir, file), contents)
  }
  const untracked = new Set(options.untracked ?? [])
  writeFileSync(
    join(root, '.git', 'index'),
    encodeIndex([
      { path: 'package.json' },
      ...[...fromRealTree, ...Object.keys(options.files ?? {})]
        .filter((f) => !untracked.has(f))
        .map((f) => ({ path: `migrations/${f}` })),
    ]),
  )
  return dir
}

/** The unmerged branch migration that landed on ordinal 122, as a file. */
const STRAY_FILE = '0122_dispatch_claims_from_an_unmerged_branch.sql'
const STRAY_NAME = 'dispatch_claims_from_an_unmerged_branch'
const STRAY_SQL = 'CREATE TABLE IF NOT EXISTS branch_only_claims (id TEXT PRIMARY KEY);\n'

test('CASE 7 — a tolerated ordinal collision still boots on the NEXT boot, with nothing pending', () => {
  // THE TWO-RUN SEQUENCE, WHICH IS THE WHOLE BUG. A recorded untracked stray sharing
  // an ordinal with a tracked file is a SUPPORTED state — the untracked refusal checks
  // pending files only, deliberately sparing a stray applied long ago — and it is the
  // live 122/124 incident class. The collision is therefore classified and stood aside
  // from, and run 1 upgrades cleanly.
  //
  // Run 2 is the one that used to die. With nothing pending the tree verdict was not
  // resolved at all, so the classifier saw `verified === null`, could not tell the
  // stray from a committed duplicate, and threw. A SUCCESSFUL upgrade then refused to
  // boot on every subsequent boot, for as long as the stray file sat on disk — an
  // idempotent runner (`AGENTS.md`) that is not idempotent, and the brick-the-boot
  // outcome this whole change exists to prevent.

  // The stray, applied from the branch checkout where it WAS tracked. That is how the
  // row came to exist on the live instance, and it is why no ledger row is hand-written
  // here either.
  const branchRoot = join(tmp, 'branch-checkout')
  const branchDir = join(branchRoot, 'migrations')
  mkdirSync(branchDir, { recursive: true })
  writeFileSync(join(branchRoot, 'package.json'), JSON.stringify({ name: 'neutron' }))
  mkdirSync(join(branchRoot, '.git'), { recursive: true })
  writeFileSync(join(branchRoot, '.git', 'HEAD'), `${'a'.repeat(40)}\n`)
  writeFileSync(join(branchDir, STRAY_FILE), STRAY_SQL)
  writeFileSync(
    join(branchRoot, '.git', 'index'),
    encodeIndex([{ path: 'package.json' }, { path: `migrations/${STRAY_FILE}` }]),
  )
  const db = new Database(join(tmp, 'tolerated.db'), { create: true })
  expect(applyMigrations(db, branchDir).applied).toEqual([122])

  // The merged checkout: the whole real tree, tracked, with the stray still on disk and
  // NOT tracked — the state a `git checkout` of the merge leaves behind.
  const dir = realTreeInCheckout('merged-checkout', {
    files: { [STRAY_FILE]: STRAY_SQL },
    untracked: [STRAY_FILE],
  })

  // THE PRECONDITION, MEASURED. Two files claim ordinal 122, the stray is recorded,
  // and the migration this build numbers 0122 is not.
  expect(
    readdirSync(dir).filter((f) => f.startsWith('0122_')).sort(),
  ).toEqual([STRAY_FILE, '0122_trident_checkpoint_head.sql'])
  expect(ledger(db)).toEqual([{ version: 122, name: STRAY_NAME }])

  const run1 = applyMigrations(db, dir)
  // It upgraded, and the tracked side of the collision ran.
  expect(run1.applied).toContain(122)
  expect(run1.applied.length).toBeGreaterThan(100)
  expect(ledger(db).filter((r) => r.version === 122).map((r) => r.name).sort()).toEqual([
    STRAY_NAME,
    'trident_checkpoint_head',
  ])

  // AND THE NEXT BOOT, with nothing left pending, does not refuse. This is the
  // discriminating assertion: before the fix it threw
  // "Migration ordinal collision at version 122".
  const boot2 = applyMigrations(db, dir)
  expect(boot2.applied).toEqual([])
  // Every file in the tree was skipped, the stray included — so ordinal 122 appears
  // TWICE, which is the collision being tolerated rather than merely not looked at.
  expect(boot2.skipped).toEqual(
    readdirSync(dir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort()
      .map((f) => Number.parseInt(f.slice(0, 4), 10)),
  )
  expect(boot2.skipped.filter((v) => v === 122)).toHaveLength(2)
  // A third boot too — the point is a fixed point, not a one-off reprieve.
  expect(applyMigrations(db, dir).applied).toEqual([])
  db.close()
})

// -------------------- 8. a repair that must not go inert after the rekey

test('CASE 8 — a repair naming the row the collapse DROPS keeps acknowledging afterwards', () => {
  // The rekey used to silently deactivate a repair. `activeRepairs` matched on the
  // ledger alone, and `collapseLedgerRowsByName` keeps the EARLIEST-applied row of a
  // duplicated name and drops the others — which sit at a different ordinal by
  // definition. So an entry naming the non-surviving row activated on the rekey boot
  // and went inert on every boot after it, because the row it was matched against no
  // longer existed. The fix is `_migration_repairs` read back as a durable second
  // trigger, NOT a looser ledger match: widening the match instead let a shipped entry
  // speak on databases it was never written about, which is CASE 8c.
  //
  // Both halves of what an active repair asserts break, independently:
  //   - the hand-verified migration stops being suppressed, so its `ALTER`s re-run;
  //   - the orphan row stops being acknowledged, so the unexplained-row guard refuses
  //     the boot. Note the asymmetry that makes this one bite: the guard selects
  //     candidates by NAME, so the SURVIVING row — same name, different ordinal — was
  //     never exempted by a (version, name) acknowledgement.
  //
  // Synthetic tree rather than the real one, because the fixture needs a name recorded
  // at two ordinals that corresponds to NO file in this build, and only an unmerged
  // branch migration is that. Same idiom as CASE 4.
  const ghost = (file: string): string => {
    const dir = mkdtempSync(join(tmp, 'ghost-'))
    writeFileSync(join(dir, file), 'CREATE TABLE IF NOT EXISTS ghost (id TEXT PRIMARY KEY);\n')
    return dir
  }
  const build = mkdtempSync(join(tmp, 'build-'))
  writeFileSync(join(build, '0001_beta.sql'), 'CREATE TABLE IF NOT EXISTS t2 (id INTEGER);\n')
  writeFileSync(join(build, '0002_gamma.sql'), 'CREATE TABLE IF NOT EXISTS t3 (id INTEGER);\n')
  // The entry names ordinal 501 — the row the collapse DROPS, because 500 was applied
  // earlier. A real operator writes whichever ordinal the refusal message printed, and
  // the message prints the row it could not explain.
  writeFileSync(
    join(build, 'repairs.json'),
    JSON.stringify([
      {
        version: 501,
        recorded_name: 'ghost',
        file_name: 'beta',
        note: 'hand-verified: the branch table is unused, and beta already ran here',
        date: '2026-08-17',
      },
    ]),
  )

  // The prior state, written by the runner that wrote every ledger in the field: one
  // branch migration renumbered between two branch builds, so the ordinal-keyed dedup
  // applied and recorded it twice. Release 1 predates provenance, so the EARLIEST row —
  // the one the collapse keeps — is the one with no hash, and it inherits release 2's.
  const db = new Database(join(tmp, 'inert-repair.db'), { create: true })
  versionKeyedRunner(db, ghost('0500_ghost.sql'), {
    provenance: false,
    appliedAt: 1_700_000_000,
  })
  versionKeyedRunner(db, ghost('0501_ghost.sql'), {
    provenance: true,
    appliedAt: 1_760_000_000,
  })
  // THE PRECONDITION, MEASURED: one name, two ordinals, and the entry names the later.
  expect(ledger(db)).toEqual([
    { version: 500, name: 'ghost' },
    { version: 501, name: 'ghost' },
  ])

  // Boot 1 — the rekey boot. The repair activates (both rows are still visible), `beta`
  // is suppressed, and the collapse drops row 501.
  expect(applyMigrations(db, build)).toEqual({ applied: [2], skipped: [1] })
  expect(ledger(db)).toEqual([
    { version: 2, name: 'gamma' },
    { version: 500, name: 'ghost' },
  ])
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 't2'").get()).toBeNull()

  // BOOT 2 — the discriminating one. Before the fix this threw
  // "NO migration file in this build corresponds to" over the surviving `ghost` row,
  // AND re-applied `beta`. Both halves are asserted.
  const boot2 = applyMigrations(db, build)
  expect(boot2.skipped).toContain(1)
  expect(boot2.applied).not.toContain(1)
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 't2'").get()).toBeNull()
  // The acknowledgement written on boot 1 is still the only row, at the ordinal the
  // entry carries — nothing rewrites it, which is what makes it a trustworthy trigger.
  expect(
    db.query('SELECT version, recorded_name, file_name FROM _migration_repairs').all(),
  ).toEqual([{ version: 501, recorded_name: 'ghost', file_name: 'beta' }])
  // And it is a fixed point.
  expect(applyMigrations(db, build).applied).toEqual([])
  db.close()
})

test('CASE 8b — a repair on a TREE-FILE name survives the collapse that makes the ledger look healthy', () => {
  // THE OTHER HALF OF CASE 8, and the one the ordinal conjunct opened. When
  // `recorded_name` IS a file in this build, the entry activates only on a row whose
  // ordinal differs from the one this build assigns — that conjunct is what keeps entry
  // 125 inert on a healthy instance, and it must stay. But a ledger written by the
  // version-keyed runner can hold that name at BOTH ordinals, and
  // `collapseLedgerRowsByName` keeps the EARLIEST-applied row. When that is the row
  // sitting at the tree ordinal, the rekey leaves a ledger indistinguishable from one
  // that never had the incident — every trace the predicate reads is gone, while the
  // instance still needs the entry. The entry then goes inert and the hand-verified
  // migration its `file_name` suppresses re-runs its statements.
  //
  // `_migration_repairs` is what remembers: it was written on the boot the entry DID
  // activate, and nothing rewrites it. THE DISCRIMINATING ASSERTION is boot 2 —
  // delete the acknowledgement widening in `applyMigrations` and `beta` re-applies here
  // and nothing else in this file notices.
  const gammaAt = (file: string): string => {
    const dir = mkdtempSync(join(tmp, 'gamma-'))
    writeFileSync(join(dir, file), 'CREATE TABLE IF NOT EXISTS t3 (id INTEGER);\n')
    return dir
  }
  const build = mkdtempSync(join(tmp, 'build-'))
  writeFileSync(join(build, '0001_beta.sql'), 'CREATE TABLE IF NOT EXISTS t2 (id INTEGER);\n')
  writeFileSync(join(build, '0002_gamma.sql'), 'CREATE TABLE IF NOT EXISTS t3 (id INTEGER);\n')
  writeFileSync(join(build, '0003_delta.sql'), 'CREATE TABLE IF NOT EXISTS t4 (id INTEGER);\n')
  // The entry names ordinal 7 — the drifted row, which is the one the refusal message
  // would have printed, and the one the collapse is about to drop.
  writeFileSync(
    join(build, 'repairs.json'),
    JSON.stringify([
      {
        version: 7,
        recorded_name: 'gamma',
        file_name: 'beta',
        note: 'hand-verified: beta already ran here, and gamma was recorded twice by two branch builds',
        date: '2026-08-17',
      },
      // THE CONTROL, and it can fail for the reason under test. This entry names a
      // tree-file `recorded_name` too, and after boot 1 the ledger records that name —
      // so a widening that had degenerated into "activate on the name" would fire it.
      // Its ordinal matches what this build assigns `delta`, so the ledger predicate is
      // false, and this database never acknowledged it, so the durable path is false
      // too. It must therefore never appear in `_migration_repairs`.
      {
        version: 99,
        recorded_name: 'delta',
        file_name: 'epsilon',
        note: 'inert here: delta sits exactly where this build numbers it',
        date: '2026-08-17',
      },
    ]),
  )

  const db = new Database(join(tmp, 'tree-file-repair.db'), { create: true })
  // Release 1 numbered gamma 0002 — the ordinal this build also assigns it — and release
  // 2 numbered it 0007. Ordinal-keyed dedup recorded it twice. The EARLIER row is the one
  // at the tree ordinal, so the collapse keeps it and drops the drifted one.
  versionKeyedRunner(db, gammaAt('0002_gamma.sql'), {
    provenance: false,
    appliedAt: 1_700_000_000,
  })
  versionKeyedRunner(db, gammaAt('0007_gamma.sql'), {
    provenance: true,
    appliedAt: 1_760_000_000,
  })
  // THE PRECONDITION, MEASURED: one name, two ordinals, one of them the tree's.
  expect(ledger(db)).toEqual([
    { version: 2, name: 'gamma' },
    { version: 7, name: 'gamma' },
  ])

  // Boot 1 — the rekey boot. Row 7 is still visible, so the entry activates: `beta` is
  // suppressed, `delta` applies, and the collapse drops row 7.
  expect(applyMigrations(db, build)).toEqual({ applied: [3], skipped: [1, 2] })
  expect(ledger(db)).toEqual([
    { version: 2, name: 'gamma' },
    { version: 3, name: 'delta' },
  ])
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 't2'").get()).toBeNull()

  // BOOT 2 — the discriminating one. The ledger now looks exactly like a healthy
  // instance's, so the ledger predicate says nothing. The acknowledgement does.
  const boot2 = applyMigrations(db, build)
  expect(boot2.skipped).toContain(1)
  expect(boot2.applied).not.toContain(1)
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 't2'").get()).toBeNull()
  // THE CONTROL, read back: the second entry never activated, so the widening is not
  // "activate on the name" — see the entry itself for why it is discriminating.
  expect(
    db.query('SELECT version, recorded_name, file_name FROM _migration_repairs').all(),
  ).toEqual([{ version: 7, recorded_name: 'gamma', file_name: 'beta' }])
  // And it is a fixed point.
  expect(applyMigrations(db, build).applied).toEqual([])
  db.close()
})

test('CASE 8c — a shipped entry does NOT speak on a database that recorded the same orphan elsewhere', () => {
  // THE FLEET, WHICH IS WHAT A `repairs.json` ENTRY IS EVALUATED BY. An entry is one
  // instance's history, shipped to every instance, so the terms it is matched on decide
  // how far it reaches. Matching an orphan `recorded_name` on the NAME ALONE — the
  // widening that carried an entry through a collapse before `_migration_repairs` did —
  // reaches too far: two databases can legitimately record one unmerged branch migration
  // at DIFFERENT ordinals, each having run its own build of that branch, and the name is
  // the same on both.
  //
  // WHAT THAT COST, reproduced against the SHIPPED entries and the real tree. The second
  // database has never run `code_trident_runs_fix_round_contract`; entry 124's `file_name`
  // names it. With a name-only match the entry activated, the migration was marked
  // applied, its three `ALTER`s never ran, no ledger row was written for it, and the boot
  // exited zero. That is this file's own silent-missing-schema class, exported to an
  // instance the incident was never about.
  //
  // THE DISCRIMINATING ASSERTIONS are the columns read back out of `pragma_table_info`
  // after the boot, with a column that IS there as the positive control. Drop
  // `row.version === repair.version` from `activeRepairs` and they go absent.
  const withEdits = (edits: {
    drop?: readonly string[]
    add?: ReadonlyArray<readonly [string, string]>
    repairs?: unknown
  }): string => {
    const dir = mkdtempSync(join(tmp, 'fleet-'))
    for (const file of readdirSync(REAL_TREE)) {
      if (!/^\d{4}_.+\.sql$/.test(file)) continue
      cpSync(join(REAL_TREE, file), join(dir, file))
    }
    for (const file of edits.drop ?? []) rmSync(join(dir, file))
    for (const [file, body] of edits.add ?? []) writeFileSync(join(dir, file), body)
    if (edits.repairs === undefined) {
      cpSync(join(REAL_TREE, 'repairs.json'), join(dir, 'repairs.json'))
    } else {
      writeFileSync(join(dir, 'repairs.json'), JSON.stringify(edits.repairs))
    }
    return dir
  }
  const FIX_ROUND_FILE = '0124_code_trident_runs_fix_round_contract.sql'
  const FIX_ROUND_NAME = 'code_trident_runs_fix_round_contract'
  const ORPHAN_NAME = 'dispatch_dependencies_and_claims'
  // Held back so the fixture is a release that predates them, exactly as the other
  // fixtures here do — `0131` rebuilds the table and would mask the missing columns.
  const TAIL = [
    '0125_code_trident_runs_base_sha.sql',
    PENDING_FILE,
    RENUMBERED_FILE,
    REPAIR_FILE,
  ]

  // THE SECOND DATABASE. Its own build of the unmerged branch took ordinal 141 — not the
  // 124 the incident instance recorded it at — and the merged 0124 had not been written
  // yet, so it is genuinely pending here.
  const db = new Database(join(tmp, 'second-instance.db'), { create: true })
  applyMigrations(
    db,
    withEdits({
      drop: [FIX_ROUND_FILE, ...TAIL],
      add: [
        [
          `0${BRANCH_ORDINAL}_${ORPHAN_NAME}.sql`,
          'CREATE TABLE IF NOT EXISTS branch_only_second (id TEXT PRIMARY KEY);\n',
        ],
      ],
      repairs: [],
    }),
  )
  // THE PRECONDITION, MEASURED: the orphan name is recorded, at its own ordinal, and the
  // migration entry 124 would suppress has never run here.
  expect(ledger(db).find((row) => row.name === ORPHAN_NAME)).toEqual({
    version: BRANCH_ORDINAL,
    name: ORPHAN_NAME,
  })
  expect(ledger(db).some((row) => row.name === FIX_ROUND_NAME)).toBe(false)

  // Boot the current build, carrying the SHIPPED repairs.json. Entry 124 names this
  // orphan at ordinal 124 and this database has it elsewhere, so the entry stays inert —
  // which leaves the row unexplained and the boot refused. That is the right failure:
  // loud, and it prints the ordinal THIS database recorded.
  let message = ''
  try {
    applyMigrations(db, withEdits({ drop: TAIL }))
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  expect(message).toContain('NO migration file in this build corresponds to')
  expect(message).toContain(`"version": ${BRANCH_ORDINAL}`)
  expect(message).toContain(`"recorded_name": "${ORPHAN_NAME}"`)

  // And the remedy is the operator's own entry, at their own ordinal, acknowledging the
  // row ALONE (`file_name` empty — nothing in this build already ran here). The migration
  // entry 124 would have suppressed now applies, which is the whole point.
  const resolved = withEdits({
    drop: TAIL,
    repairs: [
      {
        version: BRANCH_ORDINAL,
        recorded_name: ORPHAN_NAME,
        file_name: '',
        note: 'hand-verified on THIS database: the branch table is unused and nothing here already ran',
        date: '2026-08-17',
      },
    ],
  })
  expect(applyMigrations(db, resolved).applied).toContain(124)
  expect(ledger(db).some((row) => row.name === FIX_ROUND_NAME)).toBe(true)
  // THE COLUMNS, read back with a positive control. `id` is present whatever happens, so
  // an empty result would prove the query works and the columns are absent rather than
  // that the table name was a typo.
  const columns = columnsOf(db, 'code_trident_runs')
  expect(columns).toContain('id')
  expect(columns).toContain('reviewed_head')
  expect(columns).toContain('bound_pr')
  expect(columns).toContain('fenced_paths')
  db.close()
})

// ------------- 9. one recorded hash, two files in this build claiming it

test('CASE 9 — an orphan hash claimed by TWO files in this build is refused, not skipped twice', () => {
  // HASH WIDENING ASKS ABOUT THE LEDGER AND ANSWERS ABOUT A FILE, and that step is only
  // valid when the file is the unique tree-side claimant of those bytes.
  // `recorded-by-content` fires for a row no file here accounts for — the rename case —
  // and reads as "THIS file has already run". When a SECOND file here carries the same
  // bytes, the one row marks both as applied; and because the row's sole owner is absent
  // from the tree neither file is `duplicates-an-applied-file`, so the refusal built for
  // exactly this ambiguity never fired. Both were skipped, neither was recorded, and the
  // boot exited zero reporting them under `skipped` — the silent-missing-schema class,
  // reached through the widening instead of through the ordinal.
  const body = 'CREATE TABLE IF NOT EXISTS shared_bytes (id TEXT PRIMARY KEY);\n'
  const before = mkdtempSync(join(tmp, 'one-claimant-'))
  writeFileSync(join(before, '0001_original.sql'), body)
  const db = new Database(join(tmp, 'two-claimants.db'), { create: true })
  expect(applyMigrations(db, before).applied).toEqual([1])
  expect(ledger(db)).toEqual([{ version: 1, name: 'original' }])

  // The build that renamed it AND shipped a second file with the same bytes.
  const after = mkdtempSync(join(tmp, 'two-claimants-'))
  writeFileSync(join(after, '0002_renamed.sql'), body)
  writeFileSync(join(after, '0003_brand_new.sql'), body)

  let message = ''
  try {
    applyMigrations(db, after)
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  // THE DISCRIMINATING ASSERTION: it threw at all. Before this, the call returned
  // `{ applied: [], skipped: [2, 3] }` and the boot came up.
  expect(message).toContain('have the same BYTES')
  expect(message).toContain('0002_renamed.sql')
  expect(message).toContain('0003_brand_new.sql')
  // The message is honest about WHERE the recording row is: `original` is not a file in
  // this build, so it must not claim to be one.
  expect(message).toContain('recorded as "original"')
  expect(message).toContain('a name this build no longer contains')
  // Nothing was written, as the message says.
  expect(ledger(db)).toEqual([{ version: 1, name: 'original' }])

  // THE POSITIVE CONTROL, and it can fail for the reason under test: with only ONE
  // claimant the widening is exactly what it was built for and the rename boots clean.
  const single = mkdtempSync(join(tmp, 'renamed-only-'))
  writeFileSync(join(single, '0002_renamed.sql'), body)
  expect(applyMigrations(db, single)).toEqual({ applied: [], skipped: [2] })
  db.close()
})

// ---------- 10. a boot that decides nothing writes nothing, repairs included

test('CASE 10 — a fully-migrated boot carrying an ACKNOWLEDGED repair is a pure read', () => {
  // WHAT A READ-ONLY CONNECTION IS FOR: opening a backup of a live database to inspect
  // it, which is the thing an operator does most while an incident is open. The
  // acknowledged-repair write ran on EVERY boot — `INSERT OR IGNORE` made it idempotent
  // in EFFECT, not in WRITES — so the instances carrying repairs were exactly the ones
  // whose backups could not be opened, and the README's claim that a fully-migrated boot
  // is a pure read was false on them. The rows are never rewritten, so "already
  // acknowledged" and "nothing to write" are the same condition.
  const db = liveInstanceBefore({ provenance: true })
  const path = db.filename
  // Boot 1 acknowledges. Boot 2 is the steady state under test.
  applyMigrations(db)
  expect(applyMigrations(db).applied).toEqual([])
  // THE PRECONDITION, MEASURED: this database really does carry acknowledgements, so the
  // test is not passing because there was never anything to write.
  expect(
    db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM _migration_repairs').get()?.n ?? 0,
  ).toBeGreaterThan(0)
  db.close()

  const readonly = new Database(path, { readonly: true })
  // THE CONTROL FOR THE PROBE ITSELF: prove this connection genuinely refuses writes.
  // Without it a passing `applyMigrations` below would only show that the assertion ran.
  expect(() => readonly.exec('CREATE TABLE control_probe (id INTEGER)')).toThrow(/readonly/)
  // THE DISCRIMINATING ASSERTION: the same boot the live instance performs, over the real
  // tree and the shipped `repairs.json`, against a connection that cannot write.
  expect(applyMigrations(readonly).applied).toEqual([])
  readonly.close()
})
