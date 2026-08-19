/**
 * @neutronai/email-managed-core — applying THIS Core's own sidecar migrations.
 *
 * WHY THE CORE OWNS THIS RATHER THAN CALLING THE HOST RUNNER. A bundled Core's
 * only legitimate cross-module dependencies are the Cores SDK, the Cores runtime
 * and npm packages; reaching into `gateway/`, `open/`, `runtime/`, `migrations/`,
 * `auth/`, `landing/` or `logger/` is the "third-party fiction" the platform
 * boundary exists to prevent, and CI enforces it (`cores-use-sdk-only`). The
 * first cut of the pipeline store imported `@neutronai/migrations/runner.ts`
 * directly — convenient, and a violation: that module in turn imports the host
 * logger, so one import quietly dragged two forbidden edges into a Core that is
 * supposed to be liftable out of this repo intact.
 *
 * The duplication is small and the blast radius is nil: this applies migrations
 * to a sidecar DB FILE THIS CORE OWNS (`<owner_home>/email/pipeline.db`).
 * Nothing else reads its `_migrations` table, so the two implementations cannot
 * disagree about anything that matters.
 *
 * The mechanics deliberately mirror the host runner, because each of them is
 * load-bearing rather than stylistic:
 *
 *   • PRAGMA PREAMBLE HOISTING. SQLite refuses several PRAGMAs
 *     (`journal_mode`, `synchronous`, `foreign_keys`) inside a transaction, and
 *     a migration file declares its connection-level pragmas at the top so a
 *     direct `sqlite3 < file.sql` run is self-configuring. The leading preamble
 *     is therefore lifted out before BEGIN.
 *   • PER-MIGRATION ATOMICITY. Either every statement in the body lands AND the
 *     version is recorded, or nothing lands. Without it a mid-file failure
 *     leaves the sidecar half-migrated and the next open retries against split
 *     state.
 *   • FOREIGN KEYS RE-ASSERTED IN A `finally`. A migration whose preamble
 *     disabled FK enforcement must not leak that onto the next migration or
 *     onto the calling connection — including when it THROWS after the preamble
 *     ran.
 */

import type { Database } from 'bun:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface CoreMigration {
  version: number
  name: string
  sql: string
}

export interface CoreMigrationResult {
  applied: number[]
  skipped: number[]
}

/** `NNNN_name.sql`, applied in lexical order — which is numeric order here. */
const MIGRATION_FILE_RE = /^(\d{4})_(.+)\.sql$/

const PRAGMA_PREAMBLE_RE = /^(?:\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|PRAGMA\s+[^;]+;))*/i

export function loadCoreMigrations(dir: string): CoreMigration[] {
  return readdirSync(dir)
    .filter((f) => MIGRATION_FILE_RE.test(f))
    .sort()
    .map((f) => {
      const match = f.match(MIGRATION_FILE_RE)
      // Unreachable — the filter above already matched this exact pattern.
      if (match === null) throw new Error(`unreachable migration filename: ${f}`)
      return {
        version: Number.parseInt(match[1] ?? '', 10),
        name: match[2] ?? '',
        sql: readFileSync(join(dir, f), 'utf8'),
      }
    })
}

/**
 * Split off leading whitespace, comments and `PRAGMA ...;` statements so they
 * can run OUTSIDE the per-migration transaction.
 *
 * A COMMENT-ONLY PREAMBLE IS NOT A PREAMBLE. SQLite rejects an exec of nothing
 * but comments ("Query contained no valid SQL statement"), and two of this
 * Core's three migrations open with a header comment and no pragma at all — so
 * without this check the first `db.exec(preamble)` throws and the sidecar never
 * migrates. When there is no real PRAGMA to lift, the whole file is the body;
 * comments inside a transaction are fine.
 *
 * The check runs against the preamble WITH ITS COMMENTS STRIPPED, because a
 * header that merely mentions the word (`-- No PRAGMA preamble needed.`) would
 * otherwise match and pass a comment-only string straight through.
 */
function splitPragmaPreamble(sql: string): { preamble: string; body: string } {
  const match = sql.match(PRAGMA_PREAMBLE_RE)
  const preamble = match?.[0] ?? ''
  const stripped = preamble.replace(/--[^\n]*\n/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  if (!/PRAGMA\s+/i.test(stripped)) return { preamble: '', body: sql }
  return { preamble, body: sql.slice(preamble.length) }
}

export function applyCoreMigrations(db: Database, dir: string): CoreMigrationResult {
  // Per-CONNECTION, not persisted, so it is asserted here for every caller
  // rather than assumed from whoever opened the handle.
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
  for (const m of loadCoreMigrations(dir)) {
    if (seen.has(m.version)) {
      skipped.push(m.version)
      continue
    }
    const { preamble, body } = splitPragmaPreamble(m.sql)
    if (preamble.trim().length > 0) db.exec(preamble)

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
      db.exec('PRAGMA foreign_keys = ON')
    }
    applied.push(m.version)
  }
  return { applied, skipped }
}
