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
  POOL_STALE_AFTER_MS,
  USAGE_POOLS,
  USAGE_SAMPLE_RETENTION_MS,
  UsageSamplesStore,
  summariseWindow,
  type UsagePool,
} from './usage-samples-store.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const SESSION_MS = 5 * HOUR
const WEEKLY_MS = 7 * 24 * HOUR
const NOW = 1_800_000_000_000

/**
 * One reading, measured at `NOW` unless told otherwise.
 *
 * There is no `now` and no `stale` to pass, and that is the shape under test:
 * `summariseWindow` cannot see the render clock, so it cannot bake a delta that
 * would be wrong by the time it painted.
 */
function fresh(input: {
  fraction: number | null
  reset_at: number | null
  window_ms?: number | null
  measured_at?: number
}) {
  return summariseWindow({
    fraction: input.fraction,
    reset_at: input.reset_at,
    window_ms: input.window_ms === undefined ? SESSION_MS : input.window_ms,
    measured_at: input.measured_at ?? NOW,
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
      pace: null,
      exhausts_at: null,
    })
  })

  test('an UNKNOWN window length gives a fraction and a reset instant, but no pace', () => {
    // A provider that reports "62% used, resets at T" and no window length has told
    // us two true things and not the third. Pace divides by the length, so it is
    // refused — borrowing another pool's 5h/7d constant here would produce a
    // confident number about a window nobody measured.
    const out = fresh({ fraction: 0.62, reset_at: NOW + HOUR, window_ms: null })
    expect(out!.fraction).toBe(0.62)
    expect(out!.reset_at).toBe(NOW + HOUR)
    expect(out!.window_ms).toBeNull()
    expect(out!.pace).toBeNull()
    expect(out!.exhausts_at).toBeNull()
  })

  test('a full window projects nothing — there is nothing left to exhaust', () => {
    expect(fresh({ fraction: 1, reset_at: NOW + SESSION_MS / 2 })!.exhausts_at).toBeNull()
  })

  test('the reset is reported as an INSTANT, and there is no duration beside it', () => {
    // The window carries when it rolls — as the instant, not as "90 minutes". A
    // duration written into a response is a countdown frozen at response time, and a
    // client holding the payload would have no way to tell it from a live one. The
    // key list is exhaustive, so a well-meaning `resets_in_ms` convenience field
    // fails here rather than in review.
    const out = fresh({ fraction: 0.01, reset_at: NOW + 90 * MINUTE })!
    expect(out.reset_at).toBe(NOW + 90 * MINUTE)
    expect(Object.keys(out).sort()).toEqual(
      ['exhausts_at', 'fraction', 'pace', 'reset_at', 'window_ms'].sort(),
    )
  })

  test('an absent or non-finite fraction is no window at all', () => {
    expect(fresh({ fraction: null, reset_at: NOW })).toBeNull()
    expect(fresh({ fraction: Number.NaN, reset_at: NOW })).toBeNull()
    expect(fresh({ fraction: Number.POSITIVE_INFINITY, reset_at: NOW })).toBeNull()
  })
})

describe('pace-as-of-measurement — the sample anchors the maths, and there is no second clock', () => {
  test('pace for a 3h-old sample is computed AS OF the measurement', () => {
    // The mutation this kills: dividing by elapsed-as-of-NOW. Same reading, same
    // window; the render-clock version reports a calmer burn the longer the writer
    // has been dead, which is the exact opposite of what a dead writer should look
    // like. Both numbers are computed here so the difference is visible, not asserted
    // by assertion.
    const measured_at = NOW - 3 * HOUR
    const reset_at = measured_at + 2.5 * HOUR // half the 5h window had elapsed
    const out = fresh({ fraction: 0.75, reset_at, measured_at })!
    expect(out.pace).toBeCloseTo(1.5, 5)
    // What the render-clock version would have said, computed the wrong way on
    // purpose: elapsed grows to 1.1 windows, which is out of range and would have
    // reported NO pace at all on a window that was demonstrably burning at 1.5×.
    const elapsedByRenderClock = (NOW - (reset_at - SESSION_MS)) / SESSION_MS
    expect(elapsedByRenderClock).toBeGreaterThan(1)
    expect(out.pace).not.toBeNull()
  })

  test('NOTHING in the summary is a delta, so a held payload cannot go quietly wrong', async () => {
    // THE MUTANT THIS KILLS is the defect Argus found in round 1: an age, a
    // staleness verdict, a floor flag or a capacity standing computed when the
    // response was built. Every one of them is a function of `now`, and both clients
    // hold a payload between fetches while their own countdowns tick — so a baked
    // delta renders a poller that died hours ago as "just now, available".
    //
    // The refusal is STRUCTURAL rather than reviewed: this summary is identical
    // whatever the clock says, because nothing that produces it can read the clock.
    await store.record({
      pool: 'anthropic',
      ts: NOW,
      account_label: 'owner-a',
      session: 0.42,
      weekly: 0.6,
      session_reset_at: NOW + HOUR,
      weekly_reset_at: NOW + 3 * 24 * HOUR,
    })
    clock = NOW
    const atMeasurement = store.summarise('anthropic')
    clock = NOW + 9 * 24 * HOUR
    expect(store.summarise('anthropic')).toEqual(atMeasurement)
    // A positive control on the comparison: the clock really did move, and the store
    // really does read it elsewhere — `prune` runs off the same `now`, and at
    // NOW + 9d nothing is past the 30-day retention yet.
    clock = NOW + 40 * 24 * HOUR
    expect(await store.prune()).toBe(1)
  })

  test('the summary carries the measurement INSTANT and a staleness THRESHOLD, and no verdict', async () => {
    // The two halves of the age chip, split across the wire: the server owns the
    // instant and the deadline (facts), the client owns the subtraction (a delta).
    // The key lists are asserted exhaustively so re-adding `age_ms`, `stale`,
    // `floor` or `capacity` to the payload fails here rather than in review.
    await store.record({ pool: 'kimi', ts: NOW, session: 0.42 })
    const out = store.summarise('kimi')
    expect(out.measured_at).toBe(NOW)
    expect(out.stale_after_ms).toBe(POOL_STALE_AFTER_MS.kimi)
    expect(Object.keys(out).sort()).toEqual(
      ['accounts', 'measured_at', 'pool', 'stale_after_ms'].sort(),
    )
    expect(Object.keys(out.accounts[0]!).sort()).toEqual(
      ['account_label', 'measured_at', 'session', 'weekly'].sort(),
    )
  })
})

describe('reset-jitter — the instant travels as DATA, and is never rounded or equated', () => {
  test('two reports of the SAME window 8 seconds apart differ only by those 8 seconds', () => {
    // Reset jitter is real: the same window's reported reset moves by seconds between
    // reads. Nothing here may round it away or key a decision on two instants being
    // EQUAL — it passes through untouched, and the comparison that decides whether a
    // window has rolled happens at paint against the render clock, where the boundary
    // case is pinned (`gateway/__tests__/usage-dashboard-client-parity.test.ts`,
    // "reset jitter is decided by TIME COMPARISON, never equality").
    const a = fresh({ fraction: 0.97, reset_at: NOW + 17 * MINUTE })!
    const b = fresh({ fraction: 0.97, reset_at: NOW + 17 * MINUTE + 8_000 })!
    expect(b.reset_at! - a.reset_at!).toBe(8_000)
    // And the jitter changes nothing else about the reading.
    expect(b.fraction).toBe(a.fraction)
    expect(b.window_ms).toBe(a.window_ms)
  })

  test('a jittered reset survives the round trip through the series unrounded', async () => {
    // Storage is where a rounded-to-the-minute instant would creep in.
    const jittered = NOW + 17 * MINUTE + 8_123
    await store.record({ pool: 'anthropic', ts: NOW, session: 0.9, session_reset_at: jittered })
    expect(store.summarise('anthropic').accounts[0]!.session!.reset_at).toBe(jittered)
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

// THE CAPACITY POLICY IS NOT TESTED HERE ANY MORE, because it is not computed
// here any more. "What does this reading still prove", "an account is bound by its
// worst window", "an absent reset is unknown and never now" are all functions of
// the render clock, so they live in the two clients and are executed side by side
// over the same inputs by `gateway/__tests__/usage-dashboard-client-parity.test.ts`.

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
    expect(out.accounts).toEqual([])
    // A null instant is what the card renders as "never measured". The threshold is
    // still reported, because it describes the pool rather than any one reading.
    expect(out.stale_after_ms).toBe(POOL_STALE_AFTER_MS.codex)
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
    // The reading keeps its own measurement instant, three hours behind the pool's,
    // which is what lets the card age THIS account rather than the whole card.
    expect(b.measured_at).toBe(NOW - 3 * HOUR)
    expect(out.measured_at).toBe(NOW)
    // And three hours is past kimi's and anthropic's deadlines alike, so the client
    // will floor it — asserted here as the input to that decision, and asserted as
    // the rendered "≥" in the parity test.
    expect(out.measured_at! - b.measured_at).toBeGreaterThan(out.stale_after_ms)
  })

  test('a KILLED poller keeps its last reading and its instant — it never becomes a zero', async () => {
    // Half of the acceptance case; the other half is the render, pinned in the
    // parity test ("a KILLED poller ages in front of the owner"). The series must
    // still carry the last reading and the instant it was taken at, so the card can
    // age it. A summary that dropped either would leave the client with a blank,
    // which reads as no usage.
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
    expect(account.measured_at).toBe(NOW)
    // Three hours is well past kimi's deadline, so the client's verdict is settled
    // by these two numbers alone.
    expect(clock - account.measured_at).toBeGreaterThan(out.stale_after_ms)
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

  test('EVERY pool has a FINITE staleness deadline — including the one with no cadence', () => {
    // THE MUTANT THIS KILLS: `codex: null`, which made a harvested reading
    // permanently non-stale. A three-week-old sample would then have claimed
    // "available now" beside a "21d ago" chip — the confident-zero failure, one
    // level up. "No cadence" is a reason to pick a different deadline, never a
    // reason to have none.
    for (const pool of USAGE_POOLS) {
      const deadline = POOL_STALE_AFTER_MS[pool]
      expect(Number.isFinite(deadline)).toBe(true)
      expect(deadline).toBeGreaterThan(0)
    }
    expect(POOL_CADENCE_MS.codex).toBeNull()
    expect(POOL_STALE_AFTER_MS.codex).toBe(30 * MINUTE)
  })

  test('a polled pool tolerates exactly ONE missed probe before it is called stale', () => {
    // Zero grace blanks an account with headroom over a single flaky request: a
    // failed probe writes no row, so the account would read "unknown" for a whole
    // cadence. Two cadences survives one miss and still catches a writer that has
    // stopped — and the age chip is on the card the whole time either way.
    for (const pool of USAGE_POOLS) {
      const cadence = POOL_CADENCE_MS[pool]
      if (cadence === null) continue
      expect(POOL_STALE_AFTER_MS[pool]).toBe(cadence * 2)
    }
    // A positive control: the loop above asserts nothing if no pool has a cadence.
    expect(USAGE_POOLS.filter((p) => POOL_CADENCE_MS[p] !== null).length).toBeGreaterThan(1)
  })
})
