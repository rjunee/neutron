/**
 * @neutronai/gateway/cores — the email pipeline's deps bundle + cron
 * registration.
 *
 * The Core owns the BEHAVIOUR (poll, classify, escalate); this module owns the
 * WIRING — it is the only place the Core's pure tick body meets the gateway's
 * `deliver` seam, the `PushDispatcher`, the owner's timezone and the substrate
 * one-shot LLM. `open/composer.ts` supplies the bundle;
 * `build-core-modules.ts` registers the handler + job on the shared cron
 * registries.
 *
 * Shapes mirror `gateway/proactive/cron.ts` (`buildIdleNudgeSweepHandler` /
 * `registerIdleNudgeSweepCron`) exactly, so the composition layer drops these
 * in identically and nothing new has to be learned to read them.
 *
 * Per docs/plans/2026-08-06-email-core-consolidation-plan.md § 5-6 (Phase 1).
 */

import type { GmailClient } from '@neutronai/email-managed-core/backend'
import {
  openEmailPipelineStore,
  type EmailPipelineStore,
} from '@neutronai/email-managed-core/pipeline/store'
import { runEmailPipelineTick } from '@neutronai/email-managed-core/pipeline/poller'

import type { CronHandler, CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import type { CronJobDef, CronJobRegistry } from '@neutronai/cron/jobs.ts'

import type { Deliver } from '../http/deliver.ts'
import type { PushDispatcher } from '../push/dispatcher.ts'

export const EMAIL_PIPELINE_POLL_HANDLER_NAME = 'email.pipeline_poll'
export const EMAIL_PIPELINE_POLL_JOB_NAME = 'email-pipeline-poll'
/** Five minutes — the interval the acceptance criterion is written against
 *  ("an important message reaches chat within one poll interval"). */
export const EMAIL_PIPELINE_POLL_INTERVAL_MS = 5 * 60_000

/**
 * Everything the pipeline needs from the composition root. Supplied by
 * `open/composer.ts` as `CompositionInput.email_pipeline`; absent ⇒ no cron
 * registers and the pipeline is inert (the unchanged default for a composer
 * that has no Gmail).
 */
export interface EmailPipelineCompositionConfig {
  /** The (possibly multi-account) Gmail client `mountOpenCores` built. */
  gmail: GmailClient
  /** `<owner_home>` — the sidecar lands at `<owner_home>/email/pipeline.db`. */
  owner_home: string
  project_slug: string
  /** The ONE out-of-turn chat seam. Escalations post with durability 'reply'. */
  deliver: Deliver
  /** The owner's BARE app topic — `appWsTopicId(OWNER_USER_ID)`. */
  escalation_topic_id: string
  /** Best-effort mobile push, ALONGSIDE chat. Null ⇒ chat only. */
  push: PushDispatcher | null
  /**
   * The substrate one-shot caller (`buildOneShotSubstrateLlm`). NULL on an
   * LLM-less box — the cascade then classifies deterministically (owner rules,
   * importance patterns, sender cache) and never crashes a tick.
   */
  llm: ((prompt: string) => Promise<string>) | null
  /**
   * Per-fire owner-timezone resolution, the `withTickTimezone` shape the
   * proactive crons use. Accepted NOW for P2 parity: the twice-daily brief's
   * windows are owner-local and DST-correct, and threading the resolver at the
   * seam in P1 means P2 changes the tick body only. THE P1 TICK BODY DOES NOT
   * READ IT — escalation is event-driven, not clock-driven.
   */
  resolveTimezone?: (owner_slug: string) => string | undefined
  interval_ms?: number
  now?: () => number
  /** Register the store's close on the composer's cleanup list. */
  register_cleanup?: (fn: () => void) => void
}

/**
 * The cron handler. The store opens LAZILY on the first fire — boot must not
 * create a sidecar for a pipeline that may never tick, and an unwritable
 * `<owner_home>` must surface as one failed tick rather than a failed boot.
 */
export function buildEmailPipelinePollHandler(
  cfg: EmailPipelineCompositionConfig,
): CronHandler {
  const now = cfg.now ?? ((): number => Date.now())
  // ACTIVATION IS NOW, NOT THE FIRST FIRE. An `interval_ms` job waits a full
  // interval before its first execution, so the tick's own `now()` is five
  // minutes after the pipeline actually took responsibility for the mailbox.
  // Mail arriving in that window is older than a cutoff stamped inside the
  // tick, so the backlog sweep files it as history the owner already triaged —
  // never classified, never escalated, and no later pass ever looks at it
  // again. Capturing the boundary HERE, where the handler is built, is the
  // difference between "the line is where we started" and "the line is
  // wherever we happened to first wake up".
  const activated_at = now()
  let store: EmailPipelineStore | null = null

  return async () => {
    try {
      if (store === null) {
        store = openEmailPipelineStore({ owner_home: cfg.owner_home, now })
        const opened = store
        cfg.register_cleanup?.(() => opened.close())
      }
      const handle = store
      const r = await runEmailPipelineTick({
        gmail: cfg.gmail,
        store: handle,
        classify: {
          cache_lookup: (sender) => handle.getSenderCache(sender),
          // Forward the IMPORTANCE decision too. Dropping it here defaulted
          // every learned sender to not-important, which made the classifier's
          // own fix inert in production: an important receipt escalated once
          // and was archived from the cache ever after. The unit test used its
          // own three-argument double and so could not see this.
          cache_store: (sender, category, important) =>
            handle.upsertSenderCache(sender, category, important),
          llm: cfg.llm,
        },
        escalate: {
          deliver: cfg.deliver,
          topic_id: cfg.escalation_topic_id,
          push: cfg.push,
          project_slug: cfg.project_slug,
        },
        now,
        activation_at: activated_at,
      })
      // Every kind of work the tick can do has to appear in BOTH lines. A tick
      // that only finished an owed Gmail write reported `skipped` while having
      // changed the mailbox — and a cron log that under-reports its own work is
      // exactly the surface you later use to conclude, wrongly, that nothing
      // was happening.
      const detail =
        `scanned=${r.scanned} escalated=${r.escalated} archived=${r.archived} ` +
        `precutoff=${r.precutoff} resumed=${r.resumed} remutated=${r.remutated} ` +
        `arrived_during_sweep=${r.arrived_during_sweep} errors=${r.errors}`
      const acted =
        r.escalated + r.archived + r.precutoff + r.resumed + r.remutated > 0
      return { status: acted ? 'ok' : 'skipped', detail }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { status: 'error', detail: `email-pipeline-poll failed: ${msg}` }
    }
  }
}

export function buildEmailPipelinePollJob(input: { interval_ms?: number } = {}): CronJobDef {
  return {
    name: EMAIL_PIPELINE_POLL_JOB_NAME,
    description: 'Poll the inbox, classify new mail, escalate what is important',
    schedule: {
      kind: 'interval_ms',
      interval_ms: input.interval_ms ?? EMAIL_PIPELINE_POLL_INTERVAL_MS,
    },
    handler: EMAIL_PIPELINE_POLL_HANDLER_NAME,
    // A slow tick (a big first poll, a slow mailbox) must never stack a second
    // one on top of it — overlapping ticks would double-read the same messages
    // before either had written its rows.
    skip_if_running: true,
    expected_duration_ms: 60_000,
  }
}

export function registerEmailPipelineCron(input: {
  jobs: CronJobRegistry
  handlers: CronHandlerRegistry
  handler: CronHandler
  interval_ms?: number
}): { job_name: string } {
  const job = buildEmailPipelinePollJob(
    input.interval_ms !== undefined ? { interval_ms: input.interval_ms } : {},
  )
  input.jobs.register(job)
  if (input.handlers.get(EMAIL_PIPELINE_POLL_HANDLER_NAME) === undefined) {
    input.handlers.register(EMAIL_PIPELINE_POLL_HANDLER_NAME, input.handler)
  }
  return { job_name: job.name }
}
