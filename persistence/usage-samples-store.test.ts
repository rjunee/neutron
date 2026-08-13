/**
 * THE USAGE SERIES — and the arithmetic that turns "72%" into a decision.
 *
 * Two decisions, actually, and they are opposites. PACE answers "at this rate, when
 * do I hit the cap". THE RESET COUNTDOWN answers "when does capacity come back",
 * which is the input to the throughput question the owner actually asks: how hard
 * can I push concurrency right now. Both ship; neither replaces the other.
 *
 * THE WIRING TESTS LIVE IN `open/__tests__/`, not here: `open` depends on
 * `persistence` and never the reverse, so a test in this package cannot import the
 * monitors. The lint rule caught that, and the rule was right — the dependency
 * direction is the architecture, not an obstacle.
 *
 * WHAT THIS FILE MOSTLY TESTS IS THE REFUSALS. Getting a plausible number out of one
 * sample is easy and the numbers are hard to eyeball once rendered, so the cases that
 * matter are the ones where the honest answer is "I can't tell": a window that has
 * barely started, an unknown reset time, a stale reading that used to say there was
 * room. Each of those, answered confidently, is a dashboard that lies — and the
 * expensive lie here is the optimistic one, because it ends with the owner raising
 * concurrency into a wall.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'

import { ProjectDb } from './db.ts'
import {
  POOL_CADENCE_MS,
  USAGE_POOLS,
  USAGE_SAMPLE_RETENTION_MS,
  UsageSamplesStore,
  accountCapacity,
  summariseWindow,
  windowCapacity,
  type UsagePool,
} from './usage-samples-store.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const SESSION_MS = 5 * HOUR
const WEEKLY_MS = 7 * 24 * HOUR
const NOW = 1_800_000_000_000

/** The common case: a fresh reading, both clocks the same. */
function fresh(input: {
  fraction: number | null
  reset_at: number | null
  window_ms?: number | null
  now?: number
}) {
  return summariseWindow({
    fraction: input.fraction,
    reset_at: input.reset_at,
    window_ms: input.window_ms === undefined ? SESSION_MS : input.window_ms,
    measured_at: input.now ?? NOW,
    now: input.now ?? NOW,
    stale: false,
  })
}

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
    const out = fresh({ fraction: 0.75, reset_at })
    expect(out!.pace).toBeCloseTo(1.5, 5)
    expect(out!.exhausts_at! - NOW).toBe(Math.round((0.25 / 1.5) * SESSION_MS))
    expect(Math.round((out!.exhausts_at! - NOW) / MINUTE)).toBe(50)
  })

  test('pace 1 exactly means keeping up, and projects NO exhaustion', () => {
    // The common, good case. Rendering a null projection as a warning would make the
    // dashboard cry wolf on every healthy window.
    const out = fresh({ fraction: 0.5, reset_at: NOW + SESSION_MS / 2 })
    expect(out!.pace).toBeCloseTo(1, 5)
    expect(out!.exhausts_at).toBeNull()
  })

  test('a pace UNDER 1 projects nothing', () => {
    expect(fresh({ fraction: 0.2, reset_at: NOW + SESSION_MS / 2 })!.exhausts_at).toBeNull()
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
        const out = fresh({ fraction, reset_at })
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
    const out = fresh({ fraction: 0.02, reset_at: NOW + SESSION_MS - 2 * MINUTE })
    expect(out!.pace).toBeNull()
    expect(out!.exhausts_at).toBeNull()
  })

  test('an UNKNOWN reset time gives a fraction and nothing derived', () => {
    // Upstream does not always send reset headers. The fraction is still true; pace
    // and time-to-reset are simply unknowable, and inventing them would be fabrication.
    expect(fresh({ fraction: 0.8, reset_at: null })).toEqual({
      fraction: 0.8,
      window_ms: SESSION_MS,
      reset_at: null,
      resets_in_ms: null,
      pace: null,
      exhausts_at: null,
      floor: false,
    })
  })

  test('an UNKNOWN window length gives a fraction and a countdown, but no pace', () => {
    // A provider that reports "62% used, resets at T" and no window length has told
    // us two true things and not the third. Pace divides by the length, so it is
    // refused — borrowing another pool's 5h/7d constant here would produce a
    // confident number about a window nobody measured.
    const out = fresh({ fraction: 0.62, reset_at: NOW + HOUR, window_ms: null })
    expect(out!.fraction).toBe(0.62)
    expect(out!.resets_in_ms).toBe(HOUR)
    expect(out!.window_ms).toBeNull()
    expect(out!.pace).toBeNull()
    expect(out!.exhausts_at).toBeNull()
  })

  test('a full window projects nothing — there is nothing left to exhaust', () => {
    expect(fresh({ fraction: 1, reset_at: NOW + SESSION_MS / 2 })!.exhausts_at).toBeNull()
  })

  test('time-to-reset is reported even when pace is not', () => {
    expect(fresh({ fraction: 0.01, reset_at: NOW + 90 * MINUTE })!.resets_in_ms).toBe(90 * MINUTE)
  })

  test('an absent or non-finite fraction is no window at all', () => {
    expect(fresh({ fraction: null, reset_at: NOW })).toBeNull()
    expect(fresh({ fraction: Number.NaN, reset_at: NOW })).toBeNull()
    expect(fresh({ fraction: Number.POSITIVE_INFINITY, reset_at: NOW })).toBeNull()
  })
})

describe('stale-pace-as-of-measurement — the sample anchors the maths, the clock anchors the countdown', () => {
  test('pace for a 3h-old sample is computed AS OF the measurement', () => {
    // The mutation this kills: dividing by elapsed-as-of-NOW. Same reading, same
    // window; the render-clock version reports a calmer burn the longer the writer
    // has been dead, which is the exact opposite of what a dead writer should look
    // like. Both numbers are computed here so the difference is visible, not asserted
    // by assertion.
    const measured_at = NOW - 3 * HOUR
    const reset_at = measured_at + 2.5 * HOUR // half the 5h window had elapsed
    const out = summariseWindow({
      fraction: 0.75,
      reset_at,
      window_ms: SESSION_MS,
      measured_at,
      now: NOW,
      stale: true,
    })!
    expect(out.pace).toBeCloseTo(1.5, 5)
    // What the render-clock version would have said, computed the wrong way on
    // purpose: elapsed grows to 1.1 windows, which is out of range and would have
    // reported NO pace at all on a window that was demonstrably burning at 1.5×.
    const elapsedByRenderClock = (NOW - (reset_at - SESSION_MS)) / SESSION_MS
    expect(elapsedByRenderClock).toBeGreaterThan(1)
    expect(out.pace).not.toBeNull()
  })

  test('the COUNTDOWN uses the render clock even when the pace does not', () => {
    // Two clocks in one summary, and mixing them either way is a bug. The reset is a
    // fact about the future and does not age; the fraction is a fact about the past
    // and does.
    const measured_at = NOW - 2 * HOUR
    const out = summariseWindow({
      fraction: 0.4,
      reset_at: NOW + 40 * MINUTE,
      window_ms: SESSION_MS,
      measured_at,
      now: NOW,
      stale: true,
    })!
    expect(out.resets_in_ms).toBe(40 * MINUTE)
  })

  test('a stale reading is a FLOOR while its window is still running, and not after', () => {
    // Consumption only climbs inside a window, so an old 43% means "at least 43%".
    // Once the window has rolled that stops being true, and claiming it would
    // overstate usage on exactly the account that just freed up.
    const running = summariseWindow({
      fraction: 0.43,
      reset_at: NOW + HOUR,
      window_ms: SESSION_MS,
      measured_at: NOW - 2 * HOUR,
      now: NOW,
      stale: true,
    })!
    expect(running.floor).toBe(true)
    const rolled = summariseWindow({
      fraction: 0.43,
      reset_at: NOW - MINUTE,
      window_ms: SESSION_MS,
      measured_at: NOW - 2 * HOUR,
      now: NOW,
      stale: true,
    })!
    expect(rolled.floor).toBe(false)
    // And a FRESH reading is never floored: "≥ 43%" on a 20-second-old sample is
    // noise that teaches the eye to ignore the marking that matters.
    expect(fresh({ fraction: 0.43, reset_at: NOW + HOUR })!.floor).toBe(false)
  })
})

describe('reset-jitter-window-membership — decided by TIME COMPARISON, never equality', () => {
  test('two reports of the SAME window 8 seconds apart classify identically', () => {
    // Reset jitter is real: the same window's reported reset moves by seconds between
    // reads. Anything that decided "is this still the window I measured" by comparing
    // instants for EQUALITY would flip classification on that jitter alone. Here the
    // jitter passes through as data (the countdowns differ by exactly 8s) and changes
    // no decision.
    const a = fresh({ fraction: 0.97, reset_at: NOW + 17 * MINUTE })!
    const b = fresh({ fraction: 0.97, reset_at: NOW + 17 * MINUTE + 8_000 })!
    expect(windowCapacity(a, 'session', NOW, false)).toEqual({
      state: 'returns',
      at: NOW + 17 * MINUTE,
      window: 'session',
    })
    expect(windowCapacity(b, 'session', NOW, false)).toEqual({
      state: 'returns',
      at: NOW + 17 * MINUTE + 8_000,
      window: 'session',
    })
    expect(b.resets_in_ms! - a.resets_in_ms!).toBe(8_000)
  })

  test('membership is "has the instant passed", so a jitter across NOW is a rolled window', () => {
    // The comparison, exercised on both sides of the boundary a millisecond apart —
    // the property an equality check cannot have.
    const justBefore = fresh({ fraction: 0.99, reset_at: NOW + 1 })!
    const justAfter = fresh({ fraction: 0.99, reset_at: NOW - 1 })!
    expect(windowCapacity(justBefore, 'session', NOW, false)!.state).toBe('returns')
    expect(windowCapacity(justAfter, 'session', NOW, false)!.state).toBe('available')
  })
})

describe('window-regime — the length travels with the sample, never as one constant', () => {
  test('a series straddling a regime change summarises each sample with its OWN window', async () => {
    // Codex changed its short window from 300 to 10,080 minutes. A summary that
    // applied one constant across the series would report a confidently wrong pace on
    // one side of the change — and the wrongness is invisible, because both answers
    // are plausible numbers.
    const OLD_REGIME = 300 * MINUTE
    const NEW_REGIME = 10_080 * MINUTE
    await store.record({
      pool: 'codex',
      ts: NOW - 10 * HOUR,
      account_label: 'owner',
      session: 0.5,
      session_reset_at: NOW - 10 * HOUR + OLD_REGIME / 2,
      session_window_ms: OLD_REGIME,
    })
    await store.record({
      pool: 'codex',
      ts: NOW,
      account_label: 'owner',
      session: 0.5,
      session_reset_at: NOW + NEW_REGIME / 2,
      session_window_ms: NEW_REGIME,
    })
    const win = store.summarise('codex').accounts[0]!.session!
    expect(win.window_ms).toBe(NEW_REGIME)
    // Half elapsed, half consumed → pace 1 under the sample's OWN regime. Under the
    // old constant the same reading divides by an elapsed fraction over 16, which is
    // out of range and reports no pace at all.
    expect(win.pace).toBeCloseTo(1, 5)
    const underOldConstant = summariseWindow({
      fraction: 0.5,
      reset_at: NOW + NEW_REGIME / 2,
      window_ms: OLD_REGIME,
      measured_at: NOW,
      now: NOW,
      stale: false,
    })!
    expect(underOldConstant.pace).toBeNull()
  })

  test("a pool's default is used only when the sample reported no length", async () => {
    // Anthropic's probe reads utilisation and resets and no length, and its regime is
    // documented — so the default fills in. It is per pool, never global: borrowing
    // 5h/7d for a provider that never said so is the same fabrication one layer down.
    await store.record({
      pool: 'anthropic',
      ts: NOW,
      session: 0.75,
      session_reset_at: NOW + SESSION_MS / 2,
    })
    expect(store.summarise('anthropic').accounts[0]!.session!.window_ms).toBe(SESSION_MS)
    await store.record({ pool: 'kimi', ts: NOW, session: 0.75, session_reset_at: NOW + HOUR })
    const kimi = store.summarise('kimi').accounts[0]!.session!
    expect(kimi.window_ms).toBeNull()
    expect(kimi.pace).toBeNull()
  })
})

describe('capacity — when does capacity come back, and never optimistically', () => {
  test('an ABSENT reset instant is unknown, NEVER now', () => {
    // The acceptance case, and the mutant it kills: turning "no instant" into
    // "available" is what would send the owner to raise concurrency into a wall.
    const spent = fresh({ fraction: 0.99, reset_at: null })!
    expect(windowCapacity(spent, 'session', NOW, false)).toEqual({ state: 'unknown' })
    const account = accountCapacity(spent, null, NOW, false)
    expect(account.capacity).toEqual({ state: 'unknown' })
    expect(account.capacity.state).not.toBe('available')
  })

  test('an account with NO windows at all is unknown, not available', () => {
    expect(accountCapacity(null, null, NOW, false).capacity).toEqual({ state: 'unknown' })
  })

  test('a STALE reading that says there is room cannot claim availability', () => {
    // Usage only climbs between samples, so "40% used, three hours ago" does not
    // prove there is room now. A dead poller must never read as an idle account.
    const roomy = summariseWindow({
      fraction: 0.4,
      reset_at: NOW + HOUR,
      window_ms: SESSION_MS,
      measured_at: NOW - 3 * HOUR,
      now: NOW,
      stale: true,
    })!
    expect(windowCapacity(roomy, 'session', NOW, true)).toEqual({ state: 'unknown' })
    // The same reading fresh IS availability — so the refusal is about staleness,
    // not about the number.
    expect(windowCapacity(roomy, 'session', NOW, false)).toEqual({ state: 'available' })
  })

  test('a STALE reading that says SPENT still yields a countdown', () => {
    // "At least 96% used" cannot become "less used" inside one window, so the reset
    // instant is still the honest answer to when capacity returns.
    const spent = summariseWindow({
      fraction: 0.96,
      reset_at: NOW + 40 * MINUTE,
      window_ms: SESSION_MS,
      measured_at: NOW - 3 * HOUR,
      now: NOW,
      stale: true,
    })!
    expect(windowCapacity(spent, 'session', NOW, true)).toEqual({
      state: 'returns',
      at: NOW + 40 * MINUTE,
      window: 'session',
    })
  })

  test('a STALE reading whose window has ROLLED proves nothing — not availability', () => {
    // The subtle optimistic case. The reset instant passing is a fact about the
    // clock, so the window did roll — but consumption restarted and nobody measured
    // what happened next, and a poller dead for a week must not read as an account
    // that has just freed up.
    const rolledStale = summariseWindow({
      fraction: 0.9,
      reset_at: NOW - 2 * HOUR,
      window_ms: SESSION_MS,
      measured_at: NOW - 8 * HOUR,
      now: NOW,
      stale: true,
    })!
    expect(windowCapacity(rolledStale, 'session', NOW, true)).toEqual({ state: 'unknown' })
    // Freshly rolled, on the other hand, IS availability: the window turned over
    // moments ago and the reading is current.
    const rolledFresh = summariseWindow({
      fraction: 0.9,
      reset_at: NOW - MINUTE,
      window_ms: SESSION_MS,
      measured_at: NOW,
      now: NOW,
      stale: false,
    })!
    expect(windowCapacity(rolledFresh, 'session', NOW, false)).toEqual({ state: 'available' })
  })

  test('an account is bound by its WORST window, not its soonest reset', () => {
    // The defect the owner found in the countdown as first specified: a 5-hour window
    // resetting in 17 minutes buys nothing while the 7-day window is spent for another
    // three days. The mutant that picks the soonest reset dies here.
    const session = fresh({ fraction: 0.95, reset_at: NOW + 17 * MINUTE })!
    const weekly = fresh({
      fraction: 0.96,
      reset_at: NOW + 3 * 24 * HOUR,
      window_ms: WEEKLY_MS,
    })!
    const out = accountCapacity(session, weekly, NOW, false)
    expect(out.binding).toBe('weekly')
    expect(out.capacity).toEqual({
      state: 'returns',
      at: NOW + 3 * 24 * HOUR,
      window: 'weekly',
    })
  })

  test('room in both windows is availability, bound by the tighter one', () => {
    const session = fresh({ fraction: 0.2, reset_at: NOW + HOUR })!
    const weekly = fresh({ fraction: 0.35, reset_at: NOW + 4 * 24 * HOUR, window_ms: WEEKLY_MS })!
    const out = accountCapacity(session, weekly, NOW, false)
    expect(out.capacity).toEqual({ state: 'available' })
    expect(out.binding).toBe('weekly')
  })

  test('a window with under 5% left counts as spent — 1% is not capacity to push into', () => {
    const almost = fresh({ fraction: 0.97, reset_at: NOW + 20 * MINUTE })!
    expect(windowCapacity(almost, 'session', NOW, false)!.state).toBe('returns')
  })
})

describe('the store', () => {
  test('records and reads back the newest sample', async () => {
    expect(
      await store.record({ pool: 'anthropic', ts: NOW - 1000, session: 0.4, weekly: 0.2 }),
    ).toBe(true)
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

  test('two ACCOUNTS in the same millisecond are two rows, not one overwrite', async () => {
    // The reason 0121 widened the key. Under `(ts, pool)` the second write updated
    // the first account's row in place, so one account's numbers were served under
    // the other's name and nothing anywhere could tell.
    await store.record({ pool: 'anthropic', ts: NOW, account_label: 'owner-a', session: 0.2 })
    await store.record({ pool: 'anthropic', ts: NOW, account_label: 'owner-b', session: 0.9 })
    expect(store.count()).toBe(2)
    const byLabel = new Map(
      store.latestPerAccount('anthropic').map((s) => [s.account_label, s.session]),
    )
    expect(byLabel.get('owner-a')).toBe(0.2)
    expect(byLabel.get('owner-b')).toBe(0.9)
  })

  test('the account label is null unless something can actually name one', async () => {
    // The swap happens outside this process, so the instance genuinely cannot name the
    // account. An inferred name shown as a measurement is worse than no name — and the
    // empty string the key stores for "unnamed" must never surface as a name either.
    await store.record({ pool: 'anthropic', ts: NOW, session: 0.5 })
    expect(store.latest('anthropic')!.account_label).toBeNull()
    await store.record({ pool: 'anthropic', ts: NOW + 1, session: 0.5, account_label: '   ' })
    expect(store.latest('anthropic')!.account_label).toBeNull()
    await store.record({ pool: 'anthropic', ts: NOW + 2, session: 0.5, account_label: ' acct-2 ' })
    expect(store.latest('anthropic')!.account_label).toBe('acct-2')
    expect(store.summarise('anthropic').accounts.map((a) => a.account_label)).toContain(null)
  })

  test('prune drops samples past retention and keeps the rest', async () => {
    await store.record({
      pool: 'anthropic',
      ts: NOW - USAGE_SAMPLE_RETENTION_MS - 1,
      session: 0.1,
    })
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
  test('an EMPTY series returns a summary with no accounts, not an error', async () => {
    // A dashboard whose first render is a failure state teaches the owner to distrust
    // it. "No readings yet" is a state; a thrown error is a bug report. And the
    // headline for a pool nobody has measured is UNKNOWN — never "available now".
    const out = store.summarise('codex')
    expect(out.pool).toBe('codex')
    expect(out.measured_at).toBeNull()
    expect(out.age_ms).toBeNull()
    expect(out.accounts).toEqual([])
    expect(out.capacity.next).toEqual({ state: 'unknown' })
    expect(out.capacity.available_now).toBe(0)
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
    expect(out.age_ms).toBe(0)
    const account = out.accounts[0]!
    expect(account.session!.pace).toBeCloseTo(1.5, 5)
    // The weekly window at half-elapsed and half-consumed is exactly keeping up.
    expect(account.weekly!.pace).toBeCloseTo(1, 5)
    expect(account.weekly!.exhausts_at).toBeNull()
  })

  test('a pool with no samples of its own is unaffected by another pool', async () => {
    await store.record({ pool: 'anthropic', ts: NOW, session: 0.9 })
    expect(store.summarise('anthropic').accounts[0]!.session!.fraction).toBe(0.9)
    expect(store.summarise('kimi').accounts).toEqual([])
  })

  test('EVERY account keeps BOTH windows, so a non-active account has an answer', async () => {
    // The question the owner asked and could not get answered: "how much weekly
    // capacity does account X have left" — for an account that is not the one being
    // probed right now. The series has to carry it, with its age, or the card has
    // nothing but a blank that reads as zero usage.
    await store.record({
      pool: 'anthropic',
      ts: NOW - 3 * HOUR,
      account_label: 'owner-b',
      session: 0.1,
      weekly: 0.64,
      session_reset_at: NOW + HOUR,
      weekly_reset_at: NOW + 2 * 24 * HOUR,
    })
    await store.record({
      pool: 'anthropic',
      ts: NOW,
      account_label: 'owner-a',
      session: 0.2,
      weekly: 0.3,
      session_reset_at: NOW + 2 * HOUR,
      weekly_reset_at: NOW + 4 * 24 * HOUR,
    })
    const out = store.summarise('anthropic')
    expect(out.accounts).toHaveLength(2)
    // Newest first — the account being probed leads the card.
    expect(out.accounts[0]!.account_label).toBe('owner-a')
    const b = out.accounts[1]!
    expect(b.weekly!.fraction).toBe(0.64)
    expect(b.age_ms).toBe(3 * HOUR)
    expect(b.stale).toBe(true)
    // Its figures are floored and aged, never fresh-looking and never blank.
    expect(b.weekly!.floor).toBe(true)
  })

  test('the pool line points at the account with actual capacity, not the soonest reset', async () => {
    // THE ACCEPTANCE CASE. Account A's 5-hour window resets in 17 minutes and its
    // 7-day window is nearly spent; account B is healthy. A headline that picked the
    // soonest reset would say "next capacity in 17m" and point at A — the answer that
    // sends the owner to raise concurrency into a wall.
    await store.record({
      pool: 'anthropic',
      ts: NOW,
      account_label: 'owner-a',
      session: 0.98,
      weekly: 0.97,
      session_reset_at: NOW + 17 * MINUTE,
      weekly_reset_at: NOW + 3 * 24 * HOUR,
    })
    await store.record({
      pool: 'anthropic',
      ts: NOW,
      account_label: 'owner-b',
      session: 0.2,
      weekly: 0.3,
      session_reset_at: NOW + 2 * HOUR,
      weekly_reset_at: NOW + 5 * 24 * HOUR,
    })
    const capacity = store.summarise('anthropic').capacity
    expect(capacity.available_now).toBe(1)
    expect(capacity.next_account_label).toBe('owner-b')
    expect(capacity.next).toEqual({ state: 'available' })
  })

  test('with every account cooling, the headline names the binding window and the other one', async () => {
    // "next capacity in 3d (7d window; 5h window 98% used)" — the countdown paired
    // with the utilisation of the window it belongs to, and the other window named so
    // the line cannot be read as unconditional capacity.
    await store.record({
      pool: 'anthropic',
      ts: NOW,
      account_label: 'owner-a',
      session: 0.98,
      weekly: 0.97,
      session_reset_at: NOW + 17 * MINUTE,
      weekly_reset_at: NOW + 3 * 24 * HOUR,
    })
    const capacity = store.summarise('anthropic').capacity
    expect(capacity.available_now).toBe(0)
    expect(capacity.returning).toBe(1)
    expect(capacity.next).toEqual({
      state: 'returns',
      at: NOW + 3 * 24 * HOUR,
      window: 'weekly',
    })
    expect(capacity.next_other_window).toBe('session')
    expect(capacity.next_other_fraction).toBe(0.98)
  })

  test('an account nobody can vouch for never becomes the headline', async () => {
    // `unknown` sorts LAST. Pointing the owner at the account with no evidence is the
    // same optimism as calling an absent reset "now".
    await store.record({
      pool: 'anthropic',
      ts: NOW,
      account_label: 'owner-a',
      session: 0.99,
      session_reset_at: null,
    })
    await store.record({
      pool: 'anthropic',
      ts: NOW,
      account_label: 'owner-b',
      session: 0.99,
      session_reset_at: NOW + 25 * MINUTE,
    })
    const capacity = store.summarise('anthropic').capacity
    expect(capacity.unknown).toBe(1)
    expect(capacity.next_account_label).toBe('owner-b')
    expect(capacity.next).toEqual({
      state: 'returns',
      at: NOW + 25 * MINUTE,
      window: 'session',
    })
  })

  test('a KILLED poller ages the card — it never becomes a zero', async () => {
    // The other acceptance case. Nothing writes for three hours: the card must still
    // carry the last reading, marked with its age, and must not claim availability
    // off it.
    await store.record({
      pool: 'kimi',
      ts: NOW,
      session: 0.42,
      session_reset_at: NOW + 4 * HOUR,
      session_window_ms: 5 * HOUR,
    })
    clock = NOW + 3 * HOUR
    const out = store.summarise('kimi')
    const account = out.accounts[0]!
    expect(account.session!.fraction).toBe(0.42)
    expect(account.age_ms).toBe(3 * HOUR)
    expect(account.stale).toBe(true)
    expect(account.session!.floor).toBe(true)
    expect(account.capacity).toEqual({ state: 'unknown' })
  })
})

describe('the pool vocabulary', () => {
  test('every rendered pool has a cadence entry, and the two lists agree', () => {
    // A pool added to one list and not the other renders with an undefined cadence,
    // which would silently mean "never stale".
    for (const pool of USAGE_POOLS) expect(pool in POOL_CADENCE_MS).toBe(true)
    expect([...USAGE_POOLS].sort()).toEqual(
      (Object.keys(POOL_CADENCE_MS) as UsagePool[]).sort(),
    )
  })
})
