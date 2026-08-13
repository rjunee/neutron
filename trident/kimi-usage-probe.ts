/**
 * Where the Kimi subscription stands — the gauge read, not the reviewer.
 *
 * WHY AN ENDPOINT AND NOT HEADERS. Anthropic reports utilisation on the response
 * headers of any authenticated call, so the Anthropic gauge rides a one-token
 * probe (`auth/credential-usage-probe.ts`). Kimi returns no rate-limit headers on
 * a normal call, so the ONLY way to read the subscription's standing is the
 * usages endpoint: `GET {KIMI_BASE_URL}/v1/usages`. This module is that read, and
 * nothing else — it never sends a prompt and never costs a review.
 *
 * ACCOUNT-WIDE, AND THE CARD SAYS SO. The endpoint reports the ACCOUNT's
 * standing: two different keys on one account return the same numbers and the
 * same account id, so per-key attribution is not obtainable from it and is never
 * fabricated here. A response that names the account is stamped with that name; a
 * response that does not carries a null label, which the surface renders as
 * "account-wide" rather than as a guess.
 *
 * ── THE FIELD NAMES ARE UNVERIFIED, AND THAT IS WHY THIS REFUSES ─────────────
 * Kimi does not publish this endpoint's schema, and no live response has been
 * printed into this repo. **A field's name is not a contract**, so this parser is
 * built to fail LOUDLY and EMPTY rather than plausibly:
 *
 *   - it accepts a small, written-down set of aliases per field;
 *   - anything it does not recognise yields `unrecognised` WITH THE KEY NAMES IT
 *     SAW (names only — never values), so one real response is enough to correct
 *     the alias list, and the log line is the "print it before keying logic on
 *     it" step performed in production instead of skipped;
 *   - `unrecognised` writes NO sample. A missing reading must stay
 *     distinguishable from a measured zero, because a confident 0% is the one
 *     render that would tell the owner to push concurrency into a wall.
 *
 * ── UNITS ARE DECIDED BY THE FIELD NAME, AND CHECKED AGAINST THE CLOCK ──────
 * A percent read as a fraction is a 100× error that renders as a plausible bar,
 * and a seconds instant read as milliseconds lands every reset in 1970. So:
 * `*_percent` is divided by 100 and refused above 100; a fraction-named field is
 * refused above 1; and every reset instant is plausibility-checked against the
 * caller's clock AFTER conversion ({@link parseResetInstant}), which is what
 * makes a double-converted value fail loudly instead of quietly.
 */

import { KIMI_BASE_URL } from './kimi-review.ts'

/** Bounded so a wedged upstream can never stall the tick loop that calls this. */
export const KIMI_USAGE_TIMEOUT_MS = 20_000

/**
 * How far from `now` a reset instant may land and still be believed.
 *
 * A rolling quota window resets within days, so anything a year out is a unit
 * slip (a milliseconds value converted as if it were seconds), and anything a
 * year back is the mirror image. Both are refused rather than stored: a reset in
 * 1970 renders as "available now", which is the exact lie this feature exists to
 * prevent.
 */
export const RESET_PLAUSIBILITY_MS = 400 * 24 * 60 * 60 * 1000

/** The divider between the two window slots the series keeps. */
export const SHORT_WINDOW_CEILING_MS = 24 * 60 * 60 * 1000

/** One window's standing, normalised into this repo's units (0..1, epoch MS). */
export interface KimiUsageWindow {
  fraction: number
  /** Epoch MS, or null when the response carried no believable instant. */
  reset_at: number | null
  /** The window's own length, as reported. Never defaulted. */
  window_ms: number
}

export interface KimiUsageSample {
  /** The account the endpoint named, or null. NEVER inferred from the key. */
  account_label: string | null
  /** The short rolling window (≤ 24h), when one was reported. */
  session: KimiUsageWindow | null
  /** The long rolling window (> 24h), when one was reported. */
  weekly: KimiUsageWindow | null
}

export type KimiUsageProbeOutcome =
  /** The endpoint answered with at least one window this repo can store. */
  | { kind: 'ok'; sample: KimiUsageSample }
  /** 401/403 — the stored key is dead. Permanent until it is replaced. */
  | { kind: 'unauthorized'; httpStatus: number }
  /** Transport failure, timeout, or 5xx. Transient. */
  | { kind: 'error'; message: string }
  /**
   * The endpoint answered something this parser does not understand. Carries the
   * KEY NAMES observed (never values) so the alias lists below can be corrected
   * from one real response.
   */
  | { kind: 'unrecognised'; observed: string[] }

export interface KimiUsageProbeDeps {
  /** Injected in tests; production uses the global. */
  fetch?: typeof fetch
  timeoutMs?: number
  /** Override the base — tests point this at a mock. */
  baseUrl?: string
  /** The clock the reset plausibility check runs against. */
  now?: () => number
}

/** Where the window list might live. Checked in order; first array wins. */
const WINDOW_LIST_KEYS = ['usages', 'windows', 'limits', 'items', 'list'] as const
/** One level of envelope is unwrapped before the search above runs again. */
const ENVELOPE_KEYS = ['data', 'result', 'usage'] as const
/** Percent-valued utilisation aliases (0..100). */
const PERCENT_KEYS = ['used_percent', 'usage_percent', 'percent_used', 'percentage'] as const
/** Fraction-valued utilisation aliases (0..1). */
const FRACTION_KEYS = ['utilization', 'utilisation', 'fraction', 'used_fraction'] as const
/** Window-length aliases, each with the multiplier that takes it to ms. */
const WINDOW_LENGTH_KEYS: ReadonlyArray<readonly [string, number]> = [
  ['window_minutes', 60_000],
  ['window_mins', 60_000],
  ['window_seconds', 1_000],
  ['window_ms', 1],
  ['duration_minutes', 60_000],
  ['duration_seconds', 1_000],
]
/** Reset-instant aliases. Seconds unless the name says otherwise. */
const RESET_KEYS = ['reset_at', 'resets_at', 'reset', 'reset_time', 'refresh_at'] as const
const RESET_MS_KEYS = ['reset_at_ms', 'resets_at_ms'] as const
/** Account-identity aliases at the top level of the response. */
const ACCOUNT_KEYS = ['account_id', 'account', 'user_id', 'uid'] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finiteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  // A numeric STRING is accepted — JSON APIs return both, and refusing one shape
  // of the same value would be a refusal of a reading we can actually read.
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Read a reset instant and prove it lands in this decade.
 *
 * Returns null — not a guess — for an absent, unparseable or implausible value.
 * The plausibility check is the load-bearing half: it is what turns a
 * double-converted (already-ms) value into a refusal instead of a year-57000
 * instant that renders as a countdown nobody can read, and a seconds value read
 * as ms into a refusal instead of "available now" in 1970.
 */
export function parseResetInstant(
  entry: Record<string, unknown>,
  now: number,
): number | null {
  const candidates: Array<number | null> = []
  for (const key of RESET_MS_KEYS) {
    const n = finiteNumber(entry[key])
    if (n !== null) candidates.push(Math.round(n))
  }
  for (const key of RESET_KEYS) {
    const raw = entry[key]
    const n = finiteNumber(raw)
    if (n !== null) {
      // Epoch SECONDS at the boundary, the same normalisation Anthropic's reset
      // headers get (`auth/credential-usage-probe.ts`), so nothing downstream
      // ever has to know two units existed.
      candidates.push(Math.round(n * 1000))
      continue
    }
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw)
      if (Number.isFinite(parsed)) candidates.push(parsed)
    }
  }
  for (const at of candidates) {
    if (at === null) continue
    if (Math.abs(at - now) <= RESET_PLAUSIBILITY_MS) return at
  }
  return null
}

/** The 0..1 utilisation of one entry, or null when no alias carried a usable one. */
export function parseFraction(entry: Record<string, unknown>): number | null {
  for (const key of PERCENT_KEYS) {
    const n = finiteNumber(entry[key])
    // Above 100 is not a percentage of anything; refusing beats clamping, which
    // would render a broken field as a full window.
    if (n !== null && n >= 0 && n <= 100) return n / 100
  }
  for (const key of FRACTION_KEYS) {
    const n = finiteNumber(entry[key])
    // Above 1 on a fraction-named field means the field is really a percentage
    // under a misleading name — exactly the "a field's name is not a contract"
    // case. Refuse it; a 100× error renders as a completely plausible bar.
    if (n !== null && n >= 0 && n <= 1) return n
  }
  return null
}

function parseWindowLength(entry: Record<string, unknown>): number | null {
  for (const [key, multiplier] of WINDOW_LENGTH_KEYS) {
    const n = finiteNumber(entry[key])
    if (n !== null && n > 0) return Math.round(n * multiplier)
  }
  return null
}

/** Every key name in the payload, one level deep. Names only — never values. */
function observedKeys(body: unknown): string[] {
  if (!isRecord(body)) return [typeof body]
  const keys = new Set<string>(Object.keys(body))
  for (const value of Object.values(body)) {
    if (isRecord(value)) for (const k of Object.keys(value)) keys.add(k)
    else if (Array.isArray(value) && isRecord(value[0])) {
      for (const k of Object.keys(value[0])) keys.add(k)
    }
  }
  return [...keys].sort()
}

function findWindowList(body: Record<string, unknown>): unknown[] | null {
  for (const key of WINDOW_LIST_KEYS) {
    const v = body[key]
    if (Array.isArray(v)) return v
  }
  for (const key of ENVELOPE_KEYS) {
    const inner = body[key]
    if (Array.isArray(inner)) return inner
    if (isRecord(inner)) {
      for (const key2 of WINDOW_LIST_KEYS) {
        const v = inner[key2]
        if (Array.isArray(v)) return v
      }
    }
  }
  return null
}

function parseAccountLabel(body: Record<string, unknown>): string | null {
  const sources: Array<Record<string, unknown>> = [body]
  for (const key of ENVELOPE_KEYS) {
    const inner = body[key]
    if (isRecord(inner)) sources.push(inner)
  }
  for (const source of sources) {
    for (const key of ACCOUNT_KEYS) {
      const v = source[key]
      if (typeof v === 'string' && v.trim().length > 0) return v.trim()
      if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    }
  }
  return null
}

/**
 * Turn a usages response into a sample, or say plainly that it could not.
 *
 * PURE and exported so every branch — including every refusal — is testable
 * without a network, which matters more here than anywhere else in this feature:
 * the refusals are the whole safety property.
 */
export function parseKimiUsages(
  body: unknown,
  now: number,
): { kind: 'ok'; sample: KimiUsageSample } | { kind: 'unrecognised'; observed: string[] } {
  if (!isRecord(body)) return { kind: 'unrecognised', observed: observedKeys(body) }
  const list = findWindowList(body)
  if (list === null) return { kind: 'unrecognised', observed: observedKeys(body) }
  let session: KimiUsageWindow | null = null
  let weekly: KimiUsageWindow | null = null
  for (const raw of list) {
    if (!isRecord(raw)) continue
    const fraction = parseFraction(raw)
    const window_ms = parseWindowLength(raw)
    // BOTH are required, and the length is not optional-with-a-default on
    // purpose: pace divides by it, and the two slots are chosen by it. A window
    // whose length is unknown cannot be summarised or even placed, and guessing
    // one is how a 7-day standing ends up rendered as a 5-hour window.
    if (fraction === null || window_ms === null) continue
    const win: KimiUsageWindow = {
      fraction,
      reset_at: parseResetInstant(raw, now),
      window_ms,
    }
    const slot = window_ms <= SHORT_WINDOW_CEILING_MS ? 'session' : 'weekly'
    // First writer wins per slot: two windows landing in one slot means the
    // response has a shape this parser does not model, and overwriting would
    // silently report whichever happened to be last.
    if (slot === 'session' && session === null) session = win
    else if (slot === 'weekly' && weekly === null) weekly = win
  }
  if (session === null && weekly === null) {
    return { kind: 'unrecognised', observed: observedKeys(body) }
  }
  return { kind: 'ok', sample: { account_label: parseAccountLabel(body), session, weekly } }
}

/**
 * Ask the account where it stands. NEVER throws — every failure mode is a tagged
 * outcome, because this runs inside a tick loop and a thrown probe would spend
 * the loop's error budget on something as ordinary as a dropped packet.
 */
export async function probeKimiUsage(
  key: string,
  deps: KimiUsageProbeDeps = {},
): Promise<KimiUsageProbeOutcome> {
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? ((): number => Date.now())
  const base = (deps.baseUrl ?? KIMI_BASE_URL).replace(/\/+$/, '')
  let res: Response
  try {
    res = await doFetch(`${base}/v1/usages`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(deps.timeoutMs ?? KIMI_USAGE_TIMEOUT_MS),
    })
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
  if (res.status === 401 || res.status === 403) {
    return { kind: 'unauthorized', httpStatus: res.status }
  }
  if (!res.ok) {
    return { kind: 'error', message: `upstream returned ${res.status}` }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
  return parseKimiUsages(body, now())
}
