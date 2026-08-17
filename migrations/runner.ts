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

/** A ledger reduced to the two things that identify a migration. */
export interface LedgerIdentity {
  /** Every `name` the ledger records. */
  readonly names: ReadonlySet<string>
  /** Every non-NULL `content_sha256` the ledger records. */
  readonly hashes: ReadonlySet<string>
}

/**
 * Whether the ledger already records this migration — BY IDENTITY, NOT BY ORDINAL.
 *
 * THE ORDINAL IS A FILENAME PREFIX, NOT AN IDENTITY. It fixes apply ORDER and
 * nothing else, and it is allocated by whoever writes the file — so across a
 * fleet, two DIFFERENT migrations legitimately occupy one ordinal (two branches
 * both number theirs 0125; whichever merges second is renumbered, while an
 * instance that already ran the first keeps the old number), and one migration
 * legitimately occupies DIFFERENT ordinals on different instances (it merged at a
 * number other than the one it was written at). Asking "has this run?" of the
 * ordinal therefore asks a question the ordinal cannot answer, and gets it wrong
 * in both directions: a migration reads as APPLIED when a different one consumed
 * its number — so its `ALTER`s never run and the schema silently lacks them,
 * which is ordinals 122, 124 and 125 on the live instance — and reads as PENDING
 * when the same migration already ran under another number.
 *
 * The identity is the NAME, the `<slug>` half of `NNNN_<slug>.sql`. That is what
 * `_migrations.name` has always stored, what the README has always called "the
 * identity the runner compares", and what this repository has always kept unique
 * (`assertUniqueMigrationNames` now pins it rather than assuming it).
 *
 * `content_sha256` is a SECOND, name-independent identity, and it is used here
 * only to WIDEN the answer: a migration whose exact bytes are already recorded
 * has run, whatever it was called at the time. It is never used to NARROW one —
 * a recorded hash that differs from the file on disk is not treated as unapplied
 * and not treated as corruption. See README § "`content_sha256` is recorded and
 * reported, not enforced": already-applied files are edited in place for benign
 * reasons (a comment, a reflow) and turning the hash into a gate converts every
 * one of those into a crash loop. That decision predates this change and stands.
 *
 * The name is checked FIRST so a steady-state boot hashes nothing at all.
 */
export function migrationIsRecorded(migration: Migration, ledger: LedgerIdentity): boolean {
  if (ledger.names.has(migration.name)) return true
  if (ledger.hashes.size === 0) return false
  return ledger.hashes.has(migrationContentHash(migration.sql))
}

function loadMigrationRepairs(dir: string): MigrationRepair[] {
  const path = join(dir, 'repairs.json')
  if (!existsSync(path)) return []
  const repairs: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(repairs)) throw new Error(`${path} must contain a JSON array`)
  return repairs as MigrationRepair[]
}

/**
 * A repair identifies the LEDGER ROW it acknowledges: ordinal plus recorded name.
 *
 * It deliberately does NOT include `file_name`. A repair says two things, and both
 * are about the row rather than about whatever file happens to sit at that ordinal
 * in this build: the row is an acknowledged orphan, and the migration named by
 * `file_name` is already applied on this instance (see `activeRepairs`). Keying on
 * the ordinal + recorded name keeps both shipped entries matching unchanged, and
 * stops a repair from silently ceasing to apply the next time a merge renumbers
 * the file that used to collide with it.
 */
function repairKey(version: number, recordedName: string): string {
  return `${version}\0${recordedName}`
}

/**
 * The `repairs.json` entry that would acknowledge this exact ledger row.
 *
 * READ THE FIELD NAMES CAREFULLY. `recorded_name` is the name in the ledger — the
 * row being acknowledged. `file_name` holds a migration's NAME (the `<slug>` half
 * of `NNNN_<slug>.sql`), NOT a filename on disk, and it names the migration this
 * instance already has: the shipped entries carry slugs (`trident_checkpoint_head`,
 * for the file `0122_trident_checkpoint_head.sql`). "Correcting" either to a real
 * filename stops the entry matching, and the failure is invisible: the ledger looks
 * repaired while the runner keeps refusing to boot. This builder exists so the
 * operator never has to infer the convention from the key function.
 *
 * `file_name` is left for the operator to fill because only they can answer it —
 * the runner knows which row it cannot explain, but not which of this build's
 * migrations (if any) that row's schema change corresponds to. Naming one is what
 * suppresses re-applying it; leaving it as the placeholder acknowledges the row
 * alone, which is the right answer when the orphan corresponds to nothing here.
 */
function repairsEntryFor(
  version: number,
  recordedName: string,
  today: string,
): Record<string, unknown> {
  return {
    version,
    recorded_name: recordedName,
    file_name:
      'REPLACE THIS — the <slug> of the migration in THIS build that is already applied, or "" if none is.',
    note: 'REPLACE THIS — what you verified by hand, and why the live schema already matches this code.',
    date: today,
  }
}

/**
 * A blank reads as a value, so absence is spelled out — and each REASON a field can
 * be absent is spelled out separately, because they send the reader to different
 * places. A row that has a hash but no commit was written by a build that carried
 * no git metadata (a tarball or container install), and the hash still identifies
 * the file exactly.
 *
 * There is deliberately no "row predates provenance" string here any more. A row
 * with no `content_sha256` never reaches either message: the unexplained-row guard
 * adjudicates only rows carrying a hash (see `formatUnexplainedLedgerRows` for why
 * that is required rather than lenient), and the untracked message prints only the
 * occupying row's name and timestamp. A constant for an unreachable state reads as
 * documentation of a mode the code cannot enter.
 */
const NO_BUILD_IDENTITY = '(not discoverable — the build carried no git metadata)'
/**
 * A row from a build that recorded the commit but not yet the tree verdict — the
 * window between the two changes. Distinguished from the one above for the same
 * reason it is distinguished at all: it sends the reader somewhere else, namely
 * "this row's file was never checked against the tree, and nothing more can be
 * learned about it now".
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
 * The thrown message for a ledger row THIS BUILD CANNOT EXPLAIN.
 *
 * WHAT REPLACED WHAT, and why the replacement is narrower rather than weaker. The
 * refusal this supersedes fired when the file at ordinal N carried a different
 * name than the row at ordinal N. That comparison is now known to be wrong in both
 * directions (see `migrationIsRecorded`) and, worse, unfixable in the direction
 * that matters: on the live instance the mismatching file's columns were genuinely
 * absent, so the only remedies the message could offer — acknowledge the row, or
 * renumber the file — either left the schema broken or broke every instance where
 * the file HAD applied. Identity reconciliation removes the question entirely: a
 * migration whose name and bytes are both absent from the ledger simply applies.
 *
 * What survives is the half that is still a real danger signal, restated against
 * identity: a row recording a migration NO file in this build corresponds to. That
 * says an unknown migration ran against this database — a branch migration that
 * never merged, or a build that no longer exists — so the schema may carry changes
 * this code does not know about, and the next migration to touch the same table can
 * fail in ways nothing on disk explains. It is exactly how ordinals 122, 124 and
 * 125 came to exist. Fail closed, name the row, and print the entry that resolves
 * it.
 *
 * ONLY ROWS CARRYING A `content_sha256` REACH HERE, and that gate is not a
 * softening — without it this change would brick the fleet. Migration FILES have
 * been deleted from this repository on purpose: `0059_syndication_events` went with
 * the content-sync mesh rip and `0064`–`0068` went in the A2 migration collapse
 * (see `runner.test.ts`, which pins the resulting ordinal gaps). Every instance
 * alive before those removals therefore carries rows naming migrations this build
 * legitimately no longer contains — orphans by construction, on the oldest and most
 * valuable databases. All of them predate provenance and carry no hash.
 *
 * A row with no hash also cannot be ADJUDICATED. The README states what is true of
 * it: nothing more can be learned. Refusing on it would be a boot outage whose only
 * evidence is a NULL, leaving the operator nothing to verify and no move except
 * pasting the entry unread — a ritual, not a check. So the guard refuses where it
 * HAS identity evidence and stays silent where it has none, and it strengthens by
 * itself as rows gain provenance. It is still strictly stronger than the guard it
 * replaces, which could not see these rows AT ALL: that one only ever compared a
 * row against the one file sharing its ordinal.
 *
 * EVERY unexplained row is reported at once, not just the first. An operator
 * recovering from this needs one hand-verification pass and one edit, not one
 * refused boot per row.
 */
function formatUnexplainedLedgerRows(
  unexplained: ReadonlyArray<RecordedMigration>,
  today: string,
): string {
  const entries = JSON.stringify(
    unexplained.map((row) => repairsEntryFor(row.version, row.name, today)),
    null,
    2,
  )
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')
  const plural = unexplained.length === 1 ? '' : 's'
  return [
    `The _migrations ledger records ${unexplained.length} migration${plural} that NO migration file in ` +
      'this build corresponds to — neither by name nor by content hash. An unknown migration ran ' +
      'against this database, so the schema may not match this code.',
    ...unexplained.flatMap((recorded) => [
      '',
      `  recorded "${recorded.name}"`,
      `    ordinal ${recorded.version}`,
      `    applied ${formatAppliedAt(recorded.applied_at)}`,
      `    sha256  ${recorded.content_sha256 ?? ''}`,
      `    build   ${recorded.applied_by_commit ?? NO_BUILD_IDENTITY}`,
      // Whether the row's file was ever established as part of the tree that
      // applied it. On the incidents this work is about, that is THE question — the
      // offending rows named migrations no deployed commit ever contained.
      `    tree    ${recorded.tree_provenance ?? PREDATES_TREE_VERIFICATION}`,
    ]),
    '',
    'NOTHING HAS BEEN APPLIED and nothing has been written — no migration ran, no _migrations row',
    'was written, the ledger was neither created nor reshaped, and no repair was acknowledged.',
    '',
    'The likely cause is a migration from an UNMERGED BRANCH that was applied to this database. Its',
    'schema change is present here and is described nowhere in this build.',
    '',
    'Resolve ONLY with hand-verified entries in migrations/repairs.json. Establish by hand what each',
    "migration did to this database (`PRAGMA table_info(<table>)`, with a column you KNOW exists as a",
    'positive control so an empty result proves absence rather than a typo), then append these:',
    '',
    entries,
    '',
    'Set each `file_name` to the <slug> of the migration in THIS build that the row turns out to have',
    'already applied — that suppresses re-applying it — or to "" when the orphan corresponds to',
    'nothing here, which acknowledges the row alone.',
    '',
    'Never rename or delete a recorded row. It is the incident record.',
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
 * `recorded` is the row already sitting at this ordinal, when there is one. It is
 * CONTEXT, not a second finding: since the runner reconciles by identity, an
 * occupied ordinal is no longer a refusal of its own, and the file here is refused
 * for being untracked whatever else shares its number. Printing the occupant is
 * still worth it — the last outage arrived looking exactly like this, and an
 * operator who sees only "not tracked" while the ordinal is also taken will go
 * looking for a second problem that is not there.
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
          `Ordinal ${migration.version} is ALREADY recorded, under the name "${recorded.name}" — which is the shape`,
          'the last outage was reported in. That is CONTEXT, not a second problem: the runner reconciles',
          'by migration identity, not by ordinal, so a shared ordinal is not itself a fault. Do not reach',
          'for migrations/repairs.json here — an entry would acknowledge a row against a file this',
          'repository does not track, which is the disease rather than the cure. Deleting the stray',
          'clears this outright.',
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

/** The columns a table currently carries, by name. */
function tableColumns(db: Database, table: string): Set<string> {
  return new Set(
    db
      .query<{ name: string }, [string]>('SELECT name FROM pragma_table_info(?)')
      .all(table)
      .map((r) => r.name),
  )
}

/**
 * Whether `_migrations` is still keyed on `version` — i.e. predates the move to
 * name-keyed identity and cannot yet hold two migrations that share an ordinal.
 */
function ledgerIsVersionKeyed(db: Database): boolean {
  return db
    .query<{ name: string; pk: number }, []>("SELECT name, pk FROM pragma_table_info('_migrations')")
    .all()
    .some((column) => column.name === 'version' && column.pk > 0)
}

/**
 * The ledger's own DDL. Kept as one string so the table a rekey builds is
 * byte-identical to the one a fresh install creates, and so the schema snapshot
 * has exactly one thing to track.
 *
 * `name` IS THE PRIMARY KEY AND `version` IS PLAIN DATA. That inversion is the
 * whole fix. `version` used to be the key, which asserted that an ordinal
 * identifies a migration — it does not (see `migrationIsRecorded`), and the
 * assertion was load-bearing in the worst way: on an instance where a branch
 * migration had consumed ordinal 125, the merged migration numbered 0125 could not
 * be recorded at all, because its own ordinal was taken by a row for something
 * else. There was no correct value to write. Every candidate was a lie about one
 * field or another — a surrogate ordinal in a column named `version`, or a rewrite
 * of a row that is an incident record. Keying on the name removes the conflict
 * instead of choosing which field to falsify: two rows may now share a `version`,
 * which is simply true of a fleet where two migrations were both written as 0125.
 */
function ledgerDdl(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
       version INTEGER NOT NULL,
       name TEXT NOT NULL PRIMARY KEY,
       applied_at REAL NOT NULL
     )`
}

/** Bring a ledger table up to the current provenance columns. Idempotent. */
function addProvenanceColumns(db: Database, table: string): void {
  const present = tableColumns(db, table)
  for (const [column, type] of PROVENANCE_COLUMNS) {
    if (present.has(column)) continue
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    } catch (err) {
      // Check-then-ALTER is not atomic. If two processes boot at once on the
      // first run after an upgrade, both can read the column as absent and the
      // loser gets "duplicate column name". The post-state is what matters and
      // it is correct, so re-read rather than take down a boot over a race we
      // won either way. Anything else still throws — this widens nothing.
      if (!tableColumns(db, table).has(column)) throw err
    }
  }
}

/** Where the old rows live for the duration of a rekey. */
const LEDGER_LEGACY_TABLE = '_migrations_version_keyed'

/** Whether a provenance column actually recorded something. `''` is not a record. */
function hasProvenance(value: string | null): boolean {
  return value !== null && value.length > 0
}

/**
 * One row per migration NAME, from a legacy ledger that may hold the same name at
 * two different ordinals.
 *
 * THAT SHAPE IS LEGITIMATE, NOT CORRUPT, WHICH IS WHY IT IS COLLAPSED RATHER THAN
 * REFUSED. Migrations in this tree are idempotent by contract (`AGENTS.md`), and the
 * old runner deduplicated on the ORDINAL — so when a merge renumbered an
 * already-applied file to an ordinal the instance had not spent, that runner
 * re-applied it (harmlessly) and recorded a SECOND row under the new number. One
 * name, two ordinals, both rows true, nothing missing from the schema. Refusing that
 * would brick the boot of instances that were healthy, which is this file's own
 * defect class — an ordinal treated as an identity — reintroduced by its fix.
 *
 * The distinction being preserved is between a ledger this build can EXPLAIN and one
 * it cannot. Two ordinals for one name is fully explained by the paragraph above, so
 * it collapses here. A recorded migration that corresponds to NO file in this build
 * is explained by nothing, and it still fails closed — that guard lives in
 * `applyMigrations` and this function does not touch it.
 *
 * DETERMINISTIC, AND IT LOSES NOTHING RECORDED. The surviving row is the one applied
 * EARLIEST (ties broken by ordinal, then name) because that is when the schema
 * change actually landed on this database, and `applied_at` is the field that claims
 * to say so. Provenance is then filled from any row in the group that carries it:
 * the earliest row is typically the oldest release's, written before provenance
 * shipped and therefore NULL, while the re-record carries a real hash and commit.
 * Keeping the early row's identity and the late row's provenance is strictly more
 * truth than either row alone, and discarding a recorded hash for a NULL would throw
 * away the only forensic evidence the instance has.
 */
function collapseLedgerRowsByName(rows: RecordedMigration[]): RecordedMigration[] {
  const ordered = [...rows].sort(
    (a, b) => a.applied_at - b.applied_at || a.version - b.version || a.name.localeCompare(b.name),
  )
  const kept = new Map<string, RecordedMigration>()
  for (const row of ordered) {
    const winner = kept.get(row.name)
    if (winner === undefined) {
      kept.set(row.name, { ...row })
      continue
    }
    if (!hasProvenance(winner.content_sha256)) winner.content_sha256 = row.content_sha256
    if (!hasProvenance(winner.applied_by_commit)) winner.applied_by_commit = row.applied_by_commit
    if (!hasProvenance(winner.tree_provenance)) winner.tree_provenance = row.tree_provenance
  }
  return [...kept.values()]
}

/**
 * Move the ledger's primary key from `version` to `name`, preserving every migration.
 *
 * ONE TRANSACTION, and the rename happens FIRST so the surviving `_migrations` is
 * created by `ledgerDdl` directly rather than by `ALTER TABLE ... RENAME TO` —
 * which rewrites `sqlite_master` with the table name quoted and would leave a
 * rekeyed instance's schema text subtly different from a fresh install's for no
 * reason. Either the whole swap lands or the ledger is untouched.
 *
 * THE PROVENANCE COLUMNS ARE ADDED IN HERE, INSIDE THE TRANSACTION, AND THAT
 * PLACEMENT IS THE POINT. `ALTER TABLE ... ADD COLUMN` is a statement like any other:
 * run outside an explicit transaction it is its own implicit one and COMMITS. The
 * caller used to add them before calling this, so a failed rekey rolled back the swap
 * while the columns stayed — and the error below told the operator the ledger was
 * unchanged, which was false. SQLite rolls DDL back with everything else, so moving
 * the ALTERs inside the `BEGIN IMMEDIATE` makes the sentence true instead of
 * softening it.
 *
 * A DUPLICATE NAME DOES NOT FAIL THE COPY — `collapseLedgerRowsByName` resolves it,
 * for the reasons documented there. The copy is row-by-row rather than one
 * `INSERT ... SELECT` because the collapse is a decision about a GROUP of rows, and
 * it needs the legacy ledger read shape-tolerantly anyway (a pre-provenance ledger
 * has none of the three columns to select).
 *
 * CONCURRENT REKEY IS SAFE. `BEGIN IMMEDIATE` takes the write lock up front, so a
 * second process racing the same upgrade gets SQLITE_BUSY rather than a half-built
 * table — and `nexus-store.ts` already classifies busy as the init race it retries,
 * where the retry finds the ledger rekeyed and does nothing.
 */
function rekeyLedgerOnName(db: Database): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`DROP TABLE IF EXISTS ${LEDGER_LEGACY_TABLE}`)
    db.exec(`ALTER TABLE _migrations RENAME TO ${LEDGER_LEGACY_TABLE}`)
    db.exec(ledgerDdl('_migrations'))
    addProvenanceColumns(db, '_migrations')
    for (const row of collapseLedgerRowsByName(selectLedgerRows(db, LEDGER_LEGACY_TABLE))) {
      db.run(
        `INSERT INTO _migrations
           (version, name, applied_at, content_sha256, applied_by_commit, tree_provenance)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          row.version,
          row.name,
          row.applied_at,
          row.content_sha256,
          row.applied_by_commit,
          row.tree_provenance,
        ],
      )
    }
    db.exec(`DROP TABLE ${LEDGER_LEGACY_TABLE}`)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    // WHAT THIS SENTENCE MAY AND MAY NOT CLAIM. "The ledger is unchanged" is now
    // literally true — the swap, the provenance ALTERs and the copy are all inside
    // the transaction that just rolled back. It deliberately does NOT say "the
    // database is unchanged": on this same path `applyMigrations` may already have
    // written acknowledgement rows to `_migration_repairs` before calling us, and an
    // operator sent looking for a pristine database would be sent wrong. State the
    // narrow claim that holds, and name the one thing that may not.
    throw new Error(
      'The _migrations ledger could not be rekeyed from its ordinal onto the migration name. The ' +
        'ledger is unchanged — its shape, its columns and its rows are exactly what they were ' +
        'before this boot, because the whole rekey runs in one transaction that has rolled back. ' +
        '(A `_migration_repairs` acknowledgement row, if this boot had one to write, was written ' +
        'before the rekey and is still there.) Two rows recording one migration name is NOT the ' +
        'cause: that is a legitimate history and it is collapsed, not refused. SQLite reported: ' +
        (err instanceof Error ? err.message : String(err)),
      { cause: err },
    )
  }
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
 * This exists so that DECIDING costs no write. Both refusals — an unexplained
 * ledger row and an untracked file — read the ledger and can then refuse having
 * touched nothing whatsoever, including on a fresh database where `CREATE TABLE`
 * would otherwise have been the one write standing between the message's claim and
 * the truth.
 */
function readLedger(db: Database): Ledger {
  if (!ledgerExists(db)) return buildLedger([])
  return buildLedger(selectLedgerRows(db, '_migrations'))
}

/**
 * Every row of a ledger table, whatever provenance columns it does or does not
 * carry. The table is named because the rekey reads the legacy copy with exactly
 * these semantics — a ledger written before provenance shipped has none of the
 * three columns, and selecting them as NULL is both what SQLite needs and what is
 * true of those rows.
 */
function selectLedgerRows(db: Database, table: string): RecordedMigration[] {
  const present = tableColumns(db, table)
  const provenance = PROVENANCE_COLUMNS.map(([column]) =>
    present.has(column) ? column : `NULL AS ${column}`,
  ).join(', ')
  return db
    .query<RecordedMigration, []>(`SELECT version, name, applied_at, ${provenance} FROM ${table}`)
    .all()
}

/**
 * Every view of the ledger the runner needs, derived once.
 *
 * `byVersion` IS FOR MESSAGES ONLY, and it is first-write-wins because it has to
 * be: a rekeyed ledger may hold two rows at one ordinal, so there is no such thing
 * as "the row at ordinal N" any more. No decision reads it — the moment one did,
 * the ordinal would be back to being an identity.
 */
interface Ledger extends LedgerIdentity {
  readonly rows: ReadonlyArray<RecordedMigration>
  readonly byVersion: ReadonlyMap<number, RecordedMigration>
}

function buildLedger(rows: RecordedMigration[]): Ledger {
  const byVersion = new Map<number, RecordedMigration>()
  for (const row of rows) if (!byVersion.has(row.version)) byVersion.set(row.version, row)
  return {
    rows,
    names: new Set(rows.map((r) => r.name)),
    hashes: new Set(
      rows.map((r) => r.content_sha256).filter((h): h is string => h !== null && h.length > 0),
    ),
    byVersion,
  }
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
 * Forward-only and idempotent, and re-running is a no-op because
 * `pragma_table_info` is consulted first (SQLite has no
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). Columns are only ever added, never
 * dropped or renamed. The one non-additive step is `rekeyLedgerOnName`, which moves
 * the PRIMARY KEY off `version` and onto `name`; it preserves every row and every
 * column value, and it is not optional — a ledger keyed on the ordinal physically
 * cannot record a migration whose ordinal another migration already spent, which is
 * the state that took the live instance down.
 */
function ensureLedgerShape(db: Database): void {
  // The rekey runs only for a ledger that predates name-keying, and only on this
  // path — the one that is about to write a row. A steady-state boot never reshapes
  // the ledger, so an instance stays version-keyed until its next pending migration
  // and reads work either way (identity comes from `name` and `content_sha256`,
  // neither of which the key affects).
  //
  // IT RETURNS RATHER THAN FALLING THROUGH, and the ALTERs below are not run first.
  // `rekeyLedgerOnName` builds the new ledger from `ledgerDdl` and adds the
  // provenance columns to it INSIDE its own transaction, so a failed rekey leaves
  // nothing behind. Adding them here would put a committing `ALTER TABLE` in front
  // of that transaction and make its "the ledger is unchanged" false — see the
  // function.
  if (ledgerExists(db) && ledgerIsVersionKeyed(db)) {
    rekeyLedgerOnName(db)
    return
  }
  db.exec(ledgerDdl('_migrations'))
  addProvenanceColumns(db, '_migrations')
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
 * where no row is written. That is not "unknown" — it is "no run happened".
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
 * Refuse two files claiming one migration NAME.
 *
 * The name is the ledger's identity and its primary key, so two files sharing a
 * slug are indistinguishable once recorded: whichever applied first makes the other
 * read as already-applied forever, and its statements never run. That is the same
 * silent-missing-schema failure the ordinal used to cause, one level over.
 *
 * Unconditional, unlike the ordinal check — it needs no tree verdict, because an
 * untracked stray sharing a slug with a tracked file is refused by the untracked
 * guard anyway, and a duplicate slug is a mistake in this repository either way.
 */
function assertUniqueMigrationNames(migrations: Migration[]): void {
  const byName = new Map<string, Migration>()
  for (const migration of migrations) {
    const previous = byName.get(migration.name)
    if (previous) {
      throw new Error(
        `Migration name collision on "${migration.name}": ${previous.fileName} and ${migration.fileName}. ` +
          'The migration name is the ledger identity and must be unique across the tree.',
      )
    }
    byName.set(migration.name, migration)
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
  const ledger = readLedger(db)
  const migrations = loadMigrations(dir)
  assertUniqueMigrationNames(migrations)
  /**
   * The repairs that SPEAK on this database, and nothing else.
   *
   * An entry only takes effect when the row it names is actually present — an
   * ordinal carrying exactly that recorded name. This is the property that keeps
   * `repairs.json` inert on every instance it is not about, a FRESH INSTALL above
   * all: entry 122 says `trident_checkpoint_head` is already applied on the one
   * instance where it was applied by hand, and on a new database that migration
   * must obviously run. Gating on the row's presence is what distinguishes the two,
   * and it is the same trigger condition the ordinal-based version had.
   */
  const activeRepairs = loadMigrationRepairs(dir).filter((repair) =>
    ledger.rows.some(
      (row) => row.version === repair.version && row.name === repair.recorded_name,
    ),
  )
  // WHAT AN ACTIVE REPAIR ASSERTS, in two independent halves — the shipped entries
  // need both. (1) The migration named by `file_name` is ALREADY APPLIED here, hand
  // verified, so it must not run: on the live instance ordinal 122's schema change
  // was applied by hand and never recorded, so identity reconciliation would
  // otherwise re-run its `ALTER`s and fail on duplicate columns. (2) The row itself
  // is an acknowledged orphan, so the refusal below stays silent about it.
  const repairedNames = new Set(activeRepairs.map((repair) => repair.file_name))
  const acknowledgedRows = new Set(
    activeRepairs.map((repair) => repairKey(repair.version, repair.recorded_name)),
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
  //
  // PENDING IS DECIDED BY IDENTITY, NOT BY ORDINAL — the change this whole file
  // turns on. See `migrationIsRecorded`.
  const pendingMigrations = migrations.filter(
    (m) => !repairedNames.has(m.name) && !migrationIsRecorded(m, ledger),
  )
  const pendingNames = new Set(pendingMigrations.map((m) => m.name))
  const pending = pendingMigrations.length > 0
  // Both provenance reads happen ONCE per run, and only when something is pending,
  // so a steady-state boot does no filesystem work at all. `dir` is the search
  // origin: for the instance tree that walks up to the checkout's `.git`, and for a
  // sidecar tree (`migrations/comments`) it finds the same one.
  const deployedCommit = pending ? resolveDeployedCommit(process.env, dir) : null
  const tree = pending ? resolveDeployedTree(dir) : null
  // The tracked-file list, or null when there is none to compare against. A
  // `null` here is "cannot verify" and refuses nothing — see `resolveDeployedTree`.
  const verified = tree !== null && tree.kind === 'verified' ? tree : null
  // AFTER the tree verdict, not before it, so a stray colliding with a tracked
  // file is diagnosed as the stray it is. A collision always leaves at least one of
  // the two files pending — a stray was never recorded — so the verdict above is
  // never null for the reason that matters here. See the function for the argument.
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

  const today = new Date().toISOString().slice(0, 10)
  // A pending file that is present but untracked is not a migration this build
  // contains, and applying it writes a permanent ledger row for something that will
  // not exist after the next checkout. Fail closed, name the file. ONLY PENDING
  // files are checked: a migration already recorded is already permanent, and
  // refusing forever over a stray applied long ago would be an outage with no
  // remedy. This guard's job is to stop the silent APPLY, the only moment damage is
  // done. The row sharing the ordinal, if any, is passed for context only.
  for (const migration of pendingMigrations) {
    const untracked = refusesFile(migration)
    if (untracked !== null) {
      throw new Error(
        formatUntrackedMigration(
          migration,
          untracked,
          deployedCommit,
          ledger.byVersion.get(migration.version) ?? null,
        ),
      )
    }
  }
  // THE REMAINING FAIL-CLOSED GUARD, restated against identity: a recorded
  // migration that NO file in this build corresponds to. Hashes are computed lazily
  // and only for the rows that survive the name check, so a healthy boot hashes
  // nothing. See `formatUnexplainedLedgerRows` for why only rows carrying a
  // `content_sha256` are adjudicated, and why that is narrower rather than weaker.
  const fileNames = new Set(migrations.map((m) => m.name))
  const candidateRows = ledger.rows.filter(
    (row) =>
      row.content_sha256 !== null &&
      row.content_sha256.length > 0 &&
      !fileNames.has(row.name) &&
      !acknowledgedRows.has(repairKey(row.version, row.name)),
  )
  if (candidateRows.length > 0) {
    const fileHashes = new Set(migrations.map((m) => migrationContentHash(m.sql)))
    const unexplained = candidateRows.filter(
      (row) => row.content_sha256 === null || !fileHashes.has(row.content_sha256),
    )
    if (unexplained.length > 0) throw new Error(formatUnexplainedLedgerRows(unexplained, today))
  }

  // ---- Past this line, and not before it, the database is written to. ----

  if (activeRepairs.length > 0) {
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
  for (const repair of activeRepairs) {
    db.run(
      `INSERT OR IGNORE INTO _migration_repairs
       (version, recorded_name, file_name, note, acknowledged_at) VALUES (?, ?, ?, ?, ?)`,
      [repair.version, repair.recorded_name, repair.file_name, repair.note, Date.now() / 1000],
    )
  }
  const applied: number[] = []
  const skipped: number[] = []
  // NULL when nothing is pending, which is also the only case where no row is
  // written — see `treeProvenanceOf`.
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
    if (!pendingNames.has(m.name)) {
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
