/**
 * @neutronai/onboarding/profile-pic — durable pending-call store.
 *
 * Per SPEC.md Phases→Steps (was SPEC.md § Phases→Steps cross-cutting (Profile-pic
 * process-restart resume). The Gemini Imagen call inside
 * `ProfilePicPipeline.run(...)` finishes in 15-30 s under normal
 * conditions. If the per-instance gateway restarts mid-call (deploy,
 * supervisor SIGTERM, crash + watchdog respawn), the in-process
 * promise is lost and the user is stranded on the picker waiting for
 * candidates that will never arrive — at best they have to tap
 * Regenerate; at worst nobody notices and the row stays 'generating'
 * forever.
 *
 * This module persists per-call state to SQLite (table
 * `profile_pic_pending` — migration 0046). One row per
 * `gemini.generate(...)` invocation:
 *
 *   recordPending(...)               → row INSERT, status='pending'
 *   markCompleted(request_id, path)  → status='completed' + result_path
 *   markFailed(request_id, reason)   → status='failed'   (process-internal failure)
 *   markExpired(request_id)          → status='expired'  (resume-on-boot flagged)
 *
 * The resume-on-boot hook (`restart-resume.ts`) scans this table at
 * gateway startup; see that module for the time-window heuristics +
 * auto-retry semantics.
 *
 * The store is intentionally narrow: it owns DB rows, nothing else.
 * The pipeline integration + boot hook + engine wiring live in their
 * own modules.
 */

import { randomUUID } from 'node:crypto'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

export type ProfilePicPendingStatus = 'pending' | 'completed' | 'failed' | 'expired'

export interface ProfilePicPendingRow {
  request_id: string
  project_slug: string
  user_id: string | null
  prompt: string
  /**
   * Free-form archetype hint carried alongside the call. Persisted so the
   * resume-on-boot auto-retry can re-issue `pipeline.start(...)` with the
   * user's actual archetype rather than falling through to
   * `FALLBACK_DEFAULT_SLUG`. May be null when the engine didn't supply one.
   */
  archetype_hint: string | null
  started_at: number
  completed_at: number | null
  result_path: string | null
  status: ProfilePicPendingStatus
  auto_retry_attempted: boolean
  /**
   * ISSUE #45 — originating `profile_pic_jobs.id`. Stamped when the
   * pipeline records the pending row (every Gemini call attempt inside
   * `pipeline.run` carries its job_id). Nullable so legacy rows
   * (written before migration 0047) keep working; the engine hook's
   * legacy fall-through path handles null by re-firing `pipeline.start`.
   */
  job_id: string | null
}

interface RawPendingRow {
  request_id: string
  project_slug: string
  user_id: string | null
  prompt: string
  archetype_hint: string | null
  started_at: number
  completed_at: number | null
  result_path: string | null
  status: string
  auto_retry_attempted: number
  job_id: string | null
}

export interface RecordPendingInput {
  project_slug: string
  /** Engine-layer identifier; pipeline doesn't always have one. */
  user_id?: string | null
  prompt: string
  /**
   * Free-form archetype hint — persisted so the resume-on-boot auto-retry
   * preserves the user's archetype across the restart. Optional; when
   * unset the column stores NULL and the auto-retry mirrors today's
   * fallback behaviour.
   */
  archetype_hint?: string | null
  /** Override the request_id (testing seam). Defaults to a fresh UUID. */
  request_id?: string
  /**
   * ISSUE #45 — originating `profile_pic_jobs.id`. Production threads
   * this from `pipeline.run(job_id, input)` so the completed-after-Wait
   * race can surface the existing job's candidates instead of firing a
   * fresh `pipeline.start`. Optional + nullable for backward compat with
   * tests that record pending rows without a job.
   */
  job_id?: string | null
}

export interface RecordPendingResult {
  request_id: string
  started_at: number
}

export interface ProfilePicPendingStoreDeps {
  db: ProjectDb
  /** Time source (test seam). Defaults to `() => Date.now()`. */
  now?: () => number
  /** UUID factory (test seam). Defaults to `randomUUID`. */
  uuid?: () => string
}

/**
 * Durable record of every in-flight Gemini Imagen call. The pipeline
 * writes rows here; the boot-resume hook reads + transitions them.
 *
 * No transactional coupling to `profile_pic_jobs` — that table is the
 * user-visible job state machine; this one is the per-call resume
 * substrate. Multiple pending rows MAY exist for one job (the pipeline
 * retries up to `failure_budget`); the engine reads the LATEST row by
 * started_at when deciding whether to surface "still generating" vs
 * "previous attempt failed".
 */
export class ProfilePicPendingStore {
  private readonly db: ProjectDb
  private readonly now: () => number
  private readonly uuid: () => string

  constructor(deps: ProfilePicPendingStoreDeps) {
    this.db = deps.db
    this.now = deps.now ?? ((): number => Date.now())
    this.uuid = deps.uuid ?? randomUUID
  }

  /**
   * Insert a new pending row. Returns the assigned `request_id` + the
   * `started_at` epoch the row was written with — the caller pairs them
   * with the in-flight Gemini call so the corresponding completion can
   * find this row.
   */
  async recordPending(input: RecordPendingInput): Promise<RecordPendingResult> {
    const request_id = input.request_id ?? this.uuid()
    const started_at = this.now()
    await this.db.run(
      `INSERT INTO profile_pic_pending
         (request_id, project_slug, user_id, prompt, archetype_hint, started_at,
          completed_at, result_path, status, auto_retry_attempted, job_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', 0, ?)`,
      [
        request_id,
        input.project_slug,
        input.user_id ?? null,
        input.prompt,
        input.archetype_hint ?? null,
        started_at,
        input.job_id ?? null,
      ],
    )
    return { request_id, started_at }
  }

  /**
   * Mark the call completed. Idempotent — re-marking a completed row is
   * a no-op (the WHERE clause filters out non-pending rows so a row that
   * was already `expired` by the boot scan does NOT get re-classified
   * back to `completed`; that path would have lost the user's chance
   * to be told the previous attempt timed out).
   */
  async markCompleted(request_id: string, result_path: string): Promise<void> {
    const ts = this.now()
    await this.db.run(
      `UPDATE profile_pic_pending
          SET status = 'completed', completed_at = ?, result_path = ?
        WHERE request_id = ? AND status = 'pending'`,
      [ts, result_path, request_id],
    )
  }

  /**
   * Mark the call failed in-process (Gemini throw, downstream write
   * failure, etc.). Same idempotent semantics as `markCompleted` — only
   * pending rows transition; an expired row stays expired.
   */
  async markFailed(request_id: string): Promise<void> {
    const ts = this.now()
    await this.db.run(
      `UPDATE profile_pic_pending
          SET status = 'failed', completed_at = ?
        WHERE request_id = ? AND status = 'pending'`,
      [ts, request_id],
    )
  }

  /**
   * Resume-on-boot transition: pending → expired. Only fires when the
   * boot scan observes a stale pending row whose `auto_retry_attempted`
   * is 0. Atomically bumps the flag so the next boot scan won't expire
   * the same row twice.
   *
   * Returns true if the row actually transitioned (the WHERE matched);
   * false if the row was already non-pending or already retried. The
   * caller (boot hook) uses this signal to decide whether to fire the
   * one allowed auto-retry.
   */
  async markExpired(request_id: string): Promise<boolean> {
    const ts = this.now()
    return await this.db.transaction(async (tx) => {
      const before = tx
        .raw()
        .query<{ status: string; auto_retry_attempted: number }, [string]>(
          `SELECT status, auto_retry_attempted FROM profile_pic_pending WHERE request_id = ?`,
        )
        .get(request_id)
      if (before === null) return false
      if (before.status !== 'pending' || before.auto_retry_attempted !== 0) return false
      await tx.run(
        `UPDATE profile_pic_pending
            SET status = 'expired',
                completed_at = ?,
                auto_retry_attempted = 1
          WHERE request_id = ?`,
        [ts, request_id],
      )
      return true
    })
  }

  /**
   * Resume-on-boot transition: pending → failed. Fires when the row's
   * `auto_retry_attempted` is already 1 (one retry was attempted on a
   * prior boot AND that retry was also interrupted), or when the row's
   * age exceeds the absolute fail-window.
   */
  async markFailedFromBoot(request_id: string): Promise<boolean> {
    const ts = this.now()
    return await this.db.transaction(async (tx) => {
      const before = tx
        .raw()
        .query<{ status: string }, [string]>(
          `SELECT status FROM profile_pic_pending WHERE request_id = ?`,
        )
        .get(request_id)
      if (before === null) return false
      if (before.status !== 'pending') return false
      await tx.run(
        `UPDATE profile_pic_pending
            SET status = 'failed', completed_at = ?
          WHERE request_id = ?`,
        [ts, request_id],
      )
      return true
    })
  }

  /** Read a single row by request_id. Returns null when absent. */
  async get(request_id: string): Promise<ProfilePicPendingRow | null> {
    const row = this.db
      .raw()
      .query<RawPendingRow, [string]>(
        `SELECT request_id, project_slug, user_id, prompt, archetype_hint,
                started_at, completed_at, result_path, status, auto_retry_attempted,
                job_id
           FROM profile_pic_pending WHERE request_id = ?`,
      )
      .get(request_id)
    if (row === null) return null
    return toRow(row)
  }

  /**
   * List every row whose status is 'pending'. The boot-resume hook
   * iterates this list at startup to apply the time-window heuristics.
   */
  async listPending(): Promise<ProfilePicPendingRow[]> {
    const rows = this.db
      .raw()
      .query<RawPendingRow, []>(
        `SELECT request_id, project_slug, user_id, prompt, archetype_hint,
                started_at, completed_at, result_path, status, auto_retry_attempted,
                job_id
           FROM profile_pic_pending WHERE status = 'pending'
          ORDER BY started_at ASC`,
      )
      .all()
    return rows.map(toRow)
  }

  /**
   * Latest row (by started_at DESC) for the given (project_slug, user_id)
   * tuple. The engine reads this on phase-enter to decide which user-
   * visible state to surface (still-generating / completed-ready /
   * expired-retry / failed-retry).
   *
   * `user_id` null/undefined matches rows written with NULL user_id.
   */
  async latestForUser(
    project_slug: string,
    user_id: string | null,
  ): Promise<ProfilePicPendingRow | null> {
    const row =
      user_id === null
        ? this.db
            .raw()
            .query<RawPendingRow, [string]>(
              `SELECT request_id, project_slug, user_id, prompt, archetype_hint,
                      started_at, completed_at, result_path, status,
                      auto_retry_attempted, job_id
                 FROM profile_pic_pending
                WHERE project_slug = ? AND user_id IS NULL
                ORDER BY started_at DESC LIMIT 1`,
            )
            .get(project_slug)
        : this.db
            .raw()
            .query<RawPendingRow, [string, string]>(
              `SELECT request_id, project_slug, user_id, prompt, archetype_hint,
                      started_at, completed_at, result_path, status,
                      auto_retry_attempted, job_id
                 FROM profile_pic_pending
                WHERE project_slug = ? AND user_id = ?
                ORDER BY started_at DESC LIMIT 1`,
            )
            .get(project_slug, user_id)
    if (row === null) return null
    return toRow(row)
  }
}

function toRow(raw: RawPendingRow): ProfilePicPendingRow {
  if (
    raw.status !== 'pending' &&
    raw.status !== 'completed' &&
    raw.status !== 'failed' &&
    raw.status !== 'expired'
  ) {
    throw new Error(
      `profile_pic_pending row request_id=${raw.request_id} has invalid status=${raw.status}`,
    )
  }
  return {
    request_id: raw.request_id,
    project_slug: raw.project_slug,
    user_id: raw.user_id,
    prompt: raw.prompt,
    archetype_hint: raw.archetype_hint,
    started_at: raw.started_at,
    completed_at: raw.completed_at,
    result_path: raw.result_path,
    status: raw.status,
    auto_retry_attempted: raw.auto_retry_attempted === 1,
    job_id: raw.job_id,
  }
}
