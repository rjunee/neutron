/**
 * Calendar Core S1 — free-busy slot derivation tests.
 *
 * Pure deterministic cases over `findFreeSlots`. Covers:
 *   - basic slot selection over a 2-attendee freebusy set
 *   - granularity boundary alignment
 *   - empty-attendee passthrough
 *   - preferred-hours filter (default 09:00-18:00)
 *   - top-N max_slots cap
 *   - merge of overlapping busy intervals
 */

import { describe, expect, test } from 'bun:test'

import {
  findFreeSlots,
  mergeIntervals,
  type FindFreeSlotsInput,
} from '../src/free-busy.ts'

describe('mergeIntervals', () => {
  test('drops malformed intervals (NaN start or end)', () => {
    const merged = mergeIntervals([
      { start: 'not-a-date', end: '2026-05-20T11:00:00Z' },
      { start: '2026-05-20T10:00:00Z', end: '2026-05-20T11:00:00Z' },
    ])
    expect(merged).toHaveLength(1)
  })

  test('coalesces overlapping intervals', () => {
    const merged = mergeIntervals([
      { start: '2026-05-20T10:00:00Z', end: '2026-05-20T11:00:00Z' },
      { start: '2026-05-20T10:30:00Z', end: '2026-05-20T11:30:00Z' },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.end_ms).toBe(Date.parse('2026-05-20T11:30:00Z'))
  })

  test('coalesces adjacent intervals (touching boundaries)', () => {
    const merged = mergeIntervals([
      { start: '2026-05-20T10:00:00Z', end: '2026-05-20T11:00:00Z' },
      { start: '2026-05-20T11:00:00Z', end: '2026-05-20T12:00:00Z' },
    ])
    expect(merged).toHaveLength(1)
  })

  test('preserves non-overlapping intervals', () => {
    const merged = mergeIntervals([
      { start: '2026-05-20T10:00:00Z', end: '2026-05-20T11:00:00Z' },
      { start: '2026-05-20T13:00:00Z', end: '2026-05-20T14:00:00Z' },
    ])
    expect(merged).toHaveLength(2)
  })
})

describe('findFreeSlots', () => {
  // Anchor every test on a UTC window where the local-hour filter
  // (default 09:00-18:00) admits the same slots regardless of test
  // env tz — pass `clock_local_hour_of` to read the raw UTC hour so
  // the default preferred_hours window applies in UTC.
  const utcHourOf = (iso: string): number => new Date(iso).getUTCHours()

  test('returns top-N free slots over a clear window', () => {
    const input: FindFreeSlotsInput = {
      attendees: ['a@x.com', 'b@x.com'],
      duration_minutes: 30,
      window_start: '2026-05-21T09:00:00Z',
      window_end: '2026-05-21T18:00:00Z',
      granularity_minutes: 30,
      max_slots: 3,
      per_attendee_busy: [[], []],
      clock_local_hour_of: utcHourOf,
    }
    const out = findFreeSlots(input)
    expect(out).toHaveLength(3)
    // First slot starts at 09:00 local hour with 30-min granularity.
    expect(out[0]?.start).toContain('T09:00')
    expect(out[0]?.attendees).toEqual(['a@x.com', 'b@x.com'])
  })

  test('rejects slots overlapping any busy interval', () => {
    const input: FindFreeSlotsInput = {
      attendees: ['a@x.com'],
      duration_minutes: 30,
      window_start: '2026-05-21T09:00:00Z',
      window_end: '2026-05-21T12:00:00Z',
      granularity_minutes: 30,
      per_attendee_busy: [
        [{ start: '2026-05-21T09:30:00Z', end: '2026-05-21T11:00:00Z' }],
      ],
      clock_local_hour_of: utcHourOf,
    }
    const out = findFreeSlots(input)
    // Available slots: 09:00 (ends before 09:30 — free?), 11:00, 11:30.
    // The 09:00-09:30 slot ends AT 09:30 == busy start so non-overlap.
    expect(out.length).toBeGreaterThanOrEqual(2)
    for (const slot of out) {
      const s = Date.parse(slot.start)
      const e = Date.parse(slot.end)
      const busyS = Date.parse('2026-05-21T09:30:00Z')
      const busyE = Date.parse('2026-05-21T11:00:00Z')
      const overlaps = s < busyE && e > busyS
      expect(overlaps).toBe(false)
    }
  })

  test('filters slots outside the preferred-hours window', () => {
    const input: FindFreeSlotsInput = {
      attendees: ['a@x.com'],
      duration_minutes: 30,
      window_start: '2026-05-21T05:00:00Z',
      window_end: '2026-05-21T22:00:00Z',
      granularity_minutes: 60,
      preferred_hours: [10, 12],
      per_attendee_busy: [[]],
      clock_local_hour_of: utcHourOf,
    }
    const out = findFreeSlots(input)
    expect(out.length).toBeGreaterThan(0)
    for (const slot of out) {
      const hour = utcHourOf(slot.start)
      expect(hour).toBeGreaterThanOrEqual(10)
      expect(hour).toBeLessThan(12)
    }
  })

  test('returns empty when duration > window', () => {
    const input: FindFreeSlotsInput = {
      attendees: ['a@x.com'],
      duration_minutes: 120,
      window_start: '2026-05-21T09:00:00Z',
      window_end: '2026-05-21T10:00:00Z',
      granularity_minutes: 30,
      per_attendee_busy: [[]],
    }
    expect(findFreeSlots(input)).toEqual([])
  })

  test('respects max_slots cap', () => {
    const input: FindFreeSlotsInput = {
      attendees: ['a@x.com'],
      duration_minutes: 30,
      window_start: '2026-05-21T09:00:00Z',
      window_end: '2026-05-21T18:00:00Z',
      granularity_minutes: 30,
      max_slots: 2,
      per_attendee_busy: [[]],
      clock_local_hour_of: utcHourOf,
    }
    const out = findFreeSlots(input)
    expect(out).toHaveLength(2)
  })

  test('echoes attendees on every slot', () => {
    const input: FindFreeSlotsInput = {
      attendees: ['a@x.com', 'b@x.com', 'c@x.com'],
      duration_minutes: 30,
      window_start: '2026-05-21T09:00:00Z',
      window_end: '2026-05-21T18:00:00Z',
      granularity_minutes: 30,
      max_slots: 1,
      per_attendee_busy: [[], [], []],
      clock_local_hour_of: utcHourOf,
    }
    const out = findFreeSlots(input)
    expect(out[0]?.attendees).toEqual(['a@x.com', 'b@x.com', 'c@x.com'])
  })
})
