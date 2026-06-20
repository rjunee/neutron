/**
 * Action 7 — overnight-pass cron.
 *
 * Per docs/plans/P2-onboarding.md § 2.5 #7. Always fires (FIRST in
 * dispatch order so the cron is set even if mid-dispatch fails). Owned-
 * data write: registers the per-project `overnight-<slug>` cron job that
 * drives the real Autonomous Overnight-Work engine
 * (`onboarding/overnight/`).
 *
 * 2026-06-19 (overnight-engine) — two changes from the old preview-only
 * pass: (1) the job is renamed `wow-overnight-<slug>` → `overnight-<slug>`
 * (the old name was tied to the morning check-in stub); (2) the tick
 * cadence is the engine's ~30-min scan/advance loop, NOT a daily 24h
 * re-fire — the engine itself gates the 23:00–07:00 window + the ≥06:50
 * reporter internally, so the cron just needs to tick often enough to
 * scan, advance in-flight Trident runs, and fire the morning brief.
 *
 * Reversibility: the cron job has slug `overnight-<project_slug>`;
 * removing the registration cancels it.
 *
 * Failure mode: cron-store write retries via `persistence/retry.ts`
 * (the `cron_state` write itself is wrapped); 3 failures → skip.
 */

import type { WowActionContext, WowActionModule, WowActionResult } from '../action-types.ts'

const ACTION_ID = '07-overnight-pass' as const
const HANDLER_NAME = 'overnight_handler'
/** ~30-min tick — the engine gates window/budget/reporter internally. */
const INTERVAL_MS = 30 * 60 * 1000

function jobNameFor(project_slug: string): string {
  // cron job name regex is lowercase alnum + dashes only; collapse '_'.
  return `overnight-${project_slug.replace(/_/g, '-')}`
}

const action07: WowActionModule = {
  action_id: ACTION_ID,

  triggerCondition(_ctx: WowActionContext): boolean {
    // Always fires.
    return true
  },

  async run(ctx: WowActionContext): Promise<WowActionResult> {
    const job_name = jobNameFor(ctx.project_slug)
    // Idempotent — if the registry already has this job, skip the
    // re-registration. Re-running is a no-op success rather than a
    // duplicate-entry error.
    if (ctx.cron_jobs.get(job_name) !== undefined) {
      const result: WowActionResult = {
        fired: true,
        reason: 'already_scheduled',
        redacted_payload: { job_name, scheduled_at: ctx.now() },
      }
      return result
    }
    try {
      ctx.cron_jobs.register({
        name: job_name,
        description: `autonomous overnight-work engine for project ${ctx.project_slug}`,
        schedule: { kind: 'interval_ms', interval_ms: INTERVAL_MS },
        handler: HANDLER_NAME,
        skip_if_running: true,
      })
    } catch (err) {
      throw new Error(
        `failed to register overnight cron for project ${ctx.project_slug}: ${(err as Error).message}`,
      )
    }
    // Mark the cron_state row so observability can answer "when was
    // this scheduled?". record() handles UPSERT — re-runs land cleanly.
    const fired_at = ctx.now()
    await ctx.cron_state.record({
      job_name,
      project_slug: ctx.project_slug,
      fired_at: fired_at / 1000,
      duration_ms: 0,
      status: 'ok',
      error: 'scheduled',
    })
    return {
      fired: true,
      reason: 'scheduled',
      redacted_payload: { job_name, scheduled_at: fired_at },
    }
  },
}

export default action07
