/**
 * @neutronai/gateway/cores — `cores_oauth_pending` sweep cron.
 *
 * Argus PR #210 minor #1 (2026-05-19) — `CoresOAuthPendingStore.consume`
 * is delete-on-read, which covers the happy path: the user finishes
 * Google's consent screen, identity routes the callback back to
 * `/api/cores/oauth/google/ingest`, the row is consumed + deleted.
 * Abandoned flows (user closes the tab, Google denies consent, callback
 * never fires) leak the row indefinitely. The store's file-level
 * docblock promised "expired-and-unconsumed rows are swept by
 * `sweepExpired(now)` (the gateway's cron module calls this every 5
 * min)" but no code ever called sweepExpired — so unbounded growth.
 *
 * Wiring shape mirrors `onboarding/interview/import-running-cron.ts`:
 *
 *   - name:     `cores-oauth-pending-sweep-<project_slug>`
 *   - handler:  `cores.oauth_pending_sweep_tick`
 *   - schedule: `{ kind: 'interval_ms', interval_ms: 5min default }`
 *
 * 5 min is the spec-implied cadence (per the store docblock). The
 * pending TTL is 10 min so a 5-min sweep deletes any abandoned row
 * within ~one full TTL window of its expiry.
 */

import type { CronHandler, CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import type { CronJobDef, CronJobRegistry } from '@neutronai/cron/jobs.ts'
import { CoresOAuthPendingStore } from './oauth-pending-store.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('cores-oauth-pending-sweep')

export const DEFAULT_CORES_OAUTH_SWEEP_INTERVAL_MS = 5 * 60 * 1_000

export const CORES_OAUTH_PENDING_SWEEP_HANDLER_NAME =
  'cores.oauth_pending_sweep_tick'

export interface CoresOAuthPendingSweepHandlerDeps {
  /** Per-instance DB handle — same one the store reads/writes. */
  db: ProjectDb
  /** Override Date.now (testing seam). */
  now?: () => number
}

/**
 * Build the per-instance cores_oauth_pending sweep handler.
 *
 * Behavior: scan + DELETE every row whose `expires_at <= now` in a
 * single transaction (the store's sweepExpired wraps that in a
 * tx). Returns `'ok'` when a non-zero count was swept, `'skipped'`
 * otherwise — matches the import-running cron's convention so the
 * `cron_state` log stays readable.
 */
export function buildCoresOAuthPendingSweepHandler(
  deps: CoresOAuthPendingSweepHandlerDeps,
): CronHandler {
  const now = deps.now ?? ((): number => Date.now())
  const store = new CoresOAuthPendingStore({ db: deps.db, now })

  return async (ctx) => {
    let deleted: number
    try {
      deleted = await store.sweepExpired(now())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      moduleLog.warn('sweep_failed', { project: ctx.owner_slug, error: message })
      return { status: 'error', detail: message }
    }
    if (deleted > 0) {
      moduleLog.info('swept', { project: ctx.owner_slug, swept: deleted })
      return { status: 'ok', detail: `swept=${deleted}` }
    }
    return { status: 'skipped', detail: 'no_expired_rows' }
  }
}

/**
 * Per-instance cron job definition. Job-name budget: 64 chars per
 * `validateJobName`. The prefix is 26 chars; instance slugs are 3-31 chars
 * per `SLUG_RE`. Worst case 26 + 31 = 57, under the ceiling.
 */
export function buildCoresOAuthPendingSweepJob(input: {
  project_slug: string
  interval_ms?: number
}): CronJobDef {
  return {
    name: `cores-oauth-pending-sweep-${input.project_slug}`,
    description: `Cores OAuth pending-row sweep for ${input.project_slug}`,
    schedule: {
      kind: 'interval_ms',
      interval_ms:
        input.interval_ms ?? DEFAULT_CORES_OAUTH_SWEEP_INTERVAL_MS,
    },
    handler: CORES_OAUTH_PENDING_SWEEP_HANDLER_NAME,
    skip_if_running: true,
    expected_duration_ms: 5_000,
  }
}

/**
 * Register the cron + handler against the per-instance
 * `CronJobRegistry` + `CronHandlerRegistry`. Idempotent w.r.t. handler
 * registration; re-registering the same `handler-name` on the same
 * registry no-ops.
 */
export function registerCoresOAuthPendingSweepCron(input: {
  project_slug: string
  jobs: CronJobRegistry
  handlers: CronHandlerRegistry
  handler: CronHandler
  interval_ms?: number
}): { job_name: string } {
  const job =
    input.interval_ms !== undefined
      ? buildCoresOAuthPendingSweepJob({
          project_slug: input.project_slug,
          interval_ms: input.interval_ms,
        })
      : buildCoresOAuthPendingSweepJob({ project_slug: input.project_slug })
  input.jobs.register(job)
  if (
    input.handlers.get(CORES_OAUTH_PENDING_SWEEP_HANDLER_NAME) === undefined
  ) {
    input.handlers.register(
      CORES_OAUTH_PENDING_SWEEP_HANDLER_NAME,
      input.handler,
    )
  }
  const recurrence_seconds = Math.round(
    (job.schedule.kind === 'interval_ms'
      ? job.schedule.interval_ms
      : DEFAULT_CORES_OAUTH_SWEEP_INTERVAL_MS) / 1_000,
  )
  moduleLog.info('registered_handler', {
    project: input.project_slug,
    job: job.name,
    recurrence_seconds,
  })
  return { job_name: job.name }
}
