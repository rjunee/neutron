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
 *   - a response with ANY entry it cannot read yields `unrecognised` WITH THE KEY
 *     NAMES IT SAW (names only — never values), so one real response is enough to
 *     correct the alias list, and the log line is the "print it before keying
 *     logic on it" step performed in production instead of skipped. All or
 *     nothing, because a half-read sample is indistinguishable from a whole one;
 *   - `unrecognised` writes NO sample. A missing reading must stay
 *     distinguishable from a measured zero, because a confident 0% is the one
 *     render that would tell the owner to push concurrency into a wall.
 *
 * ── UNITS ARE DECIDED BY THE FIELD NAME, AND CHECKED AGAINST THE CLOCK ──────
 * A percent read as a fraction is a 100× error that renders as a plausible bar,
 * and a seconds instant read as milliseconds lands every reset in 1970. So:
 * `*_percent` is divided by 100 and refused above 100; a fraction-named field is
 * refused above 1; a percent-named field whose value is AMBIGUOUS between the two
 * readings is resolved from the REST OF THE SAME PAYLOAD where that payload proves
 * the scale, and refused where it does not ({@link provenPercentScaleKeys},
 * {@link parseFraction}); and every reset instant is plausibility-checked against
 * the caller's clock AFTER conversion ({@link parseResetInstant}), which is what
 * makes a double-converted value fail loudly instead of quietly.
 */

import { KIMI_BASE_URL } from './kimi-review.ts'

/** Bounded so a wedged upstream can never stall the tick loop that calls this. */
export const KIMI_USAGE_TIMEOUT_MS = 20_000

/**
 * The OUTER ceiling on how far into the future a reset instant may land.
 *
 * The real future bound is the entry's own window length — for a rolling window of
 * length L the next reset is at most L away — and that is what
 * {@link parseResetInstant} normally applies. This constant is the backstop for the
 * case where the LENGTH ITSELF is absurd: `window_seconds` read off a field that
 * meant something else can produce a century-long window, and a bound derived from
 * it would wave through a year-57000 instant that renders as a countdown nobody can
 * read. Whichever of the two is tighter wins.
 */
export const RESET_FUTURE_PLAUSIBILITY_MS = 400 * 24 * 60 * 60 * 1000

/**
 * How far into the PAST a reset instant may land and still be believed: A FEW
 * MINUTES OF SKEW, and nothing more.
 *
 * A reset instant slightly in the past is ordinary and true — the window rolled
 * while the request was in flight, or the two clocks disagree by a little, and the
 * probe read it just after. That is the ONLY legitimate past reading, and it is
 * bounded by network latency plus clock skew rather than by anything about the
 * window: for a rolling window of length L, the CURRENT window's reset is always
 * in `(now, now + L]`, so an instant genuinely in the past can only ever be the
 * one that just rolled, moments ago.
 *
 * TWO EARLIER BOUNDS WERE BOTH TOO LOOSE, and both failed the same way. A
 * symmetric ±400 days believed an instant a year back. Replacing it with ONE
 * WINDOW LENGTH still believed a reset four hours into a five-hour window's past —
 * and downstream `windowCapacity` reads a reset that has already passed as "the
 * window rolled, this account is available", so a 99%-spent window rendered as
 * capacity. That is precisely the optimistic answer that sends the owner to raise
 * concurrency into a wall, and against an unpublished schema it is exactly what a
 * `reset`/`reset_time` field carrying the window's START would produce. Refusing
 * leaves `reset_at` null, which renders as "unknown": the honest answer, and the
 * one the acceptance case pins.
 *
 * A CONSTANT rather than a multiple of the window, on purpose. The quantity being
 * tolerated here is CLOCK SKEW, which does not grow because the window is longer —
 * scaling it with the window is what let a five-hour window absorb four hours of
 * "skew". Window length still bounds the FUTURE side, where it genuinely applies.
 */
export const RESET_PAST_TOLERANCE_MS = 5 * 60_000

/** The divider between the two window slots the series keeps. */
export const SHORT_WINDOW_CEILING_MS = 24 * 60 * 60 * 1000

/**
 * The longest window LENGTH this parser will believe.
 *
 * THE RESET INSTANTS WERE BOUNDED AND THE LENGTHS WERE NOT, which left one input
 * unchecked on a schema nobody has published. `window_seconds` read off a field that
 * meant something else — an epoch, a byte count, a request quota — is a positive
 * finite number, so it sailed through and became a confident label: 1e12 seconds
 * renders as "11574074d window", and, worse, it silently decides the SLOT. Every
 * length above {@link SHORT_WINDOW_CEILING_MS} is filed as the WEEKLY window, so one
 * absurd number does not merely render badly — it puts a five-hour standing in the
 * seven-day row and shows the owner the wrong ceiling under the right name.
 *
 * 400 days, the same figure {@link RESET_FUTURE_PLAUSIBILITY_MS} uses, and
 * deliberately the same one: a rolling window of length L resets at most L away, so a
 * length this parser would believe but whose resets it would refuse is a pair of
 * bounds that disagree with each other. It is far above any real subscription window
 * (the largest this product models is seven days) and far below every unit error.
 *
 * REFUSING IS LOUD. A length outside the bound makes the entry unreadable, which
 * makes the whole payload `unrecognised` — the all-or-nothing rule the header states
 * — so the key names are logged and the card says "asked and refused" instead of
 * quietly re-slotting a window. Never a silent clamp: a clamped length would be a
 * made-up number driving the same slot decision.
 */
export const MAX_WINDOW_LENGTH_MS = RESET_FUTURE_PLAUSIBILITY_MS

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
  /**
   * The short rolling window (≤ 24h). NON-NULL, and that is the all-or-nothing
   * rule expressed as a type: a response missing either slot never becomes a
   * sample, so no caller can hold half a reading and no caller needs a branch for
   * one. A nullable field here would be a dead branch dressed as safety.
   */
  session: KimiUsageWindow
  /** The long rolling window (> 24h). NON-NULL, for the same reason. */
  weekly: KimiUsageWindow
}

export type KimiUsageProbeOutcome =
  /** The endpoint answered with at least one window this repo can store. */
  | { kind: 'ok'; sample: KimiUsageSample }
  /** 401/403 — the stored key is dead. Permanent until it is replaced. */
  | { kind: 'unauthorized'; httpStatus: number }
  /**
   * Any OTHER 4xx the endpoint rejected the request with — 400, 404, 410, 422.
   * PERMANENT, and that is the whole reason it is not folded into `error`.
   *
   * The header of this file says the path and schema are UNVERIFIED, which makes a
   * wrong path the single most likely first-install failure — and a 404 retried
   * every ten minutes forever is a refusal that never announces itself. Folded into
   * the transient arm it leaves the card saying "No readings yet.", a sentence
   * promising a reading that cannot arrive.
   *
   * 408 and 429 are excluded and stay transient: a timeout and a rate limit are the
   * two 4xx codes that mean "ask again later" rather than "this request is wrong".
   */
  | { kind: 'rejected'; httpStatus: number }
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
 * Read a reset instant and prove it could belong to the window in front of us.
 *
 * Returns null — not a guess — for an absent, unparseable or implausible value.
 * The plausibility check is the load-bearing half: it is what turns a
 * double-converted (already-ms) value into a refusal instead of a year-57000
 * instant that renders as a countdown nobody can read, and a seconds value read as
 * ms into a refusal instead of "available now" in 1970.
 *
 * THE BOUND IS ASYMMETRIC ON PURPOSE, and each side is measured in the thing that
 * actually bounds it:
 *
 *   - the FUTURE side is ONE WINDOW LENGTH (plus the same skew allowance), because
 *     a rolling window of length L resets within L. The window's own length is
 *     required rather than defaulted for exactly this reason: a guessed length
 *     would decide which instants are believable using a number nobody read;
 *   - the PAST side is a few minutes of CLOCK SKEW and nothing more — see
 *     {@link RESET_PAST_TOLERANCE_MS}. A reset further back than that cannot be
 *     the current window's, and believing one renders a spent window as free.
 */
export function parseResetInstant(
  entry: Record<string, unknown>,
  now: number,
  window_ms: number,
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
  const earliest = now - RESET_PAST_TOLERANCE_MS
  // The tighter of "one window away" and the absurd-length backstop.
  const furthest = Math.min(window_ms + RESET_PAST_TOLERANCE_MS, RESET_FUTURE_PLAUSIBILITY_MS)
  for (const at of candidates) {
    if (at === null) continue
    if (at >= earliest && at - now <= furthest) return at
  }
  return null
}

/**
 * Which percent-named aliases THIS payload has proved are on the 0..100 scale.
 *
 * ── THE PAYLOAD DISAMBIGUATES ITSELF, AND THE PROOF ONLY RUNS ONE WAY ───────
 * `used_percent: 0.85` read alone has two readings, 0.85% and 85%, a factor of 100
 * apart ({@link parseFraction}). But a field that carries FRACTIONS can never
 * exceed 1 — that is what "fraction" means — so a single sibling entry reading
 * `used_percent: 64` in the same response is positive proof that this response
 * writes this field on the percent scale, and that its 0.85 therefore means 0.85%.
 * The inference is one-directional and cannot misfire: no fraction payload can
 * produce the evidence, so nothing can wrongly prove "percent".
 *
 * WHY IT IS PER PAYLOAD AND PER KEY NAME. Per payload, because one response is one
 * writer at one version — evidence from a response last week says nothing about a
 * schema that changed since. Per key name, because `used_percent` proving itself
 * says nothing about `percentage`, and a proof borrowed across two field names is
 * the same "a field's name is not a contract" mistake one level up.
 *
 * The list is scanned WHOLE, not to the first hit: the entry that carries the
 * ambiguous value is usually not the one that carries the proof — the reported case
 * was a 5-hour window at 1% beside a 7-day window at 64%.
 */
export function provenPercentScaleKeys(list: readonly unknown[]): ReadonlySet<string> {
  const proven = new Set<string>()
  for (const raw of list) {
    if (!isRecord(raw)) continue
    for (const key of PERCENT_KEYS) {
      const n = finiteNumber(raw[key])
      // Strictly above 1 and inside the percent range. A value above 100 proves
      // nothing — it is out of range on BOTH readings, so it is a broken field
      // rather than evidence about which scale the good fields use.
      if (n !== null && n > 1 && n <= 100) proven.add(key)
    }
  }
  return proven
}

/** No sibling evidence — every ambiguous percent reading is refused. */
const NO_PROVEN_PERCENT_KEYS: ReadonlySet<string> = new Set<string>()

/**
 * The 0..1 utilisation of one entry, or null when no alias carried a usable one.
 *
 * ── THE AMBIGUOUS BAND IS RESOLVED FROM EVIDENCE, OR REFUSED — NEVER GUESSED ─
 * `used_percent: 0.85` has two readings — 0.85% and 85% — and they are a factor of
 * 100 apart. The name says percent, but the name is not a contract: this schema is
 * unverified (see the header), and dividing by 100 anyway is the OPTIMISTIC
 * reading, which renders an 85%-spent window as a 1% bar labelled "available".
 * That is precisely the confident-wrong number this feature exists to prevent, and
 * it is invisible because both answers look plausible.
 *
 * So the band is decided by `provenPercent` — the key names the SAME payload has
 * shown carry percents ({@link provenPercentScaleKeys}) — and by nothing else. With
 * the proof, 0.85 is 0.85% because this response demonstrably writes percents.
 * Without it, the entry is refused, which makes the payload `unrecognised` and
 * writes NO sample, leaving the card to say "no readings yet" instead of inventing
 * one. Exactly 0 is unambiguous (0% is 0.0) and is accepted with or without proof.
 *
 * REFUSING A NAMED FIELD DOES NOT FALL THROUGH TO ANOTHER ONE, the same policy its
 * sibling {@link parseWindowLength} states: the field this parser named is the field
 * the response used, so answering from a different alias would report some other
 * key's number under this one's meaning — `{used_percent: 150, utilization: 0.5}`
 * would answer 0.5 while the percent-named field is visibly broken. A present
 * percent-named field that cannot be read is a refusal for the whole entry.
 */
export function parseFraction(
  entry: Record<string, unknown>,
  provenPercent: ReadonlySet<string> = NO_PROVEN_PERCENT_KEYS,
): number | null {
  for (const key of PERCENT_KEYS) {
    const n = finiteNumber(entry[key])
    if (n === null) continue
    // Above 100 (or below 0) is not a percentage of anything; refusing beats
    // clamping, which would render a broken field as a full window.
    if (n < 0 || n > 100) return null
    // The ambiguous band: could be a percent, could be a fraction under a
    // percent's name. Answer only where this payload proved the scale.
    if (n > 0 && n <= 1 && !provenPercent.has(key)) return null
    return n / 100
  }
  for (const key of FRACTION_KEYS) {
    const n = finiteNumber(entry[key])
    if (n === null) continue
    // Above 1 on a fraction-named field means the field is really a percentage
    // under a misleading name — exactly the "a field's name is not a contract"
    // case. Refuse it; a 100× error renders as a completely plausible bar.
    if (n < 0 || n > 1) return null
    return n
  }
  return null
}

function parseWindowLength(entry: Record<string, unknown>): number | null {
  for (const [key, multiplier] of WINDOW_LENGTH_KEYS) {
    const n = finiteNumber(entry[key])
    if (n === null || n <= 0) continue
    const ms = Math.round(n * multiplier)
    // OUT OF RANGE IS A REFUSAL, NOT A FALLTHROUGH: the field this parser named is
    // the field the response used, so moving on to the next alias would answer with
    // some other key's number under this one's meaning. See {@link
    // MAX_WINDOW_LENGTH_MS}.
    if (ms > MAX_WINDOW_LENGTH_MS) return null
    return ms
  }
  return null
}

/**
 * Every key name in the payload, one level deep. Names only — never values.
 *
 * EVERY element of an array, not just the first. This list IS the mechanism by
 * which the alias lists get corrected from a real response, and the entry that
 * fails to parse is rarely the first one — a draft that sampled `value[0]` reported
 * the keys of the window it COULD read and stayed silent about the one it could
 * not, which is the opposite of the job.
 */
function observedKeys(body: unknown): string[] {
  if (!isRecord(body)) return [typeof body]
  const keys = new Set<string>(Object.keys(body))
  const add = (v: unknown): void => {
    if (isRecord(v)) for (const k of Object.keys(v)) keys.add(k)
  }
  for (const value of Object.values(body)) {
    if (Array.isArray(value)) for (const item of value) add(item)
    else add(value)
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
 *
 * ── ALL OR NOTHING, BECAUSE A PARTIAL READ IS INDISTINGUISHABLE FROM A WHOLE ──
 * If ANY entry in the list cannot be read, this returns `unrecognised` and writes
 * no sample at all. An earlier draft dropped the unreadable entries and returned
 * `ok` with whatever it did understand — and that is the confident-zero failure
 * wearing a different hat. Nothing downstream can tell a sample with one window
 * from a provider that only HAS one window: an account whose weekly figure was
 * dropped renders as an account with no weekly limit, so a 99%-spent week becomes
 * "next capacity in 40m (5h window)" and the owner raises concurrency into a wall.
 * "Could not read one of these" must not be able to arrive as "there is nothing
 * there", and the only shape in which that is structurally impossible is refusal.
 *
 * AND "ALL" MEANS BOTH SLOTS, not just "every entry I happened to see". A response
 * that lists ONE window read cleanly through the earlier draft: nothing was
 * unreadable, so it returned `ok` with `weekly: null` — the identical wire shape as
 * the dropped-window case above, and the identical wall. The endpoint reports the
 * account's 5-hour AND weekly standings (design §6.3), so a list carrying only one
 * of them is a shape this parser does not model, and it says so rather than
 * shipping half an answer. The clients refuse the same reading independently
 * (`accountCapacity` in `app/lib/usage-dashboard-client.ts`) — a half-measured
 * account has no capacity standing, whatever wrote it — so this is the loud half of
 * a defence that does not depend on one file being right.
 *
 * The refusal is not silent: `observed` carries the KEY NAMES (never values), so
 * one real response is enough to correct the alias lists above — the "print a real
 * value before keying logic on it" step, performed in production instead of
 * skipped. Until then the card says "no readings yet", which is true.
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
  let unreadable = false
  // Read the whole list BEFORE reading any single entry: a sibling window above 1%
  // is what proves this payload's percent-named fields are on the percent scale, and
  // the entry needing that proof is rarely the one that carries it.
  const provenPercent = provenPercentScaleKeys(list)
  for (const raw of list) {
    if (!isRecord(raw)) {
      unreadable = true
      continue
    }
    const fraction = parseFraction(raw, provenPercent)
    const window_ms = parseWindowLength(raw)
    // BOTH are required, and the length is not optional-with-a-default on
    // purpose: pace divides by it, and the two slots are chosen by it. A window
    // whose length is unknown cannot be summarised or even placed, and guessing
    // one is how a 7-day standing ends up rendered as a 5-hour window.
    if (fraction === null || window_ms === null) {
      unreadable = true
      continue
    }
    const win: KimiUsageWindow = {
      fraction,
      reset_at: parseResetInstant(raw, now, window_ms),
      window_ms,
    }
    const slot = window_ms <= SHORT_WINDOW_CEILING_MS ? 'session' : 'weekly'
    // Two windows landing in ONE slot means the response has a shape this parser
    // does not model — say so. Overwriting would silently report whichever came
    // last, and dropping the second is just as silent; either way the card would
    // show one of two real limits and nothing would say the other existed.
    if (slot === 'session' && session === null) session = win
    else if (slot === 'weekly' && weekly === null) weekly = win
    else unreadable = true
  }
  // BOTH slots, not "at least one": a one-window response is the same wire shape a
  // dropped window produces, and downstream neither can be told from a provider
  // that has no such window. See the header.
  if (unreadable || session === null || weekly === null) {
    return { kind: 'unrecognised', observed: observedKeys(body) }
  }
  return { kind: 'ok', sample: { account_label: parseAccountLabel(body), session, weekly } }
}

/**
 * Which 4xx codes mean "this request will never work" rather than "try again".
 *
 * 401/403 are handled before this and keep their own outcome, because "the key was
 * rejected" and "the request was rejected" send the owner to different places. Of
 * what remains, 408 (request timeout) and 429 (rate limited) are the two the spec
 * defines as retryable; everything else in the 4xx range is a statement about the
 * request itself and does not improve by being repeated.
 */
function isPermanentRejection(status: number): boolean {
  if (status < 400 || status >= 500) return false
  return status !== 408 && status !== 429
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
  if (isPermanentRejection(res.status)) {
    return { kind: 'rejected', httpStatus: res.status }
  }
  if (!res.ok) {
    return { kind: 'error', message: `upstream returned ${res.status}` }
  }
  // A 2xx THAT IS NOT JSON IS A SHAPE PROBLEM, NOT A NETWORK ONE. The other likely
  // shape of a wrong path is a 200 carrying an HTML page, and `res.json()` throwing
  // on it looks exactly like a truncated body — so without this check that failure
  // lands in the transient arm and retries forever behind "No readings yet.".
  // The content type is logged rather than the body: it is the one value that says
  // which mistake this is, and it carries nothing of the account.
  const contentType = res.headers.get('content-type') ?? ''
  if (!/\bjson\b/i.test(contentType)) {
    return { kind: 'unrecognised', observed: [`content-type=${contentType || 'absent'}`] }
  }
  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
  return parseKimiUsages(body, now())
}
