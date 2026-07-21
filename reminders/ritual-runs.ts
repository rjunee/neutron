/**
 * @neutronai/reminders — durable ritual RUN HISTORY store (migration 0106
 * `code_ritual_runs`).
 *
 * Spec of record: `docs/plans/executor-mode-reminders-2026-07-20.md` (plan task
 * 2). One row per ritual fire ATTEMPT — including skips. This is the durable
 * answer to "why did my morning brief not run yesterday": distinct from the
 * subagent registry (`code_subagent_registry`, `runtime/subagent/store.ts`),
 * whose rows are DELETED on liveness prune, these rows are retained on their own
 * {@link RITUAL_RUN_RETENTION_MS} window and only ever removed by
 * {@link RitualRunStore.pruneTerminalOlderThan}, which never touches a live
 * ('spawned') row.
 *
 * Write discipline mirrors `runtime/subagent/store.ts`: ALL writes route through
 * the ASYNC, mutex-serialized `ProjectDb.run` (NEVER `runSync`). A `runSync`
 * issued while another store has a `transaction()` open on the same connection is
 * absorbed into that transaction and LOST on its rollback (the documented
 * runSync-bypass hazard). Reads go through `db.prepare(...).get/.all`.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'

/**
 * Ritual run-history retention — 30 days. The prune wiring (tasks 4-5) calls
 * {@link RitualRunStore.pruneTerminalOlderThan} with `Date.now() - this`.
 */
export const RITUAL_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** Terminal (non-live) run statuses. 'spawned' is the sole live state. */
export type RitualRunTerminalStatus = 'finished' | 'failed' | 'timed_out' | 'crashed'

/** Full run status vocabulary — richer than the subagent registry's on purpose. */
export type RitualRunStatus = 'spawned' | RitualRunTerminalStatus | 'skipped'

/** Why a fire attempt was skipped (never spawned). Mirrors the fail-closed verdicts. */
export type RitualSkipReason = 'unknown_ritual' | 'missing_prompt' | 'unapproved'

/** A persisted `code_ritual_runs` row. */
export interface RitualRunRow {
  run_id: string
  ritual_id: string
  reminder_id: string | null
  instance_key: string
  project_id: string | null
  status: RitualRunStatus
  skip_reason: RitualSkipReason | null
  started_at: number
  ended_at: number | null
  output_summary: string | null
}

const COLS =
  'run_id, ritual_id, reminder_id, instance_key, project_id, status, ' +
  'skip_reason, started_at, ended_at, output_summary'

/**
 * Typed CRUD over `code_ritual_runs`. The SOLE writer of the table (see
 * `migrations/table-ownership.json`). Constructed per process by the reminders
 * wiring; the tick/delivery branches (tasks 4-5) call through it, never raw SQL.
 */
export class RitualRunStore {
  constructor(private readonly db: ProjectDb) {}

  /**
   * Insert a live ('spawned') run row — the ritual REPL has been dispatched.
   * `ended_at` / `output_summary` stay NULL until a terminal event
   * ({@link markTerminal}).
   */
  async insertSpawned(r: {
    run_id: string
    ritual_id: string
    reminder_id?: string | null
    instance_key: string
    project_id?: string | null
    started_at: number
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO code_ritual_runs (${COLS})
       VALUES (?, ?, ?, ?, ?, 'spawned', NULL, ?, NULL, NULL)`,
      [
        r.run_id,
        r.ritual_id,
        r.reminder_id ?? null,
        r.instance_key,
        r.project_id ?? null,
        r.started_at,
      ],
    )
  }

  /**
   * Insert a terminal 'skipped' row — the fire-time validation returned a fail
   * verdict, so no REPL was spawned. `ended_at` is set to `started_at` (a skip
   * is instantaneous). The table CHECK requires `skip_reason` to be present here
   * and absent on every non-skipped row.
   */
  async insertSkipped(r: {
    run_id: string
    ritual_id: string
    reminder_id?: string | null
    instance_key: string
    project_id?: string | null
    started_at: number
    skip_reason: RitualSkipReason
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO code_ritual_runs (${COLS})
       VALUES (?, ?, ?, ?, ?, 'skipped', ?, ?, ?, NULL)`,
      [
        r.run_id,
        r.ritual_id,
        r.reminder_id ?? null,
        r.instance_key,
        r.project_id ?? null,
        r.skip_reason,
        r.started_at,
        r.started_at,
      ],
    )
  }

  /**
   * Drive a live ('spawned') run to a terminal status (task 5 completion /
   * failure surfacing). Guarded on `status = 'spawned'` so a terminal row is
   * never rewritten. Sets `ended_at` and optional `output_summary`.
   */
  async markTerminal(
    run_id: string,
    status: RitualRunTerminalStatus,
    opts: { ended_at: number; output_summary?: string | null },
  ): Promise<void> {
    await this.db.run(
      `UPDATE code_ritual_runs
          SET status = ?, ended_at = ?, output_summary = ?
        WHERE run_id = ? AND status = 'spawned'`,
      [status, opts.ended_at, opts.output_summary ?? null, run_id],
    )
  }

  /** A single run row by id, or null. */
  get(run_id: string): RitualRunRow | null {
    const row = this.db
      .prepare<RitualRunRow, [string]>(
        `SELECT ${COLS} FROM code_ritual_runs WHERE run_id = ?`,
      )
      .get(run_id)
    return row === null ? null : row
  }

  /**
   * Run history for a ritual, newest-first (`started_at DESC` — rides
   * `idx_code_ritual_runs_ritual`). This is the durable "why didn't my brief
   * run" query; a skipped row surfaces with its `skip_reason`.
   */
  listByRitual(ritual_id: string, limit: number = 50): RitualRunRow[] {
    return this.db
      .prepare<RitualRunRow, [string, number]>(
        `SELECT ${COLS} FROM code_ritual_runs
          WHERE ritual_id = ?
          ORDER BY started_at DESC
          LIMIT ?`,
      )
      .all(ritual_id, limit)
  }

  /**
   * Delete terminal rows older than `cutoffMs` (retention prune, wired by tasks
   * 4-5). NEVER deletes a live ('spawned') row — a run still in flight is kept
   * regardless of age so its terminal event can still land.
   */
  async pruneTerminalOlderThan(cutoffMs: number): Promise<void> {
    await this.db.run(
      `DELETE FROM code_ritual_runs
        WHERE started_at < ? AND status <> 'spawned'`,
      [cutoffMs],
    )
  }
}
