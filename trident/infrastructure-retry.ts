import type { InnerResult } from './inner-loop.ts'
import type { AdvanceOutcome } from './state-machine.ts'
import type { TridentRun } from './store.ts'

/**
 * Infrastructure retry spacing: one minute, five minutes, then fifteen minutes
 * (long enough at the tail to outlast a token refresh). The retry count is
 * DERIVED from this schedule so count and duration can never disagree — the
 * lesson pinned by PR #279's readiness budget.
 */
export const INFRA_RETRY_BACKOFF_MS = [60_000, 300_000, 900_000] as const
export const DEFAULT_MAX_INFRA_RETRIES = INFRA_RETRY_BACKOFF_MS.length

/** A harvested no-APPROVE result is either safe to retry or a genuine outcome. */
export type InnerFailureClass = 'infrastructure' | 'genuine'

/** Closed executor/transport vocabulary. WORDS only: never match bare status
 * numbers because an unrelated 40-hex commit id can contain them. */
export const INFRA_CAUSE_WORDS: readonly string[] = [
  'deferred',
  'timed out',
  'timeout',
  'econnreset',
  'econnrefused',
  'fetch failed',
  'socket hang up',
  'bad gateway',
  'service unavailable',
  'internal server error',
  'gateway timeout',
  'overloaded',
]

/**
 * Classify only from measured terminal fields, fail-closed to `genuine`.
 * `infra-only` explicitly means the code was never judged. Legacy `inner-error`
 * is retryable only when its measured cause contains the closed transport list.
 * Real review verdicts (`code`/`review`/`round-lost`), findings-carrying
 * REQUEST_CHANGES, compile/test failures, provenance rejects, garbled/hang reaps,
 * and publish failures remain genuine/owned elsewhere.
 *
 * Launcher crashes are the third named infrastructure class in this card's
 * acceptance, but §1a-crash already serves them through `crash_recoveries`.
 * This classifier deliberately never sees `subagent_status='crashed'`.
 */
export function classifyInnerFailure(
  result: Pick<InnerResult, 'verdict' | 'block_kind' | 'terminal_cause' | 'checkpoint'>,
): InnerFailureClass {
  if (result.verdict === 'APPROVE') return 'genuine'
  const cause = result.terminal_cause
  if (result.block_kind === 'infra-only' && typeof cause === 'string' && cause.trim() !== '') {
    return 'infrastructure'
  }
  if (
    result.checkpoint === 'inner-error' &&
    result.block_kind === null &&
    typeof cause === 'string' &&
    cause.trim() !== ''
  ) {
    const measured = cause.toLowerCase()
    if (INFRA_CAUSE_WORDS.some((word) => measured.includes(word))) return 'infrastructure'
  }
  return 'genuine'
}

export async function tryInfrastructureRetry({
  run,
  result,
  beginInfraRetry,
  maxInfraRetries,
  onInfraRetry,
  now,
  nowMs,
  failedRun,
  infraRetryNotBefore,
  warn,
}: {
  run: TridentRun
  result: InnerResult
  beginInfraRetry: ((runId: string) => Promise<TridentRun | null>) | undefined
  maxInfraRetries: number
  onInfraRetry: ((run: TridentRun, attempt: number, cause: string) => Promise<void>) | undefined
  now: () => string
  nowMs: () => number
  failedRun: (run: TridentRun, reason: string, keepSubagentId: boolean) => TridentRun
  infraRetryNotBefore: Map<string, number>
  warn: (event: string, fields: { run: string; error: string }) => void
}): Promise<AdvanceOutcome | null> {
  // RUN-LEVEL INFRASTRUCTURE AUTO-RETRY. This sits before the harvest stamp:
  // nothing was harvested into a terminal decision when the atomic claim wins.
  // With the seam unwired, legacy callers take the exact existing path below.
  if (beginInfraRetry !== undefined && classifyInnerFailure(result) === 'infrastructure') {
    if (run.infra_retries >= maxInfraRetries) {
      const terminalRun = { ...run, harvested_at: nowMs() }
      const failed: TridentRun = {
        ...failedRun(
          terminalRun,
          `infrastructure failure persisted after ${maxInfraRetries} automatic retries ` +
            `(budget ${maxInfraRetries}) — not retrying again. Last measured cause: ${result.terminal_cause}`,
          true,
        ),
        pr: result.pr_number ?? run.pr,
        branch: result.branch ?? run.branch,
        inner_checkpoint: result.checkpoint ?? run.inner_checkpoint ?? null,
        // T4 (main) said an exhausted INFRA budget is not a review verdict and recorded
        // `null`. This branch says the same thing with a NAME instead of an absence:
        // reaching here means the infra budget ran out, so review provably never ran.
        // `null` is indistinguishable from "not yet set"; REVIEW_NOT_RUN is not.
        inner_verdict: 'REVIEW_NOT_RUN',
      }
      return { run: failed, changed: true, waiting: false, note: 'infrastructure retry budget used → failed' }
    }

    const claimed = await beginInfraRetry(run.id)
    if (claimed === null) {
      return { run, changed: false, waiting: true, note: 'infra-retry claim lost — re-read next tick' }
    }
    const backoffMs =
      INFRA_RETRY_BACKOFF_MS[claimed.infra_retries - 1] ?? INFRA_RETRY_BACKOFF_MS.at(-1)!
    infraRetryNotBefore.set(run.id, Date.parse(now()) + backoffMs)
    if (claimed.infra_retries === 1 && onInfraRetry !== undefined) {
      try {
        await onInfraRetry(claimed, 1, result.terminal_cause ?? '')
      } catch (err) {
        warn('infra_retry_observer_failed', {
          run: claimed.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return {
      run: claimed,
      changed: true,
      waiting: true,
      note: `infra failure → auto-retry attempt ${claimed.infra_retries} of ${maxInfraRetries} scheduled`,
    }
  }

  return null
}
