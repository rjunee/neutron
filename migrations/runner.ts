import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveOpenDbPath } from './db-path.ts'
import {
  type DeployedTree,
  migrationContentHash,
  resolveDeployedCommit,
  resolveDeployedTree,
} from './provenance.ts'
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
  tree_provenance: string | null
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
 * A row from a build that recorded the commit but not yet the tree verdict — the
 * window between the two changes. Distinguished from the two above for the same
 * reason they are distinguished from each other: it sends the reader somewhere
 * else, namely "this row's file was never checked against the tree, and nothing
 * more can be learned about it now".
 */
const PREDATES_TREE_VERIFICATION = '(not recorded — row predates deployed-tree verification)'

/**
 * `tree_provenance` for a file the deployed checkout demonstrably tracks.
 *
 * THE VALUE NAMES ITS OWN EVIDENCE, and that is deliberate. What was checked is
 * git's INDEX — the staged tree — so the honest claim is "this checkout tracks
 * the file", not "the deployed commit contained it". The two differ for a file
 * that was `git add`ed and never committed, which this value therefore covers;
 * `git-index.ts`'s header argues why closing that last gap would mean a packfile
 * reader on the boot path, and why the guard is worth having without it. A row
 * that overclaimed (`tracked`, reading as "in the commit") would be the worse
 * outcome: these columns exist so a later investigation can trust them, and a
 * forensic value that has to be discounted is no better than a NULL.
 */
const TRACKED_IN_DEPLOYED_TREE = 'tracked-in-index'

/**
 * `tree_provenance` for a file whose membership of the deployed tree could not
 * be established, and the reason it could not. The prefix is the contract:
 * anything that does not equal `tracked-in-index` is unverified, and a reader can
 * test for it without enumerating every reason this or a future version can
 * produce.
 */
function unverifiedTreeProvenance(reason: string): string {
  return `unverifiable:${reason}`
}

/**
 * The largest millisecond offset `new Date(...)` represents; anything beyond it
 * makes `toISOString()` throw `RangeError`. Per ECMA-262 (Time Values and Time
 * Range), ±8.64e15 ms — so ±8.64e12 in the seconds `applied_at` stores.
 */
const MAX_TIME_VALUE_MS = 8.64e15

/**
 * Render `applied_at` (unix seconds, REAL) as a timestamp.
 *
 * TOTAL BY CONSTRUCTION, and that is the whole point. This runs only while
 * building the message for a refused boot, so a throw here would replace the
 * one diagnostic the operator has with a bare `RangeError` — strictly worse
 * than the message this work set out to improve. `Number.isFinite` alone is not
 * enough: a corrupt or garbage-wide value is finite and still outside the Date
 * range. Out-of-range prints the raw number, because a nonsense timestamp is
 * itself forensic evidence and must not be swallowed.
 */
function formatAppliedAt(appliedAt: number): string {
  if (!Number.isFinite(appliedAt)) return '(unknown)'
  const ms = appliedAt * 1000
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_TIME_VALUE_MS) {
    return `(out of range — recorded as ${appliedAt})`
  }
  return new Date(ms).toISOString()
}

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
  const appliedAt = formatAppliedAt(recorded.applied_at)
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
    // Whether the row's file was ever established as part of the tree that
    // applied it. On the incident this work is about, that is THE question — the
    // offending row named a migration no deployed commit ever contained.
    `    tree    ${
      recorded.tree_provenance ??
      (recorded.content_sha256 === null ? PREDATES_PROVENANCE : PREDATES_TREE_VERIFICATION)
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
 * The thrown message for a migration file the deployed checkout does not track.
 *
 * Same self-diagnosing shape as the mismatch above, and for the same reason: the
 * operator reading this has a boot that will not come up, and everything needed
 * to decide should be in front of them. Three things this message must get right.
 *
 * It states that NOTHING WAS WRITTEN, and that claim is load-bearing: an operator
 * who fears the database is half-migrated will reach for something more
 * destructive than deleting a file. It is also a claim the code has to EARN — the
 * call site resolves the tree before the acknowledged-repair writes and before
 * the ledger is created or reshaped, precisely so this sentence is true. An
 * earlier revision of this message asserted it while `_migration_repairs` DDL ran
 * first; on an instance carrying acknowledged repairs (this repository has two)
 * that made the message wrong in exactly the incident-recovery state where it is
 * read.
 *
 * It names the tracked SIBLINGS. A refusal that only says "not tracked" is
 * indistinguishable from a check that has broken and is refusing everything —
 * the exact failure a fail-closed boot gate must let the operator rule out in
 * one read. The count is the check's own positive control.
 *
 * It is HONEST ABOUT ITS EVIDENCE. The check reads git's index, so `git add`
 * alone satisfies it while only a commit makes the file survive the next
 * checkout — which is the failure being prevented. The remedy says both, because
 * "COMMIT it" alone describes a stricter check than the one that just fired.
 *
 * `recorded` is the row already at this ordinal, when there is one. Then the file
 * ALSO reads as a name mismatch, and that is the presentation the last outage
 * arrived in — with a remedy (a `repairs.json` entry) that would acknowledge a
 * row against a file the repository does not track. This refusal takes
 * precedence, and says why.
 */
function formatUntrackedMigration(
  migration: Migration,
  tree: { readonly dirPrefix: string; readonly tracked: ReadonlySet<string> },
  deployedCommit: string | null,
  recorded: RecordedMigration | null,
): string {
  return [
    `Migration file ${migration.fileName} is present in the migrations directory but is NOT part of ` +
      "the deployed tree — git's index for this checkout does not track it. Refusing to apply it.",
    '',
    '  on disk',
    `    file    ${tree.dirPrefix}${migration.fileName}`,
    `    sha256  ${migrationContentHash(migration.sql)}`,
    '  deployed tree',
    `    build   ${deployedCommit ?? NO_BUILD_IDENTITY}`,
    `    tracked ${tree.tracked.size} file(s) in this directory, and this is not one of them`,
    ...(recorded === null
      ? []
      : [
          '  recorded',
          `    name    ${recorded.name}`,
          `    applied ${formatAppliedAt(recorded.applied_at)}`,
        ]),
    '',
    'NOTHING HAS BEEN APPLIED and nothing has been written — no migration ran, no _migrations row',
    'was written, the ledger was not reshaped, and no repair was acknowledged. This refusal is',
    'resolved before the first write, so the database is exactly as it was.',
    '',
    'An untracked file here is not a harmless extra. It would be applied at boot and recorded in',
    '_migrations PERMANENTLY, and then disappear with the next checkout, leaving a ledger row that',
    'names a migration this repository never contained. Every later boot then refuses on a mismatch',
    'that cannot be explained from anything on disk. That is how the last outage started.',
    ...(recorded === null
      ? []
      : [
          '',
          `Ordinal ${migration.version} is ALREADY recorded, under the name "${recorded.name}", so this file also`,
          'reads as a name mismatch — which is the shape the last outage was reported in. Do not resolve',
          'it that way: a migrations/repairs.json entry here would acknowledge a row against a file this',
          'repository does not track, which is the disease rather than the cure. Deleting the stray',
          'clears the mismatch outright.',
        ]),
    '',
    'Resolve by ONE of:',
    '  - DELETE the file, if it is a stray — a scratch copy, an editor artifact, a leftover from',
    '    another branch, something written into this directory by another process.',
    '  - ADD AND COMMIT it, if it is a real migration, then boot again. Both halves matter: this',
    "    check reads git's index, so `git add` is what satisfies it, and only the commit makes the",
    '    file outlive the next checkout — which is the failure the refusal exists to prevent.',
    '',
    'Do NOT reach for migrations/repairs.json. Those entries acknowledge a name mismatch on a row',
    'whose file this tree DOES contain; that is not the situation here.',
  ].join('\n')
}

/**
 * Provenance columns on `_migrations`, added additively and forward-only.
 * All three are nullable: rows written before each shipped are pre-existing and
 * stay NULL, which is the honest record — nobody knows what build applied
 * them, and that is exactly the problem this closes going forward.
 */
const PROVENANCE_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['content_sha256', 'TEXT'],
  ['applied_by_commit', 'TEXT'],
  ['tree_provenance', 'TEXT'],
]

/** The columns `_migrations` currently carries, by name. */
function ledgerColumns(db: Database): Set<string> {
  return new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('_migrations')")
      .all()
      .map((r) => r.name),
  )
}

/** Whether `_migrations` exists yet. A fresh database has no ledger at all. */
function ledgerExists(db: Database): boolean {
  return (
    db
      .query("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = '_migrations'")
      .get() !== null
  )
}

/**
 * Read the ledger without requiring it to exist or to have been reshaped first.
 *
 * A ledger written before provenance shipped has neither column, so the select
 * list is built from what is actually there and the rest is selected as NULL —
 * which is also the honest value. A database that has never been migrated has no
 * table, which reads as an empty ledger.
 *
 * This exists so that DECIDING costs no write. Both refusals — a name mismatch
 * and an untracked file — read the ledger and can then refuse having touched
 * nothing whatsoever, including on a fresh database where `CREATE TABLE` would
 * otherwise have been the one write standing between the message's claim and the
 * truth.
 */
function readLedger(db: Database): Map<number, RecordedMigration> {
  if (!ledgerExists(db)) return new Map()
  const present = ledgerColumns(db)
  const provenance = PROVENANCE_COLUMNS.map(([column]) =>
    present.has(column) ? column : `NULL AS ${column}`,
  ).join(', ')
  return new Map(
    db
      .query<RecordedMigration, []>(
        `SELECT version, name, applied_at, ${provenance} FROM _migrations`,
      )
      .all()
      .map((r) => [r.version, r] as const),
  )
}

/**
 * Create `_migrations` and bring it up to the current shape. Called ONLY on the
 * path that is about to write a row — see the call site for why that ordering is
 * load-bearing.
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
 * is easiest to get right, and on the very ordinal (124) the incident was
 * about. Bootstrapping here means row one of a brand-new database carries its
 * provenance; `migration-provenance.test.ts` pins that directly.
 *
 * The contract is unchanged in substance: additive, forward-only, idempotent.
 * Columns are only ever added, never dropped or renamed, and re-running is a
 * no-op because `pragma_table_info` is consulted first (SQLite has no
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
 */
function ensureLedgerShape(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at REAL NOT NULL
     )`,
  )
  const present = ledgerColumns(db)
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
      if (!ledgerColumns(db).has(column)) throw err
    }
  }
}

/**
 * What every row written in this run records about the deployed tree.
 *
 * One value for the whole run, because the verdict is a property of the tree and
 * not of the file: on the `verified` path every pending file has already been
 * proven tracked (the alternative threw), and on the `unverifiable` path nothing
 * about any of them could be established.
 *
 * The caller passes NULL when nothing is pending, which is also the only case
 * where no row is written. That is not "unknown" — it is "no run happened". Note
 * the tree can be resolved for a name mismatch with nothing pending at all; the
 * verdict then describes no row and the call site drops it.
 */
function treeProvenanceOf(tree: DeployedTree | null): string | null {
  if (tree === null) return null
  return tree.kind === 'verified'
    ? TRACKED_IN_DEPLOYED_TREE
    : unverifiedTreeProvenance(tree.reason)
}

/**
 * Refuse two files claiming one ordinal — unless the tree can say one of them is
 * a stray, in which case stand aside for the better diagnosis.
 *
 * WHY THIS TAKES THE TREE VERDICT. Two tracked files at one ordinal is a mistake
 * IN THIS REPOSITORY, and naming both files is the right message for it. But a
 * tracked `0124_real.sql` beside an untracked `0124_stray.sql` is not that — it is
 * the incident class, and the collision message sends the operator looking for a
 * duplicate they did not commit while the actual remedy (delete the stray, or
 * commit it) goes unsaid. Ordinals 122 and 124 on the live instance were exactly a
 * stray landing on an occupied ordinal, so this is the shape that has already cost
 * real downtime, not a hypothetical one.
 *
 * So when the tree is verified and one side of the collision is untracked, this
 * defers and lets the refusal loop below speak — it names the file and gives that
 * remedy. Fail-closed either way, and unchanged where the tree cannot tell them
 * apart (`verified` null): what changes is only which remedy the operator is
 * handed. Deferring cannot mean "apply it": the loop refuses every untracked
 * pending file, which is why standing aside here is safe.
 */
function assertUniqueMigrationOrdinals(
  migrations: Migration[],
  verified: { readonly tracked: ReadonlySet<string> } | null,
): void {
  const untracked = (m: Migration): boolean =>
    verified !== null && !verified.tracked.has(m.fileName)
  const byVersion = new Map<number, Migration>()
  for (const migration of migrations) {
    const previous = byVersion.get(migration.version)
    if (previous) {
      if (untracked(previous) || untracked(migration)) continue
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
  const seen = readLedger(db)
  const migrations = loadMigrations(dir)
  const repairs = new Map(
    loadMigrationRepairs(dir).map((repair) => [
      repairKey(repair.version, repair.recorded_name, repair.file_name),
      repair,
    ]),
  )

  // EVERY REFUSAL IS DECIDED BEFORE THE FIRST WRITE, and the whole block below is
  // ordered around that. Nothing here mutates the database: the ledger has not
  // been created or reshaped (`readLedger` tolerates its absence), no repair has
  // been acknowledged, no migration has run. That is what lets both refusal
  // messages state that the database is untouched — a guard whose job is to
  // change nothing must actually change nothing, and the untracked message says
  // so in as many words. It also keeps `applyMigrations` a pure READ for a
  // fully-migrated database, which is what makes opening a backup read-only to
  // inspect it work.
  const pendingMigrations = migrations.filter((m) => !seen.has(m.version))
  const pending = pendingMigrations.length > 0
  // A MISMATCH NEEDS THE TREE VERDICT TOO. Until this was true, an untracked
  // stray landing on an ordinal that is ALREADY recorded surfaced as a name
  // mismatch — whose remedy is a `repairs.json` entry naming a file the tree does
  // not track, which the sibling message correctly calls the disease. That was
  // not hypothetical: it is how ordinals 122 and 124 presented on the live
  // instance, and it is why the remedy applied there was the harder one.
  const mismatched = migrations.some((m) => {
    const recorded = seen.get(m.version)
    return recorded !== undefined && migrationNameMismatch(recorded.name, m.name)
  })
  // Both provenance reads happen ONCE per run, and only when there is something
  // to decide, so a steady-state boot (every migration recorded, no mismatch) does
  // no filesystem work at all. `dir` is the search origin: for the instance tree
  // that walks up to the checkout's `.git`, and for a sidecar tree
  // (`migrations/comments`) it finds the same one.
  const decidable = pending || mismatched
  const deployedCommit = decidable ? resolveDeployedCommit(process.env, dir) : null
  const tree = decidable ? resolveDeployedTree(dir) : null
  // The tracked-file list, or null when there is none to compare against. A
  // `null` here is "cannot verify" and refuses nothing — see `resolveDeployedTree`.
  const verified = tree !== null && tree.kind === 'verified' ? tree : null
  // AFTER the tree verdict, not before it, so a stray colliding with a tracked
  // file is diagnosed as the stray it is. A collision always makes the run
  // decidable — one of the two files is either pending or mismatched against the
  // recorded name — so the verdict above is never null for the reason that matters
  // here. See the function for the argument.
  assertUniqueMigrationOrdinals(migrations, verified)
  /**
   * The tree verdict WHEN IT REFUSES this file, else null.
   *
   * Returning the verdict rather than a boolean is what lets the caller pass it
   * straight to the message: a bare `untracked` flag would leave the tree's type
   * unnarrowed at exactly the point the message needs `dirPrefix` and the tracked
   * count off it.
   */
  const refusesFile = (m: Migration): typeof verified =>
    verified !== null && !verified.tracked.has(m.fileName) ? verified : null

  const acknowledged = new Map<number, MigrationRepair>()
  const today = new Date().toISOString().slice(0, 10)
  for (const migration of migrations) {
    // A file that is present but untracked is not a migration this build
    // contains, and applying it writes a permanent ledger row for something that
    // will not exist after the next checkout. Fail closed, name the file.
    const untracked = refusesFile(migration)
    const recorded = seen.get(migration.version)
    if (recorded === undefined) {
      // PENDING. Only pending files can be refused for being untracked: a row
      // already recorded is already permanent, and refusing forever over a stray
      // applied long ago would be a boot outage with no remedy. This guard's job
      // is to stop the silent APPLY, which is the only moment damage is done.
      if (untracked !== null) {
        throw new Error(formatUntrackedMigration(migration, untracked, deployedCommit, null))
      }
      continue
    }
    if (!migrationNameMismatch(recorded.name, migration.name)) continue
    const repair = repairs.get(repairKey(migration.version, recorded.name, migration.name))
    if (repair) {
      // An acknowledged repair wins even over the untracked verdict. The entry is
      // an explicit, hand-verified operator decision about this exact ordinal, and
      // overriding it would turn a documented recovery into an outage with no
      // remedy — which is the failure mode every rule here is written against.
      acknowledged.set(migration.version, repair)
      continue
    }
    // Fail closed either way; what improved is WHICH diagnosis is given. An
    // untracked file at a recorded ordinal is the stray, not a rename, and its
    // remedy is deletion rather than a repairs entry.
    throw new Error(
      untracked !== null
        ? formatUntrackedMigration(migration, untracked, deployedCommit, recorded)
        : formatNameMismatch(migration, recorded, today),
    )
  }

  // ---- Past this line, and not before it, the database is written to. ----

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
  // NULL when nothing is pending, which is also the only case where no row is
  // written — see `treeProvenanceOf`. The tree may have been resolved for a
  // mismatch alone, and that verdict describes no row.
  const treeProvenance = pending ? treeProvenanceOf(tree) : null
  // The ledger is created and reshaped HERE, on the path that is about to write a
  // row, and nowhere earlier — which is the whole reason it is read
  // shape-tolerantly (and existence-tolerantly) above. Doing it first would mean a
  // boot that ends in a refusal had already mutated the schema of the database it
  // just declared untrustworthy: a guard whose job is to change nothing, changing
  // something. It would also turn `applyMigrations` from a read into a write for a
  // fully-migrated database, which breaks opening a backup read-only to inspect
  // it. Nothing pending, nothing written.
  if (pending) ensureLedgerShape(db)
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
        `INSERT INTO _migrations
           (version, name, applied_at, content_sha256, applied_by_commit, tree_provenance)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          m.version,
          m.name,
          Date.now() / 1000,
          migrationContentHash(m.sql),
          deployedCommit,
          treeProvenance,
        ],
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
