/**
 * @neutronai/onboarding — import-running cron-tick (S12, 2026-05-16).
 *
 * Per docs/plans/P2-onboarding-v2.md § 3.4 + § S5: `import_running` is a
 * transit phase that advances to `import_analysis_presented` the moment
 * the `ImportJobRunner` reaches `completed` (or `budget-exceeded` /
 * `failed` / `cancelled` / hard-timeout). The original wiring polled the
 * runner exactly ONCE — inside `engine.notifyImportUpload`, immediately
 * after `runner.start(...)`. At that moment the runner is still in
 * `queued` / `pass1-running`, so the engine emits the live status body
 * and returns; nothing polls again. Pass-1 + Pass-2 eventually finish,
 * the runner writes `import_results`, but the engine never detects it.
 * The v0.1.33 live walkthrough demonstrated this: phase stalled at
 * `import_running` for 5 min until the test harness gave up.
 *
 * This module closes the gap by registering a per-instance cron handler
 * that scans `onboarding_state` every 15 s for rows at
 * `phase = 'import_running'` with `import_job_id` non-null, then calls
 * `engine.pollImportRunningTick(...)` for each one. The engine routes
 * through `pollImportRunningAndAdvance` with the in-progress emit
 * suppressed so polling-while-running is silent on the channel; only
 * the terminal branches (advance + analysis prompt, failed retry/skip
 * prompt, budget-exceeded partial-value prompt) fire.
 *
 * Wiring shape (per-project cron registration):
 *   - `name`: `onboarding-import-running-<owner_slug>`
 *   - `handler`: `'onboarding.import_running_tick'`
 *   - `schedule`: `{ kind: 'interval_ms', interval_ms: 15s default }`
 *
 * 15 s is the spec-implied cadence ("import_running cron-tick polling"
 * per § S5) and matches the user's perceived "the agent is still
 * thinking" window. The engine's hard-timeout backstop at
 * `IMPORT_RUNNING_HARD_TIMEOUT_MS` (15 min) means the cron stops being
 * relevant after at most 60 ticks per import.
 *
 * Spec-vs-current diff (the brief's mandatory section):
 *
 *   Intended contract: import_running is a transit phase that advances
 *   to import_analysis_presented when the ImportJobRunner completes.
 *   Detection mechanism: cron-tick polling per § S5.
 *
 *   CURRENT WIRING (pre-S12): engine.notifyImportUpload polls once. No
 *   periodic poll.
 *
 *   GAP: periodic poll trigger.
 *
 *   THIS SPRINT FIXES: the gap above.
 *
 *   EXPLICITLY OUT OF SCOPE: any other engine handler changes.
 */

import { createLogger } from '@neutronai/logger'
import type { CronHandler, CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import type { CronJobDef, CronJobRegistry } from '@neutronai/cron/jobs.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import type { InterviewEngine } from './engine.ts'

const log = createLogger('import-running-cron')

/**
 * Default sweep cadence — 5 s (lowered from 15 s on 2026-05-21 by the
 * import-progress-envelope sprint, v0.1.75).
 *
 * The tick has two jobs now:
 *   1. Detect terminal runner status and advance the phase (the original
 *      S12 job — formerly the only job).
 *   2. Push a UI-only `import_progress` envelope to the live channel so
 *      the user sees a moving progress indicator while Pass 1 / Pass 2
 *      run. 5 s feels live without spamming; 15 s left the user staring
 *      at the same dots for too long.
 *
 * Cost: per-project DB scan + one `runner.status()` call + one
 * `sendImportProgress` call per tick. The handler runs
 * `skip_if_running: true` so concurrent fires coalesce; per-project
 * SQLite WAL keeps the scan non-blocking against import-job writes. The
 * runner's own per-job rate-limit (Pass-2 is single-shot Opus, ~30-60 s)
 * remains the upper bound on how fast progress can advance.
 *
 * If we observe contention or cost issues, future Codex passes can
 * raise this back toward 10 s without affecting correctness — the
 * envelope is fire-and-forget and the terminal-advance branches don't
 * care about cadence.
 */
export const DEFAULT_IMPORT_RUNNING_TICK_INTERVAL_MS = 5_000

/** Handler-registry name. */
export const ONBOARDING_IMPORT_RUNNING_HANDLER_NAME =
  'onboarding.import_running_tick'

/**
 * Row shape returned by the SQL scan. ISSUES #2 (2026-05-19) — the scan
 * now projects (owner_slug, user_id) so the handler can dispatch one
 * tick per user. `engine.pollImportRunningTick(...)` re-reads the full
 * state itself so the handler does not race against a concurrent
 * advance that landed between scan + tick.
 */
interface ImportRunningRow {
  project_slug: string
  user_id: string
}

export interface ImportRunningHandlerDeps {
  /** The per-instance InterviewEngine instance. */
  engine: InterviewEngine
  /** Per-project DB handle — the same one the engine + state-store own. */
  db: ProjectDb
  /** Test seam. */
  now?: () => number
}

/**
 * Build the import-running cron handler for an instance. The returned
 * function is ready to register against `CronHandlerRegistry` under
 * `ONBOARDING_IMPORT_RUNNING_HANDLER_NAME`.
 *
 * Behavior:
 *   1. Scan `onboarding_state` for THIS instance's row, filtering to
 *      `phase = 'import_running'` AND `import_job_id` non-empty in the
 *      phase_state JSON. Per-project DB so the result set is at most one
 *      row.
 *   2. For each row, call `engine.pollImportRunningTick(owner_slug)`.
 *      The engine reads its own state, resolves channel context, checks
 *      the runner status, and advances on terminal states (suppressing
 *      the in-progress emit so polling is silent on the channel).
 *   3. Failures inside the engine path are caught + logged; the handler
 *      returns `'skipped'` rather than `'error'` so a transient channel
 *      send failure does NOT mark the cron in an error state. The next
 *      tick retries automatically.
 */
export function buildImportRunningHandler(
  deps: ImportRunningHandlerDeps,
): CronHandler {
  const now = deps.now ?? ((): number => Date.now())

  return async (ctx) => {
    const fired_at = now()

    const rows = deps.db
      .prepare<ImportRunningRow, [string]>(
        `SELECT project_slug, user_id
           FROM onboarding_state
          WHERE project_slug = ?
            AND phase = 'import_running'
            AND COALESCE(
                  json_extract(phase_state_json, '$.import_job_id'),
                  ''
                ) <> ''`,
      )
      .all(ctx.owner_slug)

    // S15 (2026-05-17) — tick log proves cron is actually firing in
    // journald. Pre-S15 the scheduler never started, so this line never
    // appeared; once it stops appearing in steady-state (or the count
    // stays > 0 for > 15 min on a single instance), operators have a
    // direct signal pointing at the cron tier rather than the engine.
    log.info('tick', { project: ctx.owner_slug, in_flight_imports: rows.length })

    if (rows.length === 0) {
      return { status: 'skipped', detail: 'no_in_flight_imports' }
    }

    let advanced = 0
    let emitted = 0
    let in_progress = 0
    let awaiting_user = 0
    let missing_context = 0
    let send_failed = 0

    for (const row of rows) {
      try {
        const result = await deps.engine.pollImportRunningTick({
          owner_slug: row.project_slug,
          user_id: row.user_id,
          observed_at: fired_at,
        })
        switch (result.outcome) {
          case 'advanced':
            advanced += 1
            break
          case 'emitted_terminal_prompt':
            emitted += 1
            break
          case 'in_progress':
            in_progress += 1
            break
          case 'awaiting_user_choice':
            awaiting_user += 1
            break
          case 'missing_channel_context':
            missing_context += 1
            break
          case 'no_active_job':
            // SQL pre-filter should have excluded this; a race against
            // a concurrent advance landed between scan + tick. Safe.
            break
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn('tick_failed', { project: row.project_slug, error: message })
        send_failed += 1
      }
    }

    if (advanced > 0 || emitted > 0) {
      return {
        status: 'ok',
        detail:
          `scanned=${rows.length} advanced=${advanced} emitted=${emitted} ` +
          `in_progress=${in_progress} awaiting_user=${awaiting_user} ` +
          `missing_context=${missing_context} send_failed=${send_failed}`,
      }
    }
    return {
      status: 'skipped',
      detail:
        `no_terminal scanned=${rows.length} in_progress=${in_progress} ` +
        `awaiting_user=${awaiting_user} missing_context=${missing_context} ` +
        `send_failed=${send_failed}`,
    }
  }
}

/**
 * Per-instance cron job definition. Production wires this into the per-
 * instance `CronJobRegistry` alongside the other onboarding crons
 * (resume-on-reconnect, Sean Ellis 4-week).
 *
 * Job-name budget: 64 chars per `validateJobName`. The
 * `onboarding-import-running-` prefix is 26 chars; instance slugs are
 * 3-31 chars per `SLUG_RE`. Worst-case: 26 + 31 = 57 chars, under the
 * 64-char ceiling.
 */
export function buildImportRunningJob(input: {
  owner_slug: string
  interval_ms?: number
}): CronJobDef {
  return {
    name: `onboarding-import-running-${input.owner_slug}`,
    description: `Onboarding import-running cron tick for ${input.owner_slug}`,
    schedule: {
      kind: 'interval_ms',
      interval_ms:
        input.interval_ms ?? DEFAULT_IMPORT_RUNNING_TICK_INTERVAL_MS,
    },
    handler: ONBOARDING_IMPORT_RUNNING_HANDLER_NAME,
    skip_if_running: true,
    expected_duration_ms: 5_000,
  }
}

/**
 * Register the import-running cron + handler against the per-instance
 * `CronJobRegistry` + `CronHandlerRegistry`. The per-instance gateway boot
 * calls this after the InterviewEngine + cron module are both
 * constructed; the cron starts ticking on the next `CronScheduler.start()`
 * pass.
 *
 * Idempotent at the handler level — re-registering the same handler-name
 * across the same registries instance is a no-op.
 */
export function registerImportRunningCron(input: {
  owner_slug: string
  jobs: CronJobRegistry
  handlers: CronHandlerRegistry
  handler: CronHandler
  interval_ms?: number
}): { job_name: string } {
  const job =
    input.interval_ms !== undefined
      ? buildImportRunningJob({
          owner_slug: input.owner_slug,
          interval_ms: input.interval_ms,
        })
      : buildImportRunningJob({ owner_slug: input.owner_slug })
  input.jobs.register(job)
  if (input.handlers.get(ONBOARDING_IMPORT_RUNNING_HANDLER_NAME) === undefined) {
    input.handlers.register(ONBOARDING_IMPORT_RUNNING_HANDLER_NAME, input.handler)
  }
  // S15 (2026-05-17) — startup log line. Pre-S15 the cron module
  // constructed a CronScheduler but never called .start(), so this
  // registration silently landed in a never-ticking registry. The log
  // line gives operators a journald grep target proving the per-instance
  // wiring reached the registry. Pair it with the
  // the `[cron-scheduler] started` line emitted by
  // gateway/composition.ts after `graph.compose()`.
  const recurrence_seconds = Math.round(
    (job.schedule.kind === 'interval_ms'
      ? job.schedule.interval_ms
      : DEFAULT_IMPORT_RUNNING_TICK_INTERVAL_MS) / 1_000,
  )
  log.info('registered_handler', {
    project: input.owner_slug,
    job: job.name,
    recurrence_seconds,
  })
  return { job_name: job.name }
}
