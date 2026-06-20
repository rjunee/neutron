/**
 * @neutronai/app — ReminderRow bucket-tint unit tests (P5.5).
 *
 * `computeFireAtBucket` drives the row's fire-at chip color ramp
 * (overdue → danger-tint, today → warning-tint, future →
 * surface_raised muted). Pure function — extracted to a test so the
 * row can be exercised without bundling react-native.
 */

import { describe, expect, it } from 'bun:test';

import {
  computeFireAtBucket,
  endOfTodayLocalMs,
  MS_PER_DAY,
} from '../lib/reminder-state-reducer';

describe('computeFireAtBucket', () => {
  const noonToday = new Date('2026-05-20T12:00:00Z').getTime();

  it('overdue rows bucket to "overdue"', () => {
    const past_seconds = Math.floor((noonToday - 60_000) / 1000);
    expect(computeFireAtBucket(past_seconds, noonToday)).toBe('overdue');
  });

  it('rows firing later today bucket to "today"', () => {
    const eot = endOfTodayLocalMs(noonToday);
    const fire_seconds = Math.floor((eot - 60_000) / 1000);
    expect(computeFireAtBucket(fire_seconds, noonToday)).toBe('today');
  });

  it('rows firing tomorrow+ bucket to "future"', () => {
    const fire_seconds = Math.floor((noonToday + 2 * MS_PER_DAY) / 1000);
    expect(computeFireAtBucket(fire_seconds, noonToday)).toBe('future');
  });
});
