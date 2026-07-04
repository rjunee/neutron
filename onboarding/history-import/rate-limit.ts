/**
 * @neutronai/onboarding/history-import — 429 / rate-limit detection + the
 * default retry backoff schedule.
 *
 * (K3, 2026-07-03) — extracted from the deleted per-chunk pipeline. The two
 * previously-duplicated matchers (`job-runner.is429RetryableError` and
 * `substrate-callers.is429ErrorMessage`, which the source comments noted were
 * "the same regexes ... kept in sync") are CONSOLIDATED here, byte-identical
 * regexes preserved. Live consumers after the evacuation:
 *   - the onboarding public barrel (`onboarding/index.ts`) re-exports the
 *     backoff constants + `is429RetryableError`;
 *   - the Phase-0 credential-classifier conformance guardrail
 *     (`gateway/realmode-composer/__tests__/g6-error-string-conformance.test.ts`)
 *     pins `is429ErrorMessage`.
 * Golden-tested in `__tests__/rate-limit.test.ts`.
 */

/**
 * v0.1.78 (2026-05-22) — default 429 retry schedule (ms). Generated from
 * the `min(60, 5 * 2^attempt)` rule. attempt=0 is the first call (zero
 * delay); attempt=1 sleeps 5s before retry; attempt=2 sleeps 10s; ...;
 * attempt=4+ caps at 60s. Total across 30 attempts is
 * 5+10+20+40+60*26 = 1635s ≈ 27.25 min.
 *
 * Exported so the test suite can confirm the wiring matches the spec (drift
 * detector — change here, change the test there).
 */
export const RATE_LIMIT_BACKOFF_MS_DEFAULT: ReadonlyArray<number> = (() => {
  const schedule: number[] = [0]
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const seconds = Math.min(60, 5 * Math.pow(2, attempt - 1))
    schedule.push(seconds * 1000)
  }
  return schedule
})()

/**
 * v0.1.78 — convenience constant for tests + observability dashboards.
 * Sum of every entry in `RATE_LIMIT_BACKOFF_MS_DEFAULT`. Approximately
 * 1.63 million ms (~27.25 min) on the default schedule.
 */
export const RATE_LIMIT_BACKOFF_TOTAL_MS_DEFAULT =
  RATE_LIMIT_BACKOFF_MS_DEFAULT.reduce((acc, ms) => acc + ms, 0)

/**
 * Pattern-match a substrate error MESSAGE for 429 / rate-limit shapes.
 *
 * Detection (any one match counts):
 *   1. `HTTP 429` (anchored on the token boundary).
 *   2. Any `rate_limit` / `rate-limit` / `ratelimit` mention (the Anthropic
 *      Messages API `rate_limit_error` envelope surfaces this without a
 *      leading `HTTP 429`).
 */
export function is429ErrorMessage(message: string): boolean {
  if (/HTTP\s+429\b/i.test(message)) return true
  if (/rate[_-]?limit/i.test(message)) return true
  return false
}

/**
 * True when the given thrown value matches a 429 / rate-limit shape worth
 * retrying. Narrows the unknown to its message string, then applies
 * `is429ErrorMessage`. Non-429 errors (parse failures, 400/403, OAuth
 * refresh, llm_unwired) are NOT retryable.
 */
export function is429RetryableError(err: unknown): boolean {
  if (err === null || err === undefined) return false
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err)
  return is429ErrorMessage(message)
}
