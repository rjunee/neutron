/**
 * @neutronai/auth — boot-time CREDENTIAL SCOPE RECONCILER.
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * `secrets.project_slug` and `project_credentials.owner_slug` hold the FROZEN
 * `owner_handle` (see the `auth/secrets-store.ts` header). `open/composer.ts`
 * derives that handle from the BOOT slug, so every credential written BEFORE
 * an instance was provisioned is frozen under the pre-provisioning handle
 * (`dev` on a dogfood box) while the unit later boots as, say, `juno`. Every
 * one of those rows is then unreachable: `readGitHubToken` returns null,
 * `integrations_list` reports live OAuth rows as `connected: false`, and the
 * Codex bundle cannot be seen at all. Measured 2026-08-14: 15 `secrets` rows
 * and 3 `project_credentials` rows orphaned, a night of `fatal: could not read
 * Username for 'https://github.com'` publishes diagnosed as a flaky token.
 *
 * ── WHY THIS IS NOT #451 ───────────────────────────────────────────────────
 * The #451 rename reconciler (`migrations/scope-rekey.ts`) already sweeps both
 * columns — but ONLY when `instance_scope_ledger` DISAGREES with the boot slug.
 * On this box the ledger was seeded AS the boot slug at first boot, so it
 * agrees forever and the every-boot path is a single SELECT noop. Nothing in
 * the tree looked at the credential tables themselves. That is the gap this
 * module closes, and it is why this runs as a SEPARATE step immediately after
 * the #451 block rather than as another entry in `SCOPE_SWEEP_COLUMNS`.
 * `migrations/scope-rekey.ts` behavior is deliberately untouched.
 *
 * ── THE POLICY (owner-approved 2026-08-14) ─────────────────────────────────
 *   UNAMBIGUOUS — exactly ONE distinct non-boot handle across every swept
 *     table, and ZERO rows under the boot handle in EVERY swept table. Nothing
 *     can be clobbered because there is nothing to clobber: migrate in one
 *     transaction and journal an audit row.
 *   AMBIGUOUS — two or more stale handles, or stale rows coexisting with
 *     boot-handle rows. TOUCH NOTHING; report the orphan counts so the
 *     integrations surface can say "scoped to a previous handle" instead of
 *     "not connected".
 *
 * THE ZERO-ROWS-UNDER-THE-BOOT-HANDLE PRECONDITION IS NOT OPTIONAL. It is the
 * rotation hazard, quoting the card: "if a stale `dev` row and a freshly-
 * connected `juno` row both exist for the same service, rewriting the stale one
 * overwrites the new one. The owner reconnects codex, boot 'repairs' it, and
 * the instance is silently back on yesterday's expired token."
 *
 * NEVER REFUSE TO BOOT. The caller wraps this in a try/catch that continues
 * boot on any throw (contrast #451, which fails loud). This box is headless;
 * refusing to boot removes the only surface that could explain why.
 *
 * ── WHY THE MOVE IS SAFE ───────────────────────────────────────────────────
 * `encrypt` in `auth/secrets-store.ts` binds NO AAD — the envelope is
 * `{v,iv_b64,ct_b64,tag_b64}` over the plaintext alone. The scope column is
 * therefore pure metadata and re-scoping is a metadata MOVE: the `ciphertext`
 * bytes must come out byte-identical (pinned by the tests). Nothing is ever
 * decrypted here, so no plaintext can reach a log, an error, or an audit row.
 *
 * ── OUT OF SCOPE: `reminders` ──────────────────────────────────────────────
 * `reminders.project_slug` carries the same stale handle but is NOT a
 * shared-key credential table; it is on the renameable boot-slug axis #451
 * sweeps on rename, and whether an instance-scope key belongs on that table at
 * all is undecided — this reconciler deliberately moves no reminders rows; that
 * is its own card.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { SHARED_KEY_ENCRYPTED_TABLES } from './secrets-store.ts'

/**
 * The scope column of EVERY shared-key-encrypted credential table.
 *
 * The `Record` over the tuple-union is a structural guard, not documentation:
 * adding a table to {@link SHARED_KEY_ENCRYPTED_TABLES} without giving it a
 * scope column here is a COMPILE error, so the sweep can never silently fall
 * behind the table list (acceptance (c) — "moving `secrets` but not
 * `project_credentials` leaves codex and the host-deploy token orphaned").
 */
export const CREDENTIAL_SCOPE_COLUMNS: Record<
  (typeof SHARED_KEY_ENCRYPTED_TABLES)[number],
  string
> = {
  secrets: 'project_slug',
  project_credentials: 'owner_slug',
}

/**
 * Tables that are NOT shared-key-encrypted themselves but whose scope column
 * must move WITH one that is.
 *
 * `api_keys` is metadata-only — it points at `secrets` via `secret_id` (see
 * `auth/secrets-store.ts:71-74`, which is why the S3(a) restore guard covers it
 * transitively) — but the BYO read path (`ApiKeyStore.list` →
 * `resolveLlmCredentials`, wired at `gateway/cores/integrations.ts:120-133`)
 * keys off ITS OWN `project_slug`. Moving `secrets` without it would leave BYO
 * keys half-orphaned: the secret readable, the metadata row invisible. A
 * deliberate, documented extension beyond acceptance (c)'s minimum.
 */
export const CREDENTIAL_SCOPE_COMPANION_TABLES: readonly {
  table: string
  column: string
}[] = [{ table: 'api_keys', column: 'project_slug' }]

/** One `(table, column)` pair this reconciler sweeps. */
export interface CredentialScopeColumn {
  table: string
  column: string
}

/** Rows moved onto the boot handle in one table. */
export interface CredentialScopeMove {
  table: string
  rows: number
}

/** Rows left in place under a non-boot handle in one table. */
export interface CredentialScopeOrphanCount {
  table: string
  handle: string
  rows: number
}

/**
 * What one boot-time reconciliation did. Payloads carry ONLY table names,
 * handles and counts — never a `kind`/`label`/`service` value, never ciphertext
 * and never plaintext (acceptance (d)).
 */
export type CredentialScopeReconcileResult =
  | { action: 'noop' }
  | {
      action: 'migrated'
      boot_handle: string
      stale_handles: string[]
      moved: CredentialScopeMove[]
    }
  | {
      action: 'orphaned'
      boot_handle: string
      stale_handles: string[]
      orphan_counts: CredentialScopeOrphanCount[]
    }

/**
 * SQLite identifiers are not parameterisable, so table/column names are
 * interpolated. They come from the frozen lists above, but the assertion is
 * kept (same shape as `scope-rekey.ts:assertIdent`) so a future entry with a
 * stray character fails loudly here instead of becoming a SQL-shaped surprise.
 */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

function assertIdent(name: string, what: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(
      `credential-scope-reconcile: unsafe ${what} identifier ${JSON.stringify(name)}`,
    )
  }
  return name
}

/**
 * Every `(table, column)` the reconciler sweeps: the shared-key credential
 * tables plus their metadata companions, in a stable order.
 */
export function credentialScopeSweepColumns(): CredentialScopeColumn[] {
  return [
    ...SHARED_KEY_ENCRYPTED_TABLES.map((table) => ({
      table,
      column: CREDENTIAL_SCOPE_COLUMNS[table],
    })),
    ...CREDENTIAL_SCOPE_COMPANION_TABLES,
  ]
}

/**
 * TRUE when this database's schema has `table`. A DB migrated to a version
 * before that table's migration is treated as empty rather than erroring —
 * same `sqlite_master` guard as `hasSharedKeyEncryptedRows`
 * (`auth/secrets-store.ts:90-105`).
 */
function tableExists(db: Pick<ProjectDb, 'get'>, table: string): boolean {
  const present = db.get<{ n: number }, [string]>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table],
  )
  return present !== null && present.n > 0
}

interface HandleCountRow {
  handle: string | null
  n: number
}

/** Per-table `handle → row count` maps plus the derived handle partition. */
interface CredentialScopeCensus {
  /** One entry per SWEPT (existing) table, in `credentialScopeSweepColumns` order. */
  tables: Array<{ table: string; column: string; counts: Map<string, number> }>
  /** Distinct non-boot handles seen anywhere, sorted. */
  stale_handles: string[]
  /** Total rows already sitting under the boot handle, across every swept table. */
  boot_handle_rows: number
}

/**
 * The raw census: one cheap GROUP BY per existing swept table. No ciphertext
 * column is ever read, nothing is decrypted, and nothing is written — this is
 * the shared read-only core behind both {@link reconcileCredentialScope} (which
 * needs the per-table counts to drive its move) and {@link censusCredentialScope}
 * (which the LIVE integrations status surface calls on every read).
 */
function censusCredentialScopeTables(
  db: Pick<ProjectDb, 'all' | 'get'>,
  boot_handle: string,
): CredentialScopeCensus {
  const swept = credentialScopeSweepColumns().filter(({ table }) => tableExists(db, table))
  const tables: CredentialScopeCensus['tables'] = []
  const staleHandles = new Set<string>()
  let boot_handle_rows = 0

  for (const { table, column } of swept) {
    const t = assertIdent(table, 'table')
    const c = assertIdent(column, 'column')
    const rows = db.all<HandleCountRow, []>(
      `SELECT ${c} AS handle, count(*) AS n FROM ${t} GROUP BY ${c}`,
      [],
    )
    const counts = new Map<string, number>()
    for (const row of rows) {
      if (row.handle === null) continue
      counts.set(row.handle, row.n)
      if (row.handle === boot_handle) boot_handle_rows += row.n
      else staleHandles.add(row.handle)
    }
    tables.push({ table, column, counts })
  }

  return { tables, stale_handles: [...staleHandles].sort(), boot_handle_rows }
}

/** Flatten a census into one `(table, stale handle, rows)` row per non-empty pair. */
function orphanCountsOf(census: CredentialScopeCensus): CredentialScopeOrphanCount[] {
  const orphan_counts: CredentialScopeOrphanCount[] = []
  for (const { table, counts } of census.tables) {
    for (const handle of census.stale_handles) {
      const rows = counts.get(handle)
      if (rows !== undefined && rows > 0) orphan_counts.push({ table, handle, rows })
    }
  }
  return orphan_counts
}

/**
 * READ-ONLY census of the credential tables' scope columns against the boot
 * handle — the same sweep {@link reconcileCredentialScope} runs at boot, exposed
 * for the LIVE status surface (`buildIntegrationsStatus`) so a wrong-scope miss
 * can report "scoped to a previous handle" instead of "not connected"
 * (acceptance (b), card 2026-08-14).
 *
 * Writes nothing, decrypts nothing, and returns only table names, handles and
 * counts.
 */
export function censusCredentialScope(
  db: ProjectDb,
  boot_handle: string,
): {
  stale_handles: string[]
  boot_handle_rows: number
  orphan_counts: CredentialScopeOrphanCount[]
} {
  const census = censusCredentialScopeTables(db, boot_handle)
  return {
    stale_handles: census.stale_handles,
    boot_handle_rows: census.boot_handle_rows,
    orphan_counts: orphanCountsOf(census),
  }
}

/**
 * The `(kind, label)` of every `secrets` row scoped to a NON-boot handle.
 *
 * `kind`/`label` are SLOT IDENTIFIERS the integrations panel already renders
 * (`google_calendar`, `tavily`) — never secret material; the `ciphertext` column
 * is deliberately not in the SELECT. This exists for the LIVE status surface
 * ONLY: it must never be journaled to system events, because the audit rows stay
 * counts-and-handles-only per acceptance (d).
 *
 * Returns `[]` when the `secrets` table predates this DB's migration level.
 */
export function listOrphanedSecretSlots(
  db: Pick<ProjectDb, 'all' | 'get'>,
  boot_handle: string,
): Array<{ kind: string; label: string }> {
  if (!tableExists(db, 'secrets')) return []
  return db.all<{ kind: string; label: string }, [string]>(
    'SELECT kind, label FROM secrets WHERE project_slug IS NOT NULL AND project_slug <> ?',
    [boot_handle],
  )
}

/**
 * Reconcile the credential tables' scope columns with the handle this process
 * just booted as. See the module header for the policy; the short version:
 * unambiguous ⇒ migrate in one transaction, ambiguous ⇒ zero writes.
 *
 * Never decrypts anything and never returns secret material.
 */
export async function reconcileCredentialScope(
  db: ProjectDb,
  boot_handle: string,
): Promise<CredentialScopeReconcileResult> {
  const census = censusCredentialScopeTables(db, boot_handle)
  const { stale_handles } = census

  if (stale_handles.length === 0) return { action: 'noop' }

  // THE UNAMBIGUOUS PRECONDITION — all three clauses, none optional (see the
  // rotation hazard in the module header): exactly one stale handle, it is not
  // the boot handle (guaranteed by construction of the set), and there are ZERO
  // rows under the boot handle in EVERY swept table.
  if (stale_handles.length !== 1 || census.boot_handle_rows > 0) {
    return {
      action: 'orphaned',
      boot_handle,
      stale_handles,
      orphan_counts: orphanCountsOf(census),
    }
  }

  const stale = stale_handles[0]!

  // ONE transaction for the whole move: a partial repair is worse than none.
  // Deliberately a plain `UPDATE`, NOT `UPDATE OR IGNORE` — the precondition
  // above guarantees there is no boot-handle row to collide with, so a UNIQUE
  // violation means the precondition was computed wrong and the transaction MUST
  // roll back whole. The caller catches, boot continues, and the state degrades
  // to orphan reporting rather than to a half-moved credential set.
  const moved = await db.transaction(async (tx) => {
    const out: CredentialScopeMove[] = []
    for (const { table, column, counts } of census.tables) {
      const rows = counts.get(stale)
      if (rows === undefined || rows === 0) continue
      const t = assertIdent(table, 'table')
      const c = assertIdent(column, 'column')
      const result = tx.runSync<[string, string]>(
        `UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`,
        [boot_handle, stale],
      )
      out.push({ table, rows: result.changes })
    }
    return out
  })

  return { action: 'migrated', boot_handle, stale_handles, moved }
}
