/**
 * WEB AND MOBILE MUST AGREE ABOUT THE OWNER'S QUOTA.
 *
 * The formatters and the decoder exist twice — `app/lib/usage-dashboard-client.ts` and
 * `landing/chat-react/usage-dashboard-client.ts` — because production code in `app/lib`
 * never imports `landing`; only the mirror-parity TESTS cross that line. (`app` does
 * declare `@neutronai/landing`, so the barrier is a convention rather than a resolver
 * refusal — worth stating precisely, because a first draft of the twin justified itself
 * with a bundle-independence claim the existing `UsageMeter` disproves.) That
 * duplication is correct, and it is also the risk: **these functions encode product
 * decisions, not transport.**
 *
 * A divergence is the failure nobody reports. Each surface stays self-consistent, so
 * neither looks broken; the owner simply gets a different answer about their own quota
 * depending on which device they picked up. The dangerous cases are the NULLS, where
 * both "—" and "0.0×" render perfectly and only one of them is true.
 *
 * SO THE COPIES ARE EXECUTED SIDE BY SIDE over the same inputs.
 *
 * THE BAND AND THE CLAMP ARE DELIBERATELY ABSENT FROM THE TWIN. Both clients import
 * them from `@neutronai/contracts/credential-usage.ts`, so there is nothing to
 * compare — the drift is closed STRUCTURALLY rather than tested for, which is
 * strictly better. A first draft re-declared them on the phone; the test below pins
 * that they stay shared, because re-declaring a reachable value is how the phone ends
 * up calling something amber that the web still draws green.
 *
 * IT IS ALSO WHERE THE CAPACITY POLICY IS PINNED, because that policy is a
 * function of the RENDER CLOCK and therefore lives in the clients rather than in
 * the store: "what does a stale reading still prove", "an account is bound by its
 * worst window", "an absent reset is unknown and never now". `projectPool` is
 * executed on both copies over the same payload at the same instant and the two
 * results are compared whole, so every case below is a policy assertion and a
 * parity assertion at once.
 *
 * WHY THIS FILE LIVES IN `gateway/__tests__`. `landing` does not declare
 * `@neutronai/app` and must not start — that independence is the whole reason the
 * helpers are duplicated. `gateway` is the one package declaring BOTH, the same home
 * and reasoning as `phase-models-client-parity.test.ts`.
 */

import { describe, expect, test } from 'bun:test'

import { usageBand as contractBand } from '@neutronai/contracts/credential-usage.ts'
import * as mobile from '@neutronai/app/lib/usage-dashboard-client'
import * as web from '@neutronai/landing/chat-react/usage-dashboard-client.ts'

/** Every case with a decision in it, nulls first — a happy-path-only comparison
 *  would agree on two copies of a rule that is wrong in the same way. */
const PACES: Array<number | null> = [null, 0, 0.4, 1, 1.0001, 1.5, 1.52, 9.9]
const DURATIONS: Array<number | null> = [null, -60_000, 0, 1, 59_000, 60_000, 300_000, 3_599_000, 7_200_000, 9_000_000, 604_800_000]
const FRACTIONS = [-0.2, 0, 0.004, 0.36, 0.364, 0.849, 0.85, 0.9499, 0.95, 1, 1.4]
/** Countdowns and ages, with the two values that must never merge first. */
const COUNTDOWNS: Array<number | null> = [
  null, -1, 0, 1, 59_000, 60_000, 17 * 60_000, 3_600_000, 3_840_000, 86_400_000, 190_000_000,
]

const NOW = 1_800_000_000_000
const MINUTE = 60_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const SESSION_MS = 5 * HOUR
const WEEKLY_MS = 7 * DAY

/** One window as it comes off the wire: instants and figures, never durations. */
function win(over: Partial<web.UsageWindow> & { fraction: number }): web.UsageWindow {
  return {
    window_ms: SESSION_MS,
    reset_at: NOW + HOUR,
    pace: null,
    exhausts_at: null,
    ...over,
  }
}

/** One pool as it comes off the wire. `stale_after_ms` is anthropic's: 2 minutes. */
function poolOf(
  accounts: Array<Partial<web.UsageAccount>>,
  over: Partial<web.UsagePool> = {},
): web.UsagePool {
  return {
    pool: 'anthropic',
    connection: 'connected',
    measured_at: NOW,
    stale_after_ms: 2 * MINUTE,
    accounts: accounts.map((a) => ({
      account_label: 'owner-a',
      measured_at: NOW,
      session: null,
      weekly: null,
      ...a,
    })),
    ...over,
  }
}

/**
 * Project on BOTH clients and assert they produced the same thing, whole.
 *
 * Every call site below therefore pins the policy AND the parity in one
 * assertion — there is no way to add a case here that checks one and not the
 * other, which is what a hand-maintained pair of expectations always drifts into.
 */
function project(pool: web.UsagePool, now: number): web.ProjectedPool {
  const w = web.projectPool(pool, now)
  expect(mobile.projectPool(pool, now)).toEqual(w)
  return w
}

/** The pool headline, on both clients, at one instant. */
function line(pool: web.UsagePool, now: number): string | null {
  const w = web.capacityLine(web.projectPool(pool, now))
  expect(mobile.capacityLine(mobile.projectPool(pool, now))).toBe(w)
  return w
}

const WINDOW: web.UsageWindow = win({
  fraction: 0.43,
  pace: 1.2,
  exhausts_at: NOW + 30 * MINUTE,
})

const AVAILABLE_POOL = poolOf([{ session: WINDOW, weekly: win({ fraction: 0.5, window_ms: WEEKLY_MS }) }])
const COOLING_POOL = poolOf([
  {
    session: win({ fraction: 0.98 }),
    weekly: win({ fraction: 0.97, window_ms: WEEKLY_MS, reset_at: NOW + 3 * DAY }),
  },
])
const UNKNOWN_POOL = poolOf([{ session: win({ fraction: 0.99, reset_at: null }) }])

describe('the two clients format identically', () => {
  test('formatPace agrees, and both refuse a null with a dash', () => {
    for (const p of PACES) {
      expect(mobile.formatPace(p)).toBe(web.formatPace(p))
    }
    // The specific claim, asserted rather than implied by the loop: a null pace is a
    // refusal to answer, and rendering it as any number states the opposite.
    expect(mobile.formatPace(null)).toBe('—')
    expect(web.formatPace(null)).toBe('—')
  })

  test('formatProjection agrees, and OMITS a projection that has already passed', () => {
    for (const ms of DURATIONS) {
      const at = ms === null ? null : NOW + ms
      expect(mobile.formatProjection(at, NOW)).toBe(web.formatProjection(at, NOW))
    }
    // No projection is the COMMON, GOOD case — the row is omitted, never dashed.
    expect(mobile.formatProjection(null, NOW)).toBeNull()
    // A projection in the past belongs to a stale reading, which the card is
    // already shouting about with a floored figure and an age chip. A dash there
    // would read as a failed computation.
    expect(mobile.formatProjection(NOW - 1, NOW)).toBeNull()
    expect(mobile.formatProjection(NOW + 9_000_000, NOW)).toBe('2h 30m')
  })

  test('formatPercent agrees, including outside 0..1', () => {
    for (const f of FRACTIONS) {
      expect(mobile.formatPercent(f)).toBe(web.formatPercent(f))
    }
  })

  test('paceNote agrees, and both say NOTHING about a null pace', () => {
    for (const p of PACES) {
      expect(mobile.paceNote(p)).toBe(web.paceNote(p))
    }
    expect(mobile.paceNote(null)).toBeNull()
    expect(web.paceNote(null)).toBeNull()
    // Exactly 1 is sustainable, not burning — the window refills as fast as it drains.
    expect(mobile.paceNote(1)).toBe(web.paceNote(1))
    expect(mobile.paceNote(1)).toContain('within')
  })

  test('accountName agrees, and NEITHER guesses', () => {
    for (const label of [null, 'acct-2', 'work']) {
      expect(mobile.accountName(label)).toBe(web.accountName(label))
    }
    expect(mobile.accountName(null)).toBe('active credential')
  })

  test('formatCountdown agrees, and NEITHER turns "unknown" into "now"', () => {
    for (const ms of COUNTDOWNS) {
      expect(mobile.formatCountdown(ms)).toBe(web.formatCountdown(ms))
    }
    // THE MUTANT THIS KILLS: an absent reset instant rendered as availability. It
    // is the render that would send the owner to raise concurrency into a wall, so
    // it is asserted on both clients by value, not just by agreement.
    expect(mobile.formatCountdown(null)).toBe('unknown')
    expect(web.formatCountdown(null)).toBe('unknown')
    expect(mobile.formatCountdown(null)).not.toBe('available now')
    expect(mobile.formatCountdown(null)).not.toBe('0m')
    // A reset that has passed IS availability — a fact about the clock, and the
    // one case where "now" is the true answer.
    expect(mobile.formatCountdown(0)).toBe('available now')
    expect(mobile.formatCountdown(-60_000)).toBe('available now')
    // The three shapes the owner asked for, by name.
    expect(mobile.formatCountdown(17 * 60_000)).toBe('17m')
    expect(mobile.formatCountdown(3 * 3_600_000 + 4 * 60_000)).toBe('3h 04m')
    expect(mobile.formatCountdown(2 * 86_400_000 + 5 * 3_600_000)).toBe('2d 5h')
  })

  test('formatAge agrees, and an unmeasured pool never reads as fresh', () => {
    for (const ms of COUNTDOWNS) {
      expect(mobile.formatAge(ms)).toBe(web.formatAge(ms))
    }
    expect(mobile.formatAge(null)).toBe('never measured')
    expect(mobile.formatAge(30_000)).toBe('just now')
    expect(mobile.formatAge(12 * 60_000)).toBe('12m ago')
  })

  test('windowName agrees, and comes from the LENGTH rather than a fixed label', () => {
    const CASES: Array<[('session' | 'weekly'), number | null]> = [
      ['session', 5 * 3_600_000],
      ['weekly', 7 * 86_400_000],
      ['session', 10_080 * 60_000],
      ['session', 10 * 60_000],
      ['session', 29_000],
      ['session', 1],
      ['session', 0],
      ['session', null],
      ['weekly', null],
    ]
    for (const [key, ms] of CASES) {
      expect(mobile.windowName(key, ms)).toBe(web.windowName(key, ms))
    }
    expect(mobile.windowName('session', 5 * 3_600_000)).toBe('5h window')
    expect(mobile.windowName('weekly', 7 * 86_400_000)).toBe('7d window')
    // A provider that reported no length is not given someone else's regime.
    expect(mobile.windowName('weekly', null)).toBe('long window')
  })

  test('a SUB-HOUR window is named in minutes — never "0h window"', () => {
    // THE MUTANT THIS KILLS: rounding a short window to hours. Kimi's endpoint can
    // report a length in minutes or seconds, so a 10-minute window is reachable, and
    // "0h window" is a fabricated zero printed with complete confidence — the one
    // thing this feature's doctrine says must be structurally impossible.
    for (const ms of [10 * 60_000, 29_000, 1]) {
      expect(mobile.windowName('session', ms)).toBe(web.windowName('session', ms))
      expect(web.windowName('session', ms)).not.toContain('0h')
    }
    expect(web.windowName('session', 10 * 60_000)).toBe('10m window')
    // Under thirty seconds still rounds UP to a minute rather than down to zero.
    expect(web.windowName('session', 1)).toBe('1m window')
    // A non-positive length is not a short window, it is an absent one.
    expect(web.windowName('session', 0)).toBe('short window')
  })

  test('formatWindowFraction agrees, and floors a stale reading rather than blanking it', () => {
    const live: web.ProjectedWindow = { ...WINDOW, floor: false }
    const stale: web.ProjectedWindow = { ...WINDOW, floor: true }
    expect(mobile.formatWindowFraction(live)).toBe(web.formatWindowFraction(live))
    expect(mobile.formatWindowFraction(stale)).toBe(web.formatWindowFraction(stale))
    expect(mobile.formatWindowFraction(live)).toBe('43%')
    expect(mobile.formatWindowFraction(stale)).toBe('≥ 43%')
  })

  test('capacityLine agrees on all three shapes', () => {
    // The line the owner asked for, verbatim.
    expect(line(AVAILABLE_POOL, NOW)).toBe('1 available now')
    // The countdown NAMES the binding window and reports the other one's
    // utilisation — a bare "next capacity in 17m" would be true of the 5h window
    // and false about capacity.
    expect(line(COOLING_POOL, NOW)).toBe('Next capacity in 3d 0h (7d window; 5h window 98% used)')
    expect(line(UNKNOWN_POOL, NOW)).toBe('Next capacity unknown (1 unknown)')
    // A pool with nothing measured has no standing to report, and both clients say
    // so by rendering no line at all — the empty state carries the useful sentence.
    expect(line(poolOf([]), NOW)).toBeNull()
  })

  test('the countdown shape counts the UNKNOWN accounts out loud too', () => {
    // THE MUTANT THIS KILLS: appending the "(N unknown)" suffix to the available and
    // unknown shapes but not to the countdown one — which is exactly the shape where
    // hiding an account is most expensive, because the line reads as a complete
    // account of the pool. One account returns in 25m, one cannot be vouched for.
    const pool = poolOf([
      { account_label: 'owner-a', session: win({ fraction: 0.99, reset_at: NOW + 25 * MINUTE }) },
      { account_label: 'owner-b', session: win({ fraction: 0.99, reset_at: null }) },
    ])
    expect(line(pool, NOW)).toBe('Next capacity in 25m (5h window) (1 unknown)')
  })

  test('the headline reports the OTHER window with its floor, exactly as the row does', () => {
    // THE MUTANT THIS KILLS: printing the other window's utilisation as an exact
    // percentage while the row beneath it says "≥" about the same number. One
    // reading may not be two claims, and the headline's would be the false one.
    const pool = poolOf(
      [
        {
          measured_at: NOW - 3 * HOUR,
          session: win({ fraction: 0.98, reset_at: NOW + 20 * MINUTE }),
          weekly: win({ fraction: 0.97, window_ms: WEEKLY_MS, reset_at: NOW + 3 * DAY }),
        },
      ],
      { measured_at: NOW - 3 * HOUR },
    )
    const view = project(pool, NOW)
    expect(view.accounts[0]!.stale).toBe(true)
    expect(view.capacity.next_other!.floor).toBe(true)
    expect(line(pool, NOW)).toBe('Next capacity in 3d 0h (7d window; 5h window ≥ 98% used)')
    // The row beneath says the same thing about the same number.
    expect(web.formatWindowFraction(view.accounts[0]!.session!)).toBe('≥ 98%')
  })

  test('accountCapacityNote agrees, and an unknown account says so', () => {
    for (const pool of [AVAILABLE_POOL, COOLING_POOL, UNKNOWN_POOL]) {
      const account = project(pool, NOW).accounts[0]!
      expect(mobile.accountCapacityNote(account)).toBe(web.accountCapacityNote(account))
    }
    expect(web.accountCapacityNote(project(UNKNOWN_POOL, NOW).accounts[0]!)).toBe(
      'capacity unknown',
    )
    expect(web.accountCapacityNote(project(AVAILABLE_POOL, NOW).accounts[0]!)).toBe(
      'available now',
    )
    expect(web.accountCapacityNote(project(COOLING_POOL, NOW).accounts[0]!)).toBe(
      'capacity in 3d 0h',
    )
  })

  test('NOTHING renders "in available now" once the payload outlives its own countdown', () => {
    // THE MUTANT THIS KILLS: interpolating `formatCountdown`'s zero sentinel into an
    // "in ‹…›" template. Both sentences that say "in" read a `returns` standing's
    // `in_ms`, which is positive by construction — a window whose reset has passed
    // is not returning, it has rolled — so the garble is unreachable rather than
    // merely untested. Here the same payload is projected an hour PAST the reset it
    // was showing a countdown to.
    const later = NOW + 4 * DAY
    const view = project(COOLING_POOL, later)
    expect(view.accounts[0]!.stale).toBe(true)
    expect(web.accountCapacityNote(view.accounts[0]!)).not.toContain('in available now')
    expect(line(COOLING_POOL, later)).not.toContain('in available now')
    // And what it says instead: the reading is far too old to claim anything.
    expect(web.accountCapacityNote(view.accounts[0]!)).toBe('capacity unknown')
    expect(line(COOLING_POOL, later)).toBe('Next capacity unknown (1 unknown)')
  })

  test('connectionNote agrees, and distinguishes the three empty cards', () => {
    for (const connection of ['connected', 'not_connected', 'no_meter'] as const) {
      const pool = project(poolOf([], { connection }), NOW)
      expect(mobile.connectionNote(pool)).toBe(web.connectionNote(pool))
    }
    // A card WITH readings needs no excuse.
    expect(web.connectionNote(project(AVAILABLE_POOL, NOW))).toBeNull()
    expect(web.connectionNote(project(poolOf([], { connection: 'not_connected' }), NOW))).toBe(
      'Not connected.',
    )
    expect(web.connectionNote(project(poolOf([], { connection: 'connected' }), NOW))).toBe(
      'No readings yet.',
    )
  })
})

describe('the two clients PROJECT identically — the policy, and the clock it runs on', () => {
  test('a KILLED poller AGES in front of the owner off ONE payload', () => {
    // THE BLOCKER FROM ROUND 1, and the acceptance case from the brief. The payload
    // is fetched once; the render clock ticks on its own. So the SAME bytes are
    // projected twice here, and the second projection is what an open tab actually
    // paints six hours later.
    //
    // The mutant this kills is a server-baked `age_ms`/`stale`/`floor`/`capacity`:
    // under it, both projections are identical and the card insists "just now,
    // available" about a poller that has been dead since breakfast, with a live
    // countdown ticking beside it.
    const pool = poolOf([{ session: win({ fraction: 0.42, reset_at: NOW + 4 * HOUR }) }], {
      pool: 'kimi',
      stale_after_ms: 20 * MINUTE,
    })
    const atFetch = project(pool, NOW)
    expect(atFetch.accounts[0]!.stale).toBe(false)
    expect(web.formatAge(atFetch.age_ms)).toBe('just now')
    expect(atFetch.accounts[0]!.session!.floor).toBe(false)
    expect(atFetch.accounts[0]!.capacity).toEqual({ state: 'available' })

    // Three hours later, off the same bytes. The window it described has not rolled
    // yet, so the last known figure is still a valid LOWER bound.
    const threeHoursLater = project(pool, NOW + 3 * HOUR)
    expect(threeHoursLater.accounts[0]!.age_ms).toBe(3 * HOUR)
    expect(web.formatAge(threeHoursLater.age_ms)).toBe('3h 00m ago')
    expect(threeHoursLater.accounts[0]!.stale).toBe(true)
    // The last known figure is still shown — floored and aged, never blanked and
    // never zeroed.
    expect(threeHoursLater.accounts[0]!.session!.fraction).toBe(0.42)
    expect(web.formatWindowFraction(threeHoursLater.accounts[0]!.session!)).toBe('≥ 42%')
    // And it may not claim room: usage only climbs between samples.
    expect(threeHoursLater.accounts[0]!.capacity).toEqual({ state: 'unknown' })
    expect(line(pool, NOW + 3 * HOUR)).toBe('Next capacity unknown (1 unknown)')
  })

  test('an ABSENT reset instant is unknown, NEVER now', () => {
    // The acceptance case, and the mutant it kills: turning "no instant" into
    // "available" is what would send the owner to raise concurrency into a wall.
    const view = project(UNKNOWN_POOL, NOW)
    expect(view.accounts[0]!.capacity).toEqual({ state: 'unknown' })
    expect(view.accounts[0]!.capacity.state).not.toBe('available')
    expect(web.accountCapacityNote(view.accounts[0]!)).toBe('capacity unknown')
    expect(web.accountCapacityNote(view.accounts[0]!)).not.toBe('available now')
  })

  test('an account with NO windows at all is unknown, not available', () => {
    const view = project(poolOf([{ session: null, weekly: null }]), NOW)
    expect(view.accounts[0]!.capacity).toEqual({ state: 'unknown' })
    expect(view.accounts[0]!.binding).toBeNull()
  })

  test('a STALE reading that says there is room cannot claim availability', () => {
    // Usage only climbs between samples, so "40% used, three hours ago" does not
    // prove there is room now. A dead poller must never read as an idle account.
    const roomy = poolOf([
      { measured_at: NOW - 3 * HOUR, session: win({ fraction: 0.4 }) },
    ])
    expect(project(roomy, NOW).accounts[0]!.capacity).toEqual({ state: 'unknown' })
    // The same reading FRESH is availability — so the refusal is about staleness,
    // not about the number.
    const fresh = poolOf([{ measured_at: NOW, session: win({ fraction: 0.4 }) }])
    expect(project(fresh, NOW).accounts[0]!.capacity).toEqual({ state: 'available' })
  })

  test('a STALE reading that says SPENT still yields a countdown', () => {
    // "At least 96% used" cannot become "less used" inside one window, so the reset
    // instant is still the honest answer to when capacity returns.
    const pool = poolOf([
      {
        measured_at: NOW - 3 * HOUR,
        session: win({ fraction: 0.96, reset_at: NOW + 40 * MINUTE }),
      },
    ])
    expect(project(pool, NOW).accounts[0]!.capacity).toEqual({
      state: 'returns',
      at: NOW + 40 * MINUTE,
      window: 'session',
      in_ms: 40 * MINUTE,
    })
  })

  test('a STALE reading whose window has ROLLED proves nothing — not availability', () => {
    // The subtle optimistic case. The reset instant passing is a fact about the
    // clock, so the window did roll — but consumption restarted and nobody measured
    // what happened next, and a poller dead for a week must not read as an account
    // that has just freed up.
    const rolledStale = poolOf([
      { measured_at: NOW - 8 * HOUR, session: win({ fraction: 0.9, reset_at: NOW - 2 * HOUR }) },
    ])
    expect(project(rolledStale, NOW).accounts[0]!.capacity).toEqual({ state: 'unknown' })
    // Freshly rolled, on the other hand, IS availability: the window turned over
    // moments ago and the reading is current.
    const rolledFresh = poolOf([
      { measured_at: NOW, session: win({ fraction: 0.9, reset_at: NOW - MINUTE }) },
    ])
    expect(project(rolledFresh, NOW).accounts[0]!.capacity).toEqual({ state: 'available' })
    // And a rolled window is not floored on either: "at least 90%" stopped being
    // true when consumption restarted from zero.
    expect(project(rolledStale, NOW).accounts[0]!.session!.floor).toBe(false)
  })

  test('an account is bound by its WORST window, not its soonest reset', () => {
    // The defect the owner found in the countdown as first specified: a 5-hour window
    // resetting in 17 minutes buys nothing while the 7-day window is spent for another
    // three days. The mutant that picks the soonest reset dies here.
    const view = project(
      poolOf([
        {
          session: win({ fraction: 0.95, reset_at: NOW + 17 * MINUTE }),
          weekly: win({ fraction: 0.96, window_ms: WEEKLY_MS, reset_at: NOW + 3 * DAY }),
        },
      ]),
      NOW,
    )
    expect(view.accounts[0]!.binding).toBe('weekly')
    expect(view.accounts[0]!.capacity).toEqual({
      state: 'returns',
      at: NOW + 3 * DAY,
      window: 'weekly',
      in_ms: 3 * DAY,
    })
  })

  test('room in both windows is availability, bound by the tighter one', () => {
    const view = project(
      poolOf([
        {
          session: win({ fraction: 0.2 }),
          weekly: win({ fraction: 0.35, window_ms: WEEKLY_MS, reset_at: NOW + 4 * DAY }),
        },
      ]),
      NOW,
    )
    expect(view.accounts[0]!.capacity).toEqual({ state: 'available' })
    expect(view.accounts[0]!.binding).toBe('weekly')
  })

  test('a window with under 5% left counts as spent — 1% is not capacity to push into', () => {
    const view = project(
      poolOf([{ session: win({ fraction: 0.97, reset_at: NOW + 20 * MINUTE }) }]),
      NOW,
    )
    expect(view.accounts[0]!.capacity.state).toBe('returns')
  })

  test('reset jitter is decided by TIME COMPARISON, never equality', () => {
    // Reset jitter is real: the same window's reported reset moves by seconds
    // between reads. Anything deciding "has this window rolled" by comparing
    // instants for EQUALITY would flip on that jitter alone. The comparison is
    // exercised on both sides of the boundary a millisecond apart — the property an
    // equality check cannot have.
    const at = (reset_at: number): web.UsagePool =>
      poolOf([{ session: win({ fraction: 0.99, reset_at }) }])
    expect(project(at(NOW + 1), NOW).accounts[0]!.capacity.state).toBe('returns')
    expect(project(at(NOW - 1), NOW).accounts[0]!.capacity.state).toBe('available')
    // And 8 seconds of jitter changes no decision, only the countdown it carries.
    const a = project(at(NOW + 17 * MINUTE), NOW).accounts[0]!.capacity
    const b = project(at(NOW + 17 * MINUTE + 8_000), NOW).accounts[0]!.capacity
    expect(a.state).toBe('returns')
    expect(b.state).toBe('returns')
    expect(b.state === 'returns' && a.state === 'returns' ? b.in_ms - a.in_ms : null).toBe(8_000)
  })

  test('the pool line points at the account with actual capacity, not the soonest reset', () => {
    // THE ACCEPTANCE CASE. Account A's 5-hour window resets in 17 minutes and its
    // 7-day window is nearly spent; account B is healthy. A headline that picked the
    // soonest reset would say "next capacity in 17m" and point at A — the answer
    // that sends the owner to raise concurrency into a wall.
    const pool = poolOf([
      {
        account_label: 'owner-a',
        session: win({ fraction: 0.98, reset_at: NOW + 17 * MINUTE }),
        weekly: win({ fraction: 0.97, window_ms: WEEKLY_MS, reset_at: NOW + 3 * DAY }),
      },
      {
        account_label: 'owner-b',
        session: win({ fraction: 0.2, reset_at: NOW + 2 * HOUR }),
        weekly: win({ fraction: 0.3, window_ms: WEEKLY_MS, reset_at: NOW + 5 * DAY }),
      },
    ])
    const view = project(pool, NOW)
    expect(view.capacity.available_now).toBe(1)
    expect(view.capacity.next_account_label).toBe('owner-b')
    expect(view.capacity.next).toEqual({ state: 'available' })
    expect(line(pool, NOW)).toBe('1 available now')
  })

  test('an account nobody can vouch for never becomes the headline', () => {
    // `unknown` sorts LAST. Pointing the owner at the account with no evidence is
    // the same optimism as calling an absent reset "now".
    const pool = poolOf([
      { account_label: 'owner-a', session: win({ fraction: 0.99, reset_at: null }) },
      { account_label: 'owner-b', session: win({ fraction: 0.99, reset_at: NOW + 25 * MINUTE }) },
    ])
    const view = project(pool, NOW)
    expect(view.capacity.unknown).toBe(1)
    expect(view.capacity.next_account_label).toBe('owner-b')
    expect(view.capacity.next).toEqual({
      state: 'returns',
      at: NOW + 25 * MINUTE,
      window: 'session',
      in_ms: 25 * MINUTE,
    })
  })

  test('the pool AGE comes off the pool instant, and "never measured" is not an age of zero', () => {
    const measured = project(poolOf([{ session: win({ fraction: 0.4 }) }]), NOW + 12 * MINUTE)
    expect(measured.age_ms).toBe(12 * MINUTE)
    expect(web.formatAge(measured.age_ms)).toBe('12m ago')
    const never = project(poolOf([], { measured_at: null }), NOW)
    expect(never.age_ms).toBeNull()
    expect(web.formatAge(never.age_ms)).toBe('never measured')
  })

  test('the staleness deadline comes off the PAYLOAD, so a pool with no cadence still goes stale', () => {
    // THE MUTANT THIS KILLS: a pool whose deadline is "never" — codex, whose gauge
    // is harvested rather than polled. A three-week-old harvested reading would then
    // render "available now" beside a "21d ago" chip. The deadline travels per pool,
    // so the client honours whichever one the server sent.
    const codex = poolOf([{ session: win({ fraction: 0.3, reset_at: NOW + HOUR }) }], {
      pool: 'codex',
      stale_after_ms: 30 * MINUTE,
      measured_at: NOW,
    })
    expect(project(codex, NOW + 20 * MINUTE).accounts[0]!.stale).toBe(false)
    const old = project(codex, NOW + 21 * DAY)
    expect(old.accounts[0]!.stale).toBe(true)
    expect(old.accounts[0]!.capacity).toEqual({ state: 'unknown' })
    expect(line(codex, NOW + 21 * DAY)).not.toContain('available now')
  })

  test('the deadline is a THRESHOLD, exercised on both sides of itself', () => {
    const pool = poolOf([{ session: win({ fraction: 0.4 }) }], { stale_after_ms: 2 * MINUTE })
    expect(project(pool, NOW + 2 * MINUTE).accounts[0]!.stale).toBe(false)
    expect(project(pool, NOW + 2 * MINUTE + 1).accounts[0]!.stale).toBe(true)
  })
})

describe('neither client re-declares the band or the clamp', () => {
  test('the twin exports NO band/clamp of its own — both take the contract', () => {
    // Not a style preference. `app` declares `@neutronai/contracts` and
    // `app/components/UsageMeter.tsx` already imports these, so a copy on the phone
    // buys a drift risk for nothing, and the drift it buys paints the same reading
    // two different colours on two screens the owner treats as one product.
    expect('usageBand' in mobile).toBe(false)
    expect('clampFraction' in mobile).toBe(false)
    expect('usageBand' in web).toBe(false)
    expect('clampFraction' in web).toBe(false)
  })

  test('the contract itself still bands at the boundaries both screens draw', () => {
    // A positive control on the shared source: if this ever stopped being the rule,
    // the assertion above would happily pass over two clients agreeing on nothing.
    expect(contractBand(0.849)).toBe('nominal')
    expect(contractBand(0.85)).toBe('warning')
    expect(contractBand(0.95)).toBe('critical')
  })
})

describe('the two decoders agree about what is an answer', () => {
  const CASES: unknown[] = [
    null,
    'nope',
    {},
    { pools: 'no' },
    { pools: [] },
    { pools: [{ pool: 'anthropic', measured_at: 1, session: null, weekly: null }] },
    { pools: [{ measured_at: 1 }] },
    { pools: [{ pool: 'anthropic', account_label: '', session: { fraction: 0.5 } }] },
    { pools: [{ pool: 'anthropic', session: { fraction: 'lots' } }] },
    {
      pools: [
        {
          pool: 'anthropic',
          connection: 'connected',
          measured_at: 2,
          stale_after_ms: 120_000,
          accounts: [
            {
              account_label: 'acct-2',
              measured_at: 2,
              session: {
                fraction: 0.5,
                window_ms: 18_000_000,
                reset_at: 9,
                pace: 1.2,
                exhausts_at: 11,
              },
              weekly: null,
            },
          ],
        },
      ],
    },
    // An account with no timestamp is not an account: there is nothing to age.
    { pools: [{ pool: 'kimi', accounts: [{ account_label: 'x' }] }] },
    // A payload from a server that predates the threshold.
    { pools: [{ pool: 'kimi', accounts: [{ measured_at: 1, session: { fraction: 0.2 } }] }] },
  ]

  test('every case decodes to the same value on both clients', () => {
    for (const raw of CASES) {
      expect(mobile.decodeDashboard(raw)).toEqual(web.decodeDashboard(raw))
    }
  })

  test('an EMPTY pools array is reachable on both — different from unreachable', () => {
    // Collapsing the two would hide a server that answered correctly, and the two
    // render differently: "No readings yet" versus "not available from this server".
    expect(mobile.decodeDashboard({ pools: [] })).toEqual({ reachable: true, pools: [] })
    expect(web.decodeDashboard({ pools: [] })).toEqual({ reachable: true, pools: [] })
    expect(mobile.DASHBOARD_UNREACHABLE.reachable).toBe(false)
    expect(web.DASHBOARD_UNREACHABLE.reachable).toBe(false)
  })

  test('an ABSENT staleness deadline decodes CAUTIOUSLY, never as "never stale"', () => {
    // THE MUTANT THIS KILLS is the round-1 `age_ms ?? 0`, one field over: an absent
    // field defaulting to maximum freshness. A version skew that drops the deadline
    // must make the card MORE careful, not turn an arbitrarily old reading into a
    // confident "just now, available".
    for (const bad of [undefined, null, 'soon', Number.NaN, 0, -1]) {
      const decoded = web.decodeDashboard({
        pools: [{ pool: 'kimi', stale_after_ms: bad, accounts: [{ measured_at: 1 }] }],
      })
      expect(decoded.reachable && decoded.pools[0]!.stale_after_ms).toBe(5 * MINUTE)
      expect(mobile.decodeDashboard({
        pools: [{ pool: 'kimi', stale_after_ms: bad, accounts: [{ measured_at: 1 }] }],
      })).toEqual(decoded)
    }
  })

  test('NEITHER decoder reads an age, a staleness verdict, a floor or a standing', () => {
    // Those four are the deltas, and a client that accepted a server's answer for
    // any of them would paint it unchanged for as long as the payload was held. A
    // payload carrying all four is decoded, and none of them survives.
    const raw = {
      pools: [
        {
          pool: 'kimi',
          measured_at: 1,
          age_ms: 0,
          stale: false,
          capacity: { available_now: 1, next: { state: 'available' } },
          accounts: [
            {
              account_label: 'owner-a',
              measured_at: 1,
              age_ms: 0,
              stale: false,
              binding: 'session',
              capacity: { state: 'available' },
              session: { fraction: 0.99, reset_at: null, resets_in_ms: 0, floor: false },
            },
          ],
        },
      ],
    }
    const decoded = web.decodeDashboard(raw)
    expect(mobile.decodeDashboard(raw)).toEqual(decoded)
    if (!decoded.reachable) throw new Error('unreachable: the fixture is a valid payload')
    const pool = decoded.pools[0]!
    expect(Object.keys(pool).sort()).toEqual(
      ['accounts', 'connection', 'measured_at', 'pool', 'stale_after_ms'].sort(),
    )
    expect(Object.keys(pool.accounts[0]!).sort()).toEqual(
      ['account_label', 'measured_at', 'session', 'weekly'].sort(),
    )
    expect(Object.keys(pool.accounts[0]!.session!).sort()).toEqual(
      ['exhausts_at', 'fraction', 'pace', 'reset_at', 'window_ms'].sort(),
    )
    // And the server's cheerful "available" is not what gets painted: the account
    // has no reset instant and 99% spent, so the honest answer is unknown.
    expect(web.projectPool(pool, 1).accounts[0]!.capacity).toEqual({ state: 'unknown' })
  })
})
