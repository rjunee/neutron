/**
 * @neutronai/onboarding/wow-moment — `wow_overnight_handler` (the cron
 * handler behind action 07's `wow-overnight-<internal_handle>` job).
 *
 * 2026-06-10 (wow-hang-resilience sprint). Action 07 has registered the
 * overnight-pass JOB at wow-moment dispatch time since T2 (2026-05-13),
 * and the T2-r3 shared-registry fix made the production `CronScheduler`
 * see it — but NOTHING ever registered the HANDLER in the production
 * `CronHandlerRegistry`. Every tick logged:
 *
 *   cron scheduler: skipping job wow-overnight-t-33333333 — handler
 *   wow_overnight_handler not registered
 *
 * …and the promised overnight pass silently never ran (prod incident,
 * instance t-33333333). This module is the production handler + its
 * registration helper, mirroring the `resume-cron.ts` /
 * `import-running-cron.ts` shape.
 *
 * **What the handler does today.** The full overnight-work pipeline
 * (background analysis, draft replies, task re-ranking) is future work;
 * this handler delivers the morning check-in surface honestly:
 *
 *   1. Look up the owner's completed onboarding row (the overnight job
 *      only exists for instances that reached `wow_fired`).
 *   2. Compose a short morning check-in from REAL stored state (the
 *      confirmed project list) — no fabricated "analysis ran" claims.
 *   3. Deliver via the injected `deliver` seam (production: the shared
 *      web sender registry). No active WS → status 'skipped'; the
 *      interval job re-fires tomorrow.
 *
 * The handler NEVER throws — every failure lands as a structured
 * `{ status: 'error' | 'skipped', detail }` so `cron_state` records it.
 */

import type { ProjectDb } from '../../persistence/index.ts'
import type {
  CronHandler,
  CronHandlerContext,
  CronHandlerRegistry,
  CronHandlerResult,
} from '../../cron/handlers.ts'

export const WOW_OVERNIGHT_HANDLER_NAME = 'wow_overnight_handler'

/** Cap the project list in the check-in body — terse beats exhaustive. */
const PROJECT_LIST_CAP = 5

export interface WowOvernightDeliverInput {
  topic_id: string
  body: string
}

export interface BuildWowOvernightHandlerInput {
  db: ProjectDb
  /**
   * Deliver the morning check-in to the user's active topic. Returns
   * true when delivered (an active WS accepted the message), false when
   * there is no reachable surface. Production wires the shared
   * `InMemoryWebChatSenderRegistry.send` (gateway/index.ts); when
   * omitted the handler is registration-only — it ticks, records
   * 'skipped', and never errors (the pre-handler failure mode was a
   * scheduler error EVERY tick).
   */
  deliver?: (input: WowOvernightDeliverInput) => boolean | Promise<boolean>
}

interface OnboardingRow {
  phase_state_json: string
  completed_at: number | null
}

/**
 * Build the production `wow_overnight_handler`. See module docblock for
 * scope — delivery of the morning check-in, not (yet) the autonomous
 * overnight-work pipeline.
 */
export function buildWowOvernightHandler(input: BuildWowOvernightHandlerInput): CronHandler {
  return async (ctx: CronHandlerContext): Promise<CronHandlerResult> => {
    try {
      // The overnight job exists per-instance (one user per instance at MM).
      // Read the most-recently-completed onboarding row — its
      // phase_state carries the topic_id + confirmed project list.
      const row = input.db
        .prepare<OnboardingRow, []>(
          `SELECT phase_state_json, completed_at
             FROM onboarding_state
            WHERE phase = 'completed'
            ORDER BY completed_at DESC
            LIMIT 1`,
        )
        .get()
      if (row === null || row === undefined) {
        return {
          status: 'skipped',
          detail: `no completed onboarding row for project ${ctx.project_slug}; nothing to check in on`,
        }
      }
      let phase_state: Record<string, unknown> = {}
      try {
        phase_state = JSON.parse(row.phase_state_json) as Record<string, unknown>
      } catch {
        // Corrupt JSON — deliver the no-projects shape rather than fail.
      }
      const topic_id = typeof phase_state['topic_id'] === 'string' ? phase_state['topic_id'] : null
      if (topic_id === null) {
        return {
          status: 'skipped',
          detail: 'completed onboarding row has no topic_id; cannot route the check-in',
        }
      }
      if (input.deliver === undefined) {
        return {
          status: 'skipped',
          detail: 'no deliver surface wired; overnight check-in not sent',
        }
      }
      const body = composeMorningCheckin(phase_state)
      const delivered = await input.deliver({ topic_id, body })
      if (!delivered) {
        return {
          status: 'skipped',
          detail: `no active session for topic ${topic_id}; will retry on tomorrow's tick`,
        }
      }
      return { status: 'ok', detail: 'morning check-in delivered' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err ?? 'unknown')
      return { status: 'error', detail: `wow_overnight_handler failed: ${msg}` }
    }
  }
}

/**
 * Compose the morning check-in from REAL stored state. Deliberately
 * honest: it surfaces what's on deck (the user's confirmed projects) and
 * asks for direction — it does NOT claim background analysis ran
 * (that pipeline is future work; see module docblock).
 */
export function composeMorningCheckin(phase_state: Record<string, unknown>): string {
  const projects = readProjects(phase_state)
  const lines: string[] = []
  lines.push('Morning — overnight check-in.')
  if (projects.length > 0) {
    lines.push('')
    lines.push(`Projects on deck (${projects.length}):`)
    for (const p of projects.slice(0, PROJECT_LIST_CAP)) {
      lines.push(`- ${p}`)
    }
    if (projects.length > PROJECT_LIST_CAP) {
      lines.push(`- …and ${projects.length - PROJECT_LIST_CAP} more`)
    }
  }
  lines.push('')
  lines.push('Tell me what to dig into first, or ask for a plan for the day.')
  return lines.join('\n')
}

function readProjects(phase_state: Record<string, unknown>): string[] {
  const confirmed = phase_state['primary_projects_confirmed']
  const source = Array.isArray(confirmed) ? confirmed : phase_state['primary_projects']
  if (!Array.isArray(source)) return []
  return source
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
}

/**
 * Register the handler in the production registry. Idempotent across
 * repeat calls on the same registries instance (mirrors
 * `registerOnboardingResumeCron`'s guard) — the JOB side is registered
 * dynamically by action 07 at wow-moment dispatch time, so only the
 * handler registration lives here.
 */
export function registerWowOvernightHandler(input: {
  handlers: CronHandlerRegistry
  handler: CronHandler
}): void {
  if (input.handlers.get(WOW_OVERNIGHT_HANDLER_NAME) === undefined) {
    input.handlers.register(WOW_OVERNIGHT_HANDLER_NAME, input.handler)
  }
}
