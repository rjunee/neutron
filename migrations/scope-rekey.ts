/**
 * @neutronai/migrations — boot-time INSTANCE SCOPE RECONCILER (ISSUES #451).
 *
 * ── THE DEFECT ─────────────────────────────────────────────────────────────
 * An instance has a frozen handle and a RENAMEABLE `url_slug`. Nearly every
 * table in `project.db` is scoped by that renameable slug (`project_slug`, plus
 * two other spellings of the same idea). The gateway resolves it ONCE at boot
 * (`resolveOwnerSlugFromConfig`) and hands that one string to the whole module
 * graph, so after a rename the process asks for the NEW key while every row
 * written before the rename still carries the OLD one. The database is split in
 * two and nothing notices.
 *
 * The worst miss is `onboarding_state`. `isOnboardingActive` (open/composer.ts)
 * reads `onboardingStateStore.get(project_slug, user_id)` and FAIL-CLOSES on a
 * miss — `st === null → true`. So an owner whose row plainly says
 * `phase = 'completed'` is reported as still onboarding, forever. Two things
 * follow: the bundled-ritual boot sweep defers on every boot (its gate is that
 * same predicate), so the ritual layer can never turn on; and the live-turn
 * builder keeps `onboardingActive` true, which pins the cold-turn onboarding
 * preamble on and runs every ordinary message through the onboarding-answer
 * extractor. The owner cannot get out of onboarding by using the product,
 * because using the product is what keeps him in it.
 *
 * ── THE DECISION: MIGRATE FORWARD, KEEP THE BOOT SLUG AS THE KEY ───────────
 * The boot-resolved slug stays the scope key and stranded rows are moved onto
 * it. The alternative — re-key the system onto the frozen handle — was rejected
 * for two independent reasons:
 *
 *   1. The boot value is load-bearing for AUTH EQUALITY, not just for DB
 *      keying: the owner gate compares the session cookie to it
 *      (`open/wiring/owner-gate.ts`), as does the landing auth gate. Flipping
 *      the key would invalidate every live cookie and token.
 *   2. A self-hosted install has no handle at all — there is nothing central to
 *      freeze — so "key everything on the handle" is not even expressible there.
 *
 * The codebase had already reached the same conclusion for the one table that
 * mattered most: `SqliteOnboardingStateStore.rekey` exists, with collision
 * detection. What was missing was anything that CALLED a re-key at boot, for
 * every other table. This module is that.
 *
 * ── WHY THIS IS CODE AND NOT A `.sql` MIGRATION ────────────────────────────
 * The migration runner loads `*.sql` files only, and static SQL cannot know the
 * slug the process just resolved from `<owner_home>/.url_slug` or the
 * environment. The re-key is inherently parameterised on a boot-time value, so
 * it is a boot STEP that runs after migrations and before the module graph is
 * composed (i.e. before the ritual sweep and before the first turn).
 *
 * ── MECHANICS ──────────────────────────────────────────────────────────────
 * `instance_scope_ledger` (migration 0114) is a singleton row recording the key
 * this database is scoped to.
 *
 *   ledger == current            → no-op. One SELECT, zero writes. This is the
 *                                  every-boot path.
 *   ledger != current            → re-key ledger→current, update the ledger.
 *   ledger absent (first boot     → BACKFILL. Stale keys are discovered from
 *   after this ships)              `onboarding_state`, the anchor table: a real
 *                                  install has exactly one owner row, so any
 *                                  DISTINCT `project_slug` there that is not
 *                                  the current one is a stranded key. Each is
 *                                  re-keyed forward; then the ledger is seeded.
 *
 * Everything — the snapshot excepted — happens in ONE `BEGIN IMMEDIATE`
 * transaction whose LAST write is the ledger. A crash therefore rolls the moves
 * back together with the ledger, and the next boot simply retries. After a
 * successful run the ledger equals the current slug and the whole thing is a
 * single SELECT, so it is idempotent by construction rather than by a guard
 * flag.
 *
 * ── COLLISION POLICY ───────────────────────────────────────────────────────
 * The generic move is `UPDATE OR IGNORE … WHERE col = old` followed by
 * `DELETE FROM … WHERE col = old`. That means: rows move unless a row already
 * exists under the current key, and on a collision THE CURRENT-KEY ROW WINS and
 * the old-key row is dropped. This is the right default because the current-key
 * rows are live state the running system produced, while the old-key ones are
 * leftovers from before the rename.
 *
 * `onboarding_state` is the ONE exception and is resolved FIRST, before the
 * generic move: there, blind "new wins" is precisely the bug. A post-rename
 * boot creates a fresh non-terminal row under the new key (the fail-closed
 * predicate starts onboarding again), and letting that shadow a `completed` row
 * would make the defect permanent. So per `user_id` the more AUTHORITATIVE row
 * survives — a terminal phase beats a non-terminal one (`completed` beats
 * `failed` beats everything else), ties break on the greater
 * `last_advanced_at`, and a total tie keeps the current-key row for consistency
 * with the generic rule. The loser is deleted so the generic move can proceed
 * without a conflict.
 *
 * ── WHAT IS DELIBERATELY NOT SWEPT ─────────────────────────────────────────
 * {@link SCOPE_EXCLUDED_COLUMNS}. Two kinds: columns that name a DIFFERENT
 * instance (rewriting them would silently re-address another party's records to
 * us), and columns whose value is not an instance key at all (a Core package
 * id, a per-run slug, a member's local slug). Both lists are explicit and
 * versioned, and `migrations/__tests__/scope-sweep-coverage.test.ts` asserts
 * their union covers every slug-ish column in `expected-schema.txt` — so a new
 * table cannot be added without someone classifying it.
 *
 * The exact-match predicate (`WHERE col = old`) is also what keeps the
 * scope-KEY tables safe. `work_board_items` and `code_trident_runs` store the
 * output of `workBoardScopeKey`, which is the owner slug for the General board
 * and the raw project id for a real project. Owner-board rows match the old key
 * and move; project rows don't match and correctly stay put.
 */

import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import type { Database } from 'bun:sqlite'

import { createLogger } from '@neutronai/logger'

const log = createLogger('scope-rekey')

/** One `(table, column)` pair carrying this instance's scope key. */
export interface ScopedColumn {
  table: string
  column: string
}

/**
 * EVERY column that holds THIS instance's scope key, and is therefore moved
 * forward on a rename. Explicit and versioned on purpose: a generated list
 * ("every column matching /slug/") would silently swallow the exclusions below,
 * which is the failure mode that turns a repair into data corruption.
 *
 * Sorted by table so a diff reads as a list of tables, not a reshuffle.
 */
export const SCOPE_SWEEP_COLUMNS: readonly ScopedColumn[] = [
  { table: 'api_keys', column: 'project_slug' },
  { table: 'code_ritual_runs', column: 'project_slug' },
  { table: 'code_trident_runs', column: 'project_slug' },
  // A QUEUED build, waiting on a blocker or on a file another run holds. Left on
  // the old slug it becomes unreachable: the sweep looks its card up by
  // (project_slug, board_item_id), finds nothing, and drops the hold as a card
  // that went away — so a rename would silently discard queued work rather than
  // merely mis-scope it.
  { table: 'code_trident_dispatch_holds', column: 'project_slug' },
  // The owner boundary on Codex seat rotation. Stranding these on a rename would
  // orphan every connected seat AND lose the active-slot pointer, so rotation
  // would silently start over from the first seat — including re-selecting one
  // that is still capped, with its recorded cooldown left behind.
  { table: 'codex_rotation_active', column: 'owner_slug' },
  { table: 'codex_rotation_slots', column: 'owner_slug' },
  { table: 'core_installations', column: 'project_slug' },
  { table: 'cores_oauth_broker_pending', column: 'project_slug' },
  { table: 'cores_oauth_pending', column: 'project_slug' },
  { table: 'cron_state', column: 'project_slug' },
  { table: 'current_focus_pick', column: 'project_slug' },
  { table: 'device_push_tokens', column: 'project_slug' },
  { table: 'gateway_events', column: 'project_slug' },
  { table: 'import_jobs', column: 'project_slug' },
  { table: 'import_pass1_chunks', column: 'project_slug' },
  { table: 'import_results', column: 'project_slug' },
  // The instance's own metadata row (timezone, transcription backend, …). Its
  // PRIMARY KEY *is* the slug, which is exactly why it cannot double as the
  // ledger — a renamed instance can't look its own row up.
  { table: 'instance_metadata', column: 'instance_slug' },
  { table: 'onboarding_state', column: 'project_slug' },
  { table: 'onboarding_transcripts_meta', column: 'project_slug' },
  { table: 'overnight_queue', column: 'project_slug' },
  { table: 'persona_drafts', column: 'project_slug' },
  { table: 'proactive_topic_state', column: 'project_slug' },
  { table: 'profile_pic_jobs', column: 'project_slug' },
  { table: 'profile_pic_pending', column: 'project_slug' },
  // Same axis under a different name: the owner boundary on stored credentials.
  { table: 'project_credentials', column: 'owner_slug' },
  // Same owner boundary again, on the per-project connected-account selection
  // (#500). Stranding these on a rename would silently re-enable accounts a
  // project had turned off — a privacy regression, not just lost data.
  { table: 'project_account_selection', column: 'owner_slug' },
  { table: 'project_launcher_entries', column: 'project_slug' },
  { table: 'reminders', column: 'project_slug' },
  { table: 'sean_ellis_responses', column: 'project_slug' },
  { table: 'secret_audit_log', column: 'project_slug' },
  { table: 'secrets', column: 'project_slug' },
  { table: 'signin_events', column: 'project_slug' },
  { table: 'skill_forge_proposals', column: 'project_slug' },
  { table: 'system_events', column: 'project_slug' },
  { table: 'task_reminder_links', column: 'project_slug' },
  { table: 'tasks', column: 'project_slug' },
  { table: 'tool_approvals', column: 'project_slug' },
  { table: 'topics', column: 'project_slug' },
  { table: 'upload_sessions', column: 'project_slug' },
  { table: 'watchdog_alerts', column: 'project_slug' },
  { table: 'work_board_items', column: 'project_slug' },
  { table: 'wow_events', column: 'project_slug' },
]

/** A slug-ish column the sweep must NEVER touch, with the reason. */
export interface ExcludedScopedColumn extends ScopedColumn {
  why: string
}

/**
 * Slug-ish columns that are deliberately NOT swept. Every entry is either
 * FOREIGN (it names another instance — rewriting it would re-address someone
 * else's record to us) or NOT-AN-INSTANCE-KEY (a Core package id, a run slug, a
 * member's local slug). The coverage test pins that this list plus
 * {@link SCOPE_SWEEP_COLUMNS} accounts for every slug-ish column in the schema.
 */
export const SCOPE_EXCLUDED_COLUMNS: readonly ExcludedScopedColumn[] = [
  {
    table: 'code_trident_runs',
    column: 'slug',
    why: 'NOT-AN-INSTANCE-KEY — the per-run slug of a code run.',
  },
  {
    table: 'connect_guest_invites',
    column: 'redeemed_by_slug',
    why: "NOT-AN-INSTANCE-KEY — the redeeming member's `connected_members.local_slug`.",
  },
  {
    table: 'connected_members',
    column: 'local_slug',
    why: "NOT-AN-INSTANCE-KEY — a member's local handle within this instance (the PK).",
  },
  {
    table: 'connected_members',
    column: 'home_instance_slug',
    why: 'FOREIGN — the instance a connected member belongs to, not this one.',
  },
  {
    table: 'core_global_installations',
    column: 'core_slug',
    why: 'NOT-AN-INSTANCE-KEY — a Core package id.',
  },
  {
    table: 'core_installations',
    column: 'core_slug',
    why: 'NOT-AN-INSTANCE-KEY — a Core package id.',
  },
  {
    table: 'instance_scope_ledger',
    column: 'project_slug',
    why:
      'THE LEDGER ITSELF — it records the key being migrated TO, so it is ' +
      'written explicitly (once, last) rather than swept. Sweeping it would ' +
      'make the reconciler rewrite its own bookkeeping mid-flight.',
  },
  {
    table: 'inbound_messages',
    column: 'origin_instance_slug',
    why: 'FOREIGN — the instance a cross-instance message came FROM.',
  },
  {
    table: 'inbound_messages',
    column: 'receiving_instance_slug',
    why:
      'FOREIGN-AXIS — the name a message was ADDRESSED to at receipt time. This is ' +
      'an append-only audit record of what was delivered, so rewriting it would ' +
      'falsify history; the table is paired with `origin_instance_slug` and both ' +
      'halves stay as-received.',
  },
  {
    table: 'invites',
    column: 'workspace_instance_slug',
    why: 'FOREIGN — the instance an invite points AT.',
  },
  {
    table: 'overnight_queue',
    column: 'trident_slug',
    why: 'NOT-AN-INSTANCE-KEY — the slug of the code run an item dispatched.',
  },
  {
    table: 'pending_redirects',
    column: 'new_slug',
    why:
      'NOT-A-SCOPE-KEY — a rename REDIRECT TARGET, not the row\'s own scope. These ' +
      'rows are short-lived and expiry-swept; rewriting the target would point a ' +
      'redirect at itself.',
  },
  {
    table: 'project_launcher_entries',
    column: 'slug',
    why: 'NOT-AN-INSTANCE-KEY — a per-project launcher entry id.',
  },
  {
    table: 'reverse_promotions',
    column: 'source_workspace_instance_slug',
    why: 'FOREIGN — the instance a promotion originated on.',
  },
  {
    table: 'secret_audit_log',
    column: 'core_slug',
    why: 'NOT-AN-INSTANCE-KEY — the Core that read the secret.',
  },
  {
    table: 'topic_origins',
    column: 'origin_user_instance_slug',
    why: "FOREIGN — the origin user's home instance.",
  },
]

/** Per-table outcome of one re-key. */
export interface ScopeRekeyTableCount {
  table: string
  column: string
  /** Rows carried forward onto the current key. */
  moved: number
  /** Old-key rows discarded because a current-key row already held the slot. */
  dropped: number
}

/** What one `old → current` re-key did. */
export interface ScopeRekeyResult {
  from: string
  to: string
  /** Per-table counts, only for tables that actually had rows under `from`. */
  tables: ScopeRekeyTableCount[]
  moved_total: number
  dropped_total: number
  /**
   * `onboarding_state` rows deleted by the authority policy before the generic
   * move (the losing half of an old-vs-current pair).
   */
  onboarding_conflicts_resolved: number
}

/** What the boot-time reconciliation did, in full. */
export interface ScopeReconcileResult {
  /** The boot-resolved slug everything is now scoped to. */
  current_slug: string
  /**
   * `noop`   — the ledger already agreed; nothing was written.
   * `seeded` — the ledger was absent and nothing was stranded; only the ledger
   *            was written (the first boot on a never-renamed install).
   * `rekeyed`— at least one stranded key was migrated forward.
   */
  action: 'noop' | 'seeded' | 'rekeyed'
  /** One entry per stranded key that was migrated forward. */
  rekeys: ScopeRekeyResult[]
  /** Absolute path of the pre-re-key snapshot, when one was taken. */
  snapshot_path: string | null
  moved_total: number
  dropped_total: number
  /**
   * Present only when the direction guard refused: the boot slug was the
   * fallback and the DB already carries rows under an explicit handle. Nothing
   * was written.
   */
  refused_direction?: {
    stranded_keys: string[]
    /**
     * How many rows were at stake, in total. FOR THE LOG LINE ONLY — this must
     * never reach a `system_events` payload, and there is deliberately no
     * per-handle breakdown here for one to be built from (Argus r2 blocker,
     * 2026-08-16). It is a `COUNT(*)` over ~40 swept tables, so it moves every
     * time the owner creates a task or a reminder; a journal payload containing
     * it changes on every boot, which re-arms the edge trigger and drains the
     * owner's 50-row diagnostics window — the exact starvation
     * `gateway/scope-refusal-journal.ts` exists to prevent. Logs are unbounded
     * and compete with nothing, so the operator keeps the number there.
     */
    stranded_rows: number
  }
}

export interface ReconcileInstanceScopeOptions {
  /**
   * Absolute path of the database file, used to place the pre-re-key snapshot
   * beside it. Omit (or pass `:memory:`) to skip snapshotting — tests and
   * in-memory databases have nothing to preserve.
   */
  dbPath?: string
  /** Test seam for the clock. */
  now?: () => number
  /** How many pre-re-key snapshots to retain, newest first. */
  keepSnapshots?: number
  /**
   * True when the boot slug is the bare `'dev'` FALLBACK — env/config absent,
   * not explicitly set. A fallback identity may never pull rows off an explicit
   * handle.
   *
   * REQUIRED, exactly like the explicit path's (`auth/credential-scope-reconcile.ts`
   * `migrateOrphanedCredentialScope`, whose `provenance` argument carries the
   * same rationale). It was optional, and the guard below fires only on an
   * explicit `true` — so `reconcileInstanceScope(db, 'dev', { dbPath })` FAILED
   * OPEN and moved the live owner's rows onto the anonymous handle. That is the
   * precise defect this whole change exists to remove, and leaving one of the
   * two paths able to omit the answer leaves the door it came through open.
   * Optional provenance on a safety decision is not a default, it is a way to
   * forget.
   */
  currentSlugIsFallback: boolean
}

/** Snapshot filename infix, also the prune predicate. */
const SNAPSHOT_INFIX = '.pre-rekey-'

/** Default retention for pre-re-key snapshots. */
const DEFAULT_KEEP_SNAPSHOTS = 2

/**
 * SQLite identifiers are not parameterisable, so table/column names are
 * interpolated. They come from the frozen lists above, but the assertion is
 * kept so a future entry with a stray character fails loudly here instead of
 * becoming a SQL-shaped surprise.
 */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

function assertIdent(name: string, what: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(`scope-rekey: unsafe ${what} identifier ${JSON.stringify(name)}`)
  }
  return name
}

/**
 * Authority rank for the `onboarding_state` conflict policy. A TERMINAL phase
 * outranks a non-terminal one because terminal is what `isOnboardingActive`
 * treats as "done", and `completed` outranks `failed` because it is the
 * stronger claim. Everything else is mid-flight and ranks lowest.
 */
function phaseAuthority(phase: string): number {
  if (phase === 'completed') return 2
  if (phase === 'failed') return 1
  return 0
}

interface OnboardingConflictRow {
  user_id: string
  old_phase: string
  old_advanced: number
  new_phase: string
  new_advanced: number
}

/**
 * Resolve `onboarding_state` rows that exist under BOTH keys for the same
 * `user_id`, keeping the more authoritative one and deleting the other, so the
 * generic move that follows has no conflict left to lose.
 *
 * Returns the number of rows deleted.
 */
function resolveOnboardingConflicts(db: Database, from: string, to: string): number {
  const conflicts = db
    .query<OnboardingConflictRow, [string, string]>(
      `SELECT o.user_id                AS user_id,
              o.phase                  AS old_phase,
              o.last_advanced_at       AS old_advanced,
              n.phase                  AS new_phase,
              n.last_advanced_at       AS new_advanced
         FROM onboarding_state o
         JOIN onboarding_state n
           ON n.project_slug = ?
          AND n.user_id = o.user_id
        WHERE o.project_slug = ?`,
    )
    .all(to, from)

  if (conflicts.length === 0) return 0

  const dropOld = db.prepare<unknown, [string, string]>(
    `DELETE FROM onboarding_state WHERE project_slug = ? AND user_id = ?`,
  )
  let deleted = 0
  for (const c of conflicts) {
    const oldRank = phaseAuthority(c.old_phase)
    const newRank = phaseAuthority(c.new_phase)
    // A total tie keeps the current-key row, matching the generic rule.
    const oldWins =
      oldRank > newRank || (oldRank === newRank && c.old_advanced > c.new_advanced)
    const loserSlug = oldWins ? to : from
    dropOld.run(loserSlug, c.user_id)
    deleted += 1
    log.warn('onboarding_state_conflict_resolved', {
      user_id: c.user_id,
      kept: oldWins ? `${from}:${c.old_phase}` : `${to}:${c.new_phase}`,
      dropped: oldWins ? `${to}:${c.new_phase}` : `${from}:${c.old_phase}`,
    })
  }
  return deleted
}

/**
 * Move every row scoped to `from` onto `to`, across {@link SCOPE_SWEEP_COLUMNS}.
 *
 * MUST be called inside an open transaction — it issues no BEGIN/COMMIT of its
 * own so a multi-key backfill and the ledger write share one atomic unit.
 */
export function rekeyScope(db: Database, from: string, to: string): ScopeRekeyResult {
  if (from === to) {
    throw new Error(`scope-rekey: refusing to re-key ${JSON.stringify(from)} onto itself`)
  }

  const onboarding_conflicts_resolved = resolveOnboardingConflicts(db, from, to)

  const tables: ScopeRekeyTableCount[] = []
  let moved_total = 0
  let dropped_total = 0

  for (const { table, column } of SCOPE_SWEEP_COLUMNS) {
    const t = assertIdent(table, 'table')
    const c = assertIdent(column, 'column')
    // Current-key row wins on collision: OR IGNORE leaves the loser behind and
    // the DELETE then discards it.
    const moved = db.prepare<unknown, [string, string]>(
      `UPDATE OR IGNORE ${t} SET ${c} = ? WHERE ${c} = ?`,
    ).run(to, from).changes
    const dropped = db.prepare<unknown, [string]>(
      `DELETE FROM ${t} WHERE ${c} = ?`,
    ).run(from).changes
    if (moved === 0 && dropped === 0) continue
    tables.push({ table, column, moved, dropped })
    moved_total += moved
    dropped_total += dropped
  }

  return {
    from,
    to,
    tables,
    moved_total,
    dropped_total,
    onboarding_conflicts_resolved,
  }
}

/**
 * Take a `VACUUM INTO` snapshot of the database beside itself and prune all but
 * the newest `keep`. Returns the snapshot path, or null when snapshotting is
 * not applicable (no path / in-memory).
 *
 * MUST run OUTSIDE a transaction — SQLite refuses `VACUUM` inside one. That is
 * why the caller snapshots first and only then opens the write transaction.
 */
function snapshotBeforeRekey(
  db: Database,
  dbPath: string | undefined,
  now: number,
  keep: number,
): string | null {
  if (dbPath === undefined || dbPath === '' || dbPath === ':memory:') return null

  const dir = dirname(dbPath)
  const base = basename(dbPath)
  // Timestamped, with a collision suffix so two re-keys in the same millisecond
  // can't make `VACUUM INTO` fail on an existing target.
  let target = join(dir, `${base}${SNAPSHOT_INFIX}${now}`)
  let n = 1
  while (existsSync(target)) {
    target = join(dir, `${base}${SNAPSHOT_INFIX}${now}-${n}`)
    n += 1
  }
  db.prepare<unknown, [string]>(`VACUUM INTO ?`).run(target)

  // Prune: keep the newest `keep` snapshots, oldest deleted first. Best-effort —
  // a failure to prune must never abort a repair.
  try {
    const prefix = `${base}${SNAPSHOT_INFIX}`
    const existing = readdirSync(dir)
      .filter((f) => f.startsWith(prefix))
      .sort()
      .reverse()
    for (const stale of existing.slice(Math.max(keep, 1))) {
      unlinkSync(join(dir, stale))
    }
  } catch (err) {
    log.warn('snapshot_prune_failed', { error: (err as Error).message })
  }

  return target
}

interface LedgerRow {
  project_slug: string
}

/**
 * Reconcile this database's scope key with the slug the gateway just resolved.
 *
 * Called once per boot, after migrations and BEFORE the module graph is
 * composed, so every store that reads at boot (notably the bundled-ritual sweep,
 * whose gate is the onboarding predicate) sees a single, whole database.
 *
 * Fails loudly. A half-scoped database is the defect, so a repair that cannot
 * complete must stop the boot rather than serve an owner his own data with
 * half of it invisible.
 */
export function reconcileInstanceScope(
  db: Database,
  current_slug: string,
  options: ReconcileInstanceScopeOptions,
): ScopeReconcileResult {
  return reconcileOnRawDatabase(db, current_slug, options)
}

/**
 * The `ProjectDb`-shaped entry point `boot()` calls, mirroring
 * `applyMigrationsToProjectDb`. It exists so the unserialized-handle unwrap
 * happens HERE, in the migrations band that is allowed it, rather than at the
 * call site — the gateway hands over the `ProjectDb` and never reaches for
 * `raw()` itself.
 *
 * The unserialized handle is required for the same two reasons the runner needs
 * it: this step owns its own `BEGIN IMMEDIATE`/`COMMIT`, and `VACUUM INTO`
 * cannot run inside a transaction. It is also safe here in a way it would not be
 * later — it runs before the module graph exists, so there is no concurrent
 * writer for `ProjectDb`'s mutex to be protecting anything from.
 */
export function reconcileInstanceScopeOnProjectDb(
  db: { raw(): Database },
  current_slug: string,
  options: ReconcileInstanceScopeOptions,
): ScopeReconcileResult {
  return reconcileOnRawDatabase(db.raw(), current_slug, options)
}

function reconcileOnRawDatabase(
  db: Database,
  current_slug: string,
  options: ReconcileInstanceScopeOptions,
): ScopeReconcileResult {
  const now = options.now ?? ((): number => Date.now())
  const keep = options.keepSnapshots ?? DEFAULT_KEEP_SNAPSHOTS

  const ledger = db
    .query<LedgerRow, []>(`SELECT project_slug FROM instance_scope_ledger WHERE id = 1`)
    .get()

  // The every-boot path: one SELECT, zero writes.
  if (ledger !== null && ledger !== undefined && ledger.project_slug === current_slug) {
    return {
      current_slug,
      action: 'noop',
      rekeys: [],
      snapshot_path: null,
      moved_total: 0,
      dropped_total: 0,
    }
  }

  // Discover stranded keys. `onboarding_state` is the anchor table: a real
  // install has exactly one owner row, so a DISTINCT `project_slug` there that
  // is not the current one is a key this database was previously scoped to.
  // The ledger's own value is folded in for the ledger-disagrees path, where
  // it is the authoritative answer.
  const stale = new Set<string>(
    db
      .query<{ project_slug: string }, [string]>(
        `SELECT DISTINCT project_slug FROM onboarding_state WHERE project_slug != ?`,
      )
      .all(current_slug)
      .map((r) => r.project_slug),
  )
  if (ledger !== null && ledger !== undefined && ledger.project_slug !== current_slug) {
    stale.add(ledger.project_slug)
  }
  const staleKeys = [...stale].sort()

  // DIRECTION GUARD (defect 2026-08-14): migrating forward onto an explicitly
  // configured handle is the feature; migrating onto the FALLBACK handle is
  // always wrong — the fallback means "nobody told me who I am", and an
  // anonymous process (a test suite, a bare `bun run` inheriting NEUTRON_HOME)
  // must never pull the live instance's rows onto itself. No move, no
  // snapshot, no ledger write; the boot proceeds.
  if (options.currentSlugIsFallback === true && staleKeys.length > 0) {
    const stranded_rows = countStrandedRows(db, staleKeys)
    log.warn('scope_rekey_refused_fallback_direction', {
      fallback_slug: current_slug,
      stranded_keys: staleKeys.join(','),
      stranded_rows,
    })
    return {
      current_slug,
      action: 'noop',
      rekeys: [],
      snapshot_path: null,
      moved_total: 0,
      dropped_total: 0,
      refused_direction: { stranded_keys: staleKeys, stranded_rows },
    }
  }

  const snapshot_path =
    staleKeys.length > 0 ? snapshotBeforeRekey(db, options.dbPath, now(), keep) : null

  const rekeys: ScopeRekeyResult[] = []
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const from of staleKeys) {
      rekeys.push(rekeyScope(db, from, current_slug))
    }
    // LAST write in the transaction: a crash anywhere above rolls the ledger
    // back with the moves, and the next boot retries from a consistent state.
    db.prepare<unknown, [string, number]>(
      `INSERT INTO instance_scope_ledger (id, project_slug, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET project_slug = excluded.project_slug,
                                     updated_at   = excluded.updated_at`,
    ).run(current_slug, now())
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* already rolled back by SQLite */
    }
    log.error('scope_reconcile_failed', {
      current_slug,
      stale_keys: staleKeys.join(','),
      error: (err as Error).message,
    })
    throw err
  }

  const moved_total = rekeys.reduce((a, r) => a + r.moved_total, 0)
  const dropped_total = rekeys.reduce((a, r) => a + r.dropped_total, 0)

  if (rekeys.length === 0) {
    log.info('scope_ledger_seeded', { current_slug })
    return {
      current_slug,
      action: 'seeded',
      rekeys: [],
      snapshot_path: null,
      moved_total: 0,
      dropped_total: 0,
    }
  }

  // One LOUD line per re-key: this repaired a database, and it must be visible
  // in the journal without anyone having gone looking.
  for (const r of rekeys) {
    log.warn('scope_rekeyed', {
      from: r.from,
      to: r.to,
      moved: r.moved_total,
      dropped: r.dropped_total,
      onboarding_conflicts_resolved: r.onboarding_conflicts_resolved,
      tables: r.tables.map((t) => `${t.table}:${t.moved}/${t.dropped}`).join(' '),
      snapshot: snapshot_path ?? 'none',
    })
  }

  return {
    current_slug,
    action: 'rekeyed',
    rekeys,
    snapshot_path,
    moved_total,
    dropped_total,
  }
}

/**
 * How many rows sit under `keys` in total, across every swept `(table, column)`.
 * Used ONLY by the direction guard, to put a number on the refusal LOG LINE — a
 * count is what turns "something was stranded" into evidence an operator can act
 * on. Runs on the refusal path alone, so the per-column scan costs nothing on a
 * normal boot.
 *
 * THIS NUMBER IS FOR THE LOG AND NOTHING ELSE (Argus r2 blocker, 2026-08-16).
 * It briefly fed the owner's `system_events` journal, broken down per handle,
 * and that was two defects wearing one name. It DRIFTS — `tasks`, `reminders`,
 * `topics` and `gateway_events` are all swept, so ordinary use changes it
 * between boots, the edge trigger in `gateway/scope-refusal-journal.ts` reads a
 * changed payload as new information, and the refusal is re-written every boot
 * until it has evicted the owner's whole 50-row window. And once the journal row
 * moved to the LIVE handle it was also WRONG: the reader's "stranded" count was
 * his own healthy data, which the guard had just successfully protected. Both
 * disappear the moment the number stops travelling into a bounded feed. See
 * `planInstanceRefusalRows`.
 *
 * `system_events` IS swept (a rename must carry the journal forward) but is
 * excluded from THIS count, and the exclusion outlived the payload that
 * motivated it because the number is still reported once per refused boot: the
 * previous boot's own warning row is not "data at stake", and counting it made
 * the log line climb 1 → 3 → 4 across three IDENTICAL boots. "Rows at stake"
 * means the owner's DATA that would have been taken, not the warning about it.
 */
function countStrandedRows(db: Database, keys: string[]): number {
  let total = 0
  for (const key of keys) {
    for (const { table, column } of SCOPE_SWEEP_COLUMNS) {
      if (table === 'system_events') continue
      const t = assertIdent(table, 'table')
      const c = assertIdent(column, 'column')
      const row = db
        .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`)
        .get(key)
      total += row?.n ?? 0
    }
  }
  return total
}
