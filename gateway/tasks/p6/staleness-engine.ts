/**
 * @neutronai/gateway/tasks/p6 — staleness engine (P6.1).
 *
 * Per docs/plans/2026-05-23-002-feat-p6-1-nudge-engine-staleness-current-focus-pick-plan.md
 * Part B.
 *
 * Run order: the nudge cron tick invokes `runStalenessPass(...)`
 * BEFORE `runNudgePass(...)` so demoted scores are reflected in the
 * slate the LLM sees today.
 *
 * Mechanics:
 *   1. Read yesterday's `current_focus_pick` row (one per instance per
 *      day). Extract `task_id` (the picked one) + `top_3_task_ids`.
 *   2. For each task_id in `top_3_task_ids` minus `{picked}`:
 *      - If the task is now resolved (status != 'open') → no bump
 *        (user did it; no skip).
 *      - Else → atomic UPDATE `top3_skip_count = top3_skip_count + 1`.
 *   3. Select tasks with `top3_skip_count >= demotion_threshold`.
 *   4. Demote each: set `staleness_demoted_at = now()`, multiply
 *      `focus_score` by `decay`, bump `staleness_demotion_count`,
 *      reset `top3_skip_count` to 0.
 *   5. All writes inside a single `db.transaction` so the projection
 *      subscriber sees at most one wake-up per pass.
 *
 * Skip-counting is NOT a delete mechanic. Tasks that hit
 * `staleness_demotion_count >= skip_or_kill_threshold` are flagged in
 * the NEXT nudge prompt as "consider skip-or-kill" so the LLM can
 * mention it in the rationale — but the engine never closes / deletes
 * a task on its own.
 */

import type { ProjectDb } from '@neutronai/persistence/index.ts'

/** Default skip-count threshold above which a task is demoted. */
export const DEFAULT_DEMOTION_THRESHOLD = 3

/** Default decay factor applied to focus_score on demotion. */
export const DEFAULT_DECAY_FACTOR = 0.5

/** Default demotion-count above which the next nudge prompt flags skip-or-kill. */
export const DEFAULT_SKIP_OR_KILL_THRESHOLD = 3

export interface StalenessPassInput {
  db: ProjectDb
  project_slug: string
  /**
   * Owner-local date for "today" (`YYYY-MM-DD`). The pass reads
   * yesterday's pick relative to this. Provided by the caller so the
   * day boundary respects the owner's timezone.
   */
  today: string
  demotion_threshold?: number
  decay_factor?: number
  /**
   * Test seam — defaults to `() => Date.now()`. Used only for the
   * `staleness_demoted_at` ISO stamp.
   */
  now?: () => number
}

export interface StalenessPassResult {
  /** Number of (top-3 minus picked) ids whose skip-count was bumped. */
  bumped: number
  /** Number of tasks whose threshold was crossed and got demoted. */
  demoted: number
  /** Whether yesterday's pick row existed (skipped silently if not). */
  yesterday_pick_present: boolean
}

interface PickRow {
  task_id: string
  top_3_task_ids: string
}

interface OpenTaskCheck {
  id: string
  status: string
}

/**
 * Compute yesterday's date string given today's `YYYY-MM-DD`. Pure;
 * exposed so tests can construct deterministic pick rows.
 */
export function previousDay(today: string): string {
  const parts = today.split('-')
  if (parts.length !== 3) {
    throw new Error(`previousDay: invalid date '${today}' (expected YYYY-MM-DD)`)
  }
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`previousDay: invalid date '${today}' (non-numeric component)`)
  }
  // Build the UTC date from components, subtract one day, reformat.
  // Using UTC so the math is wall-clock-stable regardless of the
  // process timezone. The caller already resolved the owner's timezone
  // when picking `today`; we treat that string as opaque.
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() - 1)
  const yy = dt.getUTCFullYear().toString().padStart(4, '0')
  const mm = (dt.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = dt.getUTCDate().toString().padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/**
 * Parse the `top_3_task_ids` JSON column. Returns an empty array on
 * malformed JSON / non-array — the engine logs but never throws so a
 * single bad row can't lock up the cron.
 */
export function parseTop3(raw: string): ReadonlyArray<string> {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

/**
 * Run a single staleness pass for one instance. Idempotent on first
 * run (no yesterday pick → returns 0 bumps, 0 demotions).
 */
export async function runStalenessPass(
  input: StalenessPassInput,
): Promise<StalenessPassResult> {
  const threshold = input.demotion_threshold ?? DEFAULT_DEMOTION_THRESHOLD
  const decay = input.decay_factor ?? DEFAULT_DECAY_FACTOR
  const now = input.now ?? ((): number => Date.now())
  const yesterday = previousDay(input.today)

  const pick = input.db
    .prepare<PickRow, [string, string]>(
      `SELECT task_id, top_3_task_ids
         FROM current_focus_pick
        WHERE project_slug = ? AND day = ?
        LIMIT 1`,
    )
    .get(input.project_slug, yesterday)
  if (pick === null || pick === undefined) {
    return { bumped: 0, demoted: 0, yesterday_pick_present: false }
  }

  const candidates = parseTop3(pick.top_3_task_ids).filter(
    (id) => id !== pick.task_id,
  )
  if (candidates.length === 0) {
    return { bumped: 0, demoted: 0, yesterday_pick_present: true }
  }

  // Check which candidates are still 'open'. Resolved (done /
  // cancelled) ones get no skip-count bump. We materialize the
  // status check before the transaction so the IN-clause expansion
  // stays read-only.
  const placeholders = candidates.map(() => '?').join(',')
  const statuses = input.db
    .prepare<OpenTaskCheck, [string, ...string[]]>(
      `SELECT id, status FROM tasks
        WHERE project_slug = ? AND id IN (${placeholders})`,
    )
    .all(input.project_slug, ...candidates)
  const stillOpen = new Set<string>()
  for (const row of statuses) {
    if (row.status === 'open') stillOpen.add(row.id)
  }

  let bumped = 0
  let demoted = 0
  const nowIso = new Date(now()).toISOString()

  interface DemoteRow {
    id: string
    focus_score: number | null
  }

  await input.db.transaction(async (tx) => {
    // Bump skip-count for top-3-but-unpicked-and-still-open.
    for (const id of candidates) {
      if (!stillOpen.has(id)) continue
      await tx.run(
        `UPDATE tasks
            SET top3_skip_count = top3_skip_count + 1
          WHERE project_slug = ? AND id = ?`,
        [input.project_slug, id],
      )
      bumped += 1
    }

    // Now pick up tasks whose count crossed the demotion threshold.
    const toDemote = tx
      .prepare<DemoteRow, [string, number]>(
        `SELECT id, focus_score FROM tasks
          WHERE project_slug = ?
            AND status = 'open'
            AND top3_skip_count >= ?`,
      )
      .all(input.project_slug, threshold)
    for (const row of toDemote) {
      const newScore =
        row.focus_score === null
          ? null
          : Math.round(row.focus_score * decay * 10) / 10
      await tx.run(
        `UPDATE tasks
            SET focus_score = ?,
                staleness_demoted_at = ?,
                staleness_demotion_count = staleness_demotion_count + 1,
                top3_skip_count = 0,
                focus_score_updated_at = ?
          WHERE project_slug = ? AND id = ?`,
        [newScore, nowIso, nowIso, input.project_slug, row.id],
      )
      demoted += 1
    }
  })

  return { bumped, demoted, yesterday_pick_present: true }
}
