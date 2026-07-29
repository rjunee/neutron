/**
 * @neutronai/app — task-state reducer (P5.4).
 *
 * Pure, React-free reducer for the per-project tasks tab provider.
 * Mirrors `launcher-state-reducer.ts` (P5.3) shape — the same
 * three-axis lifecycle (load / mutate / dismiss) plus a filter axis
 * unique to the tasks tab (Open / Done / All).
 *
 *   1. Load     — `LOAD_START` / `LOAD_OK` / `LOAD_FAIL`.
 *   2. Filter   — `SET_FILTER` flips the filter axis; the provider
 *                 listens via `useEffect` and re-fires the fetch.
 *   3. Mutate   — `MUTATE_START` / `MUTATE_OK` / `MUTATE_FAIL`.
 *                 Create / update / complete / cancel / delete ALL
 *                 share this lifecycle (server-authoritative: every
 *                 mutation re-fetches the filtered list and we
 *                 REPLACE local state — no optimistic flip per
 *                 brief § 4.9).
 *   4. Banner   — `DISMISS_ERROR` clears `error` without re-fetching.
 *
 * No `OPTIMISTIC_*` actions are exposed — locked by brief § 4.9 to
 * keep the row consistent across multi-user editing + the
 * focus-score re-sort that happens on every status flip.
 */

import type { Task } from './tasks-client';

export type FilterChoice = 'open' | 'done' | 'all';

export const FILTER_CHOICES: ReadonlyArray<{ value: FilterChoice; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
  { value: 'all', label: 'All' },
];

export interface TaskStateError {
  /** Stable identifier — e.g. 'not_found', 'unauthorized', 'network'. */
  code: string;
  /** Human-readable message safe to surface inline. */
  message: string;
}

export interface TaskState {
  /** True while the initial fetch (or a refresh) is in flight. */
  loading: boolean;
  /** Resolved tasks once GET succeeds. Server-sorted by focus_score / TaskStore order. */
  tasks: Task[];
  /** Last error from a failed GET / mutation; cleared on success or DISMISS_ERROR. */
  error: TaskStateError | null;
  /** True while a create / update / complete / cancel / delete is in flight. */
  mutating: boolean;
  /** Active status filter — drives the GET ?status=… query the provider builds. */
  filter: FilterChoice;
}

export const EMPTY_TASK_STATE: TaskState = Object.freeze({
  loading: false,
  tasks: [],
  error: null,
  mutating: false,
  filter: 'open',
});

export type TaskAction =
  | { type: 'LOAD_START' }
  | { type: 'LOAD_OK'; tasks: Task[] }
  | { type: 'LOAD_FAIL'; error: TaskStateError }
  | { type: 'SET_FILTER'; filter: FilterChoice }
  | { type: 'MUTATE_START' }
  | { type: 'MUTATE_OK'; tasks: Task[] }
  | { type: 'MUTATE_FAIL'; error: TaskStateError }
  | { type: 'DISMISS_ERROR' };

export function taskStateReducer(state: TaskState, action: TaskAction): TaskState {
  switch (action.type) {
    case 'LOAD_START':
      return { ...state, loading: true, error: null };
    case 'LOAD_OK':
      return {
        ...state,
        loading: false,
        tasks: action.tasks,
        error: null,
      };
    case 'LOAD_FAIL':
      return {
        ...state,
        loading: false,
        error: action.error,
      };
    case 'SET_FILTER':
      // Filter flip is provider-driven; the matching re-fetch is the
      // provider's `useEffect` dependency change. Reducer just records
      // the new choice. We deliberately do NOT clear `tasks` here —
      // the existing rows stay visible while the new list loads
      // (avoids a flash of empty list on the filter swap).
      return { ...state, filter: action.filter };
    case 'MUTATE_START':
      return { ...state, mutating: true, error: null };
    case 'MUTATE_OK':
      return {
        ...state,
        mutating: false,
        tasks: action.tasks,
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
 * Wraps a thrown value into the typed `TaskStateError`. Recognises
 * `TasksClientError` (carries `.code`) and falls back to `unknown`
 * for plain `Error` / non-Error throws.
 */
export function toTaskStateError(err: unknown): TaskStateError {
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
