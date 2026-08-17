/**
 * tests/support/migrated-db.ts — migrate ONCE per process, clone per test.
 *
 * WHY THIS EXISTS
 * ---------------
 * The dominant test fixture in this repo was:
 *
 *   beforeEach(() => {
 *     tmp = mkdtempSync(join(tmpdir(), 'neutron-<suite>-'))
 *     db = ProjectDb.open(join(tmp, 'project.db'))
 *     applyMigrations(db.raw())          // <- all of the migration tree, per TEST
 *   })
 *
 * `applyMigrations` parses and executes the whole migration tree (~350 KB of
 * SQL) against the fresh database. Measured on this tree, in-process and warm:
 * ~137 ms of CPU per call. Roughly 3,700 tests paid it, which measured at ~485 s
 * of CPU — about a quarter of the entire suite's ~1,918 s.
 *
 * It is not fsync: `persistence/db.ts` STARTUP_PRAGMAS already sets
 * `journal_mode = WAL` and `synchronous = NORMAL`. It is SQLite DDL parse and
 * exec, spread thin across ~120 migrations with no single villain — so there is
 * nothing to optimise inside the runner. The only real win is to stop doing it
 * per test.
 *
 * WHAT THIS DOES
 * --------------
 * Once per PROCESS, lazily on first use, it runs the REAL `applyMigrations`
 * against an in-memory database and keeps `Database.serialize()` — the raw
 * SQLite page image, ~1.1 MB. Every test then gets a CLONE of that image:
 *
 *   - `openMigratedDb()` / `openMigratedDatabase()` — in-memory clone via
 *     `Database.deserialize`. Measured ~1.4 ms. Use this when the test only
 *     needs a DB handle.
 *   - `openMigratedDbAt(path)` / `openMigratedDatabaseAt(path)` — writes the
 *     image to `path` and opens it. Measured ~7 ms, and the DB is a real file
 *     at a real path. Use this when the code under test reads `db.path`, or when
 *     the test asserts about the file itself.
 *
 * THE FILE-BACKED SHAPE IS THE MECHANICAL DEFAULT, and deliberately so. The one
 * production reader of `ProjectDb.path` is the trident orchestrator
 * (`gateway/composition/build-core-modules.ts:589` passes `input.db.path` as
 * `db_path`), which hands the path to a process that REOPENS that database — and
 * an in-memory handle has no path to hand over. So the ~400-file sweep kept the
 * real path every fixture already had, which makes the conversion equivalent by
 * construction instead of equivalent-if-nothing-reads-the-path. Reach for the
 * in-memory shape in a NEW test, where you know what it touches.
 *
 * The schema is identical BY CONSTRUCTION — the template is built by the real
 * runner, and a page image restores byte-for-byte, ledger rows included.
 * `migrated-db.test.ts` pins that against a freshly-migrated database rather
 * than asserting it here in prose.
 *
 * WHAT MUST *NOT* USE THIS
 * ------------------------
 * Tests that are ABOUT migration behaviour — the ledger, provenance, the scope
 * rekey, ordinal identity, repairs, untracked-file refusals — must keep calling
 * `applyMigrations` directly, because exercising the real path IS their
 * coverage. That is `migrations/__tests__/`, `migrations/runner.test.ts`, the
 * `tests/integration/migration-*-roundtrip` files, `tests/integration/
 * orphan-survival.test.ts` and `open/__tests__/open-scope-rekey-*`. They were
 * deliberately left on the raw runner.
 *
 * PROCESS SCOPE, NOT SUITE SCOPE: `scripts/run-tests.sh` partitions the suite
 * into many short-lived `bun test` processes, so the template is built once per
 * CHUNK, not once per run. That is the point — the cost is amortised across
 * every test in the chunk instead of being paid by each one.
 */
import { Database } from 'bun:sqlite'
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb, type OpenOptions } from '@neutronai/persistence/index.ts'

/**
 * The per-process migrated page image. `null` until first use — building it
 * eagerly at import time would charge the ~340 ms to every chunk whether or not
 * anything in it wants a database.
 */
let TEMPLATE: Uint8Array | null = null

/**
 * The migrated SQLite page image for this process, built on first call by the
 * REAL `applyMigrations` against an in-memory database.
 *
 * Exposed for the rare fixture that wants the bytes itself (and for
 * `migrated-db.test.ts`, which diffs the schema it produces against a
 * freshly-migrated database). Callers must treat the return as READ-ONLY: it is
 * the shared template, and `Database.deserialize` copies it, so handing it out
 * is safe only as long as nobody writes through it.
 */
export function migratedTemplateBytes(): Uint8Array {
  if (TEMPLATE !== null) return TEMPLATE
  const seed = new Database(':memory:')
  try {
    applyMigrations(seed)
    TEMPLATE = seed.serialize()
  } finally {
    seed.close()
  }
  return TEMPLATE
}

/**
 * A fully-migrated, WRITABLE, in-memory `bun:sqlite` Database. The raw-handle
 * counterpart of `openMigratedDb` — for the fixtures that hold a `Database`
 * directly rather than a `ProjectDb`.
 *
 * Each call is an independent clone: writes to one never reach another, and
 * never reach the template.
 */
export function openMigratedDatabase(): Database {
  return Database.deserialize(migratedTemplateBytes())
}

/**
 * A fully-migrated, WRITABLE, in-memory `ProjectDb` — the fast default for any
 * test that just needs a database with the schema in it.
 *
 * `path` reads back as `':memory:'`. If the code under test reads `db.path` —
 * the trident orchestrator's `db_path` is the one production case — use
 * `openMigratedDbAt` instead.
 */
export function openMigratedDb(): ProjectDb {
  return ProjectDb.adopt(':memory:', openMigratedDatabase())
}

/**
 * Write the migrated page image to `path`, REPLACING whatever was there, and
 * clearing any orphaned `-wal` / `-shm` beside it (a stale WAL against a
 * brand-new main file is a corruption, not a recovery). Returns `path` so it
 * composes into a fixture in one expression.
 *
 * The parent directory must exist — the same requirement SQLite itself imposes,
 * so the `mkdtempSync` the fixture already does still covers it.
 *
 * Prefer `openMigratedDbAt` / `openMigratedDatabaseAt`: they only seed a path
 * that has no database yet. This one always overwrites.
 */
export function writeMigratedDbFile(path: string): string {
  rmSync(`${path}-wal`, { force: true })
  rmSync(`${path}-shm`, { force: true })
  writeFileSync(path, migratedTemplateBytes())
  return path
}

/**
 * Make `path` hold a fully-migrated database, whatever state it is in now.
 *
 * THIS IS WHERE THE EQUIVALENCE LIVES, and it is not "write the template". The
 * fixture being replaced was `ProjectDb.open(path)` + `applyMigrations`, and on
 * a path that ALREADY holds a database that pair is a pure read that preserves
 * every row. Seeding unconditionally would instead truncate it — which is
 * exactly what broke `tests/integration/launcher-served.open.test.ts`, whose
 * restart test boots, renames a tile, throws the server away, and boots again
 * over the SAME file to prove the store is durable rather than process-local.
 * The rename came back as the default and the test read as a durability
 * regression in the product, not as a change to its fixture.
 *
 * So: an absent or empty file gets the template (the ~7 ms fast path, and the
 * overwhelming case, because fixtures `mkdtemp` a fresh dir per test); a path
 * that already has a database gets the REAL runner, which is precisely what the
 * old code did there.
 */
function seedMigratedDbFile(path: string): void {
  let size = -1
  try {
    size = statSync(path).size
  } catch {
    size = -1
  }
  if (size <= 0) {
    writeMigratedDbFile(path)
    return
  }
  const existing = new Database(path, { create: false, readwrite: true })
  try {
    applyMigrations(existing)
  } finally {
    existing.close()
  }
}

/**
 * A fully-migrated `ProjectDb` backed by a REAL FILE at `path` — the drop-in
 * replacement for `ProjectDb.open(path)` followed by `applyMigrations`.
 *
 * The resulting file is what the migration runner would have produced at that
 * path, and `db.path` is the path you passed, so anything deriving a sibling
 * file from it (sidecars, backups) behaves exactly as before. Called twice on
 * one path — the restart-shaped fixture — the second call PRESERVES what the
 * first wrote.
 */
export function openMigratedDbAt(path: string, options: OpenOptions = {}): ProjectDb {
  seedMigratedDbFile(path)
  return ProjectDb.open(path, options)
}

/**
 * A fully-migrated raw `bun:sqlite` Database backed by a REAL FILE at `path` —
 * the drop-in replacement for `new Database(path)` followed by
 * `applyMigrations`. Same reopen semantics as `openMigratedDbAt`.
 *
 * NOTE: unlike `ProjectDb.open`, this does NOT apply `STARTUP_PRAGMAS`, because
 * the call sites it replaces did not either — a bare `new Database(path)` has
 * `foreign_keys` OFF, and quietly turning it ON here would change what those
 * tests assert. Fixtures that set their own pragmas keep doing so.
 */
export function openMigratedDatabaseAt(path: string): Database {
  seedMigratedDbFile(path)
  return new Database(path, { create: true })
}
