import { describe, expect, test } from 'bun:test'
import {
  COOLDOWN_401_MS,
  COOLDOWN_402_MS,
  COOLDOWN_429_MS,
  hasUsableCredential,
  MAX_CONSECUTIVE_FAILURES,
  MAX_PARK_MS,
  newCredentialPool,
  reportFailure,
  reportSuccess,
  selectCredential,
  soonestCooldownUntil,
} from './credential-pool.ts'

const baseCreds = [
  { id: 'k1', kind: 'api_key' as const, secret: 's1' },
  { id: 'k2', kind: 'api_key' as const, secret: 's2' },
  { id: 'k3', kind: 'api_key' as const, secret: 's3' },
]

describe('credential-pool', () => {
  test('newCredentialPool rejects duplicate ids', () => {
    expect(() =>
      newCredentialPool({
        strategy: 'fill_first',
        credentials: [
          { id: 'k1', kind: 'api_key', secret: 's1' },
          { id: 'k1', kind: 'api_key', secret: 's2' },
        ],
      }),
    ).toThrow(/duplicate credential id "k1"/)
  })

  test('fill_first always picks the first available', () => {
    const pool = newCredentialPool({ strategy: 'fill_first', credentials: baseCreds })
    expect(selectCredential(pool)?.id).toBe('k1')
    expect(selectCredential(pool)?.id).toBe('k1')
  })

  test('round_robin advances stably across selections', () => {
    const pool = newCredentialPool({ strategy: 'round_robin', credentials: baseCreds })
    expect(selectCredential(pool)?.id).toBe('k1')
    expect(selectCredential(pool)?.id).toBe('k2')
    expect(selectCredential(pool)?.id).toBe('k3')
    expect(selectCredential(pool)?.id).toBe('k1')
  })

  test('round_robin skips credentials in cooldown without stalling rotation', () => {
    const pool = newCredentialPool({ strategy: 'round_robin', credentials: baseCreds })
    selectCredential(pool) // k1
    reportFailure(pool, 'k2', 429)
    expect(selectCredential(pool)?.id).toBe('k3')
    expect(selectCredential(pool)?.id).toBe('k1')
  })

  test('least_used picks the credential with the smallest use_count', () => {
    const pool = newCredentialPool({ strategy: 'least_used', credentials: baseCreds })
    selectCredential(pool) // k1 → 1
    selectCredential(pool) // k1 still 1? No: pool picks lowest, ties broken to first.
    // After two picks both with count 0 ties going to "first" we should have
    // k1 then a tied k2 (since k1 is now 1 and k2/k3 are 0).
    const next = selectCredential(pool)?.id
    expect(next).toBeDefined()
    expect(['k2', 'k3']).toContain(next as string)
  })

  test('429 cooldown honors retry_after_ms when supplied', () => {
    const pool = newCredentialPool({ strategy: 'fill_first', credentials: baseCreds })
    reportFailure(pool, 'k1', 429, 7777)
    const k1 = pool.credentials.find((c) => c.id === 'k1')!
    expect(k1.cooldown_reason).toBe('rate_limit_429')
    expect(k1.cooldown_until).toBeGreaterThan(Date.now() + 7000)
    expect(k1.cooldown_until).toBeLessThan(Date.now() + 8000)
  })

  test('429 cooldown defaults to COOLDOWN_429_MS when no retry-after', () => {
    const pool = newCredentialPool({ strategy: 'fill_first', credentials: baseCreds })
    reportFailure(pool, 'k1', 429)
    const k1 = pool.credentials.find((c) => c.id === 'k1')!
    expect(k1.cooldown_until).toBeGreaterThan(Date.now() + COOLDOWN_429_MS - 100)
  })

  test('402 cooldown is 30 minutes', () => {
    const pool = newCredentialPool({ strategy: 'fill_first', credentials: baseCreds })
    reportFailure(pool, 'k1', 402)
    const k1 = pool.credentials.find((c) => c.id === 'k1')!
    expect(k1.cooldown_reason).toBe('billing_402')
    expect(k1.cooldown_until).toBeGreaterThan(Date.now() + COOLDOWN_402_MS - 100)
  })

  test('401 cooldown is 5 minutes', () => {
    const pool = newCredentialPool({ strategy: 'fill_first', credentials: baseCreds })
    reportFailure(pool, 'k1', 401)
    const k1 = pool.credentials.find((c) => c.id === 'k1')!
    expect(k1.cooldown_reason).toBe('auth_401')
    expect(k1.cooldown_until).toBeGreaterThan(Date.now() + COOLDOWN_401_MS - 100)
  })

  test('reportSuccess clears cooldown and resets failure counter', () => {
    const pool = newCredentialPool({ strategy: 'fill_first', credentials: baseCreds })
    reportFailure(pool, 'k1', 429)
    reportSuccess(pool, 'k1')
    const k1 = pool.credentials.find((c) => c.id === 'k1')!
    expect(k1.cooldown_until).toBeUndefined()
    expect(k1.cooldown_reason).toBeUndefined()
    expect(k1.consecutive_failures).toBe(0)
  })

  test('MAX_CONSECUTIVE_FAILURES strikes parks for an hour', () => {
    const pool = newCredentialPool({ strategy: 'fill_first', credentials: baseCreds })
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
      reportFailure(pool, 'k1', 429)
    }
    const k1 = pool.credentials.find((c) => c.id === 'k1')!
    expect(k1.cooldown_reason).toBe('consecutive_failures')
    expect(k1.cooldown_until).toBeGreaterThan(Date.now() + 59 * 60_000)
  })

  test('selectCredential returns null when every credential is cooling down', () => {
    const pool = newCredentialPool({ strategy: 'round_robin', credentials: baseCreds })
    reportFailure(pool, 'k1', 402)
    reportFailure(pool, 'k2', 402)
    reportFailure(pool, 'k3', 402)
    expect(selectCredential(pool)).toBeNull()
  })

  test('reportFailure / reportSuccess on unknown id is a no-op', () => {
    const pool = newCredentialPool({ strategy: 'fill_first', credentials: baseCreds })
    expect(() => reportFailure(pool, 'nope', 429)).not.toThrow()
    expect(() => reportSuccess(pool, 'nope')).not.toThrow()
  })

  // 2026-06-17 (import-analysis-completeness) — the import substrate uses
  // this to tell the runner the ACTUAL quota-reset window so it waits the
  // right amount + shows an accurate countdown on cooldown.
  test('soonestCooldownUntil returns null when any credential is available', () => {
    const pool = newCredentialPool({ strategy: 'fill_first', credentials: baseCreds })
    reportFailure(pool, 'k1', 429)
    reportFailure(pool, 'k2', 429)
    // k3 still available → nothing to wait for.
    expect(soonestCooldownUntil(pool)).toBeNull()
  })

  test('soonestCooldownUntil returns the MIN cooldown_until across an all-cooldown pool', () => {
    const pool = newCredentialPool({ strategy: 'fill_first', credentials: baseCreds })
    // 402 (30 min) on k1 + k2, 429 (60s, the soonest) on k3.
    reportFailure(pool, 'k1', 402)
    reportFailure(pool, 'k2', 402)
    reportFailure(pool, 'k3', 429)
    expect(selectCredential(pool)).toBeNull()
    const soonest = soonestCooldownUntil(pool)
    expect(soonest).not.toBeNull()
    const k3 = pool.credentials.find((c) => c.id === 'k3')!
    // The 429 credential (k3) lifts first → that's the soonest.
    expect(soonest).toBe(k3.cooldown_until!)
    expect(soonest!).toBeLessThan(Date.now() + COOLDOWN_402_MS)
  })

  test('soonestCooldownUntil on an empty pool is null', () => {
    const pool = newCredentialPool({ strategy: 'fill_first', credentials: [] })
    expect(soonestCooldownUntil(pool)).toBeNull()
  })
})

/**
 * THE COST OF MONOTONICITY, priced. Making a park unshortenable (so a background
 * 429 could not release the hour the owner's own strike counter set) also made an
 * ABSURD park permanent: `>=` rejects every finite replacement, and `reportSuccess`
 * — the one release — is unreachable while the credential is parked, because
 * `selectCredential` filters it out and no dispatch means no success to report. On
 * a single-credential box, which every Open install is, that is the whole product
 * silent until the process restarts.
 *
 * The value that gets there arrives from upstream: `retry-after: 31536000` is one
 * legal year, and the OpenAI header parser shipped `Infinity` outright (finiteness
 * checked on the seconds, then multiplied by 1000). So the pool clamps every park
 * at `MAX_PARK_MS` and refuses to believe a non-finite or negative `retry_after_ms`
 * at all.
 */
describe('no report can park a credential past the ceiling', () => {
  const one = (): ReturnType<typeof newCredentialPool> =>
    newCredentialPool({
      strategy: 'fill_first',
      credentials: [{ id: 'only', kind: 'api_key', secret: 's' }],
    })

  test('a one-YEAR retry-after is clamped to the ceiling, not honoured', () => {
    const pool = one()
    reportFailure(pool, 'only', 429, 365 * 24 * 60 * 60_000)
    const c = pool.credentials[0]!
    expect(c.cooldown_reason).toBe('rate_limit_429')
    expect(c.cooldown_until! - Date.now()).toBeLessThanOrEqual(MAX_PARK_MS)
    // Still a real park — clamped, not discarded. Handing back a credential the
    // provider just told us to stop using would be the opposite failure.
    expect(hasUsableCredential(pool)).toBe(false)
    expect(c.cooldown_until! - Date.now()).toBeGreaterThan(COOLDOWN_429_MS)
  })

  test('an INFINITE retry-after leaves a park that still ends', () => {
    // The exact shipped value: `Number.isFinite('1e308')` is true and
    // `1e308 * 1000` is `Infinity`. Stored raw, `cooldown_until` was a timestamp
    // no clock ever reaches.
    const pool = one()
    reportFailure(pool, 'only', 429, Number.POSITIVE_INFINITY)
    const c = pool.credentials[0]!
    expect(Number.isFinite(c.cooldown_until)).toBe(true)
    expect(c.cooldown_until! - Date.now()).toBeLessThanOrEqual(MAX_PARK_MS)
  })

  test('a NaN retry-after falls back to the status window instead of being written through', () => {
    // `NaN` is the dangerous direction the other way: it is FALSY and `NaN > now`
    // is false, so `!c.cooldown_until` and `cooldown_until <= now` would BOTH read
    // a parked credential as available. A garbage header must not be able to
    // cancel a cooldown either.
    const pool = one()
    reportFailure(pool, 'only', 429, Number.NaN)
    const c = pool.credentials[0]!
    expect(Number.isFinite(c.cooldown_until)).toBe(true)
    expect(c.cooldown_reason).toBe('rate_limit_429')
    expect(hasUsableCredential(pool)).toBe(false)
    expect(c.cooldown_until! - Date.now()).toBeGreaterThan(COOLDOWN_429_MS - 1_000)
    expect(c.cooldown_until! - Date.now()).toBeLessThanOrEqual(COOLDOWN_429_MS)
  })

  test('a NEGATIVE retry-after cannot be used to skip the cooldown entirely', () => {
    const pool = one()
    reportFailure(pool, 'only', 429, -60_000)
    const c = pool.credentials[0]!
    expect(hasUsableCredential(pool)).toBe(false)
    expect(c.cooldown_until! - Date.now()).toBeGreaterThan(COOLDOWN_429_MS - 1_000)
  })

  // THE VALUE THE PRODUCTION PARSER ACTUALLY EMITTED, which is why the test above
  // passed while the defect shipped: it fed the pool a raw `-60000`, and no
  // adapter ever sent one. `parseRetryAfterMs` floored negatives at `0`, so the
  // real payload for `retry-after: -30` — and for any HTTP-date already past,
  // which clock skew alone produces — was a DEFINED ZERO. `0` passed the pool's
  // `>= 0` boundary, `park` wrote `cooldown_until = now`, and `hasUsableCredential`
  // /`selectCredential`/`soonestCooldownUntil` all read `<= now` as AVAILABLE. So
  // the 429 that asked us to stop bought a zero-length cooldown. A test whose input
  // no producer can produce is not a pin.
  test('a ZERO retry-after buys no time — the status window still applies', () => {
    const pool = one()
    reportFailure(pool, 'only', 429, 0)
    const c = pool.credentials[0]!
    expect(hasUsableCredential(pool)).toBe(false)
    expect(c.cooldown_reason).toBe('rate_limit_429')
    expect(c.cooldown_until! - Date.now()).toBeGreaterThan(COOLDOWN_429_MS - 1_000)
    expect(c.cooldown_until! - Date.now()).toBeLessThanOrEqual(COOLDOWN_429_MS)
  })

  test('and on the BACKGROUND lane, where the strike ledger is no backstop at all', () => {
    // The worst version of the same report: `origin: 'background'` deliberately
    // never touches `consecutive_failures`, so if the per-status park is zero
    // length there is no second net under it — nothing cools, ever, however many
    // times the timer fires.
    const pool = one()
    reportFailure(pool, 'only', 429, 0, 'background')
    const c = pool.credentials[0]!
    expect(hasUsableCredential(pool)).toBe(false)
    expect(c.consecutive_failures).toBe(0)
    expect(c.cooldown_until! - Date.now()).toBeGreaterThan(COOLDOWN_429_MS - 1_000)
  })

  test('CONTROL — one millisecond IS a positive hint, and is honoured as given', () => {
    // The boundary is `> 0`, not "small values are suspicious". Without this, a
    // guard written as `retry_after_ms > SOME_MINIMUM` would pass everything above
    // while quietly overriding provider hints it judged too short.
    const pool = one()
    reportFailure(pool, 'only', 429, 1)
    const c = pool.credentials[0]!
    expect(c.cooldown_until! - Date.now()).toBeLessThanOrEqual(1)
  })

  test('the ceiling is anchored to when the park BEGAN, so nothing walks it outward', () => {
    // `MAX_PARK_MS` was not a bound. The ceiling was re-derived from `Date.now()`
    // on every call, and reports DO land during a park: a parked credential is
    // never SELECTED, but turns dispatched before the park started keep reporting
    // per error event. Each late report computed a ceiling further out and the
    // monotonic rule adopted it. Measured before the fix: 21,600,000 ms → 39,600,000
    // ms, six hours to eleven, with every other ceiling assertion still green.
    const pool = one()
    const YEAR = 365 * 24 * 60 * 60_000
    const t0 = Date.now()
    reportFailure(pool, 'only', 429, YEAR)
    const c = pool.credentials[0]!
    const first = c.cooldown_until!
    expect(first - t0).toBeLessThanOrEqual(MAX_PARK_MS)

    // A second in-flight report, five hours into the park, proposing the same
    // over-ceiling window.
    const realNow = Date.now
    Date.now = () => t0 + 5 * 60 * 60_000
    try {
      reportFailure(pool, 'only', 429, YEAR)
    } finally {
      Date.now = realNow
    }
    expect(c.cooldown_until).toBe(first)
    expect(c.cooldown_until! - t0).toBeLessThanOrEqual(MAX_PARK_MS)
  })

  test('a STANDING park with no anchor adopts one, instead of walking outward forever', () => {
    // The state the first version of this fix missed, found by the cross-model
    // review and reproduced here: anchoring only FRESH parks left a standing park
    // that carries no `cooldown_started_at` re-deriving its ceiling from every
    // report and never gaining an anchor to stop it. Reports at +5h/+10h/+15h took
    // one six-hour park to 11h, 16h, 21h — unbounded. Reachable via a credential
    // carried across a pool re-resolve from before the field existed.
    const pool = one()
    const c = pool.credentials[0]!
    const t0 = Date.now()
    c.cooldown_until = t0 + MAX_PARK_MS
    c.cooldown_reason = 'rate_limit_429'
    delete c.cooldown_started_at

    const YEAR = 365 * 24 * 60 * 60_000
    const realNow = Date.now
    try {
      // First late report adopts `now` as the anchor — the true start is unknowable,
      // so this is allowed to land one window beyond it and no further.
      Date.now = () => t0 + 5 * 60 * 60_000
      reportFailure(pool, 'only', 429, YEAR)
      const afterFirst = c.cooldown_until!
      // Read through a widened view: the `delete` above narrows the property to
      // `undefined` for the rest of this block, and the compiler cannot see that
      // `reportFailure` reassigns it.
      const anchors = c as { cooldown_started_at?: number }
      expect(anchors.cooldown_started_at).toBe(t0 + 5 * 60 * 60_000)

      // THE POINT: every later report inside that park is now bounded by the same
      // anchor, so nothing walks. Before the fix this read 16h, then 21h.
      Date.now = () => t0 + 10 * 60 * 60_000
      reportFailure(pool, 'only', 429, YEAR)
      expect(c.cooldown_until).toBe(afterFirst)
      expect(c.cooldown_until! - c.cooldown_started_at!).toBe(MAX_PARK_MS)
    } finally {
      Date.now = realNow
    }
  })

  test('CONTROL — an EXPIRED park re-anchors, so the ceiling is not a one-time budget', () => {
    // The anchor must not outlive its park, and this is the mutation-control for
    // the test above: anchoring on `cooldown_started_at` whenever it is merely
    // PRESENT (rather than while a park is STANDING) keeps the ceiling frozen at
    // the first park forever. Then a credential that was once parked can never be
    // parked again — `>=` sees the stale ceiling, returns early, and an
    // already-expired park is left in place while the provider is still refusing.
    const pool = one()
    const c = pool.credentials[0]!
    const YEAR = 365 * 24 * 60 * 60_000
    const t0 = Date.now()
    reportFailure(pool, 'only', 429, YEAR)

    // Seven hours later the first park has expired on its own.
    const sevenHoursOn = t0 + 7 * 60 * 60_000
    const realNow = Date.now
    Date.now = () => sevenHoursOn
    try {
      expect(hasUsableCredential(pool)).toBe(true)
      reportFailure(pool, 'only', 429, YEAR)
      expect(hasUsableCredential(pool)).toBe(false)
      expect(c.cooldown_until! - sevenHoursOn).toBe(MAX_PARK_MS)
    } finally {
      Date.now = realNow
    }
  })

  test('the ceiling is a floor for recovery: the clamped park is still MONOTONIC under later reports', () => {
    // The clamp must not have reopened truncation. A one-year park clamped to six
    // hours is still longer than every status window, so a later 429/401 leaves it
    // exactly where it was.
    const pool = one()
    reportFailure(pool, 'only', 429, 365 * 24 * 60 * 60_000)
    const c = pool.credentials[0]!
    const until = c.cooldown_until!

    reportFailure(pool, 'only', 401)
    reportFailure(pool, 'only', 429)

    expect(c.cooldown_until).toBe(until)
    expect(c.cooldown_reason).toBe('rate_limit_429')
  })

  test('CONTROL — an ordinary retry-after under the ceiling is honoured exactly', () => {
    // Without this, a clamp written as a flat "always MAX_PARK_MS" would pass
    // every assertion above while ignoring provider back-pressure entirely.
    const pool = one()
    reportFailure(pool, 'only', 429, 90_000)
    const c = pool.credentials[0]!
    expect(c.cooldown_until! - Date.now()).toBeGreaterThan(89_000)
    expect(c.cooldown_until! - Date.now()).toBeLessThanOrEqual(90_000)
  })

  test('CONTROL — reportSuccess still releases a clamped park', () => {
    const pool = one()
    reportFailure(pool, 'only', 429, Number.POSITIVE_INFINITY)
    reportSuccess(pool, 'only')
    expect(hasUsableCredential(pool)).toBe(true)
  })
})
