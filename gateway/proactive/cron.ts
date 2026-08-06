/**
 * @neutronai/gateway/proactive — cron handlers + registration.
 *
 * Wraps the idle-topic nudge sweep as a `CronHandler` and registers it on the
 * shared cron registries — REUSING the existing cron infrastructure
 * (`cron/jobs.ts`, `cron/handlers.ts`), per the scope guard; no new scheduler. The
 * cron is instance-level (one job per instance, keyed on the instance slug) and
 * ticks each interval, gating per-topic.
 *
 * THE MORNING BRIEF USED TO LIVE HERE TOO, and ISSUES #504 deleted it. It was the
 * SECOND morning brief: a provider-driven composer whose `calendarToday`,
 * `entityDeltas` and `projectStatus` slots were supplied by NOTHING in production —
 * only by its own test — so it posted a digest that had to admit "I couldn't check
 * your calendar". That is the persona-gen shape: a feature whose only caller is a
 * test. The surviving morning brief is the RITUAL, which fires as an ordinary
 * reminder onto the owner's own session and can therefore reach the calendar Core
 * for real.
 *
 * Mirrors `nudge-engine.ts`'s `buildNudgeEngineHandler` / `registerNudgeEngineCron`
 * shape so the composition layer drops these in identically.
 */

import type { CronHandler, CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import type { CronJobDef, CronJobRegistry } from '@neutronai/cron/jobs.ts'
import {
  DEFAULT_SWEEP_INTERVAL_MS,
  runIdleNudgeSweep,
  type IdleNudgeSweepDeps,
} from './idle-nudge-sweep.ts'

export const IDLE_NUDGE_SWEEP_HANDLER_NAME = 'proactive.idle_nudge_sweep'

/**
 * Resolve the tick's owner timezone, applying the precedence both proactive
 * crons share with the P6 nudge engine: a per-tick `resolveTimezone(owner_slug)`
 * result WINS over the static `tz`, and `undefined` falls through to the static
 * `tz` (which the run function then defaults to `DEFAULT_OWNER_TIMEZONE`).
 *
 * This lives in the HANDLER, not in `runMorningBrief`/`runIdleNudgeSweep`,
 * because `owner_slug` only exists per-fire (`CronHandlerContext`) — and it must
 * stay per-fire rather than being captured at composition time: a fresh install
 * has no `instance_metadata` row until the first client connects, so a zone read
 * at boot would freeze the host's zone forever.
 */
function withTickTimezone<D extends { tz?: string; resolveTimezone?: (owner_slug: string) => string | undefined }>(
  deps: D,
  owner_slug: string,
): D {
  const resolved = deps.resolveTimezone?.(owner_slug)
  return resolved === undefined ? deps : { ...deps, tz: resolved }
}

// ---------------------------------------------------------------------------
// Idle-topic nudge sweep
// ---------------------------------------------------------------------------

export function buildIdleNudgeSweepHandler(deps: IdleNudgeSweepDeps): CronHandler {
  return async (ctx) => {
    try {
      // Same owner-clock resolution as the brief: the sweep's `day` is the key
      // `readTodayPick` uses, so the host's zone would make the lookup miss.
      const r = await runIdleNudgeSweep(withTickTimezone(deps, ctx.owner_slug))
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
