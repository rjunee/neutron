/**
 * Focus-score formula tests — pure function, deterministic outputs.
 *
 * The numeric fixtures lock the exact scoring curve Forge ships with
 * (P6 brief § 4.5 / § 7.1). Any future tweak to the formula MUST
 * update this set with intent.
 */

import { describe, expect, test } from 'bun:test'
import {
  computeFocusScore,
  FOCUS_SCORE_VERSION,
  priorityToFocusScale,
} from '../focus-score.ts'

const NOW = new Date('2026-05-20T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

function isoMinusDays(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString()
}

function isoPlusDays(days: number): string {
  return new Date(NOW.getTime() + days * DAY_MS).toISOString()
}

describe('priorityToFocusScale', () => {
  test('maps 0..3 → 5..2 (P0..P3 invert)', () => {
    expect(priorityToFocusScale(3)).toBe(5)
    expect(priorityToFocusScale(2)).toBe(4)
    expect(priorityToFocusScale(1)).toBe(3)
    expect(priorityToFocusScale(0)).toBe(2)
  })
  test('null → 2 (P3-equivalent floor)', () => {
    expect(priorityToFocusScale(null)).toBe(2)
  })
  test('out of range clamps', () => {
    expect(priorityToFocusScale(-1)).toBe(2)
    expect(priorityToFocusScale(99)).toBe(5)
  })
})

describe('computeFocusScore — golden fixtures', () => {
  test('P0 overdue + 10 days stale', () => {
    const score = computeFocusScore({
      priority: 3,
      due_date: isoMinusDays(1),
      updated_at: isoMinusDays(10),
      now: NOW,
    })
    // urgency=5 (overdue), importance=5; staleness: 10-5 = 5 capped, *0.5 = 2.5
    // → 5*3 + 5*2 + 2.5 = 27.5
    expect(score).toBe(27.5)
  })

  test('P1 due in 5 days, fresh', () => {
    const score = computeFocusScore({
      priority: 2,
      due_date: isoPlusDays(5),
      updated_at: isoMinusDays(0),
      now: NOW,
    })
    // urgency: P1=4; due in 5d (>2 but ≤7) → max(4,3) = 4
    // importance=4; staleness=0 → 4*3 + 4*2 + 0 = 20
    expect(score).toBe(20)
  })

  test('P2 due in 14 days, no staleness', () => {
    const score = computeFocusScore({
      priority: 1,
      due_date: isoPlusDays(14),
      updated_at: isoMinusDays(0),
      now: NOW,
    })
    // urgency=3, importance=3 (P2). No due-date bump (14d > 7d).
    // → 3*3 + 3*2 = 15
    expect(score).toBe(15)
  })

  test('P3 no due, fresh — baseline floor', () => {
    const score = computeFocusScore({
      priority: 0,
      due_date: null,
      updated_at: isoMinusDays(0),
      now: NOW,
    })
    // urgency=2, importance=2 → 2*3 + 2*2 = 10
    expect(score).toBe(10)
  })

  test('null priority no due — same as P3 floor', () => {
    const score = computeFocusScore({
      priority: null,
      due_date: null,
      updated_at: isoMinusDays(0),
      now: NOW,
    })
    expect(score).toBe(10)
  })

  test('due today (≤ 0 days left) is overdue per Nova rule', () => {
    const score = computeFocusScore({
      priority: 1,
      due_date: new Date(NOW.getTime() + 6 * HOUR_MS).toISOString(),
      updated_at: isoMinusDays(0),
      now: NOW,
    })
    // 6h-out → daysLeft = 0 → overdue urgency=5; importance=3 (P2).
    // → 5*3 + 3*2 = 21
    expect(score).toBe(21)
  })

  test('due in 2 days bumps urgency to 4', () => {
    const score = computeFocusScore({
      priority: 0,
      due_date: isoPlusDays(2),
      updated_at: isoMinusDays(0),
      now: NOW,
    })
    // urgency: max(2, 4) = 4; importance=2 (P3). → 4*3 + 2*2 = 16
    expect(score).toBe(16)
  })

  test('staleness cap at 5 days bonus', () => {
    const a = computeFocusScore({
      priority: 0,
      due_date: null,
      updated_at: isoMinusDays(100),
      now: NOW,
    })
    const b = computeFocusScore({
      priority: 0,
      due_date: null,
      updated_at: isoMinusDays(10),
      now: NOW,
    })
    // Both produce the cap (10d → 5*0.5 = 2.5; 100d → still 5*0.5).
    expect(a).toBe(b)
    expect(a).toBe(12.5)
  })

  test('5-day-stale row is below the threshold (no bonus)', () => {
    const score = computeFocusScore({
      priority: 0,
      due_date: null,
      updated_at: isoMinusDays(5),
      now: NOW,
    })
    expect(score).toBe(10)
  })

  test('FOCUS_SCORE_VERSION is exposed', () => {
    expect(FOCUS_SCORE_VERSION).toBe(1)
  })

  test('unparseable due_date is treated as null', () => {
    const a = computeFocusScore({
      priority: 1,
      due_date: 'nope',
      updated_at: isoMinusDays(0),
      now: NOW,
    })
    const b = computeFocusScore({
      priority: 1,
      due_date: null,
      updated_at: isoMinusDays(0),
      now: NOW,
    })
    expect(a).toBe(b)
  })
})
