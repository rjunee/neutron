/**
 * @neutronai/onboarding/wow-moment — action-runner.
 *
 * Per docs/plans/P2-onboarding.md § 2.5 + § 4. Wraps each action call:
 *   - records `onboarding.wow_action_fired` on attempt
 *   - enforces the per-action failure-mode policy (one retry with
 *     30s backoff for substrate-error actions; persistence retry via
 *     `persistence/retry.ts` is already covered for SQLite writes)
 *   - records `onboarding.wow_action_engaged` on user tap callback
 *   - never throws — every error path lands as `success:false` +
 *     reason in the telemetry row so the dispatcher keeps walking
 */

import type { WowActionContext, WowActionModule, WowActionResult } from './action-types.ts'
import type { WowTelemetry } from './telemetry.ts'

export interface RunActionInput {
  module: WowActionModule
  ctx: WowActionContext
  /**
   * P2 v2 § 5.4 — optional picker explanation. When present, the runner
   * threads it through to the fired-event's redacted_payload so M2
   * reporting can attribute each fired action to the picker's reasoning.
   */
  explanation?: string
}

export interface RunActionOutput {
  fired: boolean
  reason: string
  redacted_payload?: Record<string, unknown>
  followup_prompt_id?: string
  /** Original action result (for the dispatcher's accounting). */
  result: WowActionResult
}

export interface ActionRunnerDeps {
  telemetry: WowTelemetry
  /** Substrate-error retries for action 1 (one extra try with 30s backoff). */
  retryDelay_ms?: number
  /** Sleep override for test determinism. Production = `Bun.sleep`. */
  sleep?: (ms: number) => Promise<void>
  /**
   * 2026-06-10 (wow-hang-resilience, prod incident t-33333333) —
   * per-action hard timeout. An action whose `run(...)` neither
   * resolves nor rejects (a hung CC-spawn, a network call with no
   * deadline) used to wedge the entire wow dispatch forever: the
   * dispatcher awaited `runner.run(...)`, the engine awaited the
   * dispatcher, and the user stared at an infinite "Setting up your
   * first week…" spinner with no fallback (the retry/skip path only
   * fires on a THROW, never on a hang). This timeout converts hang →
   * handled: the runner returns `{ fired: false, reason: 'timeout' }`
   * and the dispatcher records the action in `failed[]`. Default 60s —
   * generous for any legitimate single action (the slowest is a cold
   * CC-spawn at ~4.6s-to-first-token).
   */
  action_timeout_ms?: number
}

const DEFAULT_RETRY_DELAY_MS = 30_000
export const DEFAULT_ACTION_TIMEOUT_MS = 60_000

/** Internal sentinel so the timeout path is distinguishable from a thrown error. */
class ActionTimeoutError extends Error {
  constructor(action_id: string, timeout_ms: number) {
    super(`wow action ${action_id} timed out after ${timeout_ms}ms (run() never settled)`)
    this.name = 'ActionTimeoutError'
  }
}

/**
 * The retry policy is conservative: ONLY action 1 (`01-first-week-brief`)
 * + action 2 (`02-lifestyle-reminders`) gets one extra attempt on
 * substrate / persistence error per § 2.5 spec. Other actions either
 * have no external dependency (4) or use built-in retry primitives
 * (`persistence/retry.ts` for 2 + 3 + 6, cron-store retry for 7).
 *
 * The runner detects retry-eligibility by the action's id; the actions
 * themselves declare their failure-mode in their own module.
 */
const RETRY_ELIGIBLE = new Set([
  '01-first-week-brief',
  '02-lifestyle-reminders',
])

export class ActionRunner {
  private readonly telemetry: WowTelemetry
  private readonly retryDelay_ms: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly actionTimeoutMs: number

  constructor(deps: ActionRunnerDeps) {
    this.telemetry = deps.telemetry
    this.retryDelay_ms = deps.retryDelay_ms ?? DEFAULT_RETRY_DELAY_MS
    this.sleep = deps.sleep ?? ((ms: number): Promise<void> => Bun.sleep(ms))
    this.actionTimeoutMs = deps.action_timeout_ms ?? DEFAULT_ACTION_TIMEOUT_MS
  }

  /**
   * Invoke a single action. Records telemetry in every code path. NEVER
   * throws — every error is converted to a `success:false` row.
   */
  async run(input: RunActionInput): Promise<RunActionOutput> {
    const { module, ctx, explanation } = input
    const action_id = module.action_id

    // 1. Trigger check. False → skip silently with telemetry tag.
    let triggered = false
    try {
      triggered = module.triggerCondition(ctx)
    } catch (err) {
      const fired_at = ctx.now()
      const triggerThrewPayload = withExplanation({ error: errorMessage(err) }, explanation)
      await this.telemetry.recordFired({
        project_slug: ctx.project_slug,
        action_id,
        fired_at,
        success: false,
        success_reason: 'trigger_threw',
        ...(triggerThrewPayload !== undefined ? { redacted_payload: triggerThrewPayload } : {}),
      })
      return {
        fired: false,
        reason: 'trigger_threw',
        result: { fired: false, reason: 'trigger_threw' },
      }
    }
    if (!triggered) {
      const fired_at = ctx.now()
      await this.telemetry.recordFired({
        project_slug: ctx.project_slug,
        action_id,
        fired_at,
        success: false,
        success_reason: 'no_trigger',
        ...(explanation !== undefined
          ? { redacted_payload: { explanation } }
          : {}),
      })
      return {
        fired: false,
        reason: 'no_trigger',
        result: { fired: false, reason: 'no_trigger' },
      }
    }

    // 2. Run, with optional retry for retry-eligible actions.
    const result = await this.runWithOptionalRetry(module, ctx)

    // 3. Persist telemetry from result. Thread the picker explanation
    //    through the redacted payload so M2 reporting can attribute the
    //    fire decision per § 5.4 / § 10.1.
    const fired_at = ctx.now()
    const payload = withExplanation(result.redacted_payload, explanation)
    await this.telemetry.recordFired({
      project_slug: ctx.project_slug,
      action_id,
      fired_at,
      success: result.fired,
      success_reason: result.reason,
      ...(payload !== undefined ? { redacted_payload: payload } : {}),
    })
    const out: RunActionOutput = {
      fired: result.fired,
      reason: result.reason,
      result,
    }
    if (result.redacted_payload !== undefined) {
      out.redacted_payload = result.redacted_payload
    }
    if (result.follow_up_prompt_id !== undefined) {
      out.followup_prompt_id = result.follow_up_prompt_id
    }
    return out
  }

  private async runWithOptionalRetry(
    module: WowActionModule,
    ctx: WowActionContext,
  ): Promise<WowActionResult> {
    const maxAttempts = RETRY_ELIGIBLE.has(module.action_id) ? 2 : 1
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.runWithTimeout(module, ctx)
      } catch (err) {
        // 2026-06-10 hang-resilience: a TIMEOUT does not retry. A hung
        // action (vs a thrown one) is overwhelmingly a wedged external
        // dependency — re-running it just doubles the user's wait while
        // the first invocation is still wedged in the background. Fail
        // fast so the dispatcher records it and the engine completes.
        if (err instanceof ActionTimeoutError) {
          return {
            fired: false,
            reason: 'timeout',
            redacted_payload: {
              error: err.message,
              timeout_ms: this.actionTimeoutMs,
              attempts: attempt,
            },
          }
        }
        lastErr = err
        if (attempt < maxAttempts) {
          await this.sleep(this.retryDelay_ms)
          continue
        }
        return {
          fired: false,
          reason: 'substrate_error',
          redacted_payload: { error: errorMessage(err), attempts: attempt },
        }
      }
    }
    // Unreachable — the loop returns or falls through to the outer
    // catch — but keep TS happy.
    return {
      fired: false,
      reason: 'substrate_error',
      redacted_payload: { error: errorMessage(lastErr), attempts: maxAttempts },
    }
  }

  /**
   * Race `module.run(ctx)` against the per-action timeout. On timeout,
   * throws `ActionTimeoutError` (converted to a `reason: 'timeout'`
   * failure by the caller — never retried). The hung underlying promise
   * is unavoidably left pending (the action contract has no cancel
   * surface); its eventual settlement is ignored. The timer is cleared
   * on the win path so a fast action doesn't leave a live timer keeping
   * the event loop awake.
   */
  private async runWithTimeout(
    module: WowActionModule,
    ctx: WowActionContext,
  ): Promise<WowActionResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ActionTimeoutError(module.action_id, this.actionTimeoutMs)),
        this.actionTimeoutMs,
      )
    })
    try {
      return await Promise.race([module.run(ctx), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

function errorMessage(err: unknown): string {
  if (err === null || err === undefined) return 'unknown'
  if (err instanceof Error) return err.message
  return String(err)
}

function withExplanation(
  payload: Record<string, unknown> | undefined,
  explanation: string | undefined,
): Record<string, unknown> | undefined {
  if (explanation === undefined) return payload
  if (payload === undefined) return { explanation }
  return { ...payload, explanation }
}
