/**
 * @neutronai/onboarding/history-import — boot sweep for orphaned import jobs.
 *
 * (P6, durability P0) The live synthesis import (`build-synthesis-import-
 * runner.ts`) runs `runJob` fire-and-forget: the accumulating synthesis session
 * lives ONLY in the process that started it. A restart (deploy / crash /
 * `launchctl kickstart`) discards that in-flight promise, so any `import_jobs`
 * row left at a NON-TERMINAL status is an ORPHAN — no code will ever advance it,
 * yet the engine's import-running cron keeps polling `status()` (which returns
 * the stale non-terminal row) until the progress-aware hard timeout eventually
 * fires ~30 min later. The owner stares at a spinner the whole time.
 *
 * This boot sweep runs ONCE at composition — BEFORE the runner can start any new
 * job — and flips every orphaned non-terminal row to `failed` with an honest,
 * user-facing message. The engine's import-running cron then reads the `failed`
 * status on its next tick and advances onboarding to `import_analysis_presented`
 * (failed framing → "retry or skip"), which the re-armed Path-1 completion
 * watcher consumes. Net effect: a mid-import restart surfaces a fast retry
 * affordance instead of wedging.
 *
 * Modeled on `onboarding/profile-pic/restart-resume.ts` (boot scan → time-aware
 * decision → idempotent terminal flip → single count-summary log line), with
 * two deliberate divergences for the synthesis path:
 *
 *   - NO fresh-keep tier. Profile-pic keeps a 60 s "pending" window because a
 *     Gemini call MAY still be live upstream in another instance. The synthesis
 *     run has no upstream: it ran IN the process that died and is a single
 *     accumulating session with no chunk-resumable cache (see the runner's
 *     module docstring). Every non-terminal row at composition is therefore
 *     PROVABLY orphaned and unrecoverable, so keeping it fresh would only delay
 *     the honest failure and prolong the wedge.
 *   - NO auto-retry tier. A synthesis import needs the uploaded export bytes; we
 *     do not silently re-run it. The engine surfaces retry/skip to the owner.
 *
 * CARE — must not double-fire against the engine's hard timeout (both converge
 * on `failed`, idempotently). The flip is guarded to non-terminal rows only
 * (`WHERE ... status IN (<non-terminal>)`), so whichever path fires first wins
 * and the other's UPDATE matches zero rows. If the engine's hard timeout already
 * `cancel`led a job (status `cancelled`) or it `completed` between scan and
 * write, the sweep leaves it untouched.
 */

import { createLogger } from '@neutronai/logger'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { ImportErrorCode } from './types.ts'

const log = createLogger('import-job-boot-sweep')

/**
 * Non-terminal `import_jobs` statuses — an in-flight or paused import whose
 * in-process runner did NOT survive the restart. Terminal statuses
 * (`completed` / `failed` / `cancelled`) are left untouched. Kept as a literal
 * list (not derived) so the SQL guard and the type stay pinned together; the
 * `import-job-boot-sweep.test.ts` asserts the set matches the schema CHECK.
 */
export const NON_TERMINAL_IMPORT_JOB_STATUSES = [
  'queued',
  'pass1-running',
  'pass2-running',
  'rate_limit_cooling_off',
  'rate_limit_paused',
] as const

/**
 * Error code stamped on a swept row. `substrate_error` is an existing
 * `ImportErrorCode` the engine's failed-branch already renders — no contract
 * change. The synthesis substrate/process genuinely died mid-run, so the code
 * is accurate.
 */
const ORPHAN_ERROR_CODE: ImportErrorCode = 'substrate_error'

/**
 * User-facing message the engine surfaces on the `import_analysis_presented`
 * (failed) prompt. Mirrors the honest-failure copy in the runner's read-failure
 * gate so the retry/skip affordance reads consistently regardless of which path
 * failed the job.
 */
const ORPHAN_ERROR_MESSAGE =
  'I could not finish reading your history (the import was interrupted before it ' +
  'completed). You can retry the import or skip it.'

export interface SweepOrphanedImportJobsInput {
  /** Per-instance DB — the same handle the runner + engine own. */
  db: ProjectDb
  /** Test seam: clock. Defaults to `Date.now`. */
  now?: () => number
}

export interface ImportJobBootSweepResult {
  /** Non-terminal rows found at boot. */
  scanned: number
  /** Rows this sweep actually flipped to `failed` (idempotent — a row a
   *  concurrent path already made terminal counts as scanned but not failed). */
  failed: number
}

interface OrphanRow {
  job_id: string
}

/**
 * Boot-time scan. Flips every orphaned non-terminal `import_jobs` row to
 * `failed` with an honest message. Idempotent + safe against the engine's hard
 * timeout via the non-terminal WHERE guard. Returns a count summary so the
 * caller can emit a single startup log line.
 *
 * Runs at composition (single-threaded, no cron ticking yet), so the synchronous
 * `runSync` write is safe and avoids the async mutex churn.
 */
export function sweepOrphanedImportJobsOnBoot(
  input: SweepOrphanedImportJobsInput,
): ImportJobBootSweepResult {
  const now = input.now ?? Date.now
  const statusList = NON_TERMINAL_IMPORT_JOB_STATUSES.map((s) => `'${s}'`).join(', ')
  const rows = input.db
    .prepare<OrphanRow, []>(
      `SELECT job_id FROM import_jobs WHERE status IN (${statusList})`,
    )
    .all()
  let failed = 0
  for (const row of rows) {
    // Guard the flip to non-terminal rows only: idempotent, and it never
    // clobbers a row the engine's hard timeout `cancel`led or that `completed`
    // between the scan and this write.
    const res = input.db.runSync(
      `UPDATE import_jobs
          SET status = 'failed', error_code = ?, error_message = ?, completed_at = ?
        WHERE job_id = ?
          AND status IN (${statusList})`,
      [ORPHAN_ERROR_CODE, ORPHAN_ERROR_MESSAGE, now(), row.job_id],
    )
    if (res.changes > 0) failed += 1
  }
  if (rows.length > 0) {
    log.info('sweep', { scanned: rows.length, failed })
  }
  return { scanned: rows.length, failed }
}
