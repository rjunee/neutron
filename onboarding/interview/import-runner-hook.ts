/**
 * @neutronai/onboarding/interview — the `ImportJobRunnerHook` contract.
 *
 * (K3, 2026-07-03) — lifted out of `engine-internals.ts` into its own
 * dedicated, node-free contract module so the seam survives the per-chunk
 * import-pipeline evacuation independent of the interview engine internals,
 * and so a later unit (P6 / the §L2 contracts-leaf relocation) can move it
 * without disturbing engine-internals. `engine-internals.ts` re-exports it
 * (`export type { ImportJobRunnerHook } from './import-runner-hook.ts'`) so
 * `engine.ts` and every existing consumer keep resolving unchanged.
 *
 * Placement note (band discipline): the contract references the onboarding
 * import type hub (`ImportSource`/`ChunkerInput`/`ImportJob`/`ImportResult`
 * from `history-import/types.ts`, product band), so this module stays in the
 * onboarding (product) band — a true contracts-band leaf would require
 * relocating that whole type hub across bands, which is §L2's explicitly
 * scoped job (via `export … from` shims), not K3's.
 */

import type {
  ChunkerInput,
  ImportJob,
  ImportResult,
  ImportSource,
} from '../history-import/types.ts'

/**
 * T4 (2026-05-13) — history-import job-runner hook. The engine treats imports
 * as opaque behind this surface:
 *   - `start(...)` kicks off a background job, returns `{job_id}` immediately.
 *   - `status(job_id)` is the poller; returns `null` when no row exists.
 *   - `cancel(job_id)` marks the row cancelled; inflight chunks finish.
 *
 * When the hook is absent (`deps.importJobRunner === undefined`), the engine
 * collapses `chatgpt_zip` / `claude_zip` choices into the skip path — the
 * production composer ALWAYS wires the hook (see
 * `gateway/realmode-composer/build-landing-stack.ts`) so users always reach
 * the runner. The unwired path exists for legacy callers + test harnesses
 * that don't exercise the import flow.
 */
export interface ImportJobRunnerHook {
  start(input: {
    project_slug: string
    /**
     * ISSUES #2 (2026-05-19) — onboarding_state PK is composite. Threaded so
     * the runner can resolve the right (project_slug, user_id) row.
     */
    user_id: string
    source: ImportSource
    payload: ChunkerInput
  }): Promise<{ job_id: string }>
  status(job_id: string): Promise<ImportJob | null>
  cancel(job_id: string): Promise<void>
  /**
   * T4 / Codex r2 (post-T4) — synthesize-on-demand. Aggregates the Pass-1
   * chunks already persisted for this job's (instance, source) pair and
   * persists a partial `ImportResult` to `import_results`. The engine calls
   * this on the user's "Stop now (use partial)" tap BEFORE `cancel` so the
   * partial work the user explicitly asked to keep is recoverable.
   *
   * Returns `null` when no Pass-1 rows exist yet (e.g. cancel before any
   * chunk landed) so the engine can still route gracefully to
   * use_partial → archetype_picked with `import_result=null`.
   */
  synthesizeOnDemand(
    job_id: string,
    opts?: { preferDegraded?: boolean },
  ): Promise<ImportResult | null>
}
