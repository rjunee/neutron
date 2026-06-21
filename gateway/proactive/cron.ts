/**
 * @neutronai/gateway/proactive — cron handlers + registration.
 *
 * Wraps the morning brief + idle-topic nudge sweep as `CronHandler`s and
 * registers them on the shared cron registries — REUSING the existing cron
 * infrastructure (`cron/jobs.ts`, `cron/handlers.ts`), per the scope guard;
 * no new scheduler. Both crons are instance-level (one job per instance,
 * keyed on the instance slug) and tick frequently: the morning brief posts
 * at most once per owner-local day (its own idempotency guard); the sweep
 * runs each interval and gates per-topic.
 *
 * Mirrors `nudge-engine.ts`'s `buildNudgeEngineHandler` / `registerNudgeEngineCron`
 * shape so the composition layer drops these in identically.
 */

import type { CronHandler, CronHandlerRegistry } from '../../cron/handlers.ts'
import type { CronJobDef, CronJobRegistry } from '../../cron/jobs.ts'
import {
  DEFAULT_BRIEF_INTERVAL_MS,
  runMorningBrief,
  type MorningBriefDeps,
} from './morning-brief.ts'
import {
  DEFAULT_SWEEP_INTERVAL_MS,
  runIdleNudgeSweep,
  type IdleNudgeSweepDeps,
} from './idle-nudge-sweep.ts'

export const MORNING_BRIEF_HANDLER_NAME = 'proactive.morning_brief'
export const IDLE_NUDGE_SWEEP_HANDLER_NAME = 'proactive.idle_nudge_sweep'

// ---------------------------------------------------------------------------
// Morning brief
// ---------------------------------------------------------------------------

export function buildMorningBriefHandler(deps: MorningBriefDeps): CronHandler {
  return async () => {
    try {
      const r = await runMorningBrief(deps)
      // A delivery outage returns `deliver_failed` and MUST surface as an
      // error (not the benign `skipped`) so outages are visible in telemetry
      // (#320). `posted` → ok; `already_posted`/`too_early` → skipped.
      const status =
        r.status === 'posted' ? 'ok' : r.status === 'deliver_failed' ? 'error' : 'skipped'
      return {
        status,
        detail: `day=${r.day} status=${r.status} body_len=${r.body_length}`,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { status: 'error', detail: `morning-brief failed: ${msg}` }
    }
  }
}

export function buildMorningBriefJob(input: {
  project_slug: string
  interval_ms?: number
}): CronJobDef {
  const candidate = `proactive-brief-${input.project_slug}`
  const name = candidate.length <= 64 ? candidate : `proactive-brief-${hashSlug(input.project_slug)}`
  return {
    name,
    description: `Daily morning brief for ${input.project_slug}`,
    schedule: { kind: 'interval_ms', interval_ms: input.interval_ms ?? DEFAULT_BRIEF_INTERVAL_MS },
    handler: MORNING_BRIEF_HANDLER_NAME,
    skip_if_running: true,
    expected_duration_ms: 30_000,
  }
}

export function registerMorningBriefCron(input: {
  project_slug: string
  jobs: CronJobRegistry
  handlers: CronHandlerRegistry
  handler: CronHandler
  interval_ms?: number
}): { job_name: string } {
  const jobInput: Parameters<typeof buildMorningBriefJob>[0] =
    input.interval_ms !== undefined
      ? { project_slug: input.project_slug, interval_ms: input.interval_ms }
      : { project_slug: input.project_slug }
  const job = buildMorningBriefJob(jobInput)
  input.jobs.register(job)
  if (input.handlers.get(MORNING_BRIEF_HANDLER_NAME) === undefined) {
    input.handlers.register(MORNING_BRIEF_HANDLER_NAME, input.handler)
  }
  return { job_name: job.name }
}

// ---------------------------------------------------------------------------
// Idle-topic nudge sweep
// ---------------------------------------------------------------------------

export function buildIdleNudgeSweepHandler(deps: IdleNudgeSweepDeps): CronHandler {
  return async () => {
    try {
      const r = await runIdleNudgeSweep(deps)
      return {
        status: r.posted > 0 ? 'ok' : 'skipped',
        detail: `posted=${r.posted} skipped=${r.skipped} (active=${r.skip_reasons.active} no_pick=${r.skip_reasons.no_pick} already=${r.skip_reasons.already_nudged} failed=${r.skip_reasons.deliver_failed})`,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { status: 'error', detail: `idle-nudge-sweep failed: ${msg}` }
    }
  }
}

export function buildIdleNudgeSweepJob(input: {
  project_slug: string
  interval_ms?: number
}): CronJobDef {
  const candidate = `proactive-nudge-sweep-${input.project_slug}`
  const name =
    candidate.length <= 64 ? candidate : `proactive-nudge-sweep-${hashSlug(input.project_slug)}`
  return {
    name,
    description: `Idle-topic nudge sweep for ${input.project_slug}`,
    schedule: { kind: 'interval_ms', interval_ms: input.interval_ms ?? DEFAULT_SWEEP_INTERVAL_MS },
    handler: IDLE_NUDGE_SWEEP_HANDLER_NAME,
    skip_if_running: true,
    expected_duration_ms: 30_000,
  }
}

export function registerIdleNudgeSweepCron(input: {
  project_slug: string
  jobs: CronJobRegistry
  handlers: CronHandlerRegistry
  handler: CronHandler
  interval_ms?: number
}): { job_name: string } {
  const jobInput: Parameters<typeof buildIdleNudgeSweepJob>[0] =
    input.interval_ms !== undefined
      ? { project_slug: input.project_slug, interval_ms: input.interval_ms }
      : { project_slug: input.project_slug }
  const job = buildIdleNudgeSweepJob(jobInput)
  input.jobs.register(job)
  if (input.handlers.get(IDLE_NUDGE_SWEEP_HANDLER_NAME) === undefined) {
    input.handlers.register(IDLE_NUDGE_SWEEP_HANDLER_NAME, input.handler)
  }
  return { job_name: job.name }
}

/** djb2-xor — same slug-fallback hash the nudge engine uses for long slugs. */
function hashSlug(slug: string): string {
  let h = 5381
  for (let i = 0; i < slug.length; i++) {
    h = ((h << 5) + h) ^ slug.charCodeAt(i)
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8)
}
