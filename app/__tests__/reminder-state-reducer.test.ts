/**
 * @neutronai/app — reminder-state reducer unit tests (P5.5).
 *
 * Pure-function coverage of every transition + the bucket predicates
 * `<ReminderList>` uses for the Today / Upcoming / All filter
 * mapping. Mirrors the P5.4 task-state-reducer tests.
 */

import { describe, expect, it } from 'bun:test';

import type { ReminderItem } from '../lib/reminders-client';
import {
  applyReminderFilter,
  EMPTY_REMINDER_STATE,
  endOfTodayLocalMs,
  isToday,
  isUpcoming,
  MS_PER_DAY,
  REMINDER_FILTER_CHOICES,
  reminderStateReducer,
  toReminderStateError,
  UPCOMING_HORIZON_MS,
  type ReminderStateError,
} from '../lib/reminder-state-reducer';

function reminder(id: string, fire_at: number, extra: Partial<ReminderItem> = {}): ReminderItem {
  return {
    id,
    message: `Reminder ${id}`,
    fire_at,
    status: 'pending',
    recurrence: null,
    created_at: 0,
    source: 'app:reminders-tab',
    ...extra,
  };
}

describe('reminderStateReducer', () => {
  it('LOAD_START flips loading=true and clears error', () => {
    const next = reminderStateReducer(
      { ...EMPTY_REMINDER_STATE, error: { code: 'old', message: 'stale' } },
      { type: 'LOAD_START' },
    );
    expect(next.loading).toBe(true);
    expect(next.error).toBeNull();
  });

  it('LOAD_OK stores reminders and clears loading + error', () => {
    const list = [reminder('a', 100), reminder('b', 200)];
    const next = reminderStateReducer(
      { ...EMPTY_REMINDER_STATE, loading: true },
      { type: 'LOAD_OK', reminders: list },
    );
    expect(next.loading).toBe(false);
    expect(next.reminders).toEqual(list);
    expect(next.error).toBeNull();
  });

  it('LOAD_FAIL clears loading and stores error', () => {
    const err: ReminderStateError = { code: 'forbidden', message: 'nope' };
    const next = reminderStateReducer(
      { ...EMPTY_REMINDER_STATE, loading: true },
      { type: 'LOAD_FAIL', error: err },
    );
    expect(next.loading).toBe(false);
    expect(next.error).toEqual(err);
  });

  it('SET_FILTER flips filter without touching reminders/loading', () => {
    const list = [reminder('a', 100)];
    const next = reminderStateReducer(
      { ...EMPTY_REMINDER_STATE, reminders: list, loading: true },
      { type: 'SET_FILTER', filter: 'upcoming' },
    );
    expect(next.filter).toBe('upcoming');
    expect(next.reminders).toEqual(list);
    expect(next.loading).toBe(true);
  });

  it('MUTATE_START flips mutating=true and clears error', () => {
    const next = reminderStateReducer(
      {
        ...EMPTY_REMINDER_STATE,
        error: { code: 'x', message: 'y' },
      },
      { type: 'MUTATE_START' },
    );
    expect(next.mutating).toBe(true);
    expect(next.error).toBeNull();
  });

  it('MUTATE_OK replaces reminders with server-returned list', () => {
    const list = [reminder('a', 100)];
    const next = reminderStateReducer(
      { ...EMPTY_REMINDER_STATE, mutating: true, reminders: [reminder('old', 99)] },
      { type: 'MUTATE_OK', reminders: list },
    );
    expect(next.mutating).toBe(false);
    expect(next.reminders).toEqual(list);
    expect(next.error).toBeNull();
  });

  it('MUTATE_FAIL preserves reminders but records error', () => {
    const list = [reminder('a', 100)];
    const err: ReminderStateError = { code: 'conflict', message: 'busy' };
    const next = reminderStateReducer(
      { ...EMPTY_REMINDER_STATE, reminders: list, mutating: true },
      { type: 'MUTATE_FAIL', error: err },
    );
    expect(next.mutating).toBe(false);
    expect(next.reminders).toEqual(list);
    expect(next.error).toEqual(err);
  });

  it('DISMISS_ERROR clears error without re-fetching', () => {
    const next = reminderStateReducer(
      { ...EMPTY_REMINDER_STATE, error: { code: 'x', message: 'y' } },
      { type: 'DISMISS_ERROR' },
    );
    expect(next.error).toBeNull();
  });

  it('exposes Today / Upcoming / All filter choices', () => {
    const values = REMINDER_FILTER_CHOICES.map((c) => c.value);
    expect(values).toEqual(['today', 'upcoming', 'all']);
  });

  it('default filter is today', () => {
    expect(EMPTY_REMINDER_STATE.filter).toBe('today');
  });
});

describe('toReminderStateError', () => {
  it('handles RemindersClientError-shaped objects with code + message', () => {
    const result = toReminderStateError({ code: 'forbidden', message: 'nope' });
    expect(result).toEqual({ code: 'forbidden', message: 'nope' });
  });

  it('falls back to unknown code for plain Error', () => {
    const result = toReminderStateError(new Error('boom'));
    expect(result.code).toBe('unknown');
    expect(result.message).toBe('boom');
  });

  it('falls back to unknown for non-Error throws', () => {
    const result = toReminderStateError('string-throw');
    expect(result.code).toBe('unknown');
    expect(result.message).toBe('string-throw');
  });
});

describe('isToday / isUpcoming bucket predicates', () => {
  const noonToday = new Date('2026-05-20T12:00:00Z').getTime();

  it('overdue rows are bucketed into today', () => {
    const past_seconds = Math.floor((noonToday - 60 * 60 * 1000) / 1000);
    expect(isToday(past_seconds, noonToday)).toBe(true);
    expect(isUpcoming(past_seconds, noonToday)).toBe(false);
  });

  it('rows firing later today are in today', () => {
    const eot = endOfTodayLocalMs(noonToday);
    const fire_seconds = Math.floor((eot - 60_000) / 1000);
    expect(isToday(fire_seconds, noonToday)).toBe(true);
    expect(isUpcoming(fire_seconds, noonToday)).toBe(false);
  });

  it('rows firing right after end-of-today are upcoming, not today', () => {
    const eot = endOfTodayLocalMs(noonToday);
    const fire_seconds = Math.floor((eot + 60_000) / 1000);
    expect(isToday(fire_seconds, noonToday)).toBe(false);
    expect(isUpcoming(fire_seconds, noonToday)).toBe(true);
  });

  it('rows within the 14-day horizon are upcoming', () => {
    const fire_seconds = Math.floor((noonToday + 10 * MS_PER_DAY) / 1000);
    expect(isUpcoming(fire_seconds, noonToday)).toBe(true);
  });

  it('rows beyond the 14-day horizon are NOT upcoming', () => {
    const fire_seconds = Math.floor((noonToday + UPCOMING_HORIZON_MS + 60_000) / 1000);
    expect(isUpcoming(fire_seconds, noonToday)).toBe(false);
    expect(isToday(fire_seconds, noonToday)).toBe(false);
  });
});

describe('applyReminderFilter', () => {
  const now_ms = new Date('2026-05-20T12:00:00Z').getTime();
  const eot = endOfTodayLocalMs(now_ms);
  const overdue = reminder('overdue', Math.floor((now_ms - MS_PER_DAY) / 1000));
  const today = reminder('today', Math.floor((eot - 60_000) / 1000));
  const upcoming = reminder('upcoming', Math.floor((now_ms + 5 * MS_PER_DAY) / 1000));
  const distant = reminder(
    'distant',
    Math.floor((now_ms + UPCOMING_HORIZON_MS + MS_PER_DAY) / 1000),
  );
  const all_reminders: ReminderItem[] = [overdue, today, upcoming, distant];

  it('today bucket includes overdue + today rows only', () => {
    const filtered = applyReminderFilter(all_reminders, 'today', now_ms);
    expect(filtered.map((r) => r.id)).toEqual(['overdue', 'today']);
  });

  it('upcoming bucket excludes overdue + today + distant', () => {
    const filtered = applyReminderFilter(all_reminders, 'upcoming', now_ms);
    expect(filtered.map((r) => r.id)).toEqual(['upcoming']);
  });

  it('all bucket returns every row in the canonical order', () => {
    const filtered = applyReminderFilter(all_reminders, 'all', now_ms);
    expect(filtered).toEqual(all_reminders);
  });
});
