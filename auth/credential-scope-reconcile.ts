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
 * ── THE EXPLICIT ACTION FOR THE AMBIGUOUS CASE ─────────────────────────────
 * {@link migrateOrphanedCredentialScope} is the OTHER half: boot deliberately
 * touches nothing in the ambiguous case, so the leftovers need an owner-driven
 * way out (the `integrations_migrate_orphaned` tool / `POST
 * /api/cores/integrations/migrate-orphaned`). An EXPLICIT action still may not
 * overwrite a fresh credential — the rotation hazard does not stop being a
 * data-loss bug because a human asked for it. So the explicit move is
 * COLLISION-GUARDED: every orphaned row whose UNIQUE slot is FREE under the
 * boot handle moves; every row that would land on an occupied slot is SKIPPED
 * and reported, so the owner reconnects or disconnects it deliberately. The
 * per-table UNIQUE keys live in {@link CREDENTIAL_SCOPE_COLLISION_KEYS} (and
 * the companion entries' `collision_keys`). Still a pure metadata move: nothing
 * is decrypted, and the ciphertext bytes never change.
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
 * The remaining columns of each shared-key table's UNIQUE constraint — the
 * "slot" a credential occupies once its scope column is fixed.
 *
 * Read straight off the schema: `secrets` UNIQUE(project_slug, kind, label)
 * (migration 0009) and `project_credentials` UNIQUE(owner_slug, project_id,
 * service) (migration 0092). Every listed column is NOT NULL, so the collision
 * probe can compare with plain `=` — no NULL-safe operator needed.
 *
 * A PARALLEL `Record` rather than a field on {@link CREDENTIAL_SCOPE_COLUMNS}
 * (which is a `Record<table, string>` the boot path reads as a bare column
 * name): keeping them separate leaves the boot path's shape untouched while
 * still failing to COMPILE if a table joins {@link SHARED_KEY_ENCRYPTED_TABLES}
 * without declaring its collision key. Companion tables carry theirs inline on
 * {@link CREDENTIAL_SCOPE_COMPANION_TABLES} instead, since that list is a plain
 * array with no tuple-union to guard.
 */
export const CREDENTIAL_SCOPE_COLLISION_KEYS: Record<
  (typeof SHARED_KEY_ENCRYPTED_TABLES)[number],
  readonly string[]
> = {
  secrets: ['kind', 'label'],
  project_credentials: ['project_id', 'service'],
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
  /** See {@link CREDENTIAL_SCOPE_COLLISION_KEYS}: `api_keys` UNIQUE(project_slug, provider, label). */
  collision_keys: readonly string[]
}[] = [{ table: 'api_keys', column: 'project_slug', collision_keys: ['provider', 'label'] }]

/** One `(table, column)` pair this reconciler sweeps. */
export interface CredentialScopeColumn {
  table: string
  column: string
  /**
   * The rest of the table's UNIQUE key. Only the EXPLICIT migrate action reads
   * these (to skip a row that would clobber a fresh credential); the boot path's
   * unambiguous precondition already guarantees nothing to collide with.
   */
  collision_keys: readonly string[]
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
      /**
       * Present only when the DIRECTION guard refused: the boot handle was the
       * fallback and the rows sit under an explicit one. The counts are
       * identical to any other orphan report — this flag exists so the log line
       * says WHY nothing moved, because "ambiguous census" and "anonymous
       * process" are different problems with different fixes (fix the data vs
       * set the handle).
       */
      refused_direction?: true
    }

/**
 * Where the boot handle CAME FROM. Carried separately from the handle itself
 * because the handle alone cannot answer the only question that matters here:
 * a fallback `'dev'` and a configured `'dev'` are the same string and opposite
 * situations.
 */
export interface CredentialScopeProvenance {
  /**
   * True when the boot handle is the bare fallback — env/config absent, not
   * explicitly set. A fallback identity may never pull rows off an explicit
   * handle, on ANY surface: not at boot, and not when an owner-driven action
   * asks for it, because a process that does not know who it is has no owner
   * to have been asked by.
   */
  slug_is_fallback: boolean
}

/** Options for one boot-time credential-scope reconciliation. */
export interface CredentialScopeReconcileOptions {
  /**
   * True when the boot handle is the bare fallback — env/config absent, not
   * explicitly set. A fallback identity may never pull rows off an explicit
   * handle. Mirrors `ReconcileInstanceScopeOptions.currentSlugIsFallback` in
   * `migrations/scope-rekey.ts`; both are fed from the same `slugResolution`.
   */
  currentSlugIsFallback?: boolean
}

/**
 * What one EXPLICIT (owner-driven) migration did. Like the boot result, this
 * carries ONLY table names, handles and counts — never a `kind`/`label`/
 * `service` VALUE, never ciphertext, never plaintext (acceptance (d)).
 */
export interface CredentialScopeMigrateResult {
  /**
   * Present only when the DIRECTION guard refused: the boot handle was the
   * fallback, so nothing moved and every orphan is reported as skipped. Callers
   * render a different sentence for this than for a collision — "set the
   * handle" rather than "the slot is taken".
   */
  refused_direction?: true
  boot_handle: string
  /** Every non-boot handle seen in the census (whether or not anything moved). */
  stale_handles: string[]
  /** Rows actually re-scoped, one entry per table with a non-zero move. */
  moved: CredentialScopeMove[]
  /** Rows left behind because their slot is already taken under the boot handle. */
  skipped: CredentialScopeOrphanCount[]
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
      collision_keys: CREDENTIAL_SCOPE_COLLISION_KEYS[table],
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
  tables: Array<CredentialScopeColumn & { counts: Map<string, number> }>
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

  for (const { table, column, collision_keys } of swept) {
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
    tables.push({ table, column, collision_keys, counts })
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
  options: CredentialScopeReconcileOptions = {},
): Promise<CredentialScopeReconcileResult> {
  const census = censusCredentialScopeTables(db, boot_handle)
  const { stale_handles } = census

  if (stale_handles.length === 0) return { action: 'noop' }

  // DIRECTION GUARD — the same one `migrations/scope-rekey.ts` carries, and it
  // has to be repeated here because this sweep is a SECOND reconciler over a
  // DIFFERENT set of tables. Closing the direction on one of them closes
  // nothing: the unambiguous precondition below is satisfied EXACTLY by the
  // dangerous case (rows under the live handle, none under the anonymous one),
  // so an unconfigured boot would sail through it and take the credentials the
  // other guard just refused to take. Measured on this branch before the guard
  // existed: with an explicit handle seeded and the slug then unset, every
  // credential row moved onto the fallback.
  //
  // A fallback handle means "nobody told me who I am", which is never a
  // licence to claim someone else's rows. Zero writes; the orphan report is
  // already the honest description of what this process can see, and the
  // integrations surface renders it as "scoped to a previous handle" rather
  // than the "not connected" that sent the owner hunting for a lost token.
  if (options.currentSlugIsFallback === true) {
    return {
      action: 'orphaned',
      boot_handle,
      stale_handles,
      orphan_counts: orphanCountsOf(census),
      refused_direction: true,
    }
  }

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

/**
 * EXPLICIT, COLLISION-GUARDED migration — the way out of the AMBIGUOUS case
 * boot deliberately refuses to touch (card 2026-08-14). Moves every orphaned
 * row whose UNIQUE slot is FREE under `boot_handle`, and SKIPS (and counts)
 * every row that would land on a slot already occupied by a boot-handle row.
 *
 * The `NOT EXISTS` probe IS the rotation hazard, quoting the card: "if a stale
 * `dev` row and a freshly-connected `juno` row both exist for the same service,
 * rewriting the stale one overwrites the new one. The owner reconnects codex,
 * boot 'repairs' it, and the instance is silently back on yesterday's expired
 * token." An explicit action does not get to do that either — a skipped row is
 * reported so the owner reconnects or disconnects that slot deliberately.
 *
 * Nothing is decrypted, the ciphertext column is never even SELECTed, and the
 * result carries counts/handles/table-names only.
 */
export async function migrateOrphanedCredentialScope(
  db: ProjectDb,
  boot_handle: string,
  provenance: CredentialScopeProvenance,
): Promise<CredentialScopeMigrateResult> {
  const census = censusCredentialScopeTables(db, boot_handle)
  const { stale_handles } = census
  if (stale_handles.length === 0) {
    return { boot_handle, stale_handles: [], moved: [], skipped: [] }
  }

  // THE DIRECTION GUARD, ON THIS SIDE TOO — and the reason it is a REQUIRED
  // argument rather than an option with a safe default.
  //
  // The boot path refused an anonymous fallback and this one did not, so the
  // guard was real and bypassable in one step: boot as the `'dev'` fallback,
  // call the explicit migration, and every row moves off the live handle. A
  // review found it; the repro is one seeded row and one dispatch. Closing the
  // direction on the automatic sweep closed nothing while an explicit surface
  // sat beside it doing the same write with no question asked — the same
  // mistake as the two-reconcilers one, one level up.
  //
  // "Explicit" is not the property that makes a move safe. The owner asking is
  // only meaningful when the process knows WHO it is; a fallback handle means
  // nobody said, so there is no owner to have asked. An anonymous process
  // asking itself politely is still an anonymous process.
  //
  // Required, not optional-defaulting-to-false, because the failure is silent:
  // a new surface that forgets it would compile, pass, and quietly do the
  // unguarded thing. This way forgetting is a type error.
  if (provenance.slug_is_fallback) {
    return {
      boot_handle,
      stale_handles,
      moved: [],
      skipped: orphanCountsOf(census),
      refused_direction: true,
    }
  }

  // ONE transaction for the whole move, same as the boot path: a partial
  // repair is worse than none.
  return await db.transaction(async (tx) => {
    const moved: CredentialScopeMove[] = []
    const skipped: CredentialScopeOrphanCount[] = []
    for (const { table, column, collision_keys, counts } of census.tables) {
      const t = assertIdent(table, 'table')
      const c = assertIdent(column, 'column')
      // `fresh.<k> = <t>.<k>` — every key column is NOT NULL in the schema, so
      // plain `=` is exact (see CREDENTIAL_SCOPE_COLLISION_KEYS).
      const match = collision_keys
        .map((key) => {
          const k = assertIdent(key, 'collision key')
          return `fresh.${k} = ${t}.${k}`
        })
        .join(' AND ')
      let movedRows = 0
      for (const handle of stale_handles) {
        const rows = counts.get(handle)
        if (rows === undefined || rows === 0) continue
        const result = tx.runSync<[string, string, string]>(
          `UPDATE ${t} SET ${c} = ? WHERE ${c} = ? AND NOT EXISTS (` +
            `SELECT 1 FROM ${t} AS fresh WHERE fresh.${c} = ? AND ${match})`,
          [boot_handle, handle, boot_handle],
        )
        movedRows += result.changes
        const skippedRows = rows - result.changes
        if (skippedRows > 0) skipped.push({ table, handle, rows: skippedRows })
      }
      if (movedRows > 0) moved.push({ table, rows: movedRows })
    }
    return { boot_handle, stale_handles, moved, skipped }
  })
}
