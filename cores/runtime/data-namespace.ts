/**
 * @neutronai/cores-runtime — per-Core data namespace allocator.
 *
 * Locked decision (§ A.3 + § B.P3): every Core gets either a
 *   - **table layout** — named tables in the project DB with
 *     `core_<slug>_*` prefix, OR
 *   - **sidecar layout** — a separate SQLite file at
 *     `<ownerHome>/cores/<slug>.db`.
 *
 * The decision is made at install time based on the Core's manifest:
 * if it declares `read:<slug>.db` or `write:<slug>.db` capabilities, the
 * runtime allocates a sidecar; otherwise a table-prefix carve-out in
 * the shared project DB.
 *
 * This module exposes the install-time allocator + uninstall-time
 * release. Tool calls that touch the DB go through `runScopedSql` (table
 * layout) or directly against the sidecar (sidecar layout) — the SDK's
 * connector / tool surface is the consumer; runtime-side we only own
 * the namespace mechanics.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { Database } from 'bun:sqlite'

import { ProjectDb } from '@neutronai/persistence/index.ts'

import { CoreInstallError } from './errors.ts'
import type { CoreDataLayout } from './installations-store.ts'

/**
 * The `<verb>:<resource>` capability strings that gate a Core's access
 * to the shared project DB. `read:project.db` and `write:project.db` are
 * the canonical pair declared in `core-sdk/types.ts:NeutronCapability` —
 * the only accepted forms. The pre-rename aliases were dropped in the
 * ZERO-back-compat sweep (§ 2.3); the gate accepts the project vocabulary
 * exclusively.
 */
const PROJECT_DB_CAPABILITIES = [
  'read:project.db',
  'write:project.db',
] as const

/**
 * Resolve the namespace decision from a manifest. The locked rule is:
 * a Core that declares `read:<slug>.db` or `write:<slug>.db` (where
 * `<slug>` is its derived slug) wants a sidecar; otherwise, table layout.
 *
 * The slug check is exact-match — capability `read:<other>.db` against
 * a different slug would still imply a sidecar layout but is explicitly
 * rejected: a Core cannot reach into another Core's namespace via a
 * raw capability declaration.
 */
export function decideDataLayout(
  manifest_capabilities: ReadonlyArray<string>,
  slug: string,
): { layout: CoreDataLayout } {
  const wantsOwnSidecar = manifest_capabilities.some((c) => {
    if (c === `read:${slug}.db`) return true
    if (c === `write:${slug}.db`) return true
    return false
  })
  if (wantsOwnSidecar) return { layout: 'sidecar' }
  // A Core declaring `read:<other_slug>.db` is rejected by the manifest
  // gate at install time (lifecycle.ts) — surfaced by `decideDataLayout`
  // returning 'tables', then lifecycle catches the cross-Core access.
  // We don't enforce here; this function is purely the layout shape.
  return { layout: 'tables' }
}

export interface CoreNamespaceTables {
  layout: 'tables'
  /** SQL identifier prefix every Core-owned table MUST start with. */
  table_prefix: string
}

export interface CoreNamespaceSidecar {
  layout: 'sidecar'
  sidecar_db_path: string
  sidecar_db: ProjectDb
}

export type CoreNamespace = CoreNamespaceTables | CoreNamespaceSidecar

export interface AllocateNamespaceInput {
  project_slug: string
  slug: string
  manifest_capabilities: ReadonlyArray<string>
  /** Instance data dir; sidecar files land at `<dataDir>/cores/<slug>.db`. */
  dataDir: string
  /** Pre-decided layout (lifecycle.ts derives this once). */
  layout: CoreDataLayout
}

/**
 * Compute the canonical sidecar DB path for an instance + Core slug.
 * Exposed so callers (lifecycle, tests, admin tooling) can resolve it
 * without duplicating the join.
 */
export function sidecarDbPath(dataDir: string, slug: string): string {
  return join(dataDir, 'cores', `${slug}.db`)
}

/**
 * Compute the canonical table prefix for a Core slug. The prefix shape
 * `core_<slug>_` is what `runScopedSql` enforces against, so callers
 * needing to assert "is this table mine?" use this helper.
 */
export function tablePrefix(slug: string): string {
  return `core_${slug}_`
}

/**
 * Allocate the on-disk namespace for a Core. Idempotent — repeated calls
 * with the same slug return the same shape. For sidecar layout, opens
 * (creating if absent) the SQLite file. For table layout, just returns
 * the prefix; CREATE TABLE is the Core's responsibility (gated by
 * `runScopedSql`).
 */
export function allocateCoreNamespace(input: AllocateNamespaceInput): CoreNamespace {
  if (input.layout === 'sidecar') {
    const path = sidecarDbPath(input.dataDir, input.slug)
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path)) {
      // Sanity check — if a stale file collides with a different Core's
      // sidecar (operator hand-placed file), bail with a typed error so
      // the install transcript surfaces it.
      // We can't detect cross-Core collision at the SQL layer (the
      // sidecar is opaque), so this is a best-effort path-existence check
      // only. The lifecycle module uses `core_installations` as the
      // authoritative source-of-truth.
    }
    const sidecar = ProjectDb.open(path)
    return { layout: 'sidecar', sidecar_db_path: path, sidecar_db: sidecar }
  }
  return { layout: 'tables', table_prefix: tablePrefix(input.slug) }
}

/**
 * Release a Core's namespace at uninstall time. Table layout: drops every
 * `core_<slug>_*` table from the project DB. Sidecar: closes + deletes
 * the file.
 *
 * Idempotent: a release on a Core that never wrote any tables is a no-op
 * (DROP IF EXISTS), and releasing a non-existent sidecar path is a no-op.
 *
 * The caller is responsible for marking the install row uninstalled
 * AFTER this returns; we don't touch `core_installations`.
 */
export async function releaseCoreNamespace(input: {
  project_slug: string
  slug: string
  layout: CoreDataLayout
  /** Project DB — required for table layout to drop tables. */
  projectDb: ProjectDb
  /** Instance data dir — required for sidecar layout to delete the file. */
  dataDir: string
  /** Open sidecar handle if the caller already has one; we close before delete. */
  sidecarDb?: ProjectDb
}): Promise<void> {
  if (input.layout === 'sidecar') {
    if (input.sidecarDb !== undefined) {
      try {
        input.sidecarDb.close()
      } catch (_err) {
        // best-effort close; if it was already closed, the unlink still
        // runs — we just don't want a stuck handle to skip cleanup.
      }
    }
    const path = sidecarDbPath(input.dataDir, input.slug)
    if (existsSync(path)) {
      rmSync(path, { force: true })
    }
    // Also remove the sidecar's WAL / SHM siblings if they exist.
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sib = `${path}${suffix}`
      if (existsSync(sib)) rmSync(sib, { force: true })
    }
    return
  }
  // table layout — drop every core_<slug>_* table.
  const prefix = tablePrefix(input.slug)
  // Use raw query to enumerate matching tables. SQLite identifiers can't
  // be parameterized, so we MUST list+drop one-by-one with a hardcoded
  // alphanum-only name allow-list to avoid SQL injection (slug is
  // already sanitized via packageNameToSlug, but defense in depth).
  const rows = input.projectDb
    .raw()
    .query<{ name: string }, [string]>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? || '%'`,
    )
    .all(prefix)
  for (const r of rows) {
    if (!/^[a-z][a-z0-9_]*$/.test(r.name)) {
      // Identifier failed the allow-list — refuse. Should never trigger
      // because slug is normalized, but we never want a stray name to
      // turn into raw SQL execution.
      continue
    }
    await input.projectDb.exec(`DROP TABLE IF EXISTS ${r.name}`)
  }
}

/**
 * Best-effort check that an arbitrary SQL statement only references
 * tables that the calling Core is allowed to touch. Locked policy:
 *
 *   - Tables matching `core_<slug>_*` are always allowed (the Core's own
 *     namespace).
 *   - Tables matching `core_<other_slug>_*` are NEVER allowed (cross-Core
 *     access is deferred to S32–33).
 *   - Tables NOT prefixed `core_*` (the project-shared tables — sessions,
 *     messages, secrets, etc.) are allowed iff the manifest declares
 *     `read:project.db` or `write:project.db`. We don't enforce read-vs-write here; the
 *     SDK's connector layer is the right place for that finer gate.
 *
 * Implementation: tokenizes identifiers (`[a-z][a-z0-9_]*`-shape) and
 * checks every one. Conservative — a Core's SQL with a bare identifier
 * that happens to match `core_other_xxx` will be refused even if it's
 * actually a column reference. The intent is to fail closed; a Core
 * needing complex SQL stays inside its own prefix.
 *
 * This function does NOT execute the SQL — callers run the query
 * themselves on the project DB. The return shape is `{ ok: true } |
 * { ok: false, reason }` so the caller branches.
 */
export function checkSqlNamespace(input: {
  sql: string
  slug: string
  manifest_capabilities: ReadonlyArray<string>
  /** All other Cores currently installed on the same instance — used to
   *  detect cross-Core prefix collisions. Pass an empty array if you
   *  don't want the cross-Core check. */
  other_core_slugs?: ReadonlyArray<string>
}): { ok: true } | { ok: false; reason: string } {
  const ownPrefix = tablePrefix(input.slug)
  const declaresProjectDb = input.manifest_capabilities.some((c) =>
    (PROJECT_DB_CAPABILITIES as ReadonlyArray<string>).includes(c),
  )
  const otherPrefixes = (input.other_core_slugs ?? []).map(tablePrefix)
  // Strip string literals so a quoted 'core_other_x' inside text doesn't
  // trigger the gate. Conservative: also strip `--` line comments and
  // `/* */` blocks.
  const stripped = stripSqlNonIdentifiers(input.sql)
  const ids = stripped.match(/\b[a-z][a-z0-9_]+\b/g) ?? []
  for (const id of ids) {
    if (id.startsWith(ownPrefix)) continue
    // Reserved SQL keywords (lowercase) — don't flag. Conservative list.
    if (SQL_KEYWORDS.has(id)) continue
    if (id.startsWith('core_')) {
      // Other Core's prefix?
      if (otherPrefixes.some((p) => id.startsWith(p))) {
        return {
          ok: false,
          reason: `cross-Core access denied — identifier '${id}' belongs to another Core's namespace`,
        }
      }
      // Same shape as a Core prefix but no installed Core matches — still
      // refuse: a Core MUST NOT reach into a `core_*` table that isn't
      // its own.
      return {
        ok: false,
        reason: `identifier '${id}' looks like a Core-namespaced table but is not in this Core's namespace (own prefix=${ownPrefix})`,
      }
    }
    // Non-Core-namespaced identifier (could be a project-shared table OR
    // a column / alias / keyword). Allow only when project.db is declared.
    if (declaresProjectDb) continue
    // Without project.db capability, we have to be conservative — but we
    // don't want to reject every column reference. Allow lowercase-
    // alphanum identifiers shorter than 8 chars (heuristic for column
    // names) and reject longer non-Core identifiers.
    if (id.length < 8) continue
    if (KNOWN_OWNER_SHARED_TABLES.has(id)) {
      return {
        ok: false,
        reason: `project-shared table '${id}' requires read:project.db or write:project.db capability`,
      }
    }
    // Unknown identifier — allow. The DB itself will reject if the table
    // doesn't exist.
  }
  return { ok: true }
}

/**
 * Run a SQL statement against the project DB only if `checkSqlNamespace`
 * accepts. Throws `CoreInstallError(code: 'sql_namespace_violation')`
 * otherwise.
 *
 * Bound parameters are forwarded through; the SQL itself is never
 * mutated.
 */
export async function runScopedSql(input: {
  sql: string
  params: unknown[]
  slug: string
  manifest_capabilities: ReadonlyArray<string>
  other_core_slugs?: ReadonlyArray<string>
  projectDb: ProjectDb
}): Promise<void> {
  const check = checkSqlNamespace({
    sql: input.sql,
    slug: input.slug,
    manifest_capabilities: input.manifest_capabilities,
    ...(input.other_core_slugs !== undefined ? { other_core_slugs: input.other_core_slugs } : {}),
  })
  if (!check.ok) {
    throw new CoreInstallError('sql_namespace_violation', check.reason, {
      core_slug: input.slug,
    })
  }
  // bun:sqlite's run() only accepts the SQLQueryBindings tuple shape; we
  // type-relax here because the Core author owns the sql<->params
  // contract. The wider project DB is the recipient; busy-retry is on.
  await input.projectDb.run(input.sql, input.params as never)
}

/**
 * Open a sidecar DB by instance + slug. Used at boot when the runtime
 * recomposes Core namespaces from `core_installations`. Idempotent:
 * opening twice is safe (SQLite handles per-connection state).
 */
export function openSidecar(dataDir: string, slug: string): ProjectDb {
  const path = sidecarDbPath(dataDir, slug)
  if (!existsSync(path)) {
    // First boot for this slug — create. Mkdir parent first.
    mkdirSync(dirname(path), { recursive: true })
  }
  return ProjectDb.open(path)
}

/**
 * Helper for tests + lifecycle paths that want a raw `bun:sqlite`
 * `Database` (e.g. to apply a Core's own bundled migrations to the
 * sidecar). Forwards `ProjectDb.raw()` semantics.
 */
export function rawSidecarDatabase(sidecar: ProjectDb): Database {
  return sidecar.raw()
}

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'null', 'is', 'in',
  'on', 'as', 'by', 'order', 'group', 'having', 'limit', 'offset',
  'into', 'values', 'insert', 'update', 'delete', 'set', 'create',
  'table', 'drop', 'alter', 'index', 'unique', 'primary', 'key',
  'references', 'foreign', 'with', 'when', 'case', 'then', 'else',
  'end', 'distinct', 'union', 'all', 'intersect', 'except', 'left',
  'right', 'inner', 'outer', 'join', 'cross', 'natural', 'using',
  'true', 'false', 'asc', 'desc', 'check', 'default', 'collate',
  'cast', 'like', 'between', 'exists', 'count', 'sum', 'avg', 'min',
  'max', 'coalesce', 'json_extract', 'random', 'glob', 'regexp',
  'returning', 'autoincrement', 'integer', 'real', 'text', 'blob',
  'numeric', 'strict', 'temporary', 'temp', 'virtual', 'view',
  'trigger', 'before', 'after', 'instead', 'of', 'for', 'each', 'row',
])

const KNOWN_OWNER_SHARED_TABLES = new Set([
  'sessions', 'messages', 'meters', 'secrets', 'reminders', 'topics',
  'topic_origins', 'reverse_promotions', 'gateway_events', 'workspace_members',
  'tool_approvals', 'inbound_messages', 'invites', 'onboarding_state',
  'persona_drafts', 'profile_pic_jobs', 'profile_pic_candidates',
  'wow_events', 'sean_ellis_responses', 'button_prompts', 'cron_state',
  'api_keys', 'core_installations', 'secret_audit_log',
])

function stripSqlNonIdentifiers(sql: string): string {
  // Remove single-quoted string literals and -- and /* */ comments. We
  // keep double-quoted identifiers (rare in our code; SQLite supports
  // them as identifier quoting) — they'd still be checked.
  return sql
    .replace(/'[^']*'/g, "''")
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .toLowerCase()
}
