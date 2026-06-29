/**
 * @neutronai/gateway/proactive — host LOCAL timezone resolver (single source).
 *
 * Ryan: "Detect local computer time not hardcode pt." Previously the daily
 * morning brief (and any tz-derived scheduling/wording it drives) defaulted to
 * a hardcoded `America/Los_Angeles` because `open/composer.ts` never threaded a
 * timezone into the proactive task config — so a non-Pacific owner got the
 * brief at the wrong local hour. This module is the ONE place that resolves the
 * host's actual local timezone; the composer threads its result into the
 * morning-brief scheduler instead of letting it fall back to PT.
 *
 * Resolution order (first hit wins):
 *   1. `process.env.TZ` — an explicit IANA override the operator set on the box.
 *   2. `Intl.DateTimeFormat().resolvedOptions().timeZone` — the OS/runtime zone.
 *   3. `LAST_RESORT_TIMEZONE` — only if both above are unavailable/blank. This
 *      is a defensive floor, NOT a default any healthy host should hit.
 *
 * Both inputs are injectable so the resolver is unit-testable without touching
 * the real process environment or ICU.
 */

/**
 * The defensive floor used only when neither `process.env.TZ` nor the runtime's
 * resolved timezone is available. A healthy host never reaches this — every
 * Node/Bun runtime resolves a real IANA zone via Intl. Kept as a stable,
 * well-known value rather than `UTC` so a degraded box still lands on a
 * plausible owner zone.
 */
export const LAST_RESORT_TIMEZONE = 'America/Los_Angeles'

export interface ResolveLocalTimezoneDeps {
  /** Environment to read `TZ` from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /**
   * Resolver for the runtime's timezone. Defaults to reading
   * `Intl.DateTimeFormat().resolvedOptions().timeZone`. Injected in tests to
   * simulate a non-Pacific host (or a runtime that returns nothing).
   */
  intlTimeZone?: () => string | undefined
}

/** Read the runtime's resolved IANA timezone, or `undefined` if unavailable. */
function defaultIntlTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

/** A timezone string is usable only if it is a non-empty, non-blank string. */
function usable(tz: string | undefined | null): tz is string {
  return typeof tz === 'string' && tz.trim().length > 0
}

/**
 * Resolve the host's local IANA timezone. Prefers an explicit `TZ` env override,
 * then the runtime's resolved zone, then the defensive floor. Never throws.
 */
export function resolveLocalTimezone(deps: ResolveLocalTimezoneDeps = {}): string {
  const env = deps.env ?? process.env
  const fromEnv = env.TZ
  if (usable(fromEnv)) return fromEnv.trim()

  const intl = deps.intlTimeZone ?? defaultIntlTimeZone
  const fromIntl = intl()
  if (usable(fromIntl)) return fromIntl.trim()

  return LAST_RESORT_TIMEZONE
}
