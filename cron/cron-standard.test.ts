import { describe, expect, test } from 'bun:test'
import {
  isValidCron,
  nextCronFire,
  nextCronFireFromExpression,
  parseCron,
} from './cron-standard.ts'
import { zonedParts } from './calendar.ts'

const UTC = 'UTC'
const NY = 'America/New_York'

/** Assert that `next` renders the given wall-clock parts in `tz`. */
function expectWall(
  next: number,
  tz: string,
  want: Partial<{ year: number; month: number; day: number; hour: number; minute: number }>,
): void {
  const p = zonedParts(next, tz)
  for (const [k, v] of Object.entries(want)) {
    expect(p[k as keyof typeof p]).toBe(v as number)
  }
}

describe('parseCron — field expansion', () => {
  test('every-minute wildcard expands the whole field', () => {
    const spec = parseCron('* * * * *')
    expect(spec.minutes.length).toBe(60)
    expect(spec.hours.length).toBe(24)
    expect(spec.daysOfMonth.length).toBe(31)
    expect(spec.months.length).toBe(12)
    expect(spec.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(spec.domStar).toBe(true)
    expect(spec.dowStar).toBe(true)
  })

  test('single values', () => {
    const spec = parseCron('30 9 * * *')
    expect(spec.minutes).toEqual([30])
    expect(spec.hours).toEqual([9])
    expect(spec.domStar).toBe(true)
    expect(spec.dowStar).toBe(true)
  })

  test('step in hour field (*/6)', () => {
    expect(parseCron('0 */6 * * *').hours).toEqual([0, 6, 12, 18])
  })

  test('range in day-of-week (1-5 → Mon..Fri)', () => {
    expect(parseCron('0 9 * * 1-5').daysOfWeek).toEqual([1, 2, 3, 4, 5])
  })

  test('list in day-of-week (3,6)', () => {
    expect(parseCron('0 14 * * 3,6').daysOfWeek).toEqual([3, 6])
  })

  test('list in month (1,4,7,10)', () => {
    expect(parseCron('0 14 1 1,4,7,10 *').months).toEqual([1, 4, 7, 10])
  })

  test('sunday accepts both 0 and 7', () => {
    expect(parseCron('0 9 * * 0').daysOfWeek).toEqual([0])
    expect(parseCron('0 9 * * 7').daysOfWeek).toEqual([0])
  })

  test('month + weekday names (case-insensitive)', () => {
    expect(parseCron('0 9 * feb *').months).toEqual([2])
    expect(parseCron('0 9 * * MON-fri').daysOfWeek).toEqual([1, 2, 3, 4, 5])
  })

  test('a-b/s stepped range', () => {
    expect(parseCron('0-30/10 9 * * *').minutes).toEqual([0, 10, 20, 30])
  })
})

describe('parseCron — rejects invalid input', () => {
  test('wrong field count', () => {
    expect(() => parseCron('0 9 * *')).toThrow()
    expect(() => parseCron('0 9 * * * *')).toThrow()
  })
  test('out-of-range values', () => {
    expect(() => parseCron('60 9 * * *')).toThrow()
    expect(() => parseCron('0 24 * * *')).toThrow()
    expect(() => parseCron('0 9 32 * *')).toThrow()
    expect(() => parseCron('0 9 * 13 *')).toThrow()
  })
  test('non-numeric token', () => {
    expect(() => parseCron('x 9 * * *')).toThrow()
  })
  test('zero step', () => {
    expect(() => parseCron('*/0 9 * * *')).toThrow()
  })
  test('isValidCron mirrors parseCron', () => {
    expect(isValidCron('0 9 * * *')).toBe(true)
    expect(isValidCron('0 9 * * 1-5')).toBe(true)
    expect(isValidCron('nonsense')).toBe(false)
    expect(isValidCron(42)).toBe(false)
    expect(isValidCron('0 9 30 2 *')).toBe(true) // parses, but never fires
  })
})

describe('nextCronFire — daily / hourly cadence (UTC)', () => {
  test('daily 09:00 — next after 08:00 same day', () => {
    const after = Date.UTC(2026, 0, 15, 8, 0, 0)
    const next = nextCronFire(parseCron('0 9 * * *'), after, UTC)
    expect(next).toBe(Date.UTC(2026, 0, 15, 9, 0, 0))
  })

  test('daily 09:00 — next after 09:00 rolls to tomorrow (strictly greater)', () => {
    const after = Date.UTC(2026, 0, 15, 9, 0, 0)
    const next = nextCronFire(parseCron('0 9 * * *'), after, UTC)
    expect(next).toBe(Date.UTC(2026, 0, 16, 9, 0, 0))
  })

  test('30 9 daily lands at :30', () => {
    const after = Date.UTC(2026, 0, 15, 0, 0, 0)
    expectWall(nextCronFire(parseCron('30 9 * * *'), after, UTC), UTC, { hour: 9, minute: 30 })
  })

  test('every-6-hours picks the next 6h boundary', () => {
    const after = Date.UTC(2026, 0, 15, 7, 30, 0)
    const next = nextCronFire(parseCron('0 */6 * * *'), after, UTC)
    expect(next).toBe(Date.UTC(2026, 0, 15, 12, 0, 0))
  })
})

describe('nextCronFire — weekday / monthly / annual', () => {
  test('every Monday 09:00', () => {
    // 2026-01-15 is a Thursday; next Monday is 2026-01-19.
    const after = Date.UTC(2026, 0, 15, 12, 0, 0)
    const next = nextCronFire(parseCron('0 9 * * 1'), after, UTC)
    expect(next).toBe(Date.UTC(2026, 0, 19, 9, 0, 0))
    expect(new Date(next).getUTCDay()).toBe(1)
  })

  test('weekdays only (Mon-Fri) skips the weekend', () => {
    // 2026-01-16 is a Friday 10:00 → next weekday fire is Monday 2026-01-19.
    const after = Date.UTC(2026, 0, 16, 10, 0, 0)
    const next = nextCronFire(parseCron('0 9 * * 1-5'), after, UTC)
    expect(next).toBe(Date.UTC(2026, 0, 19, 9, 0, 0))
  })

  test('monthly on the 1st at 17:00', () => {
    const after = Date.UTC(2026, 0, 15, 0, 0, 0)
    const next = nextCronFire(parseCron('0 17 1 * *'), after, UTC)
    expect(next).toBe(Date.UTC(2026, 1, 1, 17, 0, 0))
  })

  test('annual (Feb 7 09:00) — rolls a full year when past', () => {
    const after = Date.UTC(2026, 5, 1, 0, 0, 0) // June 2026, past this year's Feb
    const next = nextCronFire(parseCron('0 9 7 2 *'), after, UTC)
    expect(next).toBe(Date.UTC(2027, 1, 7, 9, 0, 0))
  })

  test('quarterly (1st of Jan/Apr/Jul/Oct at 14:00)', () => {
    const after = Date.UTC(2026, 1, 15, 0, 0, 0) // mid-Feb
    const next = nextCronFire(parseCron('0 14 1 1,4,7,10 *'), after, UTC)
    expect(next).toBe(Date.UTC(2026, 3, 1, 14, 0, 0)) // Apr 1
  })
})

describe('nextCronFire — Vixie dom/dow OR semantics', () => {
  test('both dom and dow restricted → fire on EITHER', () => {
    // "0 0 13 * 5" = the 13th OR any Friday. 2026-02-01 is a Sunday.
    const spec = parseCron('0 0 13 * 5')
    const after = Date.UTC(2026, 1, 1, 0, 0, 0)
    // First Friday of Feb 2026 is the 6th; the 13th is also a Friday.
    const next = nextCronFire(spec, after, UTC)
    expect(next).toBe(Date.UTC(2026, 1, 6, 0, 0, 0))
  })

  test('only dom restricted → dow ignored', () => {
    const next = nextCronFire(parseCron('0 0 13 * *'), Date.UTC(2026, 1, 1), UTC)
    expect(next).toBe(Date.UTC(2026, 1, 13, 0, 0, 0))
  })
})

describe('nextCronFire — DST correctness (America/New_York)', () => {
  test('daily 09:00 stays at 09:00 local across spring-forward', () => {
    // US spring-forward 2026 is Sunday 2026-03-08 (02:00→03:00).
    const after = Date.UTC(2026, 2, 8, 4, 0, 0) // just after midnight ET on the DST day
    const next = nextCronFire(parseCron('0 9 * * *'), after, NY)
    expectWall(next, NY, { year: 2026, month: 3, day: 8, hour: 9, minute: 0 })
  })

  test('daily 09:00 stays at 09:00 local across fall-back', () => {
    // US fall-back 2026 is Sunday 2026-11-01.
    const after = Date.UTC(2026, 10, 1, 3, 0, 0)
    const next = nextCronFire(parseCron('0 9 * * *'), after, NY)
    expectWall(next, NY, { year: 2026, month: 11, day: 1, hour: 9, minute: 0 })
  })

  test('a 02:30 daily time in the spring-forward gap skips to the next valid day', () => {
    // 02:30 does not exist on 2026-03-08 in NY; the fire moves to 03-09 02:30.
    const after = Date.UTC(2026, 2, 8, 6, 0, 0) // after midnight ET, before a valid 02:30 that day
    const next = nextCronFire(parseCron('30 2 * * *'), after, NY)
    expectWall(next, NY, { month: 3, day: 9, hour: 2, minute: 30 })
  })
})

describe('nextCronFireFromExpression — convenience wrapper', () => {
  test('parses + computes in one call', () => {
    const after = Date.UTC(2026, 0, 15, 8, 0, 0)
    expect(nextCronFireFromExpression('0 9 * * *', after, UTC)).toBe(Date.UTC(2026, 0, 15, 9, 0, 0))
  })

  test('impossible date (Feb 30) throws', () => {
    expect(() => nextCronFireFromExpression('0 0 30 2 *', Date.UTC(2026, 0, 1), UTC)).toThrow()
  })
})
