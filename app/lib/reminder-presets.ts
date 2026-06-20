/**
 * @neutronai/app — fire-at preset chips for the reminders tab (P5.5).
 *
 * Pure functions — no React. The create + edit modals consume these
 * to render the five preset chips (in 15m / in 1h / in 3h / tomorrow
 * 9am / in 1w). The `tomorrow 9am` offset RECOMPUTES on every modal
 * open via `nextMorningOffset(now)` so a stale module-load value
 * never drifts the user past midnight.
 *
 * Locked at P5.5 — five chips is the engineering-plan + MVP-tested
 * coverage. Custom-date pickers + recurring cadence pickers are
 * deferred per brief § 4.3 + § 4.4.
 */

export interface ReminderPreset {
  /** Stable id used for test selectors + selected-state comparison. */
  id: string;
  /** Human-readable label rendered on the chip. */
  label: string;
  /**
   * Offset in milliseconds from `now` at which the reminder fires.
   * The `tomorrow 9am` preset recomputes via `nextMorningOffset(now)`
   * so callers MUST recompute the preset list on each open, not at
   * module load.
   */
  offset_ms: number;
}

/** Compute "tomorrow at 9am local" — offset in ms from `now`. */
export function nextMorningOffset(now: Date = new Date()): number {
  const target = new Date(now);
  target.setDate(target.getDate() + 1);
  target.setHours(9, 0, 0, 0);
  return target.getTime() - now.getTime();
}

/**
 * Build the five preset chips relative to a stable `now`. Stamping
 * the preset offsets at modal-open time keeps "tomorrow 9am" honest:
 * the value at module load could drift hours by the time the user
 * actually taps the chip.
 *
 * Mirrors the MVP's preset shape verbatim; the brief locks this list.
 */
export function buildReminderPresets(now: Date = new Date()): ReminderPreset[] {
  return [
    { id: 'in-15m', label: 'in 15m', offset_ms: 15 * 60_000 },
    { id: 'in-1h', label: 'in 1h', offset_ms: 60 * 60_000 },
    { id: 'in-3h', label: 'in 3h', offset_ms: 3 * 60 * 60_000 },
    { id: 'tomorrow-9am', label: 'tomorrow 9am', offset_ms: nextMorningOffset(now) },
    { id: 'in-1w', label: 'in 1w', offset_ms: 7 * 24 * 60 * 60_000 },
  ];
}

/** Default selected preset id when the create modal opens. */
export const DEFAULT_CREATE_PRESET_ID: ReminderPreset['id'] = 'in-1h';
