/**
 * @neutronai/app — TaskRow helper unit tests (P5.4).
 *
 * Pure helpers from `components/TaskRow.tsx`:
 *
 *   - `formatDueDateLabel`  → strips the time component for the row.
 *   - `localTodayString`    → user-local `YYYY-MM-DD` (for "today"
 *                             chip bucketing).
 *   - `computeDueKind`      → 'overdue' | 'today' | 'future' | null
 *                             relative to a frozen `now`.
 *
 * RN components themselves are not mounted under bun-test (per
 * `citation-chip-row.test.ts`'s pattern); the integration layer +
 * agent-browser smoke verifies the render.
 */

import { describe, expect, it } from 'bun:test';

import {
  computeDueKind,
  formatDueDateLabel,
  localTodayString,
} from '../lib/task-row-formatters';

describe('formatDueDateLabel', () => {
  it('strips the time component when an ISO-8601 string is given', () => {
    expect(formatDueDateLabel('2026-05-21T00:00:00.000Z')).toBe('2026-05-21');
  });

  it('returns the bare YYYY-MM-DD untouched', () => {
    expect(formatDueDateLabel('2026-05-21')).toBe('2026-05-21');
  });

  it('returns null for null', () => {
    expect(formatDueDateLabel(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(formatDueDateLabel(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(formatDueDateLabel('')).toBeNull();
  });

  it('returns the raw string when no YYYY-MM-DD prefix matches', () => {
    expect(formatDueDateLabel('tomorrow')).toBe('tomorrow');
  });
});

describe('localTodayString', () => {
  it('formats a frozen now to YYYY-MM-DD in the local tz', () => {
    // The exact value depends on tz, but the shape must match.
    const out = localTodayString(new Date('2026-05-20T15:00:00Z'));
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('computeDueKind', () => {
  // Use UTC noon so the device-local date matches the input string
  // in every common tz (between UTC-12 and UTC+13).
  const TODAY_NOW = new Date('2026-05-20T12:00:00Z');
  const TODAY = localTodayString(TODAY_NOW); // e.g. '2026-05-20' in UTC

  it('returns null for a missing due_date', () => {
    expect(computeDueKind(null, TODAY_NOW)).toBeNull();
    expect(computeDueKind(undefined, TODAY_NOW)).toBeNull();
  });

  it('returns "today" when the local date matches', () => {
    expect(computeDueKind(TODAY, TODAY_NOW)).toBe('today');
  });

  it('returns "overdue" for an earlier date', () => {
    const yesterday = subOneDayIso(TODAY);
    expect(computeDueKind(yesterday, TODAY_NOW)).toBe('overdue');
  });

  it('returns "future" for a later date', () => {
    const tomorrow = addOneDayIso(TODAY);
    expect(computeDueKind(tomorrow, TODAY_NOW)).toBe('future');
  });

  it('parses ISO-8601 strings with a time component', () => {
    expect(computeDueKind(`${TODAY}T00:00:00.000Z`, TODAY_NOW)).toBe('today');
  });
});

function subOneDayIso(yyyy_mm_dd: string): string {
  const ms = Date.parse(`${yyyy_mm_dd}T12:00:00Z`);
  const earlier = new Date(ms - 24 * 60 * 60 * 1000);
  return earlier.toISOString().slice(0, 10);
}

function addOneDayIso(yyyy_mm_dd: string): string {
  const ms = Date.parse(`${yyyy_mm_dd}T12:00:00Z`);
  const later = new Date(ms + 24 * 60 * 60 * 1000);
  return later.toISOString().slice(0, 10);
}
