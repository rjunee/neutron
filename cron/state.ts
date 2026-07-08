/**
 * @neutronai/cron — last-run state persistence.
 *
 * CRUD over the `cron_state`
 * table (migration 0004). One row per (job_name, project_slug); the
 * scheduler updates after every fire so observability can answer "when did
 * vault-backup last run for instance X".
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { CronHandlerStatus } from './handlers.ts'

export interface CronStateRow {
  job_name: string
  project_slug: string
  last_run_at: number | null
  last_run_status: CronHandlerStatus | null
  last_run_error: string | null
  last_run_duration_ms: number | null
}

export class CronStateStore {
  constructor(private readonly db: ProjectDb) {}

  get(job_name: string, project_slug: string): CronStateRow | null {
    const row = this.db
      .prepare<CronStateRow, [string, string]>(
        `SELECT job_name, project_slug, last_run_at, last_run_status,
                last_run_error, last_run_duration_ms
           FROM cron_state WHERE job_name = ? AND project_slug = ?`,
      )
      .get(job_name, project_slug)
    return row ?? null
  }

  async record(input: {
    job_name: string
    project_slug: string
    fired_at: number
    duration_ms: number
    status: CronHandlerStatus
    error?: string | null
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO cron_state
         (job_name, project_slug, last_run_at, last_run_status, last_run_error, last_run_duration_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_name, project_slug) DO UPDATE SET
         last_run_at = excluded.last_run_at,
         last_run_status = excluded.last_run_status,
         last_run_error = excluded.last_run_error,
         last_run_duration_ms = excluded.last_run_duration_ms`,
      [
        input.job_name,
        input.project_slug,
        input.fired_at,
        input.status,
        input.error ?? null,
        input.duration_ms,
      ],
    )
  }

  list(): CronStateRow[] {
    return this.db
      .prepare<CronStateRow, []>(
        `SELECT job_name, project_slug, last_run_at, last_run_status,
                last_run_error, last_run_duration_ms
           FROM cron_state ORDER BY job_name`,
      )
      .all()
  }
}
