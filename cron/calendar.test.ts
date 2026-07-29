import { describe, expect, test } from 'bun:test'
import {
  hostTimeZone,
  nextFireAfter,
  parseOnCalendar,
  previousFireAtOrBefore,
  wallClockToEpoch,
  zonedParts,
  type CalendarSpec,
} from './calendar.ts'

const HOUR = 3_600_000
const DAY = 86_400_000

describe('parseOnCalendar — named shortcuts', () => {
  test('daily / hourly / weekly / monthly / minutely', () => {
    expect(parseOnCalendar('daily')).toEqual({
      daysOfWeek: null,
      dayOfMonth: null,
      hour: 0,
      minute: 0,
      second: 0,
    })
    expect(parseOnCalendar('hourly')).toEqual({
      daysOfWeek: null,
      dayOfMonth: null,
      hour: null,
      minute: 0,
      second: 0,
    })
    expect(parseOnCalendar('weekly')).toEqual({
      daysOfWeek: [1],
      dayOfMonth: null,
      hour: 0,
      minute: 0,
      second: 0,
    })
    expect(parseOnCalendar('monthly')).toEqual({
      daysOfWeek: null,
      dayOfMonth: 1,
      hour: 0,
      minute: 0,
      second: 0,
    })
    expect(parseOnCalendar('minutely')).toEqual({
      daysOfWeek: null,
      dayOfMonth: null,
      hour: null,
      minute: null,
      second: 0,
    })
  })

  test('shortcuts are case-insensitive', () => {
    expect(parseOnCalendar('DAILY')).toEqual(parseOnCalendar('daily'))
  })
})

describe('parseOnCalendar — explicit forms', () => {
  test('daily HH:MM(:SS) — full date, bare time, and seconds', () => {
    const expected: CalendarSpec = {
      daysOfWeek: null,
      dayOfMonth: null,
      hour: 9,
      minute: 0,
      second: 0,
    }
    expect(parseOnCalendar('*-*-* 09:00:00')).toEqual(expected)
    expect(parseOnCalendar('09:00')).toEqual(expected)
    expect(parseOnCalendar('*-*-* 09:00')).toEqual(expected)
    expect(parseOnCalendar('*-*-* 09:30:45')).toEqual({
      daysOfWeek: null,
      dayOfMonth: null,
      hour: 9,
      minute: 30,
      second: 45,
    })
  })

  test('weekly DOW HH:MM — single, list, and range', () => {
    expect(parseOnCalendar('Mon *-*-* 09:00:00').daysOfWeek).toEqual([1])
    expect(parseOnCalendar('Mon 09:00').daysOfWeek).toEqual([1])
    expect(parseOnCalendar('Mon,Fri 09:00').daysOfWeek).toEqual([1, 5])
    expect(parseOnCalendar('Mon..Fri 09:00').daysOfWeek).toEqual([1, 2, 3, 4, 5])
    // Sunday normalizes to 0; wrap-around range.
    expect(parseOnCalendar('Sun 09:00').daysOfWeek).toEqual([0])
    expect(parseOnCalendar('Fri..Mon 09:00').daysOfWeek).toEqual([0, 1, 5, 6])
    // Full weekday names are accepted (systemd allows both forms).
    expect(parseOnCalendar('Monday 09:00').daysOfWeek).toEqual([1])
    expect(parseOnCalendar('Monday..Friday 09:00').daysOfWeek).toEqual([1, 2, 3, 4, 5])
  })

  test('monthly DOM HH:MM', () => {
    expect(parseOnCalendar('*-*-15 09:30:00')).toEqual({
      daysOfWeek: null,
      dayOfMonth: 15,
      hour: 9,
      minute: 30,
      second: 0,
    })
  })

  test('hour/minute wildcards', () => {
    expect(parseOnCalendar('*-*-* *:15:00').hour).toBeNull()
    expect(parseOnCalendar('*-*-* *:15:00').minute).toBe(15)
  })
})

describe('parseOnCalendar — rejects out-of-subset grammar', () => {
  test.each([
    ['yearly', /year/i],
    ['2026-*-* 09:00:00', /year/i],
    ['*-06-* 09:00:00', /month-of-year/i],
    ['*-*-* *:*:*', /second/i],
    ['Funday 09:00', /weekday/i],
    ['Mon..Fri..Sun 09:00', /malformed weekday range/i],
    ['Mon.. 09:00', /malformed weekday range/i],
    ['Mon *-*-31 09:00:00', /combined weekday \+ day-of-month/i],
    ['MondayX 09:00', /weekday/i],
    ['Mon-Fri *-*-* 09:00:00', /weekday|Y-M-D/i],
    ['Mond 09:00', /weekday/i],
    ['Mon,,Fri 09:00', /empty weekday list element/i],
    ['Mon, 09:00', /empty weekday list element/i],
    ['*-*-99 09:00:00', /day-of-month/i],
    ['*-*-* 99:00:00', /hour/i],
    ['*-*-* 09:0/15:00', /minute/i],
    ['', /empty/i],
    ['nonsense', /shortcut|HH:MM/i],
  ])('throws on %p', (expr, re) => {
    expect(() => parseOnCalendar(expr)).toThrow(re as RegExp)
  })
})

describe('nextFireAfter — daily', () => {
  const spec = parseOnCalendar('*-*-* 09:00:00')
  const tz = 'UTC'

  test('later same day', () => {
    const from = wallClockToEpoch(2026, 6, 7, 8, 0, 0, tz)
    expect(nextFireAfter(spec, from, tz)).toBe(wallClockToEpoch(2026, 6, 7, 9, 0, 0, tz))
  })

  test('strictly after — exact match rolls to next day', () => {
    const from = wallClockToEpoch(2026, 6, 7, 9, 0, 0, tz)
    expect(nextFireAfter(spec, from, tz)).toBe(wallClockToEpoch(2026, 6, 8, 9, 0, 0, tz))
  })

  test('past today rolls to next day', () => {
    const from = wallClockToEpoch(2026, 6, 7, 10, 0, 0, tz)
    expect(nextFireAfter(spec, from, tz)).toBe(wallClockToEpoch(2026, 6, 8, 9, 0, 0, tz))
  })

  test('month rollover (Dec 31 → Jan 1)', () => {
    const from = wallClockToEpoch(2026, 12, 31, 10, 0, 0, tz)
    expect(nextFireAfter(spec, from, tz)).toBe(wallClockToEpoch(2027, 1, 1, 9, 0, 0, tz))
  })
})

describe('nextFireAfter — hourly', () => {
  test('next top of the hour', () => {
    const spec = parseOnCalendar('hourly')
    const tz = 'UTC'
    const from = wallClockToEpoch(2026, 6, 7, 8, 30, 0, tz)
    expect(nextFireAfter(spec, from, tz)).toBe(wallClockToEpoch(2026, 6, 7, 9, 0, 0, tz))
  })
})

describe('nextFireAfter — weekly', () => {
  const spec = parseOnCalendar('Mon *-*-* 09:00:00')
  const tz = 'UTC'

  test('Wednesday → next Monday', () => {
    // 2026-06-10 is a Wednesday.
    const from = wallClockToEpoch(2026, 6, 10, 12, 0, 0, tz)
    const next = nextFireAfter(spec, from, tz)
    expect(new Date(next).getUTCDay()).toBe(1)
    expect(zonedParts(next, tz).hour).toBe(9)
    expect(next).toBe(wallClockToEpoch(2026, 6, 15, 9, 0, 0, tz))
  })

  test('crosses a month boundary (Jul 30 Thu → Aug 3 Mon)', () => {
    const from = wallClockToEpoch(2026, 7, 30, 10, 0, 0, tz)
    const next = nextFireAfter(spec, from, tz)
    expect(new Date(next).getUTCDay()).toBe(1)
    expect(zonedParts(next, tz).month).toBe(8)
    expect(next).toBe(wallClockToEpoch(2026, 8, 3, 9, 0, 0, tz))
  })
})

describe('nextFireAfter — monthly', () => {
  const tz = 'UTC'

  test('day 1 → first of next month', () => {
    const spec = parseOnCalendar('*-*-01 09:00:00')
    const from = wallClockToEpoch(2026, 6, 15, 10, 0, 0, tz)
    expect(nextFireAfter(spec, from, tz)).toBe(wallClockToEpoch(2026, 7, 1, 9, 0, 0, tz))
  })

  test('day 31 skips short months (Feb → Mar 31)', () => {
    const spec = parseOnCalendar('*-*-31 09:00:00')
    const from = wallClockToEpoch(2026, 2, 15, 10, 0, 0, tz)
    expect(nextFireAfter(spec, from, tz)).toBe(wallClockToEpoch(2026, 3, 31, 9, 0, 0, tz))
  })
})

describe('nextFireAfter — DST boundaries (America/New_York)', () => {
  const tz = 'America/New_York'

  test('daily 09:00 across spring-forward (Mar 8 2026) — 23h day', () => {
    const spec = parseOnCalendar('*-*-* 09:00:00')
    const prior = wallClockToEpoch(2026, 3, 7, 9, 0, 0, tz)
    const next = nextFireAfter(spec, wallClockToEpoch(2026, 3, 7, 9, 30, 0, tz), tz)
    expect(next).toBe(wallClockToEpoch(2026, 3, 8, 9, 0, 0, tz))
    expect(zonedParts(next, tz).hour).toBe(9)
    expect(next - prior).toBe(23 * HOUR)
  })

  test('daily 09:00 across fall-back (Nov 1 2026) — 25h day', () => {
    const spec = parseOnCalendar('*-*-* 09:00:00')
    const prior = wallClockToEpoch(2026, 10, 31, 9, 0, 0, tz)
    const next = nextFireAfter(spec, wallClockToEpoch(2026, 10, 31, 9, 30, 0, tz), tz)
    expect(next).toBe(wallClockToEpoch(2026, 11, 1, 9, 0, 0, tz))
    expect(zonedParts(next, tz).hour).toBe(9)
    expect(next - prior).toBe(25 * HOUR)
  })

  test('skips a nonexistent spring-forward gap time (02:30 → next valid day)', () => {
    // 2026-03-08 the clock jumps 02:00 → 03:00, so 02:30 does not exist that
    // day. A daily 02:30 schedule must skip it (not fire an hour early at
    // 01:30) and land on the next day's real 02:30.
    const spec = parseOnCalendar('*-*-* 02:30:00')
    const from = wallClockToEpoch(2026, 3, 7, 3, 0, 0, tz)
    const next = nextFireAfter(spec, from, tz)
    const parts = zonedParts(next, tz)
    // Must be a real 02:30, NOT 01:30 on the gap day.
    expect(parts.hour).toBe(2)
    expect(parts.minute).toBe(30)
    expect(parts).toEqual({ year: 2026, month: 3, day: 9, hour: 2, minute: 30, second: 0 })
  })

  test('hourly skips the missing 02:00 hour on the spring-forward day', () => {
    const spec = parseOnCalendar('hourly')
    // From 01:30 EST the next top-of-hour is 03:00 EDT (02:00 doesn't exist).
    const from = wallClockToEpoch(2026, 3, 8, 1, 30, 0, tz)
    const next = nextFireAfter(spec, from, tz)
    expect(zonedParts(next, tz).hour).toBe(3)
  })

  test('minutely fires BOTH passes of the fall-back repeated hour', () => {
    // 2026-11-01: 02:00 EDT falls back to 01:00 EST, so 01:00-01:59 occurs
    // twice — first in EDT (UTC-4), then in EST (UTC-5).
    const spec = parseOnCalendar('minutely')
    const first0130 = Date.UTC(2026, 10, 1, 5, 30, 0) // 01:30 EDT
    const second0130 = Date.UTC(2026, 10, 1, 6, 30, 0) // 01:30 EST
    // After the FIRST 01:30, the next minute is the first 01:31 (not 02:00).
    expect(nextFireAfter(spec, first0130, tz)).toBe(Date.UTC(2026, 10, 1, 5, 31, 0))
    // After the SECOND 01:30, the next minute is the SECOND 01:31 — the bug was
    // jumping straight to 02:00 and dropping the repeated hour's fires.
    const afterSecond = nextFireAfter(spec, second0130, tz)
    expect(afterSecond).toBe(Date.UTC(2026, 10, 1, 6, 31, 0))
    expect(zonedParts(afterSecond, tz).hour).toBe(1)
    expect(zonedParts(afterSecond, tz).minute).toBe(31)
  })

  test('hourly fires the repeated 01:00 twice on the fall-back day', () => {
    const spec = parseOnCalendar('hourly')
    const first0100 = Date.UTC(2026, 10, 1, 5, 0, 0) // 01:00 EDT
    // The next hourly fire after the first 01:00 is the SECOND 01:00 (EST),
    // not 02:00.
    const next = nextFireAfter(spec, first0100, tz)
    expect(next).toBe(Date.UTC(2026, 10, 1, 6, 0, 0)) // 01:00 EST
    expect(zonedParts(next, tz).hour).toBe(1)
  })

  test('monthly day-1 09:00 lands on the fall-back day (Nov 1)', () => {
    const spec = parseOnCalendar('*-*-01 09:00:00')
    const from = wallClockToEpoch(2026, 10, 15, 10, 0, 0, tz)
    const next = nextFireAfter(spec, from, tz)
    const parts = zonedParts(next, tz)
    expect(parts.month).toBe(11)
    expect(parts.day).toBe(1)
    expect(parts.hour).toBe(9)
  })
})

describe('previousFireAtOrBefore', () => {
  const spec = parseOnCalendar('*-*-* 09:00:00')
  const tz = 'UTC'

  test('after today 09:00 → today 09:00', () => {
    const at = wallClockToEpoch(2026, 6, 7, 10, 0, 0, tz)
    expect(previousFireAtOrBefore(spec, at, tz)).toBe(wallClockToEpoch(2026, 6, 7, 9, 0, 0, tz))
  })

  test('before today 09:00 → yesterday 09:00', () => {
    const at = wallClockToEpoch(2026, 6, 7, 8, 0, 0, tz)
    expect(previousFireAtOrBefore(spec, at, tz)).toBe(wallClockToEpoch(2026, 6, 6, 9, 0, 0, tz))
  })

  test('exactly at 09:00 → that instant (inclusive)', () => {
    const at = wallClockToEpoch(2026, 6, 7, 9, 0, 0, tz)
    expect(previousFireAtOrBefore(spec, at, tz)).toBe(at)
  })

  test('weekly Mon from a Wednesday → that Monday', () => {
    const weekly = parseOnCalendar('Mon *-*-* 09:00:00')
    // 2026-06-10 Wed → prior Monday is 2026-06-08.
    const at = wallClockToEpoch(2026, 6, 10, 12, 0, 0, tz)
    expect(previousFireAtOrBefore(weekly, at, tz)).toBe(wallClockToEpoch(2026, 6, 8, 9, 0, 0, tz))
  })
})

describe('wallClockToEpoch / zonedParts round-trip', () => {
  test('round-trips a wall-clock time in a DST zone', () => {
    const tz = 'America/New_York'
    const epoch = wallClockToEpoch(2026, 7, 4, 14, 30, 15, tz)
    expect(zonedParts(epoch, tz)).toEqual({
      year: 2026,
      month: 7,
      day: 4,
      hour: 14,
      minute: 30,
      second: 15,
    })
  })

  test('hostTimeZone returns a non-empty IANA string', () => {
    expect(hostTimeZone().length).toBeGreaterThan(0)
  })
})

describe('nextFireAfter is monotonic across re-arm (no double-fire at exact instant)', () => {
  test('feeding the result back yields the next occurrence, not the same one', () => {
    const spec = parseOnCalendar('*-*-* 09:00:00')
    const tz = 'UTC'
    const first = nextFireAfter(spec, wallClockToEpoch(2026, 6, 7, 8, 0, 0, tz), tz)
    const second = nextFireAfter(spec, first, tz)
    expect(second).toBe(first + DAY)
  })
})
