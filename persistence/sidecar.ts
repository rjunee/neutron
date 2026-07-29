/**
 * openSidecar() + shared sidecar store helpers — refactor P3.
 *
 * The repo has ~10 raw `bun:sqlite` sidecar databases (doc-search index,
 * comments store, binary-blob index, calendar/email/code-gen/research
 * per-project sidecars, …) that each used to open with a different — or
 * missing — pragma cocktail. This module is the ONE sanctioned way to open a
 * sidecar: it applies the exact `STARTUP_PRAGMAS` set that `ProjectDb.open`
 * applies to the instance DB (WAL + foreign_keys + synchronous=NORMAL +
 * temp_store=MEMORY + cache_size=-64000 + busy_timeout=100), so every sidecar
 * gets the same crash/contention tolerance.
 *
 * This is NOT an ORM and not a `ProjectDb`: sidecar stores keep their raw
 * `Database` handle, their own schemas (via their own migration trees or
 * inline `CREATE TABLE IF NOT EXISTS` bootstraps) and their own query code.
 * Only the OPEN (+ a handful of genuinely repeated helpers below) is shared.
 *
 * Busy-retry is OPT-IN, not applied here: the jittered retry loop
 * (`withBusyRetry`, re-exported below) is async BY DESIGN (it sleeps with
 * `await Bun.sleep` so the gateway watchdog tick keeps firing during
 * contention — see `retry.ts`), and today's sidecar stores are synchronous
 * writers, so `openSidecar` cannot force it on them. The connection-level
 * `PRAGMA busy_timeout` (100 ms, C-level sync wait) IS always applied; an
 * async sidecar write path that wants the full retry ladder wraps its write
 * in `withBusyRetry` itself.
 */

import { Database } from 'bun:sqlite'
import { STARTUP_PRAGMAS } from './db.ts'
import { PersistenceError } from './errors.ts'

// Opt-in busy-retry for async sidecar writers — see module header.
export { withBusyRetry } from './retry.ts'

export interface SidecarOpenOptions {
  /** Create the file if it doesn't exist. Default: true (bun:sqlite default). */
  create?: boolean
}

/**
 * Open (or create) a sidecar SQLite database with the shared ProjectDb
 * startup-pragma set (WAL + foreign_keys=ON + synchronous=NORMAL +
 * temp_store=MEMORY + cache_size=-64000 + busy_timeout=100). Returns the raw
 * `bun:sqlite` handle — the sidecar store owns everything past the open. Open
 * failures and pragma failures are wrapped in `PersistenceError` (with the
 * driver error as `cause`); a pragma failure closes the half-opened handle
 * before throwing.
 *
 * Note on foreign_keys: every sidecar adopting this helper is FK-enforced
 * today — the migration-runner sidecars (comments / calendar / email /
 * code-gen / research) go through `applyMigrations`, which unconditionally
 * asserts `PRAGMA foreign_keys = ON`, and the inline-schema sidecars
 * (doc-search / binary-store) already set it explicitly. So FK=ON here is
 * behavior-preserving across the board, not a new enforcement.
 */
export function openSidecar(path: string, options: SidecarOpenOptions = {}): Database {
  const create = options.create ?? true
  let db: Database
  try {
    db = new Database(path, { create })
  } catch (err) {
    throw new PersistenceError(`failed to open SQLite sidecar at ${path}`, err)
  }
  try {
    for (const stmt of STARTUP_PRAGMAS) {
      db.exec(stmt)
    }
  } catch (err) {
    try {
      db.close()
    } catch {
      /* surface the pragma error, not the close secondary */
    }
    throw new PersistenceError(`failed to apply startup pragmas to sidecar at ${path}`, err)
  }
  return db
}

/* ── JSON codec ─────────────────────────────────────────────────────────── */

/**
 * What to do when a JSON column's text does not parse. THREE divergent
 * policies exist across sidecar stores today and P3 deliberately does NOT
 * unify them — each call site states its historical policy explicitly:
 *
 *  - `'throw'`    — corrupt JSON propagates the `SyntaxError` (email
 *                   `applied_labels`, research `sources_json`/`brief_json`).
 *  - `'fallback'` — corrupt JSON degrades to a caller-supplied value
 *                   (calendar attendees → `[]` / `null`, doc-search
 *                   embeddings → `null`).
 *  - `'raw'`      — corrupt JSON degrades to the raw column text itself
 *                   (code-gen `request_json`: pre-JSON rows stored the bare
 *                   task string).
 *
 * The codec covers ONLY the parse step; each store's post-parse shape
 * validation (array checks, element filters, schema validators) stays at
 * the call site where it belongs.
 */
export type CorruptJsonPolicy<T = unknown> =
  | { onCorrupt: 'throw' }
  | { onCorrupt: 'fallback'; fallback: T }
  | { onCorrupt: 'raw' }

/**
 * Parse a JSON column with an EXPLICIT corrupt-text policy. Returns the
 * parsed value as `unknown` — callers keep their existing casts / shape
 * checks. NULL columns are the caller's business (check before calling);
 * this helper only answers "the text is there but does it parse".
 */
export function parseJsonColumn<T = unknown>(raw: string, policy: CorruptJsonPolicy<T>): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch (err) {
    switch (policy.onCorrupt) {
      case 'throw':
        throw err
      case 'fallback':
        return policy.fallback
      case 'raw':
        return raw
    }
  }
}

/* ── Row mapper ─────────────────────────────────────────────────────────── */

/**
 * Null-propagating single-row decode: the repeated
 * `const row = stmt.get(...); if (row === null) return null; return decode(row)`
 * tail of every sidecar `getX()` method.
 */
export function mapRow<Raw, Out>(row: Raw | null, decode: (row: Raw) => Out): Out | null {
  return row === null ? null : decode(row)
}

/** Multi-row decode — the `stmt.all(...).map(decode)` tail. */
export function mapRows<Raw, Out>(rows: readonly Raw[], decode: (row: Raw) => Out): Out[] {
  return rows.map(decode)
}

/* ── Now-seam ───────────────────────────────────────────────────────────── */

/** Injectable clock (epoch ms). Every sidecar store takes one for tests. */
export type NowFn = () => number

/**
 * Resolve an optional injected clock to a concrete one — the repeated
 * `opts.now ?? (() => Date.now())` constructor line.
 */
export function resolveNow(now?: NowFn): NowFn {
  return now ?? ((): number => Date.now())
}
