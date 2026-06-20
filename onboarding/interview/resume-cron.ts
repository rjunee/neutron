/**
 * @neutronai/onboarding — resume-on-reconnect cron (Trident 6, P2 § 2.8).
 *
 * Per docs/plans/P2-onboarding.md § 2.8 (resume-on-reconnect) + § 7
 * playbook P1 (state-machine drift). The audit at
 * `docs/research/p2-spec-conformance-audit-2026-05-13.md` row 12 / § P1-1
 * flagged the cron wiring as unverified — the inline-on-`advance(...)`
 * path was already wired (the user typing a new inbound triggers the
 * welcome-back prompt), but owners who abandon their chat WITHOUT
 * sending a new inbound never receive the proactive prompt.
 *
 * This module adds the proactive sweep: a per-instance cron tick that
 * scans `onboarding_state` for rows past the resume window (24h) AND
 * not currently holding an active resume prompt, then drives the
 * engine's existing `advance(...)` to emit the welcome-back prompt
 * exactly as if the user had typed something. The engine's idempotency
 * guards (`resume_active_prompt_id` persisted before the channel send)
 * ensure re-runs do NOT spam the user.
 *
 * Wiring shape mirrors `registerSeanEllisCron` (Sprint 6):
 *   - `name`: `onboarding-resume-<project_slug>`
 *   - `handler`: `'onboarding.resume_reconnect'`
 *   - `schedule`: `{ kind: 'interval_ms', interval_ms: 5min }`
 *
 * The 5-minute default cadence is consistent with § 7 playbook P1's
 * "watchdog signal at last_advanced_at > 5 min in the past" framing —
 * resume-on-reconnect at 24h is the user-visible artifact; the cron
 * checks every 5 min so an instance that slipped past the 24h boundary
 * sees the welcome-back prompt within ≤ 5 min of crossing it.
 *
 * The handler reads `topic_id`, `user_id`, and `signup_via` from the
 * stored `phase_state_json` so no external resolveContext callback is
 * needed (the engine itself writes these at `start(...)` time per
 * § 2.8 + § 2.9). Instances whose phase_state is missing any of those
 * fields are skipped without crashing the tick.
 */

import type { CronHandler, CronHandlerRegistry } from '../../cron/handlers.ts'
import type { CronJobDef, CronJobRegistry } from '../../cron/jobs.ts'
import type { ProjectDb } from '../../persistence/index.ts'
import {
  DEFAULT_RESUME_GAP_MS,
  type InterviewEngine,
} from './engine.ts'
import type { OnboardingPhase } from './phase.ts'

/** Default sweep cadence — 5 min, per § 7 playbook P1 watchdog framing. */
export const DEFAULT_RESUME_SWEEP_INTERVAL_MS = 5 * 60 * 1_000

/** Handler-registry name. */
export const ONBOARDING_RESUME_HANDLER_NAME = 'onboarding.resume_reconnect'

/**
 * Row shape returned by the SQL scan. ISSUES #2 (2026-05-19) — the scan
 * now projects user_id from the SQL column (not from phase_state.user_id)
 * so the cron's row scan and the engine.advance dispatch both anchor on
 * the composite (project_slug, user_id) PK. The handler still reads
 * `topic_id` + `signup_via` from `phase_state_json`.
 */
interface StaleOnboardingRow {
  project_slug: string
  user_id: string
  phase: string
  phase_state_json: string
}

export interface OnboardingResumeHandlerDeps {
  /** The per-instance InterviewEngine. */
  engine: InterviewEngine
  /** Per-project DB handle — the same one the engine + state-store own. */
  db: ProjectDb
  /**
   * Resume window — defaults to `DEFAULT_RESUME_GAP_MS` (24h). The
   * cron's threshold must match the engine's so the engine's Path B
   * (stale + no active prompt → emit) fires on the very same row the
   * cron just selected. Override only in tests.
   */
  resume_gap_ms?: number
  /**
   * Codex r1 P1 (2026-05-13) — deliverability precheck. Engine's
   * `emitResumePrompt` persists `resume_active_prompt_id` BEFORE the
   * channel send AND treats a `was_new:false` send (no live WS for the
   * topic_id, no telegram sender wired) as "delivered enough", which
   * leaves the cron-handled row filtered OUT of future scans even
   * though the user never saw anything.
   *
   * When supplied, the cron handler calls `canDeliver({topic_id,
   * signup_via})` FIRST and skips the row without invoking the engine
   * when delivery is impossible. Skipped rows DO NOT persist
   * `resume_active_prompt_id`, so the next tick re-tries once
   * deliverability is restored (e.g. the user reconnects on web).
   *
   * Production wiring supplies a closure that:
   *   - returns false for `signup_via='telegram'` until the
   *     Telegram→engine path is wired (M3),
   *   - returns true for `signup_via='web'` only when the shared
   *     `WebChatSenderRegistry` has an active sender for the topic_id
   *     (precheck via `webRegistry.has(topic_id)` — see
   *     `gateway/http/chat-bridge.ts`).
   *
   * Optional for back-compat: when omitted, the handler emits for
   * every eligible row (legacy / test path).
   */
  canDeliver?: (input: { topic_id: string; signup_via: 'telegram' | 'web' }) => boolean
  /** Test seam. */
  now?: () => number
}

/**
 * Build the resume-on-reconnect cron handler for an instance. The returned
 * function is ready to register against `CronHandlerRegistry` under
 * `ONBOARDING_RESUME_HANDLER_NAME`.
 *
 * Behavior:
 *   1. Scan `onboarding_state` for THIS instance's row, filtering to
 *      non-terminal phases AND `last_advanced_at < now - resume_gap_ms`
 *      AND no `resume_active_prompt_id` in the phase_state JSON
 *      (idempotency guard).
 *   2. For the row (per-project DB; at most one per project_slug PK),
 *      parse `topic_id`, `user_id`, and `signup_via` from `phase_state`.
 *      Skip without erroring if any required field is missing.
 *   3. Call `engine.advance(...)` with no choice / no freeform — this
 *      hits the engine's "Path B: stale + no active resume → emit"
 *      branch exactly as if the user had typed something. The engine
 *      persists `resume_active_prompt_id` BEFORE the channel send so a
 *      concurrent inbound resolves cleanly.
 *   4. Send failures are caught + logged; the cron returns `'skipped'`
 *      rather than `'error'` so an offline channel (e.g. closed web WS)
 *      does NOT mark the cron in an error state. The next tick re-tries
 *      automatically.
 */
export function buildOnboardingResumeHandler(
  deps: OnboardingResumeHandlerDeps,
): CronHandler {
  const now = deps.now ?? ((): number => Date.now())
  const resume_gap_ms = deps.resume_gap_ms ?? DEFAULT_RESUME_GAP_MS

  return async (ctx) => {
    const fired_at = now()
    const threshold = fired_at - resume_gap_ms

    // The COALESCE protects against null/missing keys; sqlite's
    // `json_extract` returns NULL when the key is absent.
    //
    // Design choice — `active_prompt_id = ''` filter (Codex r2 P2 vs r3):
    //
    // The first cut omitted this predicate; the second cut added it.
    // Codex r3 then critiqued the predicate as too broad. We keep it
    // for the following reasons:
    //
    //   (a) Telegram instances are skipped anyway via `canDeliver`
    //       (no engine→Telegram path before M3). Adding/removing the
    //       active_prompt_id predicate has no effect on this
    //       population.
    //
    //   (b) Web instances with a closed WS are skipped via
    //       `canDeliver` (`webRegistry.has(topic_id) === false`).
    //       Same as above.
    //
    //   (c) Web instances with a live WS where the prior phase prompt
    //       is still onscreen (live-WS-idle OR just-reconnected after
    //       `chat-bridge.startSession`-triggered re-emit) ARE the
    //       only population we could meaningfully reach. For those:
    //
    //         - The user has an interactive keyboard on screen they
    //           can already answer.
    //         - Stacking a welcome-back prompt on top creates two
    //           competing keyboards for the same phase — confusing
    //           UX, opposite of what § 2.8 wants.
    //         - The inline-on-`advance` path (Sprint S2) still fires
    //           the welcome-back when the user types a freeform
    //           inbound that doesn't match the active prompt.
    //
    // Net: the cron emits welcome-back only when (i) the row is
    // stale, (ii) no resume prompt is already active, AND (iii) no
    // ordinary phase prompt is awaiting an answer. This is the
    // intended "fresh nudge" surface; the other resume paths
    // (engine.advance Path C, engine.start re-emit) handle the rest.
    //
    // Trade-off accepted: if the engine ever leaves a row in
    // (stale, active_prompt_id set, but user-not-watching), we miss
    // the proactive nudge — but the inline path covers the next
    // inbound and reconnect path covers the next session-open. The
    // alternative (drop the predicate) regresses live-WS-idle and
    // just-reconnected users into a double-keyboard.
    const rows = deps.db
      .prepare<StaleOnboardingRow, [string, number]>(
        `SELECT project_slug, user_id, phase, phase_state_json
           FROM onboarding_state
          WHERE project_slug = ?
            AND phase NOT IN ('completed', 'failed')
            AND last_advanced_at < ?
            AND COALESCE(
                  json_extract(phase_state_json, '$.resume_active_prompt_id'),
                  ''
                ) = ''
            AND COALESCE(
                  json_extract(phase_state_json, '$.active_prompt_id'),
                  ''
                ) = ''`,
      )
      .all(ctx.project_slug, threshold)

    if (rows.length === 0) {
      return { status: 'skipped', detail: 'no_stale_rows' }
    }

    let emitted = 0
    let skipped_missing_context = 0
    let skipped_send_failed = 0
    let skipped_undeliverable = 0
    for (const row of rows) {
      const parsed = parsePhaseState(row.phase_state_json)
      if (parsed === null) {
        skipped_missing_context += 1
        continue
      }
      const { topic_id, signup_via } = parsed
      // ISSUES #2 (2026-05-19) — source user_id from the SQL column on
      // the scan row, not from phase_state.user_id. Reading from the
      // column matches the new (project_slug, user_id) PK; the
      // phase_state copy is a one-release compat shim per brief § 4.6.
      const user_id = row.user_id
      // Codex r1 P1 — deliverability precheck. Skip rows whose channel
      // is currently unreachable (telegram instances on the engine-less
      // M2 path, web instances with closed WS). This is critical because
      // emitResumePrompt persists `resume_active_prompt_id` BEFORE the
      // channel send, so a "no, was_new=false" emit would still
      // permanently filter the row out of future scans.
      if (deps.canDeliver !== undefined && !deps.canDeliver({ topic_id, signup_via })) {
        skipped_undeliverable += 1
        continue
      }
      const channel_kind = signup_via === 'telegram' ? 'telegram' : 'app-socket'
      try {
        const result = await deps.engine.advance({
          project_slug: row.project_slug,
          topic_id,
          user_id,
          channel_kind,
          observed_at: fired_at,
        })
        if (result.outcome === 'resume_prompt_emitted') {
          emitted += 1
        } else {
          // The row passed the SQL filter but the engine didn't take
          // Path B — typically a race where the user beat the cron to
          // an inbound. Counts as a clean skip; the engine's own state
          // already advanced.
          skipped_missing_context += 1
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(
          `[onboarding-resume-cron] project=${row.project_slug} send-failed: ${message}`,
        )
        skipped_send_failed += 1
        // Codex r2 P2 (2026-05-13) — `emitResumePrompt` persists
        // `resume_active_prompt_id` BEFORE the channel send. When the
        // send throws, that marker stays in the row and the cron's
        // WHERE clause permanently filters it out of future scans.
        // Roll back the marker so the next tick can retry. Best
        // effort: a double-fault on the rollback must not crash the
        // whole tick.
        try {
          await deps.db.run(
            `UPDATE onboarding_state
                SET phase_state_json =
                      json_remove(phase_state_json, '$.resume_active_prompt_id')
              WHERE project_slug = ?
                AND COALESCE(
                      json_extract(phase_state_json, '$.resume_active_prompt_id'),
                      ''
                    ) <> ''`,
            [row.project_slug],
          )
        } catch (rollback_err) {
          const rmsg =
            rollback_err instanceof Error ? rollback_err.message : String(rollback_err)
          console.warn(
            `[onboarding-resume-cron] project=${row.project_slug} rollback-failed: ${rmsg}`,
          )
        }
      }
    }

    if (emitted === 0) {
      return {
        status: 'skipped',
        detail: `no_emits scanned=${rows.length} missing_context=${skipped_missing_context} undeliverable=${skipped_undeliverable} send_failed=${skipped_send_failed}`,
      }
    }
    return {
      status: 'ok',
      detail: `emitted_${emitted}_at_${now()}`,
    }
  }
}

interface ParsedContext {
  topic_id: string
  signup_via: 'telegram' | 'web'
}

function parsePhaseState(json: string): ParsedContext | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const obj = parsed as Record<string, unknown>
  const topic_id = obj['topic_id']
  const signup_via = obj['signup_via']
  if (typeof topic_id !== 'string' || topic_id.length === 0) return null
  if (signup_via !== 'telegram' && signup_via !== 'web') return null
  return { topic_id, signup_via }
}

/**
 * Per-instance cron job definition. Production wires this into the per-
 * instance `CronJobRegistry` alongside the rest of the onboarding crons
 * (Sean Ellis 4-week, future stuck-phase watchdog).
 *
 * Job-name budget is 64 chars per `validateJobName` (`/^[a-z][a-z0-9-]{0,63}$/`).
 * The `onboarding-resume-` prefix is 18 chars; instance slugs are validated
 * by `provisioning/allocate-slug.ts:SLUG_RE = /^[a-z][a-z0-9-]{2,30}$/`
 * (3-31 chars). Worst-case name length: 18 + 31 = 49 chars, well under
 * the 64-char ceiling.
 */
export function buildOnboardingResumeJob(input: {
  project_slug: string
  interval_ms?: number
}): CronJobDef {
  return {
    name: `onboarding-resume-${input.project_slug}`,
    description: `Onboarding resume-on-reconnect (24h gap) cron for ${input.project_slug}`,
    schedule: {
      kind: 'interval_ms',
      interval_ms: input.interval_ms ?? DEFAULT_RESUME_SWEEP_INTERVAL_MS,
    },
    handler: ONBOARDING_RESUME_HANDLER_NAME,
    skip_if_running: true,
    expected_duration_ms: 10_000,
  }
}

/**
 * Register the resume-on-reconnect cron + handler against the per-instance
 * `CronJobRegistry` + `CronHandlerRegistry`. The per-instance gateway boot
 * calls this after the InterviewEngine + cron module are both
 * constructed; the cron starts ticking on the next `CronScheduler.start()`
 * pass.
 *
 * Idempotent against re-register attempts at the handler level (the
 * handler-name short-circuit prevents `'cron handler already registered'`
 * when the same handler-name is wired more than once across the same
 * registries instance). The job-name path uses the registries' native
 * validation since each instance has exactly one resume-cron entry.
 */
export function registerOnboardingResumeCron(input: {
  project_slug: string
  jobs: CronJobRegistry
  handlers: CronHandlerRegistry
  handler: CronHandler
  interval_ms?: number
}): { job_name: string } {
  const job =
    input.interval_ms !== undefined
      ? buildOnboardingResumeJob({
          project_slug: input.project_slug,
          interval_ms: input.interval_ms,
        })
      : buildOnboardingResumeJob({ project_slug: input.project_slug })
  input.jobs.register(job)
  if (input.handlers.get(ONBOARDING_RESUME_HANDLER_NAME) === undefined) {
    input.handlers.register(ONBOARDING_RESUME_HANDLER_NAME, input.handler)
  }
  return { job_name: job.name }
}

/**
 * Re-export the phase-string type for handler consumers that want to
 * narrow the SQL projection's `phase` column.
 */
export type { OnboardingPhase }
