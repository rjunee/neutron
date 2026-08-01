/**
 * @neutronai/contracts — the ACTIVE CREDENTIAL's usage standing.
 *
 * ONE credential, two ceilings. Anthropic meters a Claude subscription against
 * a rolling 5-hour SESSION window and a rolling 7-day WEEKLY window, and
 * reports both as a 0..1 fraction on every authenticated API response
 * (`anthropic-ratelimit-unified-5h-utilization` /
 * `anthropic-ratelimit-unified-7d-utilization`). Those two numbers are the
 * whole model — there is nothing to compute, only to read and surface.
 *
 * SCOPE — deliberately singular. This describes the credential the instance is
 * DISPATCHING WITH RIGHT NOW, and nothing else. A deployment that holds several
 * credentials and swaps between them still reports exactly one reading here:
 * the one currently installed. There is no pooling, no averaging, and no
 * multi-account shape in this contract, because "how close am I to being cut
 * off" is a question about the credential answering the next turn.
 *
 * UNKNOWN IS A FIRST-CLASS STATE. A fresh install has no credential; a just-booted
 * gateway has not measured one yet; a BYO API key is billed per-token and has no
 * subscription window at all. Each of those is `available: false` with a reason —
 * never a fabricated `0`. Surfaces MUST render the unavailable state as the
 * absence of a meter, because a zero-length bar reads as "0% used", which is a
 * different and much more reassuring claim than "unknown".
 *
 * Shared by the gateway surface that serves it and by both clients that draw it,
 * so the thresholds and the band vocabulary cannot drift between them.
 */

/** Why there is no reading. Every one of these renders as "no meter at all". */
export type UsageUnavailableReason =
  /** No credential is configured yet (fresh install, pre-onboarding). */
  | 'no_credential'
  /** A credential exists but has not been measured yet (gateway just booted). */
  | 'not_measured_yet'
  /**
   * The active credential carries no subscription windows — a BYO Anthropic API
   * key is metered by spend, not by a 5h/7d ceiling, so there is no bar to draw.
   */
  | 'unsupported_credential'
  /** The last measurement failed (network, upstream 5xx, missing headers). */
  | 'probe_failed'

/** A measured reading of the active credential's two windows. */
export interface CredentialUsageReading {
  /** Fraction (0..1) of the rolling 5-hour session window consumed. */
  session: number
  /** Fraction (0..1) of the rolling 7-day window consumed. */
  weekly: number
  /** Epoch MS the 5-hour window resets, when upstream reported it. */
  session_reset_at?: number
  /** Epoch MS the 7-day window resets, when upstream reported it. */
  weekly_reset_at?: number
}

/** The wire shape of `GET /api/app/usage`. */
export type CredentialUsagePayload =
  | ({
      available: true
      /** Epoch MS the reading was taken — lets a client age out a stale bar. */
      measured_at: number
    } & CredentialUsageReading)
  | { available: false; reason: UsageUnavailableReason }

/**
 * The colour band of the WHOLE bar. Not a gradient and not a coloured tip: the
 * entire filled length is one colour, and it changes as a unit when the fraction
 * crosses a threshold. That is what makes the bar readable at 2px — a 2px-tall
 * gradient is indistinguishable from a 2px-tall smudge.
 */
export type UsageBand = 'nominal' | 'warning' | 'critical'

/** At/above this fraction the bar turns from green to yellow. */
export const USAGE_WARNING_AT = 0.85

/** At/above this fraction the bar turns from yellow to red. */
export const USAGE_CRITICAL_AT = 0.95

/**
 * Band for a 0..1 fraction. Boundaries are INCLUSIVE at the lower edge — exactly
 * 0.85 is already warning, exactly 0.95 is already critical — so a reading that
 * lands precisely on a threshold errs toward the more urgent colour.
 */
export function usageBand(fraction: number): UsageBand {
  if (fraction >= USAGE_CRITICAL_AT) return 'critical'
  if (fraction >= USAGE_WARNING_AT) return 'warning'
  return 'nominal'
}

/**
 * Clamp a raw fraction into the 0..1 the bar can actually draw. Upstream reports
 * values slightly over 1.0 once a window is blown through; a >100% bar would
 * otherwise overflow its track.
 */
export function clampFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0
  if (fraction < 0) return 0
  if (fraction > 1) return 1
  return fraction
}
