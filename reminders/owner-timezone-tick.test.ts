/**
 * @neutronai/reminders — a recurring reminder fires on the OWNER's wall clock,
 * never the host's.
 *
 * THE DEFECT THIS PINS. `ReminderTickLoop` took no timezone from the
 * composition and defaulted to `hostTimeZone()`. On a server set to `Etc/UTC`
 * with an owner in the Americas, a `0 21 * * *` evening cadence resolved as
 * 21:00 UTC and arrived mid-afternoon for the owner — a multi-hour error that
 * raises NO error: the reminder is delivered, on time by the machine's clock,
 * wrong by the only clock that matters. Every recurring reminder on the
 * instance was mistimed by the host-to-owner offset simultaneously.
 *
 * WHY THESE TESTS DO NOT DEPEND ON THE MACHINE RUNNING THEM. The whole bug is a
 * dependency on the host zone, so a test that is itself host-dependent proves
 * nothing — it would pass on a laptop already set to the owner's zone and stay
 * green on the UTC box that is broken. Two properties make these host-proof:
 *
 *   1. The oracle is WALL-CLOCK MEANING, not an epoch literal. Each test formats
 *      the computed fire instant back into the target zone and asserts it reads
 *      21:00 there. That question has the same answer on every machine.
 *   2. The zone matrix carries FOUR DISTINCT UTC OFFSETS (New York, Berlin,
 *      Tokyo, Auckland) plus UTC. A host has ONE zone, so it can coincide with
 *      at most one row — reverting the fix to a host fallback reds the matrix on
 *      literally any machine, including a UTC server and a laptop set to any one
 *      of the four. The host zone is thereby an input the test has already
 *      quantified over rather than an ambient condition it inherits.
 *
 * No assertion here reads a real clock: `now` is injected everywhere, so there
 * is no elapsed-time race to flake under load.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ReminderStore, type Reminder } from './store.ts'
import {
  REMINDER_FALLBACK_TIME_ZONE,
  ReminderTickLoop,
  type ReminderDispatcher,
} from './tick.ts'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-reminders-owner-tz-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const recordingDispatcher = (): ReminderDispatcher & { fired: Reminder[] } => {
  const fired: Reminder[] = []
  return { fired, dispatch: async (r) => { fired.push(r) } }
}

/** Render an instant as `HH:mm` on a given zone's wall clock. This is the
 *  oracle: it asks what the owner's clock would read, which is the only
 *  question the fix is about, and answers it identically on every host. */
const wallClockIn = (epoch_ms: number, tz: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epoch_ms))

/** Render an instant as `YYYY-MM-DD` on a given zone's wall clock. */
const calendarDayIn = (epoch_ms: number, tz: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epoch_ms))

/** Seed one already-due `0 21 * * *` row, tick once, return the advanced
 *  fire instant in ms. `zone` is what the owner-zone resolver reports;
 *  `undefined` means "no resolver wired" (the unknown-owner-zone path). */
async function nextEveningFire(opts: {
  now_ms: number
  zone?: string | null
  owner_slug?: string
}): Promise<number> {
  const store = new ReminderStore(db)
  const owner_slug = opts.owner_slug ?? 'inst'
  const row = await store.createRecurring({
    owner_slug,
    topic_id: null,
    fire_at: opts.now_ms / 1000 - 10, // already due
    message: 'evening wrap',
    recurrence_spec: '0 21 * * *',
  })
  const loopOpts: ConstructorParameters<typeof ReminderTickLoop>[0] = {
    store,
    dispatcher: recordingDispatcher(),
    now: () => opts.now_ms,
  }
  if (opts.zone !== undefined) loopOpts.resolve_time_zone = () => opts.zone ?? null
  const loop = new ReminderTickLoop(loopOpts)

  // Assert on THIS row rather than the tick's fired count: a test may call the
  // helper twice against the same db, and an earlier row left pending is due
  // again on the later anchor. The row's own advance is the claim being made.
  await loop.runOnce()
  const advanced = store.get(row.id)
  expect((advanced as Reminder).fire_at * 1000).toBeGreaterThan(opts.now_ms)
  // A mistimed reminder is the bug; a VANISHED one would be a worse bug, so
  // pin that the row stays a live recurring row through every zone path.
  expect(advanced?.status).toBe('pending')
  expect(advanced?.recurrence_spec).toBe('0 21 * * *')
  return (advanced as Reminder).fire_at * 1000
}

describe("a recurring cron resolves on the OWNER's wall clock", () => {
  // Four distinct UTC offsets. Any host matches at most one, so a host-zone
  // fallback cannot survive this table on any machine. Auckland is also the
  // southern-hemisphere case, where DST runs opposite to the northern rows.
  const ZONES: readonly string[] = [
    'America/New_York',
    'Europe/Berlin',
    'Asia/Tokyo',
    'Pacific/Auckland',
  ]

  for (const zone of ZONES) {
    test(`\`0 21 * * *\` fires at 21:00 in ${zone} — regardless of the host zone`, async () => {
      // Anchor: 2026-06-15 08:00 UTC. Mid-June is deliberate — the northern
      // zones are on summer time and Auckland is on standard time, so the row
      // is never accidentally correct via a zero-DST coincidence.
      const now_ms = Date.UTC(2026, 5, 15, 8, 0, 0)
      const fire_ms = await nextEveningFire({ now_ms, zone })

      expect(wallClockIn(fire_ms, zone)).toBe('21:00')
      // …and it is strictly in the future, i.e. a real next occurrence.
      expect(fire_ms).toBeGreaterThan(now_ms)
    })
  }

  test('the owner zone wins over UTC — a UTC host does not silently define 21:00', async () => {
    // The live failure, stated directly: on a UTC box the old code resolved
    // 21:00 as 21:00 UTC. For an owner in any of these zones that instant is
    // NOT their 9pm, and this asserts the difference rather than assuming it.
    const now_ms = Date.UTC(2026, 5, 15, 8, 0, 0)
    for (const zone of ZONES) {
      const fire_ms = await nextEveningFire({ now_ms, zone })
      expect(wallClockIn(fire_ms, zone)).toBe('21:00')
      expect(wallClockIn(fire_ms, 'UTC')).not.toBe('21:00')
    }
  })

  test('the resolver is asked PER FIRE, so a zone learned after boot applies without a restart', async () => {
    // Clients report their zone on connect, which routinely happens AFTER the
    // tick loop was constructed. Resolving once at construction would strand a
    // fresh install on the fallback until someone restarted the gateway.
    const store = new ReminderStore(db)
    let zone = 'Asia/Tokyo'
    let now_ms = Date.UTC(2026, 5, 15, 8, 0, 0)
    const row = await store.createRecurring({
      owner_slug: 'inst',
      topic_id: null,
      fire_at: now_ms / 1000 - 10,
      message: 'evening wrap',
      recurrence_spec: '0 21 * * *',
    })
    const loop = new ReminderTickLoop({
      store,
      dispatcher: recordingDispatcher(),
      now: () => now_ms,
      resolve_time_zone: () => zone,
    })

    await loop.runOnce()
    const firstFire = (store.get(row.id) as Reminder).fire_at * 1000
    expect(wallClockIn(firstFire, 'Asia/Tokyo')).toBe('21:00')

    // The owner's client now reports a different zone (they travelled, or this
    // is simply the first connect). Make the row due again and tick.
    zone = 'America/New_York'
    now_ms = firstFire
    await loop.runOnce()
    const secondFire = (store.get(row.id) as Reminder).fire_at * 1000
    expect(wallClockIn(secondFire, 'America/New_York')).toBe('21:00')
  })

  test('the resolver is keyed on the ROW owner, not a composition-time slug', async () => {
    const store = new ReminderStore(db)
    const now_ms = Date.UTC(2026, 5, 15, 8, 0, 0)
    await store.createRecurring({
      owner_slug: 'owner-a',
      topic_id: null,
      fire_at: now_ms / 1000 - 10,
      message: 'evening wrap',
      recurrence_spec: '0 21 * * *',
    })
    const seen: string[] = []
    const loop = new ReminderTickLoop({
      store,
      dispatcher: recordingDispatcher(),
      now: () => now_ms,
      resolve_time_zone: (owner_slug) => { seen.push(owner_slug); return 'Asia/Tokyo' },
    })
    await loop.runOnce()
    expect(seen).toEqual(['owner-a'])
  })
})

describe('DST — the same wall-clock hour on either side of a transition', () => {
  // A fixed UTC offset is the tempting wrong fix and would pass a single-date
  // test. These two dates straddle the 2026-03-08 US spring-forward, so the
  // SAME cadence must map to two DIFFERENT UTC instants to stay at 21:00.
  const ZONE = 'America/New_York'

  test('21:00 stays 21:00 before AND after spring-forward (offset shifts, wall clock does not)', async () => {
    const beforeDst = await nextEveningFire({
      now_ms: Date.UTC(2026, 2, 1, 12, 0, 0), // 2026-03-01, standard time
      zone: ZONE,
    })
    const afterDst = await nextEveningFire({
      now_ms: Date.UTC(2026, 2, 20, 12, 0, 0), // 2026-03-20, daylight time
      zone: ZONE,
    })

    // The owner's clock reads the same on both sides…
    expect(wallClockIn(beforeDst, ZONE)).toBe('21:00')
    expect(wallClockIn(afterDst, ZONE)).toBe('21:00')

    // …while the underlying UTC instant moved by exactly one hour, which is
    // precisely what a fixed-offset implementation cannot do.
    expect(wallClockIn(beforeDst, 'UTC')).toBe('02:00') // 21:00 EST = UTC-5
    expect(wallClockIn(afterDst, 'UTC')).toBe('01:00') // 21:00 EDT = UTC-4
  })

  test('the fall-back transition keeps the same wall-clock hour too', async () => {
    // 2026-11-01 is the US fall-back; bracket it the other way.
    const beforeEnd = await nextEveningFire({
      now_ms: Date.UTC(2026, 9, 20, 12, 0, 0), // 2026-10-20, daylight time
      zone: ZONE,
    })
    const afterEnd = await nextEveningFire({
      now_ms: Date.UTC(2026, 10, 10, 12, 0, 0), // 2026-11-10, standard time
      zone: ZONE,
    })
    expect(wallClockIn(beforeEnd, ZONE)).toBe('21:00')
    expect(wallClockIn(afterEnd, ZONE)).toBe('21:00')
    expect(wallClockIn(beforeEnd, 'UTC')).toBe('01:00')
    expect(wallClockIn(afterEnd, 'UTC')).toBe('02:00')
  })

  test('a southern-hemisphere zone transitions the opposite way, and still holds 21:00', async () => {
    // Auckland: DST ENDS in April and STARTS in September — the reverse of the
    // northern rows above, so a hemisphere-shaped assumption fails here.
    const inNzdt = await nextEveningFire({
      now_ms: Date.UTC(2026, 2, 1, 0, 0, 0), // March — NZDT (UTC+13)
      zone: 'Pacific/Auckland',
    })
    const inNzst = await nextEveningFire({
      now_ms: Date.UTC(2026, 5, 1, 0, 0, 0), // June — NZST (UTC+12)
      zone: 'Pacific/Auckland',
    })
    expect(wallClockIn(inNzdt, 'Pacific/Auckland')).toBe('21:00')
    expect(wallClockIn(inNzst, 'Pacific/Auckland')).toBe('21:00')
    expect(wallClockIn(inNzdt, 'UTC')).toBe('08:00') // 21:00 NZDT = UTC+13
    expect(wallClockIn(inNzst, 'UTC')).toBe('09:00') // 21:00 NZST = UTC+12
  })

  test('a late-evening weekday cadence lands on the intended OWNER day, not the host day', async () => {
    // The zone error is not only an hour error: in a zone behind UTC, a late
    // evening cadence sits on a DIFFERENT UTC calendar day, so resolving it on
    // the host's clock also breaks the `1-5` weekday filter — a Friday-night
    // ritual is evaluated against Saturday. 23:00 in a UTC-4 zone is 03:00 the
    // NEXT day in UTC.
    const store = new ReminderStore(db)
    // 2026-06-15 is a Monday; 12:00 UTC is 08:00 that morning in New York.
    const now_ms = Date.UTC(2026, 5, 15, 12, 0, 0)
    const row = await store.createRecurring({
      owner_slug: 'inst',
      topic_id: null,
      fire_at: now_ms / 1000 - 10,
      message: 'weeknight wrap',
      recurrence_spec: '0 23 * * 1-5',
    })
    const loop = new ReminderTickLoop({
      store,
      dispatcher: recordingDispatcher(),
      now: () => now_ms,
      resolve_time_zone: () => 'America/New_York',
    })
    await loop.runOnce()
    const fire_ms = (store.get(row.id) as Reminder).fire_at * 1000

    expect(wallClockIn(fire_ms, 'America/New_York')).toBe('23:00')
    // It is Monday evening on the OWNER's calendar…
    expect(calendarDayIn(fire_ms, 'America/New_York')).toBe('2026-06-15')
    // …while in UTC that instant is already Tuesday. A host-zone resolution
    // would have silently shifted the ritual a day.
    expect(calendarDayIn(fire_ms, 'UTC')).toBe('2026-06-16')
  })
})

describe('when the owner zone is unknown', () => {
  test('the fallback is an explicit constant, NOT whatever the host is set to', async () => {
    // Pinning the value is the point: it makes the honest-default decision a
    // reviewable fact rather than an emergent property of the deployment. If
    // someone reintroduces a host fallback, this stops meaning anything, so
    // the matrix above is what actually guards it — this guards the intent.
    expect(REMINDER_FALLBACK_TIME_ZONE).toBe('UTC')
  })

  test('no resolver wired → the cadence resolves in the fallback zone', async () => {
    const now_ms = Date.UTC(2026, 5, 15, 8, 0, 0)
    const fire_ms = await nextEveningFire({ now_ms })
    expect(wallClockIn(fire_ms, REMINDER_FALLBACK_TIME_ZONE)).toBe('21:00')
  })

  const UNKNOWN_ZONES: ReadonlyArray<readonly [string, string | null]> = [
    ['null (never reported)', null],
    ['an empty string (row present, column blank)', ''],
  ]

  for (const [label, value] of UNKNOWN_ZONES) {
    test(`a resolver returning ${label} falls back without retiring the reminder`, async () => {
      const now_ms = Date.UTC(2026, 5, 15, 8, 0, 0)
      const fire_ms = await nextEveningFire({ now_ms, zone: value })
      expect(wallClockIn(fire_ms, REMINDER_FALLBACK_TIME_ZONE)).toBe('21:00')
    })
  }

  test('a resolver that THROWS degrades to the fallback — the reminder survives a DB error', async () => {
    // Production reads SQLite here. A read failure must cost an hour of
    // accuracy, never the recurring row itself.
    const store = new ReminderStore(db)
    const now_ms = Date.UTC(2026, 5, 15, 8, 0, 0)
    const row = await store.createRecurring({
      owner_slug: 'inst',
      topic_id: null,
      fire_at: now_ms / 1000 - 10,
      message: 'evening wrap',
      recurrence_spec: '0 21 * * *',
    })
    const loop = new ReminderTickLoop({
      store,
      dispatcher: recordingDispatcher(),
      now: () => now_ms,
      resolve_time_zone: () => { throw new Error('database is locked') },
    })
    const result = await loop.runOnce()

    expect(result.fired).toBe(1)
    const advanced = store.get(row.id)
    expect(advanced?.status).toBe('pending')
    expect(wallClockIn((advanced as Reminder).fire_at * 1000, REMINDER_FALLBACK_TIME_ZONE)).toBe(
      '21:00',
    )
  })
})
