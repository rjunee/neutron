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

  test('formatDuration agrees, including on the already-past cases', () => {
    for (const ms of DURATIONS) {
      expect(mobile.formatDuration(ms)).toBe(web.formatDuration(ms))
    }
    // A stale reading is not a negative duration and not "0m".
    expect(mobile.formatDuration(-1)).toBe('—')
    expect(mobile.formatDuration(0)).toBe('—')
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
          measured_at: 2,
          account_label: 'acct-2',
          session: { fraction: 0.5, reset_at: 9, resets_in_ms: 8, pace: 1.2, exhausts_at: 11 },
          weekly: { fraction: 0.1, reset_at: null, resets_in_ms: null, pace: null, exhausts_at: null },
        },
      ],
    },
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
