/**
 * @neutronai/onboarding — import-running cron-tick (S12, 2026-05-16).
 *
 * The contract this module implements — checkable against the code and the
 * tests below, not quoted from a document: `import_running` is a transit phase
 * that advances to `import_analysis_presented` the moment the
 * `ImportJobRunner` reaches `completed` (or `budget-exceeded` / `failed` /
 * `cancelled` / hard-timeout). (`docs/plans/P2-onboarding-v2.md` § 3.4 + § S5
 * is where it was originally specified. That file is not in this repository, so
 * the § numbers are a pointer for whoever holds it; nothing here is a quote,
 * and the authority for the behaviour is
 * `tests/integration/import-running-cron-tick.test.ts`.) The original wiring polled the
 * runner exactly ONCE — inside `engine.notifyImportUpload`, immediately
 * after `runner.start(...)`. At that moment the runner is still in
 * `queued` / `pass1-running`, so the engine emits the live status body
 * and returns; nothing polls again. Pass-1 + Pass-2 eventually finish,
 * the runner writes `import_results`, but the engine never detects it.
 * The v0.1.33 live walkthrough demonstrated this: phase stalled at
 * `import_running` for 5 min until the test harness gave up.
 *
 * This module closes the gap by registering a per-instance cron handler
 * that scans `onboarding_state` on an interval for rows at
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
 *   - `schedule`: `{ kind: 'interval_ms', interval_ms:
 *     DEFAULT_IMPORT_RUNNING_TICK_INTERVAL_MS }` — read the figure off
 *     {@link DEFAULT_IMPORT_RUNNING_TICK_INTERVAL_MS}. It was lowered once
 *     already and an earlier revision of THIS header went stale by restating
 *     it, which is why this docblock names the constant and states no figure.
 *     Elsewhere in the tree the cadence is still written as a number in
 *     several places — arithmetic that needs the value (the lines/day math on
 *     {@link IDLE_TICK_LOG_INTERVAL_MS}), dated incident narratives, and a
 *     constant-guard test that asserts it. Those are not authoritative, and
 *     they are not reliably current either: successive sweeps for this change
 *     each turned up another site still saying 15 s, including two found only
 *     after a sweep had been declared complete. **If you change this constant,
 *     grep for the OLD NUMBER across the repo — not for a phrase, and not
 *     against any inventory, including this sentence.** Phrase-shaped greps are
 *     what missed them: the stale sites said "15s sweep" and "15 seconds",
 *     which none of the patterns aimed at "every 15s" could see.
 *
 * A few-second cadence matches the user's perceived "the agent is still
 * thinking" window. How long the cron stays relevant for a given import is
 * decided by the engine's timeout rule, NOT by anything in this file and not
 * by a flat tick count. Since 2026-06-18 that rule is progress-aware — read
 * `evaluateImportTimeout` in `engine-internals.ts`. Do not plan tick cost off a
 * summary of it, including this one: what matters here is only that this file
 * imposes no bound of its own, so a slow import can legitimately be ticked for
 * a long time. (Successive revisions of this header stated the bound as "15
 * min", then "at most 60 ticks per import", then an enumeration of the rule's
 * windows, then a per-import ceiling — each one either predating a redesign or
 * contradicted by a short-circuit in the same function. The reason this
 * paragraph states no bound is that the attempts to state one kept being wrong.)
 *
 * Spec-vs-current diff (the brief's mandatory section):
 *
 *   Intended contract: import_running is a transit phase that advances
 *   to import_analysis_presented when the ImportJobRunner completes.
 *   Detection mechanism: cron-tick polling (§ S5 in the unavailable spec
 *   above — the mechanism is pinned by the tests, not by that reference).
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
 * How often an IDLE tick may log its heartbeat.
 *
 * 10 minutes against a 5 s sweep turns ~17,280 idle lines/day into ~144 — quiet
 * enough to read a journal, frequent enough that "the line stopped appearing" is
 * still a signal an operator can act on within a coffee break.
 *
 * The ceiling is DETECTION LATENCY: one whole interval has to pass before silence
 * means anything, so the interval is how long an operator waits before "the cron
 * stopped" is readable at all. It is NOT related to the 15 min stuck-count window
 * in the S15 note below — this throttle only ever applies to the idle branch, which
 * reports `in_flight_imports=0` by definition, so it cannot slow or mask a >0 count.
 */
export const IDLE_TICK_LOG_INTERVAL_MS = 10 * 60_000

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
 *   1. Scan `onboarding_state` for THIS instance's rows, filtering to
 *      `phase = 'import_running'` AND `import_job_id` non-empty in the
 *      phase_state JSON. The primary key is `(project_slug, user_id)`
 *      (`migrations/0043_onboarding_state_wow_pushed_at.sql`), so the
 *      per-project DB bounds the result set to one row PER USER, not one row
 *      overall — which is why the scan projects `user_id` and the handler
 *      loops (ISSUES #2, 2026-05-19). In the single-owner case that is one
 *      row in practice, but the loop is the contract.
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
  // ONE logger view per clock, deliberately. `rateLimited` windows are
  // per-process state keyed `subsystem × key` — the CLOCK is not part of the
  // key — so two views on `import-running-cron` reading different clocks would
  // compare one clock's readings against the other's stamps in a single
  // window. Only the test seam injects a clock, so in production this IS the
  // module-level `log` and that mix cannot arise at all; a test that injects
  // one gets its own view, and `resetLoggerStateForTests` is what keeps its
  // stamps out of the next test's window.
  const tickLog =
    deps.now === undefined ? log : createLogger('import-running-cron', { now: deps.now })
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

    // S15 (2026-05-17) — the tick log proves the cron is actually firing in
    // journald. Pre-S15 the scheduler never started, so this line never
    // appeared; once it stops appearing in steady-state, operators have a
    // direct signal pointing at the cron tier rather than the engine. (S15
    // also read a count that stayed > 0 for > 15 min as a stuck signal. That
    // stopped holding on 2026-06-18 — see below; it is quoted here as history,
    // not as a live alarm.)
    //
    // ── WHY THIS IS NO LONGER LOGGED UNCONDITIONALLY (2026-08-10) ──────────
    // It was, and on an idle instance that is a tick every 5s forever with
    // `in_flight_imports=0` — measured at ~17k lines/day on the owner's box,
    // where it BURIED everything else: diagnosing a live turn meant discovering
    // the flood first and filtering it out, and the turn's own activity was
    // invisible until then. A log that hides the signal it sits next to has a
    // negative information value, however cheap each line is.
    //
    // Both S15 properties are preserved, deliberately:
    //   * a tick with WORK still logs every time, so whatever the >0 count is
    //     worth to an operator is untouched by this change — which is less than
    //     S15 assumed, and was already less before this change.
    //     "> 0 for > 15 min" stopped being an alarm on 2026-06-18, when the
    //     import timeout became progress-aware: the deadline RESETS on forward
    //     progress, so a legitimately-progressing import sits at count > 0 for
    //     well past 15 min by design. `evaluateImportTimeout` in
    //     engine-internals.ts is the rule — read it there rather than trusting
    //     a set of windows copied out into a comment. Either way this line
    //     reports only the COUNT, never progress, so it cannot tell a
    //     slow-healthy import from a stuck one. Read >0 as "work is in
    //     flight", not as a timer. And
    //   * an IDLE tick still logs, just at most once per
    //     {@link IDLE_TICK_LOG_INTERVAL_MS}, so "the line stopped appearing"
    //     remains a real signal — it is a slower heartbeat, not a silent one.
    //     ("At most once" is the forward-clock bound; `rateLimited`'s contract
    //     in logger/index.ts states where that bound does not hold, and it is
    //     the place to read for it rather than this comment. Do not read the
    //     bound as a guarantee that a line was DELIVERED — it bounds attempts,
    //     which is the half that matters to a heartbeat.)
    // Silencing idle ticks ENTIRELY would have removed the liveness proof this
    // line exists for, which is the trap: the cheap fix and the correct fix
    // differ, and only the correct one keeps the original guarantee.
    //
    // The throttle is the logger's own `rateLimited` window, not a hand-rolled
    // one, so there is no check-then-forget-to-mark seam for this call site to
    // get wrong. The two clauses above are the parts of its contract that bear
    // on THIS line; the contract itself lives on `rateLimited` in
    // logger/index.ts. Its clock is this handler's `now`, so the window is
    // deterministic under test. The key carries `ctx.owner_slug` so the window is
    // scoped to the same thing the line reports (`project=`) — today's wiring
    // hands one slug per registration (build-core-modules.ts passes
    // `input.project_slug`), so that is one window in practice; the key is
    // scoping, not a claim that anything sweeps more than one. It is in-memory on
    // purpose: a restart SHOULD log immediately, since "did it come back up?" is
    // exactly the question a heartbeat answers.
    const idle = rows.length === 0
    const tickEmitter = idle
      ? tickLog.rateLimited(`idle_tick:${ctx.owner_slug}`, IDLE_TICK_LOG_INTERVAL_MS)
      : tickLog
    tickEmitter.info('tick', {
      project: ctx.owner_slug,
      in_flight_imports: rows.length,
    })

    if (idle) {
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
