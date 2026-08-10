/**
 * THE USAGE SERIES — and the arithmetic that turns "72%" into a decision.
 *
 * The monitor has always measured the active credential every 60 seconds and thrown
 * every reading away, so the product could say how full a window was and not whether
 * that was climbing fast or flat. This is the store that remembers, plus the pace maths
 * read off it.
 *
 * THE WIRING TESTS LIVE IN `open/__tests__/usage-sample-persistence.test.ts`, not here:
 * `open` depends on `persistence` and never the reverse, so a test in this package
 * cannot import the monitor. The lint rule caught that, and the rule was right — the
 * dependency direction is the architecture, not an obstacle.
 *
 * WHAT THIS FILE MOSTLY TESTS IS THE REFUSALS. Getting a plausible number out of one
 * sample is easy and the numbers are hard to eyeball once rendered, so the cases that
 * matter are the ones where the honest answer is "I can't tell": a window that has
 * barely started, an unknown reset time, a projection that lands after the reset. Each
 * of those, answered confidently, is a dashboard that lies.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'

import { ProjectDb } from './db.ts'
import {
  USAGE_SAMPLE_RETENTION_MS,
  UsageSamplesStore,
  summariseWindow,
} from './usage-samples-store.ts'

const HOUR = 60 * 60 * 1000
const SESSION_MS = 5 * HOUR
const NOW = 1_800_000_000_000

let tmp: string
let db: ProjectDb
let store: UsageSamplesStore
let clock = NOW

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'usage-samples-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  clock = NOW
  store = new UsageSamplesStore({ db, now: () => clock })
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('summariseWindow — pace, and the cases where it refuses to answer', () => {
  test('HALF-ELAPSED at 75% is pace 1.5 — the hand-checkable case', () => {
    // A first draft of `exhausts_at` divided by pace twice, which is arithmetically
    // wrong and looks entirely plausible. This case is small enough to verify on
    // paper: 5h window, half gone, 75% used → 1.5×, and the remaining 25% at 1.5× of
    // a 5h window takes (0.25 / 1.5) × 5h = 50 minutes.
    const reset_at = NOW + SESSION_MS / 2
    const out = summariseWindow(0.75, reset_at, SESSION_MS, NOW)
    expect(out!.pace).toBeCloseTo(1.5, 5)
    expect(out!.exhausts_at! - NOW).toBe(Math.round((0.25 / 1.5) * SESSION_MS))
    expect(Math.round((out!.exhausts_at! - NOW) / 60_000)).toBe(50)
  })

  test('pace 1 exactly means keeping up, and projects NO exhaustion', () => {
    // The common, good case. Rendering a null projection as a warning would make the
    // dashboard cry wolf on every healthy window.
    const reset_at = NOW + SESSION_MS / 2
    const out = summariseWindow(0.5, reset_at, SESSION_MS, NOW)
    expect(out!.pace).toBeCloseTo(1, 5)
    expect(out!.exhausts_at).toBeNull()
  })

  test('a pace UNDER 1 projects nothing', () => {
    const reset_at = NOW + SESSION_MS / 2
    expect(summariseWindow(0.2, reset_at, SESSION_MS, NOW)!.exhausts_at).toBeNull()
  })

  test('a projection, when there is one, ALWAYS lands before the reset', () => {
    // Asserted as a PROPERTY over a grid rather than as one case, because it is a
    // mathematical fact rather than a branch: `pace > 1` means fraction > elapsed, and
    // the projected time to burn the remainder is then always shorter than the time
    // left in the window. The first version of this file carried an `at < reset_at`
    // guard for the opposite case; a mutation pass showed the guard could never fire,
    // and it was removed with the derivation written down instead of kept as untestable
    // "safety".
    let checked = 0
    for (let e = 5; e <= 95; e += 5) {
      for (let d = 1; d <= 20; d += 1) {
        const elapsed = e / 100
        const fraction = elapsed + d / 100
        if (fraction >= 1) continue
        const reset_at = NOW + Math.round((1 - elapsed) * SESSION_MS)
        const out = summariseWindow(fraction, reset_at, SESSION_MS, NOW)
        if (out!.pace === null || out!.pace <= 1) continue
        expect(out!.exhausts_at).not.toBeNull()
        expect(out!.exhausts_at!).toBeLessThan(reset_at)
        checked += 1
      }
    }
    // A positive control: a property test over an empty grid asserts nothing.
    expect(checked).toBeGreaterThan(100)
  })

  test('a BARELY-STARTED window refuses to report a pace', () => {
    // Two minutes into five hours, a single turn divides by ~0.007 and yields a pace
    // in the hundreds — correct arithmetic, useless answer, and it would tell the
    // owner they are about to run out of a window that just began.
    const reset_at = NOW + SESSION_MS - 2 * 60_000
    const out = summariseWindow(0.02, reset_at, SESSION_MS, NOW)
    expect(out!.pace).toBeNull()
    expect(out!.exhausts_at).toBeNull()
  })

  test('an UNKNOWN reset time gives a fraction and nothing derived', () => {
    // Upstream does not always send reset headers. The fraction is still true; pace
    // and time-to-reset are simply unknowable, and inventing them would be fabrication.
    const out = summariseWindow(0.8, null, SESSION_MS, NOW)
    expect(out).toEqual({
      fraction: 0.8,
      reset_at: null,
      resets_in_ms: null,
      pace: null,
      exhausts_at: null,
    })
  })

  test('a full window projects nothing — there is nothing left to exhaust', () => {
    const reset_at = NOW + SESSION_MS / 2
    expect(summariseWindow(1, reset_at, SESSION_MS, NOW)!.exhausts_at).toBeNull()
  })

  test('time-to-reset is reported even when pace is not', () => {
    const reset_at = NOW + 90 * 60_000
    const out = summariseWindow(0.01, reset_at, SESSION_MS, NOW)
    expect(out!.resets_in_ms).toBe(90 * 60_000)
  })

  test('an absent or non-finite fraction is no window at all', () => {
    expect(summariseWindow(null, NOW, SESSION_MS, NOW)).toBeNull()
    expect(summariseWindow(Number.NaN, NOW, SESSION_MS, NOW)).toBeNull()
    expect(summariseWindow(Number.POSITIVE_INFINITY, NOW, SESSION_MS, NOW)).toBeNull()
  })
})

describe('the store', () => {
  test('records and reads back the newest sample', async () => {
    expect(await store.record({ pool: 'anthropic', ts: NOW - 1000, session: 0.4, weekly: 0.2 })).toBe(true)
    await store.record({ pool: 'anthropic', ts: NOW, session: 0.5, weekly: 0.3 })
    const latest = store.latest('anthropic')
    expect(latest!.ts).toBe(NOW)
    expect(latest!.session).toBe(0.5)
  })

  test('a sample with NOTHING measurable is not written', async () => {
    // All-null rows would make "no data" indistinguishable from "we measured nothing",
    // which are different facts and lead to different actions.
    expect(await store.record({ pool: 'anthropic', session: null, weekly: null })).toBe(false)
    expect(store.count()).toBe(0)
  })

  test('one measurable half is enough', async () => {
    expect(await store.record({ pool: 'anthropic', session: 0.5, weekly: null })).toBe(true)
    expect(store.count()).toBe(1)
  })

  test('a NaN never enters the series', async () => {
    // A NaN in the data is worse than a gap: it propagates silently through every
    // derived number downstream.
    await store.record({ pool: 'anthropic', ts: NOW, session: Number.NaN, weekly: 0.3 })
    expect(store.latest('anthropic')!.session).toBeNull()
  })

  test('a double write in the same millisecond UPDATES rather than duplicating', async () => {
    await store.record({ pool: 'anthropic', ts: NOW, session: 0.4, weekly: 0.2 })
    await store.record({ pool: 'anthropic', ts: NOW, session: 0.6, weekly: 0.2 })
    expect(store.count()).toBe(1)
    expect(store.latest('anthropic')!.session).toBe(0.6)
  })

  test('the account label is null unless something can actually name one', async () => {
    // The swap happens outside this process, so the instance genuinely cannot name the
    // account. An inferred name shown as a measurement is worse than no name.
    await store.record({ pool: 'anthropic', ts: NOW, session: 0.5 })
    expect(store.latest('anthropic')!.account_label).toBeNull()
    await store.record({ pool: 'anthropic', ts: NOW + 1, session: 0.5, account_label: '   ' })
    expect(store.latest('anthropic')!.account_label).toBeNull()
    await store.record({ pool: 'anthropic', ts: NOW + 2, session: 0.5, account_label: ' acct-2 ' })
    expect(store.latest('anthropic')!.account_label).toBe('acct-2')
  })

  test('prune drops samples past retention and keeps the rest', async () => {
    await store.record({ pool: 'anthropic', ts: NOW - USAGE_SAMPLE_RETENTION_MS - 1, session: 0.1 })
    await store.record({ pool: 'anthropic', ts: NOW - HOUR, session: 0.2 })
    expect(store.count()).toBe(2)
    expect(await store.prune()).toBe(1)
    expect(store.count()).toBe(1)
    expect(store.latest('anthropic')!.session).toBe(0.2)
  })

  test('prune on an empty series is a no-op, not an error', async () => {
    expect(await store.prune()).toBe(0)
  })
})

describe('summarise — what the dashboard receives', () => {
  test('an EMPTY series returns a summary with null windows, not an error', async () => {
    // A dashboard whose first render is a failure state teaches the owner to distrust
    // it. "No readings yet" is a state; a thrown error is a bug report.
    const out = store.summarise('anthropic')
    expect(out).toEqual({
      pool: 'anthropic',
      measured_at: null,
      account_label: null,
      session: null,
      weekly: null,
    })
  })

  test('both windows are summarised from the newest sample', async () => {
    await store.record({
      pool: 'anthropic',
      ts: NOW,
      session: 0.75,
      weekly: 0.5,
      session_reset_at: NOW + SESSION_MS / 2,
      weekly_reset_at: NOW + 3.5 * 24 * HOUR,
    })
    const out = store.summarise('anthropic')
    expect(out.measured_at).toBe(NOW)
    expect(out.session!.pace).toBeCloseTo(1.5, 5)
    // The weekly window at half-elapsed and half-consumed is exactly keeping up.
    expect(out.weekly!.pace).toBeCloseTo(1, 5)
    expect(out.weekly!.exhausts_at).toBeNull()
  })

  test('a pool with no samples of its own is unaffected by another pool', async () => {
    // Only one pool exists today, but the table is keyed by pool and a summarise that
    // ignored the key would report the wrong pool's numbers the moment a second lands.
    await store.record({ pool: 'anthropic', ts: NOW, session: 0.9 });
    expect(store.summarise('anthropic').session!.fraction).toBe(0.9)
  })
})
