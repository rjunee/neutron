/**
 * @neutronai/reminders — the SOLE `code_ritual_runs` writer (executor-mode
 * reminders, plan task 4; migration 0106 PART B).
 *
 * `code_ritual_runs` is the DURABLE run history for rituals — one row per fire
 * ATTEMPT, skips included — retained on its own window (NOT pruned on the
 * subagent liveness prune). It answers "why did my morning brief not run
 * yesterday?" long after the live `code_subagent_registry` row is gone. This
 * module is its single write authority (`migrations/table-ownership.json`); every
 * INSERT/UPDATE against the table lives here.
 *
 * Row shape (DDL: `migrations/0106_ritual_schema.sql`):
 *   run_id PK, ritual_id (NOT NULL), reminder_id, project_slug, subagent_run_id,
 *   status CHECK(skipped|running|finished|failed|timed_out|crashed),
 *   skip_reason CHECK(unknown_ritual|missing_prompt|unapproved) coupled to status
 *   by `((status='skipped') = (skip_reason IS NOT NULL))`, content_hash,
 *   started_at/ended_at (epoch ms), output_summary, failure_reason.
 *
 * The four insert/mark helpers are the exact fire-time transitions the executor
 * drives:
 *   - `insertSkipped`  — a fail-CLOSED validation verdict; NOTHING spawned
 *     (started_at = ended_at = now; carries the skip_reason).
 *   - `insertRunning`  — a spawn succeeded; carries subagent_run_id + content_hash.
 *   - `insertFailed`   — a spawn was REFUSED (cap/duplicate) before any subagent
 *     row exists (status 'failed', no subagent_run_id).
 *   - `markTerminal`   — the substrate turn settled; sets ended_at + a truncated
 *     output_summary and/or failure_reason.
 *
 * Writes route through the ASYNC, mutex-serialized `ProjectDb.run` (never
 * `runSync`) — the same correctness requirement `runtime/subagent/store.ts`
 * documents: a `runSync` issued while another store has an open `transaction()`
 * on the shared connection is absorbed into it and LOST on its rollback.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { RitualFireSkipReason } from './rituals.ts'

/**
 * A non-skip run outcome the executor drives via `markTerminal`.
 * - `cancelled`: an operator (`/dispatch stop`) or shutdown aborted the turn. It
 *   is a terminal outcome but NOT a merit failure (not in `FAIL`), so it breaks a
 *   consecutive-failure streak rather than feeding the escalation, and surfaces no
 *   failure notice (Argus r1 minor — operator cancel must not read as a 3am
 *   failure).
 */
export type RitualRunTerminalStatus = 'finished' | 'failed' | 'timed_out' | 'crashed' | 'cancelled'

/** Every `code_ritual_runs.status` value. */
export type RitualRunStatus =
  | 'skipped'
  | 'running'
  | RitualRunTerminalStatus

/** A `code_ritual_runs` row (reads — tests + observability). */
export interface RitualRunRow {
  run_id: string
  ritual_id: string
  reminder_id: string | null
  project_slug: string | null
  subagent_run_id: string | null
  status: RitualRunStatus
  skip_reason: RitualFireSkipReason | null
  content_hash: string | null
  started_at: number
  ended_at: number | null
  output_summary: string | null
  failure_reason: string | null
}

/** Max stored bytes (chars) of a run's final text. */
export const MAX_RITUAL_OUTPUT_SUMMARY_CHARS = 4000

/**
 * `code_ritual_runs` retention window (30 days). This is the run-history table's
 * OWN retention — it is NEVER pruned by the subagent liveness prune (which reaps
 * the live `code_subagent_registry`), because the whole point of the history row
 * is to answer "why did my morning brief not run last week?" long after the live
 * registry row is gone. `pruneOlderThan` is driven at boot with
 * `Date.now() - RITUAL_RUN_RETENTION_MS`.
 */
export const RITUAL_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const COLS =
  'run_id, ritual_id, reminder_id, project_slug, subagent_run_id, status, ' +
  'skip_reason, content_hash, started_at, ended_at, output_summary, failure_reason'

export interface RitualRunStore {
  /** A fail-CLOSED validation SKIP — nothing spawned (started_at = ended_at = now). */
  insertSkipped(input: {
    run_id: string
    ritual_id: string
    reminder_id: string | null
    project_slug: string | null
    skip_reason: RitualFireSkipReason
    now_ms: number
  }): Promise<void>
  /** A spawn SUCCEEDED — the run is live (carries subagent_run_id + content_hash). */
  insertRunning(input: {
    run_id: string
    ritual_id: string
    reminder_id: string | null
    project_slug: string | null
    subagent_run_id: string
    content_hash: string
    now_ms: number
  }): Promise<void>
  /** A spawn was REFUSED (cap / duplicate) — 'failed', no subagent row. */
  insertFailed(input: {
    run_id: string
    ritual_id: string
    reminder_id: string | null
    project_slug: string | null
    failure_reason: string
    now_ms: number
  }): Promise<void>
  /** The substrate turn settled — set ended_at + summary/failure on a live row. */
  markTerminal(input: {
    run_id: string
    status: RitualRunTerminalStatus
    ended_at_ms: number
    output_summary?: string
    failure_reason?: string
  }): Promise<void>
  /** Read a single row (tests + observability). */
  get(run_id: string): RitualRunRow | null
  /** Every row for a ritual, newest first (tests + observability). */
  listByRitual(ritual_id: string): RitualRunRow[]
  /**
   * The most recent TERMINAL rows (finished/failed/timed_out/crashed/cancelled —
   * excludes 'skipped' and 'running') for a ritual, newest first, capped at
   * `limit`. `cancelled` is included so it can act as a streak-breaker in the
   * escalation rule. The once-per-streak escalation rule reads the last 4 with
   * this.
   */
  listRecentTerminal(input: { ritual_id: string; limit: number }): RitualRunRow[]
  /**
   * Every 'running' row across ALL rituals, oldest first. LOAD-BEARING for the
   * boot-reap ordering guarantee: `reapOrphanRitualRuns` calls this as its FIRST,
   * SYNCHRONOUS statement during compose — before the tick loop that could spawn
   * a fresh 'running' row exists — so the snapshot can only contain orphans left
   * by a prior boot (`code_ritual_runs` has no boot_id column; ordering IS the
   * current-boot safety).
   */
  listOrphanRunning(): RitualRunRow[]
  /**
   * Delete terminal/skipped rows whose `started_at` is STRICTLY older than
   * `cutoff_ms`. NEVER deletes 'running' rows (any age) — those are either live
   * or pending a reap. Returns the number of rows deleted.
   */
  pruneOlderThan(input: { cutoff_ms: number }): Promise<number>
}

/** Build the sole `code_ritual_runs` writer over `db`. */
export function createRitualRunStore(db: ProjectDb): RitualRunStore {
  return {
    async insertSkipped(input): Promise<void> {
      // A skip never spawned — started_at = ended_at = now, no subagent/hash.
      await db.run(
        `INSERT INTO code_ritual_runs
           (run_id, ritual_id, reminder_id, project_slug, subagent_run_id, status,
            skip_reason, content_hash, started_at, ended_at, output_summary, failure_reason)
         VALUES (?, ?, ?, ?, NULL, 'skipped', ?, NULL, ?, ?, NULL, NULL)`,
        [
          input.run_id,
          input.ritual_id,
          input.reminder_id,
          input.project_slug,
          input.skip_reason,
          input.now_ms,
          input.now_ms,
        ],
      )
    },

    async insertRunning(input): Promise<void> {
      await db.run(
        `INSERT INTO code_ritual_runs
           (run_id, ritual_id, reminder_id, project_slug, subagent_run_id, status,
            skip_reason, content_hash, started_at, ended_at, output_summary, failure_reason)
         VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, ?, NULL, NULL, NULL)`,
        [
          input.run_id,
          input.ritual_id,
          input.reminder_id,
          input.project_slug,
          input.subagent_run_id,
          input.content_hash,
          input.now_ms,
        ],
      )
    },

    async insertFailed(input): Promise<void> {
      // Spawn-refusal path — no subagent row ever existed. started_at = ended_at
      // = now: the attempt began and ended in the same instant.
      await db.run(
        `INSERT INTO code_ritual_runs
           (run_id, ritual_id, reminder_id, project_slug, subagent_run_id, status,
            skip_reason, content_hash, started_at, ended_at, output_summary, failure_reason)
         VALUES (?, ?, ?, ?, NULL, 'failed', NULL, NULL, ?, ?, NULL, ?)`,
        [
          input.run_id,
          input.ritual_id,
          input.reminder_id,
          input.project_slug,
          input.now_ms,
          input.now_ms,
          input.failure_reason,
        ],
      )
    },

    async markTerminal(input): Promise<void> {
      const summary =
        input.output_summary !== undefined
          ? input.output_summary.slice(0, MAX_RITUAL_OUTPUT_SUMMARY_CHARS)
          : null
      const failure = input.failure_reason ?? null
      // Guarded on the row still being 'running' so a late turn-settlement can
      // never resurrect / overwrite an already-terminal row (defensive; the
      // executor only marks a row it just inserted 'running').
      await db.run(
        `UPDATE code_ritual_runs
            SET status = ?, ended_at = ?, output_summary = ?, failure_reason = ?
          WHERE run_id = ? AND status = 'running'`,
        [input.status, input.ended_at_ms, summary, failure, input.run_id],
      )
    },

    get(run_id): RitualRunRow | null {
      return db.get<RitualRunRow>(
        `SELECT ${COLS} FROM code_ritual_runs WHERE run_id = ?`,
        [run_id],
      )
    },

    listByRitual(ritual_id): RitualRunRow[] {
      return db.all<RitualRunRow>(
        `SELECT ${COLS} FROM code_ritual_runs WHERE ritual_id = ? ORDER BY started_at DESC`,
        [ritual_id],
      )
    },

    listRecentTerminal(input): RitualRunRow[] {
      // Ordered by COMPLETION (ended_at), not start — 'consecutive' failures are
      // consecutive by when they FINISHED (Argus r1 minor). Every row matched here
      // is terminal, so ended_at is always set (no NULL ordering surprise); a
      // same-instant refusal (started_at = ended_at) still orders deterministically
      // via the started_at + run_id tie-breaks.
      return db.all<RitualRunRow>(
        `SELECT ${COLS} FROM code_ritual_runs
          WHERE ritual_id = ? AND status IN ('finished','failed','timed_out','crashed','cancelled')
          ORDER BY ended_at DESC, started_at DESC, run_id DESC
          LIMIT ?`,
        [input.ritual_id, input.limit],
      )
    },

    listOrphanRunning(): RitualRunRow[] {
      // Sync read — the reap driver's FIRST statement. See interface doc: this
      // ordering (snapshot before the tick loop exists) is the current-boot safety.
      return db.all<RitualRunRow>(
        `SELECT ${COLS} FROM code_ritual_runs WHERE status = 'running' ORDER BY started_at ASC`,
      )
    },

    async pruneOlderThan(input): Promise<number> {
      // `ProjectDb.run` returns void (no driver changes count), so COUNT first,
      // then DELETE with the identical predicate. Strict `<` keeps rows AT the
      // cutoff; `status <> 'running'` keeps every live/pending-reap row of any age.
      const countRow = db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM code_ritual_runs
          WHERE status <> 'running' AND started_at < ?`,
        [input.cutoff_ms],
      )
      const deleted = countRow?.n ?? 0
      if (deleted > 0) {
        await db.run(
          `DELETE FROM code_ritual_runs WHERE status <> 'running' AND started_at < ?`,
          [input.cutoff_ms],
        )
      }
      return deleted
    },
  }
}
