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
 * mechanism that produced it in the first place. The one thing written by hand is
 * the ledger's SHAPE (`asPreviousReleaseWroteIt`), because the point of that state
 * is that a PREVIOUS RELEASE wrote it, and the current runner cannot produce it.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../runner.ts'

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

/** The live instance's prior state: the branch's ledger, in the old release's shape. */
function liveInstanceBefore(options: { provenance: boolean }): Database {
  const db = new Database(join(tmp, 'live.db'), { create: true })
  applyMigrations(db, branchTree())
  asPreviousReleaseWroteIt(db, options)
  return db
}

// ------------------------------------------------------- 1. the live instance

test('CASE 1 — an ordinal spent by another migration still applies, and fixes the schema', () => {
  const db = liveInstanceBefore({ provenance: false })

  // THE PRECONDITION, MEASURED RATHER THAN ASSUMED. Ordinal 125 is recorded under
  // another name, and the two columns 0125 adds are absent — which is why no
  // repairs.json entry could ever have fixed this: a repair reconciles names, and
  // no amount of name reconciliation creates a column.
  expect(ledger(db).find((r) => r.version === 125)?.name).toBe(
    'code_trident_runs_fix_round_contract',
  )
  const before = columnsOf(db, 'code_trident_runs')
  expect(before).not.toContain('base_sha')
  expect(before).not.toContain('base_behind')
  expect(before).toContain('reviewed_head') // positive control: the table IS readable

  const result = applyMigrations(db)

  // The migration numbered 0125 in this tree ran, at last.
  expect(result.applied).toContain(125)
  const after = columnsOf(db, 'code_trident_runs')
  expect(after).toContain('base_sha')
  expect(after).toContain('base_behind')
  // Everything else that the instance had never seen ran too, in one pass.
  expect(result.applied).toContain(127)
  expect(result.applied).toContain(130)
  // And nothing it HAD seen ran again — including the two migrations whose recorded
  // ordinal differs from their number in this tree.
  expect(result.applied).not.toContain(124)
  expect(result.applied).not.toContain(126)
  expect(result.skipped).toContain(124)
  expect(result.skipped).toContain(126)

  // Ordinal 125 now legitimately carries TWO rows: the migration the branch put
  // there, and the one this tree numbers 0125. That is the truth about a fleet where
  // two different migrations were both written as 0125, and it is only expressible
  // because the ledger is keyed on the name.
  const at125 = ledger(db)
    .filter((r) => r.version === 125)
    .map((r) => r.name)
  expect(at125).toEqual(['code_trident_runs_base_sha', 'code_trident_runs_fix_round_contract'])
  // No row was renamed, renumbered or removed. The branch migration's row survives
  // as the incident record.
  expect(ledger(db).find((r) => r.name === 'dispatch_dependencies_and_claims')?.version).toBe(124)

  // Idempotent: a second boot is a no-op, which is what makes the deploy safe to
  // repeat and proves the applied migrations were actually recorded.
  expect(applyMigrations(db).applied).toEqual([])
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
  expect(result.applied).toContain(125)
  expect(columnsOf(db, 'code_trident_runs')).toContain('base_sha')
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
