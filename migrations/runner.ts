import { Database } from 'bun:sqlite'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveOpenDbPath } from './db-path.ts'
import { installProcessSafetyNet } from '@neutronai/logger/fire-and-forget.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

export interface Migration {
  version: number
  name: string
  sql: string
}

export interface ApplyResult {
  applied: number[]
  skipped: number[]
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
      }
    })
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
  const seen = new Set(
    db
      .query<{ version: number }, []>('SELECT version FROM _migrations')
      .all()
      .map((r) => r.version),
  )
  const applied: number[] = []
  const skipped: number[] = []
  for (const m of loadMigrations(dir)) {
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
      db.run('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        m.version,
        m.name,
        Date.now() / 1000,
      ])
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
  installProcessSafetyNet() // F3 — standalone CLI entrypoint (`bun run migrate`)
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
