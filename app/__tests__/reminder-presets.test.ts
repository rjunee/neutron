/**
 * @neutronai/app — reminder-presets unit tests (P5.5).
 *
 * The five-chip preset list is the create + edit modal's only way to
 * pick a fire-at without a custom-date picker. The `tomorrow 9am`
 * offset MUST recompute on every modal open or it drifts past
 * midnight; this test covers that recompute contract.
 */

import { describe, expect, it } from 'bun:test';

import {
  buildReminderPresets,
  DEFAULT_CREATE_PRESET_ID,
  nextMorningOffset,
} from '../lib/reminder-presets';

describe('buildReminderPresets', () => {
  it('returns five chips with stable ids', () => {
    const presets = buildReminderPresets(new Date('2026-05-20T10:00:00Z'));
    expect(presets.map((p) => p.id)).toEqual([
      'in-15m',
      'in-1h',
      'in-3h',
      'tomorrow-9am',
      'in-1w',
    ]);
  });

  it('+15m / +1h / +3h / +1w presets are deterministic', () => {
    const presets = buildReminderPresets(new Date('2026-05-20T10:00:00Z'));
    const byId = new Map(presets.map((p) => [p.id, p.offset_ms]));
    expect(byId.get('in-15m')).toBe(15 * 60_000);
    expect(byId.get('in-1h')).toBe(60 * 60_000);
    expect(byId.get('in-3h')).toBe(3 * 60 * 60_000);
    expect(byId.get('in-1w')).toBe(7 * 24 * 60 * 60_000);
  });

  it('tomorrow-9am preset depends on the supplied `now` and re-stamps', () => {
    const morning = new Date('2026-05-20T08:00:00');
    const evening = new Date('2026-05-20T23:00:00');
    const morningPresets = buildReminderPresets(morning);
    const eveningPresets = buildReminderPresets(evening);
    const morningOffset = morningPresets.find((p) => p.id === 'tomorrow-9am')!.offset_ms;
    const eveningOffset = eveningPresets.find((p) => p.id === 'tomorrow-9am')!.offset_ms;
    expect(morningOffset).not.toBe(eveningOffset);
    // morning at 8am → tomorrow 9am is 25 hours
    expect(morningOffset).toBe(25 * 60 * 60_000);
    // evening at 11pm → tomorrow 9am is 10 hours
    expect(eveningOffset).toBe(10 * 60 * 60_000);
  });

  it('default preset id matches one of the chips', () => {
    const presets = buildReminderPresets();
    expect(presets.map((p) => p.id)).toContain(DEFAULT_CREATE_PRESET_ID);
  });
});

describe('nextMorningOffset', () => {
  it('returns the gap until tomorrow 9am local', () => {
    const now = new Date('2026-05-20T10:00:00');
    const offset = nextMorningOffset(now);
    const target = new Date('2026-05-21T09:00:00');
    expect(offset).toBe(target.getTime() - now.getTime());
  });

  it('when called at midnight, returns ~9h (same day 9am... but tomorrow per setDate(+1))', () => {
    // setDate(+1) bumps to next day, so midnight 2026-05-20 → 2026-05-21 09:00 = 33h.
    const now = new Date('2026-05-20T00:00:00');
    const offset = nextMorningOffset(now);
    expect(offset).toBe(33 * 60 * 60_000);
  });
});
