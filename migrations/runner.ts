import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveOpenDbPath } from './db-path.ts'
import { migrationContentHash, resolveDeployedCommit } from './provenance.ts'
import { installProcessSafetyNet } from '@neutronai/logger/fire-and-forget.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

export interface Migration {
  version: number
  name: string
  sql: string
  fileName: string
}

interface MigrationRepair {
  version: number
  recorded_name: string
  file_name: string
  note: string
  date: string
}

export interface ApplyResult {
  applied: number[]
  skipped: number[]
}

/** One `_migrations` row, as the runner reads it back on the next boot. */
interface RecordedMigration {
  version: number
  name: string
  applied_at: number
  content_sha256: string | null
  applied_by_commit: string | null
}

export function loadMigrations(dir: string = HERE): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const match = f.match(/^(\d{4})_(.+)\.sql$/)
      if (!match) throw new Error(`unreachable: ${f}`)
      const version = Number.parseInt(match[1] ?? '', 10)
      const name = match[2] ?? ''
      return {
        version,
        name,
        sql: readFileSync(join(dir, f), 'utf8'),
        fileName: f,
      }
    })
}

export function migrationNameMismatch(recorded: string, file: string): boolean {
  return recorded !== file
}

function loadMigrationRepairs(dir: string): MigrationRepair[] {
  const path = join(dir, 'repairs.json')
  if (!existsSync(path)) return []
  const repairs: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(repairs)) throw new Error(`${path} must contain a JSON array`)
  return repairs as MigrationRepair[]
}

function repairKey(version: number, recordedName: string, fileName: string): string {
  return `${version}\0${recordedName}\0${fileName}`
}

/**
 * The `repairs.json` entry that would acknowledge this exact mismatch.
 *
 * READ THE FIELD NAME CAREFULLY: `file_name` holds the migration's NAME (the
 * `<slug>` half of `NNNN_<slug>.sql`), NOT the file's name on disk. That is
 * what `repairKey` compares — it is called with `migration.name`, and the
 * shipped entries in `repairs.json` carry slugs (`trident_checkpoint_head`,
 * for the file `0122_trident_checkpoint_head.sql`). "Correcting" this to the
 * real filename would silently stop every entry from ever matching, and the
 * failure would be invisible: the ledger would look repaired while the runner
 * kept refusing to boot. This builder exists so the operator never has to
 * infer the convention from the key function — and so the two cannot drift.
 */
function repairsEntryFor(
  version: number,
  recordedName: string,
  migrationName: string,
  today: string,
): Record<string, unknown> {
  return {
    version,
    recorded_name: recordedName,
    file_name: migrationName,
    note: 'REPLACE THIS — what you verified by hand, and why the live schema already matches this code.',
    date: today,
  }
}

/**
 * A blank reads as a value, so absence is spelled out — and the two REASONS a
 * field can be absent are spelled out separately, because they send the reader
 * to different places. A row with no hash at all was written before provenance
 * existed and nothing more can be learned from it. A row that has a hash but no
 * commit was written by a build that carried no git metadata (a tarball or
 * container install), and the hash still identifies the file exactly.
 */
const PREDATES_PROVENANCE = '(not recorded — row predates migration provenance)'
const NO_BUILD_IDENTITY = '(not discoverable — the build carried no git metadata)'

/**
 * The thrown message for a name mismatch.
 *
 * The refusal itself is unchanged and deliberately fail-closed (see the call
 * site). What changed is that recovery no longer requires reverse-engineering
 * `repairKey` from source: the message prints what is on disk against what was
 * recorded — including the provenance of the build that wrote the row, which
 * is the question the original incident could not answer — and then the exact
 * JSON to paste into `migrations/repairs.json`.
 */
function formatNameMismatch(
  migration: Migration,
  recorded: RecordedMigration,
  today: string,
): string {
  const entry = repairsEntryFor(migration.version, recorded.name, migration.name, today)
  const indented = JSON.stringify(entry, null, 2)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
  const appliedAt = Number.isFinite(recorded.applied_at)
    ? new Date(recorded.applied_at * 1000).toISOString()
    : '(unknown)'
  return [
    `Migration version ${migration.version} was recorded as "${recorded.name}" but this code contains "${migration.name}". ` +
      'The schema may not match this code.',
    '',
    '  on disk',
    `    file    ${migration.fileName}`,
    `    sha256  ${migrationContentHash(migration.sql)}`,
    '  recorded',
    `    name    ${recorded.name}`,
    `    applied ${appliedAt}`,
    `    sha256  ${recorded.content_sha256 ?? PREDATES_PROVENANCE}`,
    `    build   ${
      recorded.applied_by_commit ??
      (recorded.content_sha256 === null ? PREDATES_PROVENANCE : NO_BUILD_IDENTITY)
    }`,
    '',
    'Resolve ONLY with a hand-verified entry in migrations/repairs.json. Confirm by hand that the',
    'live schema already matches this code, then append this entry (replacing the note):',
    '',
    indented,
    '',
    'Never rename the recorded row and never auto-apply the migration.',
  ].join('\n')
}

/**
 * Provenance columns on `_migrations`, added additively and forward-only.
 * Both are nullable: rows written before this shipped are pre-existing and
 * stay NULL, which is the honest record — nobody knows what build applied
 * them, and that is exactly the problem this closes going forward.
 */
const PROVENANCE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['content_sha256', 'TEXT'],
  ['applied_by_commit', 'TEXT'],
]

/**
 * Bring `_migrations` up to the current shape.
 *
 * WHY THIS IS NOT A `NNNN_*.sql` MIGRATION, which is the obvious place for it:
 * `_migrations` is the ledger, and the runner is its sole owner — it is
 * created here by `CREATE TABLE IF NOT EXISTS` and no `.sql` file in this tree
 * has ever touched its DDL. Evolving it from inside the ledger is circular,
 * and on a fresh install it is also WRONG: the runner writes each row inside
 * that migration's own transaction, so migrations 0001..NNNN-1 would all be
 * recorded before the ALTER at ordinal NNNN ever ran. Every fresh install
 * would come up with a provenance-less history — reintroducing the exact
 * forensic gap this work exists to close, on the population where the record
 * is easiest to get right. Bootstrapping here means row one of a brand-new
 * database carries its provenance.
 *
 * The contract is unchanged in substance: additive, forward-only, idempotent.
 * Columns are only ever added, never dropped or renamed, and re-running is a
 * no-op because `pragma_table_info` is consulted first (SQLite has no
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
 */
function ensureProvenanceColumns(db: Database): void {
  const columnNames = (): Set<string> =>
    new Set(
      db
        .query<{ name: string }, []>("SELECT name FROM pragma_table_info('_migrations')")
        .all()
        .map((r) => r.name),
    )
  const present = columnNames()
  for (const [column, type] of PROVENANCE_COLUMNS) {
    if (present.has(column)) continue
    try {
      db.exec(`ALTER TABLE _migrations ADD COLUMN ${column} ${type}`)
    } catch (err) {
      // Check-then-ALTER is not atomic. If two processes boot at once on the
      // first run after an upgrade, both can read the column as absent and the
      // loser gets "duplicate column name". The post-state is what matters and
      // it is correct, so re-read rather than take down a boot over a race we
      // won either way. Anything else still throws — this widens nothing.
      if (!columnNames().has(column)) throw err
    }
  }
}

function assertUniqueMigrationOrdinals(migrations: Migration[]): void {
  const byVersion = new Map<number, Migration>()
  for (const migration of migrations) {
    const previous = byVersion.get(migration.version)
    if (previous) {
      throw new Error(
        `Migration ordinal collision at version ${migration.version}: ${previous.fileName} and ${migration.fileName}`,
      )
    }
    byVersion.set(migration.version, migration)
  }
}

/**
 * Apply a per-project-scoped migration tree (e.g. `migrations/comments/`)
 * against a sidecar DB. Identical mechanics to `applyMigrations` —
 * preamble PRAGMA hoisting, per-migration BEGIN/COMMIT atomicity, the
 * `_migrations` bookkeeping table — but takes the directory explicitly
 * so the caller picks the migration tree.
 *
 * Why a separate name: the implicit `dir = HERE` default on
 * `applyMigrations` makes "apply against the instance DB migration tree"
 * the canonical use; renaming `dir` to required and calling it from
 * sidecars would force every call site to pass a dir argument they
 * don't otherwise care about. `applyProjectScopedMigrations` is a
 * single-purpose alias whose name documents intent at the call site.
 *
 * Per docs/plans/P7.2-inline-comments-sprint-brief.md § 3.4 — the
 * comments sidecar migration tree starts at 0001 (parallel namespace),
 * not at the next instance-wide version. Other per-project sidecars
 * (e.g. a future Tier 1 Core sidecar) can share this runner.
 */
export function applyProjectScopedMigrations(
  db: Database,
  dir: string,
): ApplyResult {
  return applyMigrations(db, dir)
}

/**
 * Apply the instance-DB migration tree against a wrapped connection (the
 * gateway's boot-time `ProjectDb`). P2 (world-class-refactor plan) restricts
 * `ProjectDb.raw()` to THIS module — the migration runner is the one
 * legitimate consumer of the bare `bun:sqlite` Database (its per-migration
 * BEGIN/COMMIT + PRAGMA-preamble mechanics need the unserialized handle).
 * The parameter is a structural `{ raw(): Database }` rather than the
 * `ProjectDb` class so `migrations/` doesn't grow an import edge onto
 * `persistence/` (which already depends on this package for sidecars).
 */
export function applyMigrationsToProjectDb(db: { raw(): Database }): ApplyResult {
  return applyMigrations(db.raw())
}

export function applyMigrations(db: Database, dir: string = HERE): ApplyResult {
  // foreign_keys is per-connection (PRAGMA, not persisted), so every caller-supplied Database
  // gets it asserted here before any work. The bootstrap SQL also sets it for direct sqlite CLI
  // runs; both paths are required.
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at REAL NOT NULL
     )`,
  )
  ensureProvenanceColumns(db)
  const seen = new Map(
    db
      .query<RecordedMigration, []>(
        'SELECT version, name, applied_at, content_sha256, applied_by_commit FROM _migrations',
      )
      .all()
      .map((r) => [r.version, r] as const),
  )
  const migrations = loadMigrations(dir)
  assertUniqueMigrationOrdinals(migrations)
  const repairs = new Map(
    loadMigrationRepairs(dir).map((repair) => [
      repairKey(repair.version, repair.recorded_name, repair.file_name),
      repair,
    ]),
  )
  const acknowledged = new Map<number, MigrationRepair>()
  const today = new Date().toISOString().slice(0, 10)
  for (const migration of migrations) {
    const recorded = seen.get(migration.version)
    if (recorded === undefined || !migrationNameMismatch(recorded.name, migration.name)) continue
    const repair = repairs.get(repairKey(migration.version, recorded.name, migration.name))
    if (!repair) {
      // Fail closed, exactly as before: refuse, apply nothing, rename nothing.
      // Only the message got better.
      throw new Error(formatNameMismatch(migration, recorded, today))
    }
    acknowledged.set(migration.version, repair)
  }

  if (acknowledged.size > 0) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS _migration_repairs (
         version INTEGER NOT NULL,
         recorded_name TEXT NOT NULL,
         file_name TEXT NOT NULL,
         note TEXT NOT NULL,
         acknowledged_at REAL NOT NULL,
         PRIMARY KEY (version, recorded_name, file_name)
       )`,
    )
  }
  for (const repair of acknowledged.values()) {
    db.run(
      `INSERT OR IGNORE INTO _migration_repairs
       (version, recorded_name, file_name, note, acknowledged_at) VALUES (?, ?, ?, ?, ?)`,
      [repair.version, repair.recorded_name, repair.file_name, repair.note, Date.now() / 1000],
    )
  }
  const applied: number[] = []
  const skipped: number[] = []
  // Resolved ONCE per run, and only when there is something to apply, so a
  // steady-state boot (every migration already recorded) does no filesystem
  // work at all. `dir` is the search origin: for the instance tree that walks
  // up to the checkout's `.git`, and for a sidecar tree (`migrations/comments`)
  // it finds the same one.
  const pending = migrations.some((m) => !seen.has(m.version))
  const deployedCommit = pending ? resolveDeployedCommit(process.env, dir) : null
  for (const m of migrations) {
    if (seen.has(m.version)) {
      skipped.push(m.version)
      continue
    }
    // SQLite forbids several PRAGMAs (journal_mode, synchronous, foreign_keys) inside a
    // transaction. The migration SQL file declares its connection-level pragmas at the top so a
    // direct `sqlite3 < file.sql` run is also self-configuring; here we lift that leading
    // preamble out of the transactional body before BEGIN. Anything that's not a leading
    // comment or PRAGMA statement falls into the body and is wrapped atomically.
    const { preamble, body } = splitPragmaPreamble(m.sql)
    if (preamble.trim().length > 0) db.exec(preamble)

    // Each migration is atomic: either every statement in the body lands AND _migrations
    // records the version, or nothing lands and the database is unchanged. Without this the
    // runner could leave an instance DB partially migrated after a mid-file failure (e.g. a later
    // ALTER, an extension-specific DDL step, or a data backfill), and the next startup would
    // retry against split state.
    db.exec('BEGIN')
    try {
      db.exec(body)
      // Provenance is written inside the migration's own transaction, so a row
      // can never exist without naming the build that wrote it — the gap that
      // made the original incident unanswerable after the fact.
      db.run(
        `INSERT INTO _migrations (version, name, applied_at, content_sha256, applied_by_commit)
         VALUES (?, ?, ?, ?, ?)`,
        [m.version, m.name, Date.now() / 1000, migrationContentHash(m.sql), deployedCommit],
      )
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    } finally {
      // Re-assert PRAGMA foreign_keys=ON after every migration so that a
      // migration whose preamble disabled FK enforcement (e.g. 0067's
      // projects rebuild, or 0004's DROP-and-rebuild step that would
      // otherwise cascade via 0003's workspace_members FK) does not leak
      // FK=OFF onto subsequent migrations or the calling connection —
      // including when the migration THROWS after its preamble ran (the
      // rollback path above rethrows, so this must be a finally). Cheap
      // (PRAGMA, no I/O) and outside the migration's BEGIN/COMMIT —
      // PRAGMAs that change foreign_keys are no-ops inside a transaction
      // per SQLite docs.
      db.exec('PRAGMA foreign_keys = ON')
    }
    applied.push(m.version)
  }
  return { applied, skipped }
}

const PRAGMA_PREAMBLE_RE = /^(?:\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|PRAGMA\s+[^;]+;))*/i

/**
 * Split off leading whitespace, line/block comments, and `PRAGMA ...;` statements so the
 * runner can run those outside the per-migration transaction. The regex anchors at start of
 * input and stops at the first statement that is not a comment or PRAGMA.
 *
 * If the matched preamble contains no actual PRAGMA statement (i.e. just comments and
 * whitespace), there is nothing to lift — leave the whole file as the body. Otherwise
 * `db.exec(preamble)` would error on a comment-only string ("Query contained no valid SQL
 * statement"). Comments inside the transactional body are fine.
 */
export function splitPragmaPreamble(sql: string): { preamble: string; body: string } {
  const match = sql.match(PRAGMA_PREAMBLE_RE)
  const preamble = match ? match[0] : ''
  // The "contains an actual PRAGMA" check must run against the preamble with
  // its comments stripped, not the raw preamble text — a header comment that
  // merely MENTIONS "PRAGMA " (e.g. `-- No PRAGMA preamble needed.`) would
  // otherwise word-match and pass a comment-only string through to
  // `db.exec(preamble)`, which SQLite rejects ("Query contained no valid SQL
  // statement"). Migration preambles are PRAGMA-only per the doc comment
  // above, so they don't carry string literals that could themselves contain
  // `--`/`/* */` — this strip is safe for the shapes this runner handles.
  const stripped = preamble.replace(/--[^\n]*\n/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  if (!/PRAGMA\s+/i.test(stripped)) {
    return { preamble: '', body: sql }
  }
  return { preamble, body: sql.slice(preamble.length) }
}

/**
 * Whether the migrate CLI should print the one-line human summary instead of
 * the raw JSON. Driven by `NEUTRON_MIGRATE_QUIET` — set to `1`/`true` by
 * install.sh so the bootstrap stays clean; unset for standalone debugging.
 */
export function isQuietMigrate(env: NodeJS.ProcessEnv): boolean {
  const v = env['NEUTRON_MIGRATE_QUIET']
  return v === '1' || v === 'true'
}

/**
 * One clean line in the installer's `✓ ...` house style summarising what the
 * migrate run did — applied count (the common fresh-install case) with the
 * already-up-to-date case spelled out explicitly.
 */
export function summarizeMigrateResult(result: ApplyResult): string {
  const n = result.applied.length
  if (n === 0) return '✓ database ready (already up to date)'
  return `✓ database ready (${n} migration${n === 1 ? '' : 's'} applied)`
}

if (import.meta.main) {
  // F3 — standalone CLI entrypoint (`bun run migrate`). RESIDUAL (deliberate):
  // covers the body onward (incl. the fallible `new Database(...)`), but NOT
  // this module's OWN static imports. NO bootstrap split — it is a DUAL
  // library+entry module whose exports are consumed by PRODUCTION (gateway
  // boot's `applyMigrationsToProjectDb`, comment-store / nexus-store's
  // `applyProjectScopedMigrations`); splitting would repoint those importers.
  // Its static imports are stable internal modules (bun:sqlite, node:fs,
  // ./db-path.ts, logger). See installProcessSafetyNet doc.
  installProcessSafetyNet()
  // An explicit db-path arg wins (install.sh passes one). With no arg, resolve
  // the SAME file the server opens — NEUTRON_DB_PATH (honored from .env, which
  // Bun auto-loads) else <NEUTRON_HOME>/project.db — so the documented bare
  // `bun run migrate` quickstart actually succeeds on a fresh install instead
  // of exiting 2 against an unspecified path.
  const target = Bun.argv[2] ?? resolveOpenDbPath(process.env)
  // new Database(..., { create: true }) creates the file but NOT its parent
  // directory; ensure it exists so a first-run migrate can't fail on a missing
  // NEUTRON_HOME (or a pinned db dir that hasn't been created yet).
  mkdirSync(dirname(target), { recursive: true })
  const db = new Database(target, { create: true })
  const result = applyMigrations(db)
  // Quiet/summary mode (NEUTRON_MIGRATE_QUIET=1) — the installer sets this so a
  // fresh install prints one clean human line instead of dumping the raw
  // `{"applied":[...]}` JSON mid-install. Standalone/debug `bun run migrate`
  // (flag unset) keeps the full JSON output intact.
  if (isQuietMigrate(process.env)) {
    console.log(summarizeMigrateResult(result))
  } else {
    console.log(JSON.stringify(result, null, 2))
  }
}
