/**
 * THE KIMI GAUGE READ — and every way it refuses.
 *
 * This endpoint's schema is not published and no live response has been printed
 * into this repo, so the parser is written to be WRONG LOUDLY rather than right by
 * accident. That makes the refusals the important half of the file:
 *
 *   - an unmodelled payload yields `unrecognised` WITH THE KEY NAMES IT SAW, so a
 *     single real response is enough to correct the alias list — the "print it
 *     before keying logic on it" step, performed in production instead of skipped;
 *   - no refusal ever produces a sample, because a fabricated 0% reads as "the
 *     whole subscription is free" and is the one render that would send the owner
 *     to raise concurrency into a wall.
 *
 * Time-dependent cases use `Date.now()`-relative instants, per the repo rule.
 */

import { describe, expect, test } from 'bun:test'

import {
  parseFraction,
  parseKimiUsages,
  parseResetInstant,
  probeKimiUsage,
  RESET_PLAUSIBILITY_MS,
} from '../kimi-usage-probe.ts'

const NOW = Date.now()
const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The shape this parser models, in the units the endpoint is documented to use. */
function usagesBody(): unknown {
  return {
    account_id: 'acct-example',
    usages: [
      {
        window_minutes: 300,
        used_percent: 42,
        reset_at: Math.round((NOW + 40 * MINUTE) / 1000),
      },
      {
        window_minutes: 10_080,
        used_percent: 64,
        reset_at: Math.round((NOW + 3 * 24 * HOUR) / 1000),
      },
    ],
  }
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('parseKimiUsages — the shape it models', () => {
  test('two windows land in the two slots, in this repo units', () => {
    const out = parseKimiUsages(usagesBody(), NOW)
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    expect(out.sample.account_label).toBe('acct-example')
    expect(out.sample.session).toEqual({
      fraction: 0.42,
      reset_at: Math.round((NOW + 40 * MINUTE) / 1000) * 1000,
      window_ms: 300 * MINUTE,
    })
    expect(out.sample.weekly!.fraction).toBe(0.64)
    expect(out.sample.weekly!.window_ms).toBe(10_080 * MINUTE)
  })

  test('the SLOT is decided by the window length, never by position', () => {
    // A response that lists the long window first must not report a 7-day standing
    // as the 5-hour one. Reversing the array is the mutation this kills.
    const body = usagesBody() as { usages: unknown[] }
    const out = parseKimiUsages({ ...body, usages: [...body.usages].reverse() }, NOW)
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    expect(out.sample.session!.fraction).toBe(0.42)
    expect(out.sample.weekly!.fraction).toBe(0.64)
  })

  test('an account the endpoint does not name is null, never the key', () => {
    // Per-key attribution is not obtainable from an account-wide endpoint, so it is
    // not invented. The card says "account-wide" and means it.
    const body = usagesBody() as Record<string, unknown>
    delete body['account_id']
    const out = parseKimiUsages(body, NOW)
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    expect(out.sample.account_label).toBeNull()
  })
})

describe('parseKimiUsages — a field name is not a contract', () => {
  test('an unmodelled payload is UNRECOGNISED, and reports the keys it saw', () => {
    // The whole mechanism by which the alias list gets corrected from reality: the
    // names travel out (names only — never values), and NOTHING is stored.
    const out = parseKimiUsages(
      { quota: { five_hour: { spent: 0.42 }, seven_day: { spent: 0.64 } } },
      NOW,
    )
    expect(out.kind).toBe('unrecognised')
    if (out.kind !== 'unrecognised') return
    expect(out.observed).toContain('quota')
    expect(out.observed).toContain('five_hour')
  })

  test('a window with NO length is skipped, not defaulted', () => {
    // Pace divides by the length and the slot is chosen by it. A guessed length
    // renders a 7-day standing as a 5-hour window, which is a confident lie about
    // the number the owner is about to act on.
    const out = parseKimiUsages({ usages: [{ used_percent: 42, reset_at: NOW / 1000 }] }, NOW)
    expect(out.kind).toBe('unrecognised')
  })

  test('a window with no usable utilisation is skipped', () => {
    const out = parseKimiUsages({ usages: [{ window_minutes: 300, note: 'ok' }] }, NOW)
    expect(out.kind).toBe('unrecognised')
  })

  test('a non-object body is unrecognised, not an empty reading', () => {
    for (const body of [null, 'ok', 42, []]) {
      expect(parseKimiUsages(body, NOW).kind).toBe('unrecognised')
    }
  })
})

describe('units — the two slips that render as plausible numbers', () => {
  test('a percent above 100 is refused rather than clamped to a full window', () => {
    expect(parseFraction({ used_percent: 142 })).toBeNull()
    expect(parseFraction({ used_percent: 42 })).toBe(0.42)
  })

  test('a fraction-named field above 1 is refused — the name lied about the unit', () => {
    // 64 under a field called `utilization` is a percentage wearing a fraction's
    // name. Accepting it renders a 64% window as 6400%; clamping it renders it as
    // 100%. Both are confident and wrong, so it is refused.
    expect(parseFraction({ utilization: 64 })).toBeNull()
    expect(parseFraction({ utilization: 0.64 })).toBe(0.64)
  })

  test('a reset in SECONDS lands in this decade', () => {
    const seconds = Math.round((NOW + 17 * MINUTE) / 1000)
    expect(parseResetInstant({ reset_at: seconds }, NOW)).toBe(seconds * 1000)
  })

  test('a value already in MILLISECONDS is refused, never double-converted', () => {
    // The unit slip that lands every reset a thousand times too far out. Converted
    // again it becomes an instant tens of thousands of years away, which renders as
    // a countdown nobody can read — so the plausibility check is what makes it a
    // refusal instead.
    expect(parseResetInstant({ reset_at: NOW + 17 * MINUTE }, NOW)).toBeNull()
    // Under its explicit alias the same number is believed.
    expect(parseResetInstant({ reset_at_ms: NOW + 17 * MINUTE }, NOW)).toBe(NOW + 17 * MINUTE)
  })

  test('an instant a year out or a year back is refused, not stored', () => {
    const farFuture = Math.round((NOW + RESET_PLAUSIBILITY_MS + HOUR) / 1000)
    expect(parseResetInstant({ reset_at: farFuture }, NOW)).toBeNull()
    // The mirror image: a 1970 instant renders as "available now", which is the
    // failure this whole feature is built to prevent.
    expect(parseResetInstant({ reset_at: 0 }, NOW)).toBeNull()
  })

  test('an ISO-8601 instant is read, and an unparseable string is not', () => {
    const iso = new Date(NOW + 2 * HOUR).toISOString()
    expect(parseResetInstant({ reset_at: iso }, NOW)).toBe(NOW + 2 * HOUR)
    expect(parseResetInstant({ reset_at: 'soon' }, NOW)).toBeNull()
  })
})

describe('probeKimiUsage — transport', () => {
  test('sends the bearer key to the usages endpoint of the configured base', async () => {
    let seenUrl = ''
    let seenAuth = ''
    await probeKimiUsage('secret-key', {
      baseUrl: 'https://kimi.example.com/coding',
      now: () => NOW,
      fetch: (async (url: string, init: RequestInit) => {
        seenUrl = url
        seenAuth = new Headers(init.headers).get('authorization') ?? ''
        return okResponse(usagesBody())
      }) as unknown as typeof fetch,
    })
    expect(seenUrl).toBe('https://kimi.example.com/coding/v1/usages')
    expect(seenAuth).toBe('Bearer secret-key')
  })

  test('401 is unauthorized, 5xx is an error, and a throw is an error — never ok', async () => {
    const status = async (code: number) =>
      probeKimiUsage('k', {
        baseUrl: 'https://kimi.example.com/coding',
        now: () => NOW,
        fetch: (async () => new Response('', { status: code })) as unknown as typeof fetch,
      })
    expect((await status(401)).kind).toBe('unauthorized')
    expect((await status(403)).kind).toBe('unauthorized')
    expect((await status(500)).kind).toBe('error')
    expect((await status(404)).kind).toBe('error')
    const threw = await probeKimiUsage('k', {
      baseUrl: 'https://kimi.example.com/coding',
      now: () => NOW,
      fetch: (async () => {
        throw new Error('socket hang up')
      }) as unknown as typeof fetch,
    })
    expect(threw).toEqual({ kind: 'error', message: 'socket hang up' })
  })

  test('a 200 carrying HTML is an error or unrecognised — never a zero reading', async () => {
    const out = await probeKimiUsage('k', {
      baseUrl: 'https://kimi.example.com/coding',
      now: () => NOW,
      fetch: (async () =>
        new Response('<html>signed out</html>', { status: 200 })) as unknown as typeof fetch,
    })
    expect(out.kind === 'error' || out.kind === 'unrecognised').toBe(true)
    expect(out.kind).not.toBe('ok')
  })
})
