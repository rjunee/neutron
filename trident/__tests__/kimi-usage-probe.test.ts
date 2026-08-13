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
  RESET_FUTURE_PLAUSIBILITY_MS,
} from '../kimi-usage-probe.ts'

const NOW = Date.now()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** The 5-hour window the fixtures use. `parseResetInstant` bounds the FUTURE by
 *  the window's own length, so every direct call has to say which window it is for. */
const SESSION_MS = 300 * MINUTE

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

  test('a percent-named field INSIDE 0..1 is refused — the reading is ambiguous', () => {
    // THE MUTANT THIS KILLS: dividing anything in [0, 100] by 100. `used_percent:
    // 0.85` is either 0.85% or 85%, a factor of 100 apart, and the divide-anyway
    // reading is the OPTIMISTIC one — an 85%-spent window rendered as a 1% bar
    // labelled "available", which is the confident-wrong number that sends the
    // owner to raise concurrency into a wall. Refusing writes no sample at all, and
    // "no readings yet" is the honest card.
    expect(parseFraction({ used_percent: 0.85 })).toBeNull()
    expect(parseFraction({ used_percent: 1 })).toBeNull()
    // Exactly zero is unambiguous — 0% and 0.0 are the same number.
    expect(parseFraction({ used_percent: 0 })).toBe(0)
    // Just past the ambiguous band, the percent reading is the only one available.
    expect(parseFraction({ used_percent: 1.5 })).toBe(0.015)
    // And a fraction-named field in that same band is still read as a fraction:
    // the refusal is about the NAME disagreeing with the value, not about the band.
    expect(parseFraction({ utilization: 0.85 })).toBe(0.85)
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
    expect(parseResetInstant({ reset_at: seconds }, NOW, SESSION_MS)).toBe(seconds * 1000)
  })

  test('a value already in MILLISECONDS is refused, never double-converted', () => {
    // The unit slip that lands every reset a thousand times too far out. Converted
    // again it becomes an instant tens of thousands of years away, which renders as
    // a countdown nobody can read — so the plausibility check is what makes it a
    // refusal instead.
    expect(parseResetInstant({ reset_at: NOW + 17 * MINUTE }, NOW, SESSION_MS)).toBeNull()
    // Under its explicit alias the same number is believed.
    expect(parseResetInstant({ reset_at_ms: NOW + 17 * MINUTE }, NOW, SESSION_MS)).toBe(NOW + 17 * MINUTE)
  })

  test('an instant a year out or a year back is refused, not stored', () => {
    const farFuture = Math.round((NOW + RESET_FUTURE_PLAUSIBILITY_MS + HOUR) / 1000)
    expect(parseResetInstant({ reset_at: farFuture }, NOW, SESSION_MS)).toBeNull()
    // The mirror image: a 1970 instant renders as "available now", which is the
    // failure this whole feature is built to prevent.
    expect(parseResetInstant({ reset_at: 0 }, NOW, SESSION_MS)).toBeNull()
  })

  test('an ISO-8601 instant is read, and an unparseable string is not', () => {
    const iso = new Date(NOW + 2 * HOUR).toISOString()
    expect(parseResetInstant({ reset_at: iso }, NOW, SESSION_MS)).toBe(NOW + 2 * HOUR)
    expect(parseResetInstant({ reset_at: 'soon' }, NOW, SESSION_MS)).toBeNull()
  })

  test('the PAST bound is CLOCK SKEW, not a window — a stale instant is refused', () => {
    // THE BLOCKER FROM ROUND 3, and the two mutants it kills.
    //
    // FIRST: a symmetric `Math.abs(at - now) <= PLAUSIBILITY` bound, which believes
    // an instant up to 400 days in the PAST. SECOND, and the one that actually
    // shipped: a bound of ONE WINDOW LENGTH, which believes a reset four hours into
    // a five-hour window's past. Downstream, a reset that has already passed means
    // "the window rolled, this account is free", so a 99%-spent window with a
    // four-hour-old reset rendered "1 available now" — the optimistic answer that
    // sends the owner to raise concurrency into a wall. Against an unpublished
    // schema that is exactly what a `reset`/`reset_time` field carrying the window's
    // START would produce.
    //
    // For a rolling window of length L the CURRENT window's reset is in
    // `(now, now + L]`, so the only legitimate past instant is the one that rolled
    // moments ago — bounded by latency and clock skew, NOT by the window.
    const secondsAt = (ms: number): number => Math.round(ms / 1000)
    // Inside the skew allowance: the window rolled while the request was in flight
    // and the probe read it just after. Ordinary, true, and believed.
    expect(parseResetInstant({ reset_at: secondsAt(NOW - MINUTE) }, NOW, SESSION_MS)).toBe(
      secondsAt(NOW - MINUTE) * 1000,
    )
    // Past it, on both windows — the bound does NOT scale with the window, because
    // the quantity being tolerated is skew and skew does not grow with the window.
    // Four hours back on a five-hour window is the reproduced failure, by value.
    const weekly = 7 * 24 * HOUR
    for (const window_ms of [SESSION_MS, weekly]) {
      expect(parseResetInstant({ reset_at: secondsAt(NOW - 4 * HOUR) }, NOW, window_ms)).toBeNull()
      expect(
        parseResetInstant({ reset_at: secondsAt(NOW - SESSION_MS - MINUTE) }, NOW, window_ms),
      ).toBeNull()
      expect(
        parseResetInstant({ reset_at: secondsAt(NOW - 300 * 24 * HOUR) }, NOW, window_ms),
      ).toBeNull()
    }
  })

  test('the FUTURE bound is ONE WINDOW, because that is where length applies', () => {
    // The other half of the asymmetry, and the reason the window length is still a
    // required argument. A rolling window of length L resets within L, so an instant
    // further out than that is not this window's reset — it is a unit slip or a
    // field that means something else. The bound SCALES here, because window length
    // is not a constant and one provider has already changed regime.
    const secondsAt = (ms: number): number => Math.round(ms / 1000)
    const weekly = 7 * 24 * HOUR
    // Two days out: implausible for a five-hour window, ordinary for a weekly one.
    // The SAME instant, judged by the length the entry itself reported.
    expect(parseResetInstant({ reset_at: secondsAt(NOW + 2 * 24 * HOUR) }, NOW, SESSION_MS))
      .toBeNull()
    expect(parseResetInstant({ reset_at: secondsAt(NOW + 2 * 24 * HOUR) }, NOW, weekly)).toBe(
      secondsAt(NOW + 2 * 24 * HOUR) * 1000,
    )
    // And inside its own window it is believed either way — the positive control
    // that stops the two refusals above from passing on a function that refuses
    // everything.
    expect(parseResetInstant({ reset_at: secondsAt(NOW + 3 * HOUR) }, NOW, SESSION_MS)).toBe(
      secondsAt(NOW + 3 * HOUR) * 1000,
    )
  })
})

describe('a PARTIAL read is a refusal, not a smaller answer', () => {
  /** The modelled body with one extra entry this parser cannot read. */
  function bodyWithUnreadable(extra: Record<string, unknown>): unknown {
    const body = usagesBody() as { usages: unknown[] }
    return { ...body, usages: [...body.usages, extra] }
  }

  test('a dropped window makes the WHOLE response unrecognised', () => {
    // THE MUTANT THIS KILLS: `continue` on an unreadable entry and `ok` with
    // whatever was understood. Nothing downstream can tell a sample carrying one
    // window from a provider that only HAS one window — the missing weekly figure
    // is simply absent from the card and from the pool headline. So an account
    // whose weekly window is 99% spent would read "Next capacity in 40m (5h
    // window)". "Could not read it" must not arrive as "there is nothing there".
    const out = parseKimiUsages({ usages: [{ window_minutes: 300, used_percent: 42 }, { note: 'x' }] }, NOW)
    expect(out.kind).toBe('unrecognised')
    if (out.kind !== 'unrecognised') return
    // And it is LOUD: the keys it could not place travel out so one real response
    // corrects the alias list.
    expect(out.observed).toContain('note')
  })

  test('a non-object entry in the list is a refusal too', () => {
    expect(parseKimiUsages(bodyWithUnreadable({}), NOW).kind).toBe('unrecognised')
    const body = usagesBody() as { usages: unknown[] }
    expect(parseKimiUsages({ ...body, usages: [...body.usages, 'five hours'] }, NOW).kind).toBe(
      'unrecognised',
    )
  })

  test('a SECOND window in an already-filled slot is a refusal, not a silent drop', () => {
    // Two short windows means the response has a shape this parser does not model.
    // Overwriting reports whichever came last; dropping reports whichever came
    // first. Both show one of two real limits with nothing saying the other
    // existed, so the response is refused and the key names go out instead.
    const out = parseKimiUsages(
      {
        usages: [
          { window_minutes: 60, used_percent: 10 },
          { window_minutes: 300, used_percent: 90 },
        ],
      },
      NOW,
    )
    expect(out.kind).toBe('unrecognised')
  })

  test('a response listing only ONE window is a refusal, not half a sample', () => {
    // THE BLOCKER FROM ROUND 3, and the gap the "all or nothing" rule had: nothing
    // in this body is UNREADABLE, so the earlier draft returned `ok` with
    // `weekly: null` — byte-for-byte the wire shape a dropped window produces, and
    // the same wall. `{session: 20%, weekly: null}` rendered "1 available now" with
    // zero unknowns; `{session: 99%, resets in 40m, weekly: null}` rendered the bare
    // "Next capacity in 40m (5h window)". The endpoint reports both standings, so
    // one of them is a shape this parser does not model.
    const sessionOnly = { usages: [{ window_minutes: 300, used_percent: 20 }] }
    const out = parseKimiUsages(sessionOnly, NOW)
    expect(out.kind).toBe('unrecognised')
    // Still LOUD: the key names travel so one real response corrects the aliases.
    if (out.kind !== 'unrecognised') return
    expect(out.observed).toContain('window_minutes')
    // The mirror image — a weekly-only response — is refused the same way. The rule
    // is about the PAIR, not about which half is missing.
    expect(
      parseKimiUsages({ usages: [{ window_minutes: 10_080, used_percent: 64 }] }, NOW).kind,
    ).toBe('unrecognised')
  })

  test('the modelled body is still ok — the refusal is not a blanket one', () => {
    // The POSITIVE CONTROL for the three refusals above: without it, a parser that
    // returned `unrecognised` unconditionally would pass every test in this block.
    expect(parseKimiUsages(usagesBody(), NOW).kind).toBe('ok')
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
