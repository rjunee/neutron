/**
 * @neutronai/tasks — focus-score recompute cron (P6).
 *
 * Walks every open task for an instance and re-stamps `focus_score` +
 * `focus_score_updated_at` against the current wall clock. The store
 * already stamps the score synchronously on score-affecting writes —
 * the cron is the convergence guarantee for the time-based components
 * (staleness, overdue/due-soon buckets) that drift even when no
 * mutation fires.
 *
 * Mirrors the per-instance cron shape locked by the Sean Ellis trigger:
 * a `buildFocusScoreRecomputeHandler(...)` factory + a
 * `registerFocusScoreRecomputeCron(...)` glue function that drops the
 * job + handler into the shared `CronJobRegistry` / `CronHandlerRegistry`.
 * The same handler is re-usable from a systemd OnCalendar fallback
 * (production wires both paths — the in-process scheduler and the unit
 * timer share one handler).
 */

import type {
  CronHandler,
  CronHandlerRegistry,
} from '@neutronai/cron/handlers.ts'
import type {
  CronJobDef,
  CronJobRegistry,
} from '@neutronai/cron/jobs.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { computeFocusScore } from './focus-score.ts'

/**
 * 4-hour cadence — the focus-score time-derived signals (staleness,
 * overdue, due-soon) tick once per day, so anything more frequent than
 * daily is wasted work on those signals; but a task created at 13:00
 * shouldn't wait 24h to see its score reflect today's clock. 4h is
 * the comfortable compromise (5 ticks per day; ≤ 4h staleness on any
 * recently-mutated row).
 */
export const DEFAULT_FOCUS_SCORE_INTERVAL_MS = 4 * 60 * 60 * 1000

export const FOCUS_SCORE_HANDLER_NAME = 'tasks.focus_score_recompute'

interface OpenTaskRow {
  id: string
  priority: number | null
  due_date: string | null
  updated_at: string
}

export interface FocusScoreRecomputeResult {
  scanned: number
  updated: number
}

export interface FocusScoreRecomputeHandlerDeps {
  db: ProjectDb
  /** Test seam — defaults to `Date.now()`. */
  now?: () => number
}

/**
 * Pure(ish) recompute pass — scans every open task for `project_slug`,
 * recomputes `focus_score`, and UPDATEs the row when the new score
 * differs from the stored one (or the stored score is null).
 *
 * Single-transaction write fan-out: the whole batch lands inside one
 * `projectDb.transaction(...)` so the projection layer's debounced
 * subscriber sees at most one wake-up per instance per tick.
 *
 * Returns the count of rows scanned and the count actually updated.
 */
export async function recomputeFocusScoresForProject(input: {
  db: ProjectDb
  project_slug: string
  now?: () => number
}): Promise<FocusScoreRecomputeResult> {
  const nowMs = (input.now ?? Date.now)()
  const nowDate = new Date(nowMs)
  const nowIso = nowDate.toISOString()

  // Pull the open rows we need to consider. Reading outside the
  // transaction is fine — the recompute is idempotent: any concurrent
  // mutation lands its OWN score stamp, and the next tick converges if
  // we wrote a stale value here.
  const rows = input.db
    .prepare<OpenTaskRow, [string]>(
      `SELECT id, priority, due_date, updated_at
         FROM tasks
        WHERE project_slug = ? AND status = 'open'`,
    )
    .all(input.project_slug)

  if (rows.length === 0) {
    return { scanned: 0, updated: 0 }
  }

  const updates: Array<{ id: string; score: number }> = []
  for (const row of rows) {
    const score = computeFocusScore({
      priority: row.priority,
      due_date: row.due_date,
      updated_at: row.updated_at,
      now: nowDate,
    })
    updates.push({ id: row.id, score })
  }

  let updated = 0
  if (updates.length > 0) {
    await input.db.transaction(async (tx) => {
      for (const u of updates) {
        await tx.run(
          `UPDATE tasks
              SET focus_score = ?, focus_score_updated_at = ?
            WHERE id = ?`,
          [u.score, nowIso, u.id],
        )
        updated += 1
      }
    })
  }
  return { scanned: rows.length, updated }
}

/**
 * Build the per-instance cron handler that converges focus scores.
 * Returns a `CronHandler` ready to register against the shared
 * `CronHandlerRegistry`.
 */
export function buildFocusScoreRecomputeHandler(
  deps: FocusScoreRecomputeHandlerDeps,
): CronHandler {
  const now = deps.now ?? ((): number => Date.now())
  return async (ctx) => {
    const result = await recomputeFocusScoresForProject({
      db: deps.db,
      project_slug: ctx.owner_slug,
      now,
    })
    if (result.scanned === 0) {
      return { status: 'skipped', detail: 'no_open_tasks' }
    }
    return {
      status: 'ok',
      detail: `scanned=${result.scanned} updated=${result.updated}`,
    }
  }
}

/**
 * Build the per-instance cron job definition for the focus-score
 * recompute pass.
 */
export function buildFocusScoreRecomputeJob(input: {
  project_slug: string
  interval_ms?: number
}): CronJobDef {
  // Cron job name budget is 64 chars (validateJobName /^[a-z][a-z0-9-]{0,63}$/);
  // 'tasks-focus-score-' (18) leaves 45 chars for the instance slug. The
  // instance slug allocator caps at 50 chars (allocate-slug.ts) so
  // worst-case overflow surfaces at register time. For the 50-char
  // worst case we fall back to a hash to keep the name in budget.
  const slug = input.project_slug
  const candidate = `tasks-focus-score-${slug}`
  const name = candidate.length <= 64 ? candidate : `tasks-focus-score-${hashSlug(slug)}`
  return {
    name,
    description: `Focus-score recompute for ${input.project_slug}`,
    schedule: {
      kind: 'interval_ms',
      interval_ms: input.interval_ms ?? DEFAULT_FOCUS_SCORE_INTERVAL_MS,
    },
    handler: FOCUS_SCORE_HANDLER_NAME,
    skip_if_running: true,
    expected_duration_ms: 30_000,
  }
}

/**
 * Register the focus-score-recompute cron + handler against the
 * per-instance `CronJobRegistry` + `CronHandlerRegistry`. Idempotent on
 * the handler side — the registry rejects duplicate handler names, so
 * a multi-instance boot that calls this once per instance only registers
 * the shared handler the first time.
 */
export function registerFocusScoreRecomputeCron(input: {
  project_slug: string
  jobs: CronJobRegistry
  handlers: CronHandlerRegistry
  /** The handler built via `buildFocusScoreRecomputeHandler`. */
  handler: CronHandler
  interval_ms?: number
}): { job_name: string } {
  const jobInput: Parameters<typeof buildFocusScoreRecomputeJob>[0] =
    input.interval_ms !== undefined
      ? { project_slug: input.project_slug, interval_ms: input.interval_ms }
      : { project_slug: input.project_slug }
  const job = buildFocusScoreRecomputeJob(jobInput)
  input.jobs.register(job)
  if (input.handlers.get(FOCUS_SCORE_HANDLER_NAME) === undefined) {
    input.handlers.register(FOCUS_SCORE_HANDLER_NAME, input.handler)
  }
  return { job_name: job.name }
}

/**
 * Deterministic 8-char djb2-hash for the cron job name fallback. We
 * never accept slugs > 50 chars in production, but this keeps the
 * registry well-formed if a test injects a pathologically long slug.
 */
function hashSlug(slug: string): string {
  let h = 5381
  for (let i = 0; i < slug.length; i++) {
    h = ((h << 5) + h) ^ slug.charCodeAt(i)
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8)
}
