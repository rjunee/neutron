/**
 * @neutronai/onboarding/profile-pic — process-restart resume hook.
 *
 * Per SPEC.md Phases→Steps (was SPEC.md § Phases→Steps cross-cutting:
 *   "Profile-pic process-restart resume — Gemini calls finish in 15-30 s;
 *    not blocking M2."
 *
 * Called from the per-instance gateway's boot sequence (the same code path
 * that runs migrations on first hit). Scans `profile_pic_pending` for
 * rows that were 'pending' when the previous process died and applies
 * the time-window heuristics from the brief:
 *
 *   - started_at within 60 s ago     → keep 'pending' (the call MAY
 *                                       still be live upstream, even
 *                                       though our in-flight promise is
 *                                       gone; the engine surfaces
 *                                       "still generating" to the user)
 *   - started_at older AND auto_retry_attempted = 0
 *                                    → mark 'expired' + fire one
 *                                       auto-retry via the pipeline
 *   - started_at older AND auto_retry_attempted = 1
 *                                    → mark 'failed'; user must
 *                                       re-trigger via the picker
 *
 * Gemini Imagen 4 (Nano Banana Pro) — REST surface is synchronous; the
 * SDK does NOT expose a request_id lookup or in-flight poll handle. So
 * "the call MAY still be live upstream" is informational only — we can
 * never recover the bytes from a call whose process died. The 60 s
 * grace window exists so a fast process-restart (deploy that takes 2-3
 * sec) doesn't immediately fail rows that another gateway instance
 * MIGHT still be racing (if a future deployment topology adds one).
 *
 * Auto-retry semantics: when a row transitions pending → expired AND
 * `auto_retry_attempted` was 0, the boot hook fires one new
 * `pipeline.start(...)` against the same (project_slug, prompt). The new
 * row gets its own request_id; the old row stays at 'expired' so the
 * engine UX can still surface "previous attempt timed out, retry?"
 * (the auto-retry is invisible to the user — they just see fresh
 * candidates show up next time they re-enter the phase).
 *
 * Idempotent: re-running the boot hook on an already-processed row is a
 * no-op (the WHERE clauses in markExpired / markFailedFromBoot reject
 * non-pending rows).
 */

import { createLogger } from '@neutronai/logger'
import type { ProfilePicPendingRow, ProfilePicPendingStore } from './pending-call-store.ts'
import type { ProfilePicPipeline, StartProfilePicInput } from './pipeline.ts'

const log = createLogger('profile-pic-resume')

/**
 * Threshold (ms) below which a pending row is kept untouched. Older
 * than this, the boot hook applies the expire/fail rules.
 *
 * Per brief: 60 s. Tunable for tests.
 */
export const DEFAULT_PENDING_FRESH_WINDOW_MS = 60_000

/**
 * Absolute cap (ms) — any pending row older than this transitions
 * straight to 'failed' regardless of `auto_retry_attempted`. The brief
 * states 5 min; we use it as a hard ceiling so a row stuck at
 * `auto_retry_attempted=0` for many hours doesn't get a fresh retry.
 */
export const DEFAULT_PENDING_HARD_FAIL_WINDOW_MS = 5 * 60_000

export interface ResumeOnBootDeps {
  store: ProfilePicPendingStore
  /**
   * Pipeline used to fire one auto-retry per expired row. Optional —
   * tests that just want to assert the row transition can omit it; in
   * that case 'expired' rows do NOT trigger a retry call (the engine
   * will re-fire when the user re-enters the phase).
   */
  pipeline?: ProfilePicPipeline
  /** Time source (test seam). Defaults to `() => Date.now()`. */
  now?: () => number
  /** Pending-call freshness window (ms). Defaults to 60 s. */
  fresh_window_ms?: number
  /** Hard-fail window (ms). Defaults to 5 min. */
  hard_fail_window_ms?: number
}

export interface ResumeOnBootResult {
  kept_pending: number
  expired: number
  failed: number
  auto_retries_fired: number
  /**
   * Job ids returned by each auto-retry call. The boot hook fires them
   * fire-and-forget — `pipeline.start` returns synchronously with the
   * id while the in-flight Gemini call runs in the background. Tests
   * (or callers that want strict shutdown sequencing) can
   * `await pipeline.awaitJob(id)` on each.
   */
  auto_retry_job_ids: string[]
}

/**
 * Boot-time scan. Reads every `status='pending'` row, applies the time-
 * window heuristics, and fires up to one auto-retry per row that
 * transitions to 'expired'.
 *
 * Returns a count summary so the gateway can log a single line at
 * startup (e.g. "[profile-pic] resume: 0 kept, 1 expired, 0 failed,
 * 1 auto-retry fired") rather than a noisy per-row log.
 *
 * Per-row errors during auto-retry are caught + logged (profile-pic-resume logger);
 * a flaky retry does NOT abort the whole scan.
 */
export async function resumeProfilePicOnBoot(
  deps: ResumeOnBootDeps,
): Promise<ResumeOnBootResult> {
  const now = deps.now ?? ((): number => Date.now())
  const fresh = deps.fresh_window_ms ?? DEFAULT_PENDING_FRESH_WINDOW_MS
  const hard = deps.hard_fail_window_ms ?? DEFAULT_PENDING_HARD_FAIL_WINDOW_MS
  const result: ResumeOnBootResult = {
    kept_pending: 0,
    expired: 0,
    failed: 0,
    auto_retries_fired: 0,
    auto_retry_job_ids: [],
  }
  const rows = await deps.store.listPending()
  for (const row of rows) {
    const age = now() - row.started_at
    if (age < fresh) {
      result.kept_pending += 1
      continue
    }
    // Age past the hard-fail window OR a retry was already attempted →
    // straight to failed. The user has to re-trigger.
    if (age >= hard || row.auto_retry_attempted) {
      const flipped = await deps.store.markFailedFromBoot(row.request_id)
      if (flipped) result.failed += 1
      continue
    }
    // First-time stale row inside the retry window → expire + fire one
    // auto-retry.
    const flipped = await deps.store.markExpired(row.request_id)
    if (!flipped) continue
    result.expired += 1
    if (deps.pipeline !== undefined) {
      const job_id = await fireAutoRetry(deps.pipeline, row)
      if (job_id !== null) {
        result.auto_retries_fired += 1
        result.auto_retry_job_ids.push(job_id)
      }
    }
  }
  return result
}

async function fireAutoRetry(
  pipeline: ProfilePicPipeline,
  row: ProfilePicPendingRow,
): Promise<string | null> {
  try {
    const startInput: StartProfilePicInput = {
      project_slug: row.project_slug,
      prompt: row.prompt,
    }
    if (row.user_id !== null) startInput.user_id = row.user_id
    // Argus r1 BLOCKER 3 — preserve the persisted archetype_hint on the
    // auto-retry. Without this, `pipeline.start` falls through to
    // FALLBACK_DEFAULT_SLUG and the retried portrait is detached from
    // the user's actual archetype.
    if (row.archetype_hint !== null) startInput.archetype_hint = row.archetype_hint
    const r = await pipeline.start(startInput)
    return r.job_id
  } catch (err) {
    log.warn('auto_retry_failed', {
      request_id: row.request_id,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}
