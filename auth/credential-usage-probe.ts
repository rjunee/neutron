/**
 * @neutronai/auth — measure ONE credential's standing against its subscription
 * windows.
 *
 * WHY A PROBE AND NOT A TAP ON THE REAL TURNS. Anthropic reports utilization on
 * the RESPONSE HEADERS of an authenticated API call, and every owner-facing turn
 * in this codebase is dispatched by spawning the `claude` binary
 * (`runtime/adapters/claude-code/`), which owns its own HTTP client and surfaces
 * no response headers to us. There is therefore no way to observe the two
 * ceilings by watching normal traffic — the numbers have to be asked for. This
 * module asks, with the cheapest question that still gets an answer: a one-token
 * `POST /v1/messages` that we never read the body of.
 *
 * WHY THIS IS NOT A VIOLATION OF THE SUBSTRATE RULE. `tests/integration/
 * no-direct-anthropic-api.test.ts` forbids direct `api.anthropic.com` fetches in
 * owner-facing LLM call sites, because dispatching a turn over raw HTTP means
 * either omitting the Claude Code system-prompt signature or forging it. This is
 * the same class of exception that test already allow-lists for
 * `auth/max-oauth.ts`: an AUTH-TIER PROBE, not a call site. It carries no owner
 * content, no `system` field, no signature, and never a turn — it exists purely
 * to read four response headers. It lives beside `max-oauth.ts` for exactly that
 * reason.
 *
 * THE HEADERS ARE THE SOURCE OF TRUTH. Nothing here counts tokens, models
 * spend, or infers a window from timestamps. The two fractions are quoted
 * verbatim from Anthropic's own accounting:
 *
 *   anthropic-ratelimit-unified-5h-utilization: 0.03
 *   anthropic-ratelimit-unified-5h-reset:       1785464400   (epoch SECONDS)
 *   anthropic-ratelimit-unified-7d-utilization: 0.16
 *   anthropic-ratelimit-unified-7d-reset:       1785866400
 *
 * The `…-reset` values arrive in SECONDS and are normalised to epoch MS here, at
 * the boundary, so nothing downstream ever has to know two units existed.
 *
 * A 200 WITHOUT THE HEADERS IS AN ERROR, NOT A ZERO. An API-key credential is
 * billed per token and carries no subscription window, so it answers 200 with no
 * `unified-*` headers at all. Reporting that as "0% utilized" would draw an
 * empty bar and quietly assert the owner has their whole allowance left. It is
 * classified as `no-windows` and surfaces as "no meter".
 */

import { PROBE_MODEL } from '@neutronai/runtime/models.ts'
import type { CredentialUsageReading } from '@neutronai/contracts/credential-usage.ts'

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'

/** Anthropic's unified rate-limit headers — the entire input to this module. */
export const UNIFIED_5H_UTILIZATION_HEADER = 'anthropic-ratelimit-unified-5h-utilization'
export const UNIFIED_7D_UTILIZATION_HEADER = 'anthropic-ratelimit-unified-7d-utilization'
export const UNIFIED_5H_RESET_HEADER = 'anthropic-ratelimit-unified-5h-reset'
export const UNIFIED_7D_RESET_HEADER = 'anthropic-ratelimit-unified-7d-reset'

/** Bounded so a wedged upstream can never stall the tick loop that calls this. */
export const USAGE_PROBE_TIMEOUT_MS = 20_000

export type CredentialUsageProbeOutcome =
  /** The credential answered and reported both windows. */
  | { kind: 'ok'; reading: CredentialUsageReading }
  /**
   * Authenticated, but this credential has no 5h/7d windows to report (a
   * per-token API key). Distinct from `error` because it is PERMANENT for this
   * credential — retrying will never produce a reading.
   */
  | { kind: 'no-windows' }
  /** 401 / 403 — the credential is dead. Also permanent until it is replaced. */
  | { kind: 'unauthorized'; httpStatus: number }
  /**
   * Transport failure, timeout, or 5xx. TRANSIENT — deliberately distinct from
   * the two permanent outcomes so a caller can keep showing the last real
   * reading through a network blip instead of blanking the meter.
   */
  | { kind: 'error'; message: string }

export interface UsageProbeDeps {
  /** Injected so tests drive every branch without touching the network. */
  fetch?: typeof fetch
  timeoutMs?: number
  /** Override the API base — tests point this at a mock. */
  apiBaseUrl?: string
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)
  if (raw === null) return undefined
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : undefined
}

/** `…-reset` headers are epoch SECONDS; normalise to epoch MS at the boundary. */
function resetMsHeader(headers: Headers, name: string): number | undefined {
  const seconds = numberHeader(headers, name)
  return seconds === undefined ? undefined : Math.round(seconds * 1000)
}

/**
 * Pull a reading out of any authenticated Anthropic response's headers, or
 * `null` when the response carries no unified windows.
 *
 * Exported as a PURE function on purpose: it is the piece a multi-credential
 * rotator wants to share with this single-credential read. A rotator has its own
 * reasons to call the API (account identity, cooldown decisions, round-robin)
 * and its own result taxonomy, but the header vocabulary and the seconds→ms
 * normalisation must not be implemented twice — two copies of "which header
 * carries the weekly number" is exactly the drift that surfaces as a bar showing
 * one thing and a rotation firing on another.
 */
export function parseUnifiedRateLimitHeaders(headers: Headers): CredentialUsageReading | null {
  const session = numberHeader(headers, UNIFIED_5H_UTILIZATION_HEADER)
  const weekly = numberHeader(headers, UNIFIED_7D_UTILIZATION_HEADER)
  if (session === undefined || weekly === undefined) return null
  const sessionResetAt = resetMsHeader(headers, UNIFIED_5H_RESET_HEADER)
  const weeklyResetAt = resetMsHeader(headers, UNIFIED_7D_RESET_HEADER)
  return {
    session,
    weekly,
    ...(sessionResetAt !== undefined ? { session_reset_at: sessionResetAt } : {}),
    ...(weeklyResetAt !== undefined ? { weekly_reset_at: weeklyResetAt } : {}),
  }
}

/**
 * Ask one credential where it stands. NEVER throws — every failure mode is a
 * tagged outcome, because this runs inside a tick loop and a thrown probe would
 * take the loop's error budget for something as ordinary as a dropped packet.
 */
export async function probeCredentialUsage(
  token: string,
  deps: UsageProbeDeps = {},
): Promise<CredentialUsageProbeOutcome> {
  const doFetch = deps.fetch ?? fetch
  const url =
    deps.apiBaseUrl === undefined
      ? ANTHROPIC_MESSAGES_URL
      : new URL('/v1/messages', deps.apiBaseUrl).toString()
  let res: Response
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? USAGE_PROBE_TIMEOUT_MS),
    })
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }

  if (res.status === 401 || res.status === 403) {
    return { kind: 'unauthorized', httpStatus: res.status }
  }

  // A 429 still carries the unified headers — and it is precisely the moment the
  // meter matters most — so it is read exactly like a 200 rather than treated as
  // a failure. Falling through here is deliberate.
  const reading = parseUnifiedRateLimitHeaders(res.headers)
  if (reading !== null) return { kind: 'ok', reading }

  if (res.status === 429) {
    // Capped, but the headers did not say by how much. A window that has
    // rejected a request is by definition full; anything less than 1.0 here
    // would UNDER-report at the one moment accuracy matters.
    return { kind: 'ok', reading: { session: 1, weekly: 1 } }
  }
  if (res.status >= 500) {
    return { kind: 'error', message: `upstream returned ${res.status}` }
  }
  // Authenticated (or at least not rejected) but no windows reported — a
  // per-token API key. Permanent for this credential.
  return { kind: 'no-windows' }
}
