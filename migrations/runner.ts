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
import { createLogger, type LogFields } from '@neutronai/logger'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The runner's one log sink, for the ADVISORY notices only.
 *
 * Every refusal in this file is thrown, not logged, and that stays true: a boot gate
 * whose diagnosis went to a log the operator may never read would be a gate that
 * failed quietly. This exists for what must be said WITHOUT stopping the boot — see
 * `contentDriftFields`, which is the one such case.
 */
const log = createLogger('migrations')

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

/**
 * A row that RECORDED ITS CONTENT HASH, and therefore one that can be adjudicated
 * against this build at all.
 *
 * The distinction is load-bearing rather than cosmetic. Only these rows reach the
 * unexplained-row refusal and the content-drift notice, and both of them print or
 * compare the hash — so a `string | null` there forces a `?? ''` or a redundant null
 * test at every use, each of which reads as a mode the code can enter. It cannot: every
 * such site sits behind `isHashed`. Naming the narrowed shape once is what lets those
 * branches be deleted rather than commented.
 */
type HashedMigration = RecordedMigration & { content_sha256: string }

/** Whether a row recorded its content hash. The narrowing form of `hasProvenance`. */
function isHashed(row: RecordedMigration): row is HashedMigration {
  return hasProvenance(row.content_sha256)
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
  /**
   * Every non-NULL `content_sha256`, mapped to the NAMES of the rows carrying it.
   *
   * THE OWNERS ARE WHAT MAKE THE HASH SAFE TO WIDEN ON, and a bare set of hashes was
   * not. See `classifyMigration`: "these bytes are recorded" is only evidence that
   * THIS file has run if the row recording them is a row no file in this build already
   * accounts for. Without the owner's name there is no way to ask that question.
   */
  readonly hashOwners: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * What the ledger says about one migration file.
 *
 * A verdict rather than a boolean because the fourth answer exists and used to be
 * silently folded into "recorded" — see `classifyMigration`.
 */
export type MigrationVerdict =
  /** No row accounts for this file. It runs. */
  | 'pending'
  /** A row records this migration's NAME. The ordinary already-applied answer. */
  | 'recorded-by-name'
  /** A row records these exact BYTES under a name this build no longer uses. */
  | 'recorded-by-content'
  /** These bytes are recorded, but by a row another file in this build accounts for. */
  | 'duplicates-an-applied-file'

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
 * WIDENING ON THE HASH NEEDS THE ROW'S NAME, AND WITHOUT IT THE WIDENING WAS A
 * SILENT-SKIP BUG. "These bytes are recorded" reads as "this file has already run",
 * and that inference is only sound when the recording row is one no file in this build
 * already accounts for — the rename/renumber case the widening exists for. When the
 * row's name IS a file here, the bytes are recorded because THAT file ran, and this is
 * a SECOND, differently-named file that happens to be byte-identical. Treating it as
 * applied meant it never ran, never recorded, and the run reported success with the
 * file listed under `skipped` — the same silent-missing-schema failure as the ordinal
 * bug, arrived at through the fix for it. So that case gets its own verdict and the
 * caller refuses on it. Two files with identical bytes is a mistake in this repository
 * exactly as two files with one name is, and it is caught in the one place it can do
 * damage rather than by hashing the whole tree on every boot.
 *
 * The name is checked FIRST so a steady-state boot hashes nothing at all.
 */
export function classifyMigration(
  migration: Migration,
  ledger: LedgerIdentity,
  /** Every migration NAME this build contains. */
  treeNames: ReadonlySet<string>,
): MigrationVerdict {
  if (ledger.names.has(migration.name)) return 'recorded-by-name'
  if (ledger.hashOwners.size === 0) return 'pending'
  const owners = ledger.hashOwners.get(migrationContentHash(migration.sql))
  if (owners === undefined) return 'pending'
  for (const owner of owners) if (!treeNames.has(owner)) return 'recorded-by-content'
  return 'duplicates-an-applied-file'
}

function loadMigrationRepairs(dir: string): MigrationRepair[] {
  const path = join(dir, 'repairs.json')
  if (!existsSync(path)) return []
  const repairs: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(repairs)) throw new Error(`${path} must contain a JSON array`)
  return repairs as MigrationRepair[]
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
 * operator never has to infer the convention from the matcher — `recorded_name` is
 * what the entry is matched on (see `activeRepairs`), and getting it wrong is the one
 * mistake that silently does nothing.
 *
 * `version` IS EMITTED AS CONTEXT, NOT AS PART OF THE MATCH. It records the ordinal
 * the row was written under, and it is copied into `_migration_repairs` for the audit
 * trail, so an entry whose ordinal is stale still activates rather than quietly
 * ceasing to.
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
 * directions (see `classifyMigration`) and, worse, unfixable in the direction
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
 * itself as rows gain provenance.
 *
 * IT IS NOT STRICTLY STRONGER THAN THE GUARD IT REPLACES, and an earlier version of
 * this comment claimed it was. The claim was wrong in a way worth recording, because
 * the wrongness is the whole reason this rewrite exists. The old guard compared the row
 * at ordinal N against the FILE at ordinal N, so it refused on a HASHLESS orphan
 * whenever a build file occupied that orphan's number — and that is exactly how 122,
 * 124 and 125 were noticed at all. This guard cannot see those rows: no hash, no
 * adjudication. So the two are not ordered. What is traded is deliberate and it runs
 * in both directions: the old guard caught hashless orphans that happened to collide
 * with a build file, and paid for it by refusing legitimate boots on every instance
 * where a merge had merely renumbered a migration — an unfixable refusal, because its
 * two remedies were "acknowledge the row" (leaving the schema genuinely broken) and
 * "renumber the file" (breaking every instance where the file HAD applied). This guard
 * sees every orphan carrying identity evidence regardless of ordinal, and misses the
 * hashless ones. The reason that is the better trade is that the loud failure it gives
 * up was never the mechanism that FIXED anything, and the false refusals it removes had
 * no remedy at all; provenance closes the gap going forward, because every row written
 * from here on carries a hash.
 *
 * EVERY unexplained row is reported at once, not just the first. An operator
 * recovering from this needs one hand-verification pass and one edit, not one
 * refused boot per row.
 */
function formatUnexplainedLedgerRows(
  unexplained: ReadonlyArray<HashedMigration>,
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
      `    sha256  ${recorded.content_sha256}`,
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
 * The thrown message for a file whose BYTES are already recorded by a row that
 * ANOTHER file in this build accounts for.
 *
 * WHY THIS IS A REFUSAL AND NOT A SKIP. Hash widening answers "has this migration run
 * under a different name?", and it is sound only against a row no file here explains.
 * When the row's name is itself a file in this tree, the honest reading of the evidence
 * is not "this file has run" — it is "two files in this build have identical bytes, and
 * one of them ran". Calling that applied is how a real migration comes to never run,
 * never record, and be reported as `skipped` on a boot that exits zero: the ordinal
 * bug's exact failure mode, re-entered through the mechanism that fixed it.
 *
 * IT NAMES BOTH FILES, because the operator cannot act on either one alone. Which of
 * the two is redundant is a judgement about intent that only they can make, and the
 * remedies differ completely: a copy-paste leftover gets deleted, while two migrations
 * that genuinely need the same statements need one of them to differ (a comment naming
 * what it is for is enough — the hash is over the bytes).
 *
 * NOT RESOLVABLE THROUGH `repairs.json`, and it says so. Those entries acknowledge a
 * LEDGER ROW; here the ledger is fine and the duplication is in the tree.
 */
function formatDuplicateContentMigrations(
  duplicates: ReadonlyArray<{ readonly migration: Migration; readonly recordedName: string }>,
): string {
  return [
    `${duplicates.length} migration file(s) in this build have the same BYTES as a migration that has ` +
      'already been applied under a different name, and the already-applied one is ALSO a file in this ' +
      'build. Refusing, because treating these as applied would mean they never run at all.',
    ...duplicates.flatMap(({ migration, recordedName }) => [
      '',
      `  ${migration.fileName}`,
      `    sha256    ${migrationContentHash(migration.sql)}`,
      `    identical to the applied migration recorded as "${recordedName}"`,
    ]),
    '',
    'NOTHING HAS BEEN APPLIED and nothing has been written — no migration ran, no _migrations row',
    'was written, the ledger was neither created nor reshaped, and no repair was acknowledged.',
    '',
    'Two files with identical content cannot be told apart by the content hash, so the runner cannot',
    'know which one a recorded hash refers to. That is the same ambiguity two files sharing a NAME',
    'create, and it is a mistake in this repository rather than a state of the database.',
    '',
    'Resolve by ONE of:',
    '  - DELETE the redundant file, if it is a copy of a migration that has already merged under',
    '    another name — the usual cause, and the usual remedy.',
    '  - MAKE THEM DIFFER, if both are genuinely wanted. The hash is over the bytes, so a header',
    '    comment naming what each one is for is enough, and is worth having anyway.',
    '',
    'Do NOT reach for migrations/repairs.json. Those entries acknowledge a row in the ledger; the',
    'ledger is not the problem here and an entry would hide a duplicate that is still duplicated.',
  ].join('\n')
}

/**
 * The advisory line for a migration recorded under this name whose recorded bytes are
 * NOT the bytes now on disk.
 *
 * A NOTICE AND DELIBERATELY NOT A GATE. Refusing here is a decision this repository
 * has already weighed and rejected — README § "`content_sha256` is recorded and
 * reported, not enforced", pointed at by `docs/INVARIANTS.md`: already-applied files
 * are edited in place for benign reasons (a comment, a reflow, a typo in a string
 * literal), none of which change the schema that landed, and a gate turns every one of
 * those into a crash loop resolvable only through `repairs.json`. That decision stands
 * and this does not touch it.
 *
 * WHAT IT FIXES IS THE SILENCE, WHICH WAS NOT PART OF THAT DECISION. The dangerous
 * shape is a migration amended during review and renumbered by the merge: an instance
 * that ran the earlier bytes has the name recorded, so the amended file reads as
 * applied, its added statements never run, and the boot reports success with a schema
 * that quietly lacks them. Both hashes are in hand at that moment and nothing was said.
 * The runner cannot tell that case from a reflow — only the operator can — so it prints
 * what it knows and lets the boot continue.
 *
 * THE ORDINAL IS CALLED OUT AS ITS OWN FIELD WHEN IT ALSO MOVED, because that
 * combination is the one a benign in-place edit cannot produce: an edit keeps its
 * filename, so changed bytes AND a changed number means the file that ran is not the
 * file on disk. `renumbered=true` is therefore the line worth reading, and it is a
 * field rather than prose so it can be grepped for.
 *
 * FIELDS RATHER THAN A PROSE BLOB, unlike the refusals above. Those are thrown, so
 * they are the last thing an operator sees and can afford to be a page long; this goes
 * through the logfmt logger, which quotes a value containing whitespace — a multi-line
 * message would arrive as one escaped string.
 */
function contentDriftFields(migration: Migration, recorded: HashedMigration): LogFields {
  const renumbered = recorded.version !== migration.version
  return {
    migration: migration.name,
    recorded_sha256: recorded.content_sha256,
    on_disk_sha256: migrationContentHash(migration.sql),
    renumbered,
    ...(renumbered ? { recorded_ordinal: recorded.version, on_disk: migration.fileName } : {}),
    note: renumbered
      ? 'bytes AND ordinal both moved, which an in-place edit cannot cause: the file that ran is not this file, so check the amended statements by hand'
      : 'harmless if the edit was a comment or a reflow; if it added schema, those statements did NOT run here',
    enforced: false,
  }
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
 * identifies a migration — it does not (see `classifyMigration`), and the
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
 * DETERMINISTIC. The surviving row is the one applied EARLIEST (ties broken by
 * ordinal, then name) because that is when the schema change actually landed on this
 * database, and `applied_at` is the field that claims to say so.
 *
 * THE PROVENANCE TRIPLE IS ADOPTED WHOLE, FROM ONE DONOR ROW, AND THAT IS THE POINT
 * OF THIS FUNCTION'S SECOND HALF. The earliest row is typically the oldest release's,
 * written before provenance shipped and therefore NULL across all three columns,
 * while the re-record carries a real hash and commit — so keeping the early row's
 * identity and adopting a later row's provenance is more truth than either row alone,
 * and dropping a recorded hash for a NULL would discard the only forensic evidence the
 * instance has.
 *
 * What it must NOT do is fill the three columns INDEPENDENTLY. They are not three
 * facts, they are one: `content_sha256`, `applied_by_commit` and `tree_provenance` are
 * written together, inside a single migration's own transaction, and together they say
 * "these bytes, from this build, verified this way". Filling each from whichever row
 * happened to have it synthesises a tuple NO ROW EVER HAD — one row's hash beside
 * another row's commit — which is a fabricated forensic record in the columns that
 * exist precisely so a later investigation can trust them. A row that has to be
 * discounted is worse than a NULL, which is the argument
 * `TRACKED_IN_DEPLOYED_TREE` already makes about overclaiming.
 *
 * So the donor is a single row, and `content_sha256` is what identifies one: it is the
 * only member of the triple the runner writes unconditionally (the other two are
 * legitimately NULL for a tarball install, or for a build predating tree
 * verification), so a row carrying it recorded provenance and a row without it
 * predates provenance entirely. The first such row in the order above wins, and all
 * three of its values are taken — NULLs included.
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
    // The winner already recorded its own provenance, or this row has none to give.
    // Either way there is nothing to adopt, and mixing is what must not happen.
    if (hasProvenance(winner.content_sha256)) continue
    if (!hasProvenance(row.content_sha256)) continue
    winner.content_sha256 = row.content_sha256
    winner.applied_by_commit = row.applied_by_commit
    winner.tree_provenance = row.tree_provenance
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
 *
 * THE SCRATCH NAME IS REFUSED WHEN OCCUPIED, NEVER CLEARED. This used to open with
 * `DROP TABLE IF EXISTS _migrations_version_keyed`, which is a data-destroying
 * statement guarded by nothing — and because the drop is inside the transaction that
 * goes on to COMMIT, a real table there was deleted PERMANENTLY, silently, on a boot
 * whose whole contract is that it repairs the ledger without losing a row. The reason
 * that line looked safe is the reason it was not: this function cannot leave one
 * behind. The rename, the copy and the final drop are one `BEGIN IMMEDIATE`, so a
 * crash or an error rolls the scratch table away with everything else. There is
 * therefore no "leftover from an interrupted rekey" for the DROP to clean up — the
 * state it was written to handle cannot occur. Anything actually sitting at that name
 * came from somewhere else and is somebody's data, so the honest move is to fail
 * closed and name it. Refusing costs a boot the operator can fix in one statement;
 * dropping costs them a table with no warning and no record.
 */
function rekeyLedgerOnName(db: Database): void {
  // BEFORE the transaction, so the throw carries no rollback ambiguity: nothing has
  // been attempted yet, and the message below can state that without qualification.
  if (tableExists(db, LEDGER_LEGACY_TABLE)) {
    throw new Error(
      `The _migrations ledger must be rekeyed from its ordinal onto the migration name, but the ` +
        `table ${LEDGER_LEGACY_TABLE} already exists and the rekey needs that name free. NOTHING ` +
        'HAS BEEN APPLIED and nothing has been written — no migration ran, no row was written, the ' +
        'ledger was neither reshaped nor read into it.\n\n' +
        'This is NOT a leftover from an interrupted rekey. The whole rekey is one transaction, so a ' +
        'failed or killed one rolls that table away with everything else; it can never be left ' +
        'behind. So the table holds data this runner did not put there, and it is deliberately NOT ' +
        'dropped — an earlier version of this code dropped it unconditionally, which silently and ' +
        'permanently destroyed whatever was in it.\n\n' +
        `Resolve by hand, after looking at it (\`SELECT * FROM ${LEDGER_LEGACY_TABLE} LIMIT 5\`): ` +
        'rename it to something outside this runner\'s namespace if the contents matter, or drop it ' +
        'yourself once you have established they do not. Then boot again.',
    )
  }
  db.exec('BEGIN IMMEDIATE')
  try {
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
    // operator told to expect a wholly untouched database would be sent wrong. State
    // the narrow claim that holds, and name the one thing that may not.
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

/**
 * Whether a TABLE by this name exists. Deliberately `type = 'table'` and not a
 * bare name lookup: `sqlite_master` also holds views, indexes and triggers, and
 * the two callers are asking different questions that both need the narrow one —
 * "is there a ledger to read" and "is the rekey's scratch name free".
 */
function tableExists(db: Database, table: string): boolean {
  return (
    db
      .query<{ ok: number }, [string]>(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) !== null
  )
}

/** Whether `_migrations` exists yet. A fresh database has no ledger at all. */
function ledgerExists(db: Database): boolean {
  return tableExists(db, '_migrations')
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
  /**
   * The row recording each NAME. Unlike `byVersion` this is a real index, because
   * the name IS the identity and (once rekeyed) the primary key — at most one row can
   * answer to it. A pre-rekey ledger can hold the same name twice, and first-write-wins
   * over the select order is fine for the one thing that reads this: the
   * content-drift notice, which is advisory and whose two rows would carry the same
   * name and therefore the same question.
   */
  readonly byName: ReadonlyMap<string, RecordedMigration>
}

function buildLedger(rows: RecordedMigration[]): Ledger {
  const byVersion = new Map<number, RecordedMigration>()
  for (const row of rows) if (!byVersion.has(row.version)) byVersion.set(row.version, row)
  const byName = new Map<string, RecordedMigration>()
  for (const row of rows) if (!byName.has(row.name)) byName.set(row.name, row)
  const hashOwners = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!hasProvenance(row.content_sha256)) continue
    const hash = row.content_sha256 as string
    const owners = hashOwners.get(hash)
    if (owners === undefined) hashOwners.set(hash, new Set([row.name]))
    else owners.add(row.name)
  }
  return {
    rows,
    names: new Set(rows.map((r) => r.name)),
    hashOwners,
    byVersion,
    byName,
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
 *
 * THE VERDICT MUST BE RESOLVED ON EVERY BOOT THAT HAS A COLLISION, and the caller
 * does that — see `hasOrdinalCollision`. A verdict resolved only when something is
 * pending would make this function's answer depend on whether there was work to do,
 * which is the one thing a classification must not depend on.
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
 * Whether two files in this tree claim one ordinal.
 *
 * A PURE IN-MEMORY CHECK OVER THE ALREADY-LOADED TREE, and that is what makes it
 * usable as the trigger for resolving the tree verdict. It touches no filesystem, so
 * a healthy tree — which has no collision — still resolves nothing and a steady-state
 * boot still does no filesystem work at all. Only a tree that has something to
 * classify pays for the classification.
 */
function hasOrdinalCollision(migrations: Migration[]): boolean {
  const seen = new Set<number>()
  for (const migration of migrations) {
    if (seen.has(migration.version)) return true
    seen.add(migration.version)
  }
  return false
}

/** Whether two files in this tree claim one migration NAME. Same shape, same reason. */
function hasNameCollision(migrations: Migration[]): boolean {
  const seen = new Set<string>()
  for (const migration of migrations) {
    if (seen.has(migration.name)) return true
    seen.add(migration.name)
  }
  return false
}

/**
 * Refuse two files claiming one migration NAME.
 *
 * The name is the ledger's identity and its primary key, so two files sharing a
 * slug are indistinguishable once recorded: whichever applied first makes the other
 * read as already-applied forever, and its statements never run. That is the same
 * silent-missing-schema failure the ordinal used to cause, one level over.
 *
 * IT TAKES THE TREE VERDICT ONLY TO IMPROVE THE MESSAGE, never to stand aside, and
 * that asymmetry with the ordinal check is the whole of what this parameter is for. The
 * ordinal check DEFERS to the untracked refusal, and it can: a stray sharing an ordinal
 * leaves the tracked file pending, so the refusal loop reaches it and speaks. A stray
 * sharing a NAME cannot be deferred, because the shared name is exactly what makes the
 * tracked file read as already-applied — so nothing is pending, the loop reaches
 * nobody, and standing aside would mean booting on a tree with two files the ledger
 * cannot tell apart.
 *
 * This used to be documented as deferring anyway. The docblock claimed "an untracked
 * stray sharing a slug with a tracked file is refused by the untracked guard anyway",
 * and it was aspirational: this check ran BEFORE the tree was ever resolved, so the
 * path it described was unreachable, and what the operator actually got was the bare
 * two-filenames line below — no mention that one of the files is not tracked, and no
 * hint that deleting it is the remedy. So the refusal stays unconditional and gains the
 * half it was missing: when the tree can identify a side as untracked, it says which
 * one and what to do about it.
 */
function assertUniqueMigrationNames(
  migrations: Migration[],
  verified: { readonly tracked: ReadonlySet<string> } | null,
): void {
  const byName = new Map<string, Migration>()
  for (const migration of migrations) {
    const previous = byName.get(migration.name)
    if (previous) {
      const strays = [previous, migration].filter(
        (m) => verified !== null && !verified.tracked.has(m.fileName),
      )
      throw new Error(
        [
          `Migration name collision on "${migration.name}": ${previous.fileName} and ${migration.fileName}. ` +
            'The migration name is the ledger identity and must be unique across the tree.',
          ...(strays.length === 0
            ? []
            : [
                '',
                `NOT TRACKED by git's index for this checkout: ${strays.map((m) => m.fileName).join(', ')}`,
                strays.length === 1
                  ? '  So this is almost certainly a stray rather than a duplicate you committed — a scratch'
                  : '  So these are almost certainly strays rather than duplicates you committed — scratch',
                '  copy, editor artifact, leftover from another branch, or something written into this',
                '  directory by another process. DELETING it clears this outright. If it is a real',
                '  migration, give it a name of its own and `git add` it — the name is the ledger identity,',
                '  so two files may never share one whatever their ordinals are.',
                '',
                '  Do NOT reach for migrations/repairs.json: those entries acknowledge a row in the ledger,',
                '  and nothing has been recorded here.',
              ]),
        ].join('\n'),
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
  /**
   * The repairs that SPEAK on this database, and nothing else.
   *
   * An entry only takes effect when the ledger actually RECORDS the name it names.
   * This is the property that keeps `repairs.json` inert on every instance it is not
   * about, a FRESH INSTALL above all: entry 122 says `trident_checkpoint_head` is
   * already applied on the one instance where it was applied by hand, and on a new
   * database that migration must obviously run. Gating on the row's presence is what
   * distinguishes the two, and that argument is unchanged — a fresh install records
   * none of these names, so none of these entries activate.
   *
   * WHAT CHANGED, AND WHY: the trigger used to require an exact (version, name) PAIR,
   * which is an ordinal-as-identity assumption — the very thing this file deletes —
   * left behind in repair matching. It broke on the one shape it most needed to
   * survive. A ledger may legitimately record ONE name at TWO ordinals (see
   * `collapseLedgerRowsByName`), the rekey keeps the earliest-applied row and drops
   * the other, and the dropped row sits at a DIFFERENT ordinal by definition. So an
   * entry naming the non-surviving row activated on the rekey boot and went INERT on
   * every boot after it — silently un-suppressing a hand-verified migration whose
   * `ALTER`s then re-run, and un-acknowledging an orphan the boot then refuses over.
   * Both consequences land hardest on the databases repairs exist for.
   *
   * AND IT MUST NOT OVER-ACTIVATE EITHER, which is why the name alone is not the
   * whole condition. A repair is about a row this build cannot account for on its
   * own, so the trigger is: the ledger records that name at an ordinal OTHER than the
   * one this build assigns it — which includes the case where this build has no file
   * of that name at all, the orphan the entries are usually written for. Measured, not
   * assumed: entry 125's `recorded_name` is `code_trident_runs_fix_round_contract`,
   * which IS a file here (`0124_…`), so a name-only trigger fired on any healthy
   * instance that had recorded 0124 and not yet run 0125 — suppressing 0125 forever on
   * a database the incident was never about, and leaving its name permanently
   * unrecorded. The schema still converged (`0131` rebuilds the table either way),
   * which is exactly what would have made the widening invisible.
   *
   * THAT COMPARISON IS FORENSICS, NOT IDENTITY. It does not ask "has this migration
   * run?" — `classifyMigration` owns that question and answers it by name. It asks
   * whether the ledger's record of a name is what a normal apply of THIS build would
   * have written, and a mismatch is precisely the incident these entries describe.
   *
   * The `version` field is kept on the entry as CONTEXT rather than as a key: it
   * records the ordinal the row was written under, it is printed in the refusal
   * message that emits these entries, and it is still written into
   * `_migration_repairs` as part of the audit trail. An entry whose `version` has gone
   * stale — because the row it named was the one a collapse dropped — therefore keeps
   * working instead of quietly ceasing to.
   */
  const treeOrdinalByName = new Map(migrations.map((m) => [m.name, m.version] as const))
  const activeRepairs = loadMigrationRepairs(dir).filter((repair) =>
    ledger.rows.some(
      (row) =>
        row.name === repair.recorded_name &&
        row.version !== treeOrdinalByName.get(repair.recorded_name),
    ),
  )
  // WHAT AN ACTIVE REPAIR ASSERTS, in two independent halves — the shipped entries
  // need both. (1) The migration named by `file_name` is ALREADY APPLIED here, hand
  // verified, so it must not run: on the live instance ordinal 122's schema change
  // was applied by hand and never recorded, so identity reconciliation would
  // otherwise re-run its `ALTER`s and fail on duplicate columns. (2) The row itself
  // is an acknowledged orphan, so the refusal below stays silent about it.
  //
  // BOTH HALVES ARE KEYED ON THE NAME, and the second one has to be or the fix is
  // half a fix. The unexplained-row guard selects its candidates by NAME
  // (`!fileNames.has(row.name)`), so an acknowledgement keyed on (version, name)
  // could fail to exempt a row the guard had already selected — the surviving row of
  // a collapsed pair, same name, different ordinal. Keying both on the name puts the
  // exemption in the same terms as the selection.
  const repairedNames = new Set(activeRepairs.map((repair) => repair.file_name))
  const acknowledgedNames = new Set(activeRepairs.map((repair) => repair.recorded_name))

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
  // turns on. See `classifyMigration`.
  //
  // Every migration NAME this build contains. `classifyMigration` needs it to tell the
  // rename/renumber case (widen: these bytes ran under a name this build no longer
  // uses) from two files in this tree sharing bytes (refuse: one of them would never
  // run). It is also what the unexplained-row guard selects against further down, so it
  // is derived once here rather than twice.
  const treeNames = new Set(migrations.map((m) => m.name))
  const verdicts = new Map(
    migrations.map((m) => [m.name, classifyMigration(m, ledger, treeNames)] as const),
  )
  const pendingMigrations = migrations.filter(
    (m) => !repairedNames.has(m.name) && verdicts.get(m.name) === 'pending',
  )
  const pendingNames = new Set(pendingMigrations.map((m) => m.name))
  const pending = pendingMigrations.length > 0
  // A COLLISION NEEDS CLASSIFYING WHETHER OR NOT THERE IS WORK TO DO, so it is its
  // own trigger for the tree read below. This costs a healthy install nothing: the
  // checks are pure passes over the already-loaded `migrations` array and a clean tree
  // answers false to both, so a steady-state boot still does no filesystem work at all.
  //
  // A NAME COLLISION IS A TRIGGER TOO, and for a sharper reason than the ordinal one:
  // the refusal it leads to cannot be reached any other way. Two files sharing a slug
  // make each other read as already-applied, so nothing is pending, so the untracked
  // loop below never runs — and `assertUniqueMigrationNames` would have had no verdict
  // with which to tell the operator that one of the two files is a stray. That is the
  // gap its docblock used to paper over.
  const collision = hasOrdinalCollision(migrations) || hasNameCollision(migrations)
  // `dir` is the search origin: for the instance tree that walks up to the
  // checkout's `.git`, and for a sidecar tree (`migrations/comments`) it finds the
  // same one. Each read happens ONCE per run.
  //
  // THE COMMIT READ STAYS GATED ON `pending` ALONE, and the asymmetry is deliberate:
  // `deployedCommit` only ever stamps rows this run writes and captions the untracked
  // refusal, which iterates pending files — nothing pending, nothing that value can
  // reach. The tree verdict is different in kind, because a classification is
  // consulted on every boot.
  const deployedCommit = pending ? resolveDeployedCommit(process.env, dir) : null
  const tree = pending || collision ? resolveDeployedTree(dir) : null
  // The tracked-file list, or null when there is none to compare against. A
  // `null` here is "cannot verify" and refuses nothing — see `resolveDeployedTree`.
  const verified = tree !== null && tree.kind === 'verified' ? tree : null
  // AFTER the tree verdict, not before it, so a stray colliding with a tracked file
  // is diagnosed as the stray it is.
  //
  // WHAT THE VERDICT MUST NOT DEPEND ON, stated as the invariant this line rests on:
  // whether anything is pending. This comment used to argue the opposite — that a
  // collision "always leaves at least one of the two files pending, because a stray
  // was never recorded" — and that premise is false. It holds only for the boot that
  // finds the collision first. A RECORDED untracked stray is a supported state: the
  // refusal loop below checks pending files only, deliberately sparing a stray applied
  // long ago (refusing forever over one would be an outage with no remedy), and
  // ordinals 122 and 124 on the live instance are exactly that. So the sequence is:
  // boot one has the tracked side pending, resolves the tree, classifies the stray and
  // stands aside; boot two has nothing pending, and a `pending`-gated verdict would be
  // null — turning a tolerated collision into a hard refusal on every boot after a
  // SUCCESSFUL upgrade. Gating the read on `collision` too is what keeps the answer a
  // property of the tree rather than of the schedule, and it is why migrations being
  // idempotent by contract (`AGENTS.md`) survives contact with this guard.
  assertUniqueMigrationOrdinals(migrations, verified)
  // AFTER the tree verdict for the same reason, and with the same effect on the
  // message rather than on the outcome — see the function. It refuses either way.
  assertUniqueMigrationNames(migrations, verified)
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
  // TWO FILES IN THIS TREE WITH ONE SET OF BYTES, one of them already applied. Refused
  // rather than skipped, because skipping is how the second one never runs at all —
  // see `classifyMigration` and `formatDuplicateContentMigrations`. A hand-verified
  // repair naming the file still speaks for it, so an acknowledged duplicate stays
  // acknowledged.
  const duplicates = migrations
    .filter(
      (m) => !repairedNames.has(m.name) && verdicts.get(m.name) === 'duplicates-an-applied-file',
    )
    .map((migration) => ({
      migration,
      recordedName:
        [...(ledger.hashOwners.get(migrationContentHash(migration.sql)) ?? [])].find((owner) =>
          treeNames.has(owner),
        ) ?? '',
    }))
  if (duplicates.length > 0) throw new Error(formatDuplicateContentMigrations(duplicates))
  // THE REMAINING FAIL-CLOSED GUARD, restated against identity: a recorded
  // migration that NO file in this build corresponds to. Hashes are computed lazily
  // and only for the rows that survive the name check, so a healthy boot hashes
  // nothing. See `formatUnexplainedLedgerRows` for why only rows carrying a
  // `content_sha256` are adjudicated, and why that is narrower rather than weaker.
  //
  // THE HASH IS NON-NULL BY CONSTRUCTION FROM HERE ON, and the type says so rather than
  // a `?? ''` further downstream implying a NULL could arrive. `hasProvenance` is the
  // same test `buildLedger` applies when it decides which rows own a hash, so the two
  // cannot drift apart. Two branches for an unreachable NULL used to survive past this
  // filter — the same "documentation of a mode the code cannot enter" the
  // `PREDATES_PROVENANCE` constant was deleted for.
  const candidateRows = ledger.rows.filter(
    (row): row is HashedMigration =>
      hasProvenance(row.content_sha256) &&
      !treeNames.has(row.name) &&
      !acknowledgedNames.has(row.name),
  )
  if (candidateRows.length > 0) {
    const fileHashes = new Set(migrations.map((m) => migrationContentHash(m.sql)))
    const unexplained = candidateRows.filter((row) => !fileHashes.has(row.content_sha256))
    if (unexplained.length > 0) throw new Error(formatUnexplainedLedgerRows(unexplained, today))
  }
  // CONTENT DRIFT IS REPORTED, NEVER ENFORCED — the last thing before the writes, and
  // deliberately not a refusal. See `contentDriftFields`: gating on a hash mismatch is
  // a decision this repository has weighed and declined, and this closes the SILENCE
  // that decision left rather than reopening the decision. Only names the ledger
  // actually records are compared, and only rows carrying a hash can be, so a fresh
  // install and a pre-provenance ledger both say nothing.
  for (const migration of migrations) {
    if (verdicts.get(migration.name) !== 'recorded-by-name') continue
    const recorded = ledger.byName.get(migration.name)
    if (recorded === undefined || !isHashed(recorded)) continue
    if (recorded.content_sha256 === migrationContentHash(migration.sql)) continue
    log.warn('migration_content_drift', contentDriftFields(migration, recorded))
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
  // written — see `treeProvenanceOf`. The `pending` gate is kept EXPLICIT rather than
  // left to `tree` being null, because `tree` is now also resolved for a collision:
  // "no run happened" must stay a statement about the run, not a side effect of which
  // reads the run happened to need.
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
