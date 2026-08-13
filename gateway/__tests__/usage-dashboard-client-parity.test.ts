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
const HOUR = 3_600_000
const DAY = 24 * HOUR

const WINDOW: web.UsageWindow = {
  fraction: 0.43,
  window_ms: 5 * HOUR,
  reset_at: NOW + HOUR,
  resets_in_ms: HOUR,
  pace: 1.2,
  exhausts_at: NOW + 30 * 60_000,
  floor: false,
}

/** One pool per capacity shape — the three sentences the headline can be. */
function poolWith(
  account: Partial<web.UsageAccount>,
  capacity: Partial<web.PoolCapacity>,
): web.UsagePool {
  const full: web.UsageAccount = {
    account_label: 'owner-a',
    measured_at: NOW,
    age_ms: 0,
    stale: false,
    session: WINDOW,
    weekly: { ...WINDOW, window_ms: 7 * DAY, fraction: 0.5 },
    binding: 'session',
    capacity: { state: 'available' },
    ...account,
  }
  return {
    pool: 'anthropic',
    connection: 'connected',
    measured_at: NOW,
    age_ms: 0,
    accounts: [full],
    capacity: {
      available_now: 0,
      returning: 0,
      unknown: 0,
      next_account_label: full.account_label,
      next: { state: 'unknown' },
      next_other_window: null,
      next_other_fraction: null,
      ...capacity,
    },
  }
}

const AVAILABLE_POOL = poolWith({}, { available_now: 1, next: { state: 'available' } })
const COOLING_POOL = poolWith(
  {
    session: { ...WINDOW, fraction: 0.98 },
    weekly: { ...WINDOW, window_ms: 7 * DAY, fraction: 0.97, reset_at: NOW + 3 * DAY },
    binding: 'weekly',
    capacity: { state: 'returns', at: NOW + 3 * DAY, window: 'weekly' },
  },
  {
    returning: 1,
    next: { state: 'returns', at: NOW + 3 * DAY, window: 'weekly' },
    next_other_window: 'session',
    next_other_fraction: 0.98,
  },
)
const UNKNOWN_POOL = poolWith(
  { session: { ...WINDOW, fraction: 0.99, reset_at: null }, capacity: { state: 'unknown' } },
  { unknown: 1, next: { state: 'unknown' } },
)

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

  test('formatWindowFraction agrees, and floors a stale reading rather than blanking it', () => {
    const live = { ...WINDOW, floor: false }
    const stale = { ...WINDOW, floor: true }
    expect(mobile.formatWindowFraction(live)).toBe(web.formatWindowFraction(live))
    expect(mobile.formatWindowFraction(stale)).toBe(web.formatWindowFraction(stale))
    expect(mobile.formatWindowFraction(live)).toBe('43%')
    expect(mobile.formatWindowFraction(stale)).toBe('≥ 43%')
  })

  test('capacityLine agrees on all three shapes', () => {
    for (const pool of [AVAILABLE_POOL, COOLING_POOL, UNKNOWN_POOL]) {
      expect(mobile.capacityLine(pool, NOW)).toBe(web.capacityLine(pool, NOW))
    }
    // The line the owner asked for, verbatim.
    expect(mobile.capacityLine(AVAILABLE_POOL, NOW)).toBe('1 available now')
    // The countdown NAMES the binding window and reports the other one's
    // utilisation — a bare "next capacity in 17m" would be true of the 5h window
    // and false about capacity.
    expect(mobile.capacityLine(COOLING_POOL, NOW)).toBe(
      'Next capacity in 3d 0h (7d window; 5h window 98% used)',
    )
    expect(mobile.capacityLine(UNKNOWN_POOL, NOW)).toBe('Next capacity unknown (1 unknown)')
    // A pool with nothing measured has no standing to report, and both clients say
    // so by rendering no line at all — the empty state carries the useful sentence.
    const empty = { ...AVAILABLE_POOL, accounts: [] }
    expect(mobile.capacityLine(empty, NOW)).toBeNull()
    expect(web.capacityLine(empty, NOW)).toBeNull()
  })

  test('accountCapacityNote agrees, and an unknown account says so', () => {
    for (const account of [AVAILABLE_POOL.accounts[0]!, COOLING_POOL.accounts[0]!]) {
      expect(mobile.accountCapacityNote(account, NOW)).toBe(
        web.accountCapacityNote(account, NOW),
      )
    }
    expect(mobile.accountCapacityNote(UNKNOWN_POOL.accounts[0]!, NOW)).toBe('capacity unknown')
    expect(mobile.accountCapacityNote(AVAILABLE_POOL.accounts[0]!, NOW)).toBe('available now')
  })

  test('connectionNote agrees, and distinguishes the three empty cards', () => {
    for (const connection of ['connected', 'not_connected', 'no_meter'] as const) {
      const pool = { ...UNKNOWN_POOL, connection, accounts: [] }
      expect(mobile.connectionNote(pool)).toBe(web.connectionNote(pool))
    }
    // A card WITH readings needs no excuse.
    expect(mobile.connectionNote(AVAILABLE_POOL)).toBeNull()
    expect(mobile.connectionNote({ ...UNKNOWN_POOL, connection: 'not_connected', accounts: [] })).toBe(
      'Not connected.',
    )
    expect(
      mobile.connectionNote({ ...UNKNOWN_POOL, connection: 'connected', accounts: [] }),
    ).toBe('No readings yet.')
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
          age_ms: 1,
          accounts: [
            {
              account_label: 'acct-2',
              measured_at: 2,
              age_ms: 1,
              stale: false,
              session: {
                fraction: 0.5,
                window_ms: 18_000_000,
                reset_at: 9,
                resets_in_ms: 8,
                pace: 1.2,
                exhausts_at: 11,
                floor: false,
              },
              weekly: null,
              binding: 'session',
              capacity: { state: 'returns', at: 9, window: 'session' },
            },
          ],
          capacity: {
            available_now: 0,
            returning: 1,
            unknown: 0,
            next_account_label: 'acct-2',
            next: { state: 'returns', at: 9, window: 'session' },
            next_other_window: null,
            next_other_fraction: null,
          },
        },
      ],
    },
    // A capacity state neither client models. It must decode to UNKNOWN on both —
    // an unreadable standing may never become "push more work at it".
    { pools: [{ pool: 'kimi', accounts: [{ measured_at: 1, capacity: { state: 'maybe' } }] }] },
    // An account with no timestamp is not an account: there is nothing to age.
    { pools: [{ pool: 'kimi', accounts: [{ account_label: 'x' }] }] },
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
})
