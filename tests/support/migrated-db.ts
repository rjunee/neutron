/**
 * tests/support/migrated-db.ts — seed a test database by COPYING a template
 * the REAL migration runner built, instead of replaying every migration again.
 *
 * WHY THIS EXISTS
 * ---------------
 * The overwhelming majority of test files want one thing from `migrations/`: a
 * project database with the current schema on it. They each got it by calling
 * `applyMigrations(db.raw())`, which replays the whole tree — measured at
 * ~110-137 ms of CPU per call, of which ~86% is SQL execution (so memoising the
 * file reads recovers almost nothing). Multiplied by the hundreds of call sites
 * in the suite that is a large, entirely repeated bill.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is NOT a second migration engine, and there is deliberately no "fast
 * migration logic" here that could drift from the real one. The template is
 * produced ONCE PER PROCESS by the UNMODIFIED `applyMigrations` against the
 * real `migrations/` tree, and every seeded database is a byte-for-byte copy of
 * that real replay: same schema text, same rows, same `_migrations` ledger
 * (`content_sha256`, `applied_by_commit`, `tree_provenance` included, because
 * the template is built in the same checkout the tests run from), same
 * persisted `journal_mode`. `migrations/runner.ts` is not touched by any of
 * this, and neither is any production path — the gateway boot
 * (`gateway/index.ts`) and the install CLI keep calling the real runner.
 *
 * The equivalence is not asserted, it is DIFFED:
 * `tests/support/migrated-db-conformance.test.ts` builds one database each way
 * over the full tree and compares schema, journal mode, every user table's full
 * contents (minus one wall-clock column), and then hands the seeded database to
 * the real runner to certify — it must report every migration already applied.
 *
 * ONE THING IT DELIBERATELY DOES NOT COPY
 * ---------------------------------------
 * The `.migrate-owner` marker the runner drops BESIDE a database it claims
 * (`migrations/runner.ts`, `migrateOwnerMarkerPath`). Seeding does not write
 * one, and must not: the marker is a claim by a specific runner checkout over a
 * specific path, and forging it from a test helper is precisely the kind of
 * re-implemented runner behaviour this file exists to avoid. Absence is the safe
 * side of that guard — the runner TOLERANTLY claims a previously absent marker
 * and only refuses on one that disagrees — so a seeded database that later meets
 * the real runner gets claimed then, exactly as a fresh one would.
 *
 * WHEN NOT TO USE IT
 * ------------------
 * - Anything that asserts on an `ApplyResult` (`applied` / `skipped` / refusals)
 *   or reads `_migrations` timestamps: the seeded ledger carries the TEMPLATE's
 *   `applied_at`, not this test's wall clock. Those tests stay on the real runner.
 * - Anything applying a CUSTOM migration directory (sidecar trees, the runner's
 *   own fixture dirs). This helper is hardwired to the default tree.
 * - Anything that sets `NEUTRON_COMMIT_SHA`. The template is built once per
 *   process and bakes that variable into every `applied_by_commit`, so the
 *   value a seeded test gets is whichever test seeded FIRST. `seedMigratedDb`
 *   throws rather than hand over a mismatched stamp.
 * - Anything migrating a database that already has content. `seedMigratedDb`
 *   REFUSES a non-empty target rather than falling back to a slow path, so a
 *   wrongly-converted call site fails loudly instead of quietly masking a
 *   refusal, a repair entry or a legacy-ledger rekey the real runner would have
 *   had to handle.
 */
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { applyMigrations } from '@neutronai/migrations/runner.ts'

/** Resolved lazily on first seed, then reused for the life of the process. */
let templatePath: string | null = null
let templateDir: string | null = null

/**
 * The only environment variable that changes what the runner WRITES:
 * `resolveDeployedCommit` (migrations/provenance.ts) prefers it over the git
 * checkout when stamping `_migrations.applied_by_commit`.
 */
const PROVENANCE_ENV = 'NEUTRON_COMMIT_SHA'

/** Its value at the moment the template was built — see `assertProvenanceEnvUnchanged`. */
let templateProvenanceEnv: string | undefined

/**
 * Build (or return) this process's template database.
 *
 * `bun test` runs many files in ONE long-lived process, so this is paid once
 * per process. `scripts/run-tests.sh` partitions the suite across several
 * short-lived processes; each one builds its own template, which changes the
 * amortisation and nothing else.
 *
 * The build writes to `building.db` and PUBLISHES by rename, so `templatePath`
 * can only ever name a fully-migrated file — a crash mid-replay leaves the
 * half-built database under a name nothing reads.
 */
function template(): string {
  if (templatePath !== null) return templatePath

  const dir = mkdtempSync(join(tmpdir(), 'neutron-migrated-template-'))
  const building = join(dir, 'building.db')
  const db = new Database(building, { create: true })
  try {
    // THE REAL RUNNER, unmodified, over the real default migrations directory.
    // Every refusal it can raise (untracked stray, ordinal collision, duplicate
    // bytes) fires HERE, once, with the identical diagnosis each converted test
    // would have produced on its own.
    applyMigrations(db)
    // Fold the WAL back into the main database file before the copy. A clean
    // close already checkpoints, but doing it explicitly means every page the
    // migrations wrote is in the ONE file `seedMigratedDb` copies, so the copy
    // cannot lose the most recent pages to a sidecar it did not take.
    // (The seeded copy does get its own `-shm` back afterwards — see
    // `materializeWalIndex`. That is a lock structure, not data.)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }

  const published = join(dir, 'template.db')
  renameSync(building, published)
  templateDir = dir
  templatePath = published
  templateProvenanceEnv = process.env[PROVENANCE_ENV]
  return published
}

/**
 * Refuse to hand out a template whose provenance stamp no longer matches the
 * caller's environment.
 *
 * The template is built ONCE, on the first seed of the process, and it bakes in
 * whatever `NEUTRON_COMMIT_SHA` was set at that instant — that value is written
 * into `_migrations.applied_by_commit` for every migration. A test that sets the
 * variable and then seeds would silently get the FIRST seeding test's commit,
 * not its own, and a test that seeds after one that set it would inherit a
 * stamp from a file it has never heard of. Neither is a difference the
 * conformance diff can see, because both databases in that diff are built in
 * the same process under the same environment.
 *
 * No test does this today (the two that set the variable live in
 * `migrations/__tests__/` and stay on the real runner by design), so this guard
 * is here to make sure it stays that way loudly rather than by luck. It costs
 * one string comparison per seed.
 */
function assertProvenanceEnvUnchanged(): void {
  const now = process.env[PROVENANCE_ENV]
  if (now === templateProvenanceEnv) return
  throw new Error(
    `seedMigratedDb: ${PROVENANCE_ENV} is ${describeEnv(now)} but the template for this ` +
      `process was built with it ${describeEnv(templateProvenanceEnv)}. The seeded ledger ` +
      "would carry the template's applied_by_commit, not this test's. A test that cares " +
      'about migration provenance must use the real runner: applyMigrations(db.raw()).',
  )
}

function describeEnv(value: string | undefined): string {
  return value === undefined ? 'unset' : `set to ${JSON.stringify(value)}`
}

// The template is scratch state for one process; leave nothing behind.
process.on('exit', () => {
  if (templateDir !== null) rmSync(templateDir, { recursive: true, force: true })
})

/**
 * Create a fully-migrated project database at `path`.
 *
 * Call it BEFORE opening the database — that ordering is the whole trick. The
 * seed is a file copy, so it cannot run against a handle somebody already
 * holds:
 *
 *     seedMigratedDb(join(tmp, 'project.db'))
 *     db = ProjectDb.open(join(tmp, 'project.db'))
 *
 * Throws if `path` already exists and is non-empty. That is the guard that
 * keeps this helper honest: seeding is only equivalent to a replay on a FRESH
 * database, so the one case where it would not be, it refuses. It also throws on
 * an in-memory database, which has no file to copy onto at all.
 */
export function seedMigratedDb(path: string): void {
  // An in-memory database has no file to copy onto, and `copyFileSync` would
  // happily create a FILE LITERALLY NAMED `:memory:` in the working directory
  // while the database the test then opens stays empty — a silent miss that
  // surfaces far away as "no such table". Refuse it here, where the diagnosis is
  // still local. (Observed for real on one converted call site: a 1.1 MB `:memory:`
  // file appeared at the repo root and the suite failed on a missing table.)
  // Both spellings SQLite accepts: the bare `:memory:`, and a `file:` URI that
  // either names `:memory:` or asks for `mode=memory`. Matching on the substring
  // rather than on equality is deliberate — `file::memory:?cache=shared` is
  // in-memory too, and the first version of this guard tested only for
  // `mode=memory`, which let that spelling straight through.
  if (path.includes(':memory:') || path.includes('mode=memory')) {
    throw new Error(
      `seedMigratedDb: cannot seed the in-memory database ${path}. Seeding copies a ` +
        'template FILE, so there is no in-memory target to copy onto. Use the real ' +
        'runner for an in-memory database: applyMigrations(db.raw()).',
    )
  }
  if (existsSync(path) && statSync(path).size > 0) {
    throw new Error(
      `seedMigratedDb: refusing to seed ${path} — it already exists and is non-empty. ` +
        'Seeding is only equivalent to a real migration replay on a FRESH database; ' +
        'a database with content may need refusals, repair entries or a ledger rekey ' +
        'that only the real runner (applyMigrations) performs. Use that instead.',
    )
  }
  const source = template()
  assertProvenanceEnvUnchanged()
  copyFileSync(source, path)
  materializeWalIndex(path)
}

/**
 * Give the freshly copied database its `-shm` WAL index, by opening it
 * READ-WRITE once and touching a page.
 *
 * This is not cosmetic, and it is not about the copy being incomplete — the
 * copied file is a complete, checkpointed WAL database. It is about what the
 * NEXT reader is allowed to do. A WAL database can only be read through its
 * shared-memory index, and a READ-ONLY connection is not permitted to create
 * that index: SQLite fails the open outright with `unable to open database
 * file`. So the first connection to a seeded database has to be a writer, or
 * there can never be a reader at all.
 *
 * A replayed database always satisfied that by accident — the test held an open
 * read-write handle from `ProjectDb.open` while the migrations ran, so the index
 * already existed by the time anything opened the path read-only. A byte copy
 * has no such handle, which is why seeding without this step broke exactly the
 * call sites whose subject opens read-only (`ProjectDb.open(..., { readonly:
 * true })`) and nothing else. That failure is also platform-shaped — it
 * reproduces locally and not on the Linux CI runner — so it is the kind of bug
 * a green pipeline will happily carry.
 *
 * `PRAGMA user_version` is the trigger on purpose: it takes a read transaction
 * (which is what builds the index) while touching only the database header.
 * Reading `sqlite_schema` instead would work too and costs ~20x more, because it
 * makes SQLite parse the whole 124-migration schema — measured 33 ms/seed
 * against 1.4 ms for the pragma.
 */
function materializeWalIndex(path: string): void {
  const db = new Database(path, { readwrite: true, create: false })
  try {
    db.exec('PRAGMA user_version')
  } finally {
    db.close(true)
  }
}
