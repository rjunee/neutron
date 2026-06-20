/**
 * @neutronai/app — reminder-state reducer (P5.5).
 *
 * Pure, React-free reducer for the per-project reminders tab provider.
 * Mirrors `task-state-reducer.ts` (P5.4) shape — the same four-axis
 * lifecycle (load / filter / mutate / dismiss) with the reminders-
 * specific filter buckets (Today / Upcoming / All).
 *
 *   1. Load     — `LOAD_START` / `LOAD_OK` / `LOAD_FAIL`.
 *   2. Filter   — `SET_FILTER` flips the filter axis. Filter buckets
 *                 are CLIENT-SIDE only (the gateway returns the same
 *                 pending list regardless of filter); switching does
 *                 NOT re-fetch.
 *   3. Mutate   — `MUTATE_START` / `MUTATE_OK` / `MUTATE_FAIL`.
 *                 Create / snooze / cancel / convertToTask ALL share
 *                 this lifecycle. Server-authoritative — every
 *                 mutation route returns the post-mutation pending
 *                 list which REPLACES local state.
 *   4. Banner   — `DISMISS_ERROR` clears `error` without re-fetching.
 *
 * Also exports the bucket-predicate helpers (`isToday`, `isUpcoming`)
 * the list container uses to map the canonical server list into the
 * three filter views, plus the `toReminderStateError` adapter for
 * `RemindersClientError` → typed `ReminderStateError`.
 *
 * No `OPTIMISTIC_*` actions — locked by brief § 4.9 (multi-user
 * consistency + post-snooze re-sort make optimistic UI a footgun).
 */

import type { ReminderItem } from './reminders-client';

export type ReminderFilterChoice = 'today' | 'upcoming' | 'all';

export const REMINDER_FILTER_CHOICES: ReadonlyArray<{
  value: ReminderFilterChoice;
  label: string;
}> = [
  { value: 'today', label: 'Today' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'all', label: 'All' },
];

export interface ReminderStateError {
  /** Stable identifier — e.g. 'not_found', 'unauthorized', 'network'. */
  code: string;
  /** Human-readable message safe to surface inline. */
  message: string;
}

export interface ReminderState {
  /** True while the initial fetch (or a refresh) is in flight. */
  loading: boolean;
  /** Server-canonical pending list, sorted `fire_at ASC` by ReminderStore.listPendingByTopic. */
  reminders: ReminderItem[];
  /** Last error from a failed GET / mutation; cleared on success or DISMISS_ERROR. */
  error: ReminderStateError | null;
  /** True while a create / snooze / cancel / convertToTask is in flight. */
  mutating: boolean;
  /** Active client-side filter — drives the bucketing in `<ReminderList>`. */
  filter: ReminderFilterChoice;
}

export const EMPTY_REMINDER_STATE: ReminderState = Object.freeze({
  loading: false,
  reminders: [],
  error: null,
  mutating: false,
  filter: 'today',
});

export type ReminderAction =
  | { type: 'LOAD_START' }
  | { type: 'LOAD_OK'; reminders: ReminderItem[] }
  | { type: 'LOAD_FAIL'; error: ReminderStateError }
  | { type: 'SET_FILTER'; filter: ReminderFilterChoice }
  | { type: 'MUTATE_START' }
  | { type: 'MUTATE_OK'; reminders: ReminderItem[] }
  | { type: 'MUTATE_FAIL'; error: ReminderStateError }
  | { type: 'DISMISS_ERROR' };

export function reminderStateReducer(
  state: ReminderState,
  action: ReminderAction,
): ReminderState {
  switch (action.type) {
    case 'LOAD_START':
      return { ...state, loading: true, error: null };
    case 'LOAD_OK':
      return {
        ...state,
        loading: false,
        reminders: action.reminders,
        error: null,
      };
    case 'LOAD_FAIL':
      return {
        ...state,
        loading: false,
        error: action.error,
      };
    case 'SET_FILTER':
      // Client-side filter — does NOT clear `reminders` or trigger
      // a re-fetch. The provider's `useEffect` does NOT depend on
      // `filter` (every mount fires one canonical fetch; bucketing
      // happens at render time in <ReminderList>).
      return { ...state, filter: action.filter };
    case 'MUTATE_START':
      return { ...state, mutating: true, error: null };
    case 'MUTATE_OK':
      return {
        ...state,
        mutating: false,
        reminders: action.reminders,
        error: null,
      };
    case 'MUTATE_FAIL':
      return {
        ...state,
        mutating: false,
        error: action.error,
      };
    case 'DISMISS_ERROR':
      return { ...state, error: null };
    default:
      return state;
  }
}

/**
 * Wraps a thrown value into the typed `ReminderStateError`. Recognises
 * `RemindersClientError` (carries `.code`) and falls back to `unknown`
 * for plain `Error` / non-Error throws.
 */
export function toReminderStateError(err: unknown): ReminderStateError {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string'
  ) {
    return {
      code: (err as { code: string }).code,
      message: (err as { message: string }).message,
    };
  }
  if (err instanceof Error) {
    return { code: 'unknown', message: err.message };
  }
  return { code: 'unknown', message: String(err) };
}

/** Milliseconds in a day, exposed for tests to mirror provider arithmetic. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Look-ahead horizon for the Upcoming bucket. */
export const UPCOMING_HORIZON_MS = 14 * MS_PER_DAY;

/**
 * Compute the user-local end-of-today timestamp (ms). The bucket
 * boundary collapses to a date-level comparison so DST transitions
 * don't slosh boundary rows across buckets.
 */
export function endOfTodayLocalMs(now_ms: number = Date.now()): number {
  const d = new Date(now_ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/**
 * Today bucket predicate. Includes overdue reminders so the user sees
 * "what's late + what's due today" together at the top of the tab.
 */
export function isToday(fire_at_seconds: number, now_ms: number = Date.now()): boolean {
  const fire_ms = fire_at_seconds * 1000;
  return fire_ms <= endOfTodayLocalMs(now_ms);
}

/**
 * Upcoming bucket predicate. Strictly future to the end of today AND
 * within the 14-day horizon — overdue rows are NOT in upcoming, and
 * very distant rows are NOT in upcoming (they live in All only).
 */
export function isUpcoming(
  fire_at_seconds: number,
  now_ms: number = Date.now(),
): boolean {
  const fire_ms = fire_at_seconds * 1000;
  const eot = endOfTodayLocalMs(now_ms);
  return fire_ms > eot && fire_ms <= now_ms + UPCOMING_HORIZON_MS;
}

/**
 * Run a reminder list through the active filter. Pure — no Date.now
 * shortcuts so the provider can freeze a `now_ms` per render via
 * `useMemo` for stable bucketing inside the same render pass.
 */
export function applyReminderFilter(
  reminders: ReminderItem[],
  filter: ReminderFilterChoice,
  now_ms: number = Date.now(),
): ReminderItem[] {
  if (filter === 'all') return reminders;
  if (filter === 'today') {
    return reminders.filter((r) => isToday(r.fire_at, now_ms));
  }
  return reminders.filter((r) => isUpcoming(r.fire_at, now_ms));
}

export type FireAtBucket = 'overdue' | 'today' | 'future';

/**
 * Compute the row's fire-at chip bucket from a unix-second `fire_at`.
 * `<ReminderRow>` consumes this to drive the danger/warning/muted
 * chip color ramp.
 */
export function computeFireAtBucket(
  fire_at_seconds: number,
  now_ms: number = Date.now(),
): FireAtBucket {
  const fire_ms = fire_at_seconds * 1000;
  if (fire_ms < now_ms) return 'overdue';
  if (fire_ms <= endOfTodayLocalMs(now_ms)) return 'today';
  return 'future';
}
