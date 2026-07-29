/**
 * @neutronai/app — launcher-state reducer (P5.3).
 *
 * Pure, React-free reducer for the per-project launcher provider.
 * Covers four lifecycles:
 *
 *   1. Initial load   — `LOAD_START` / `LOAD_OK` / `LOAD_FAIL`.
 *   2. Mutation       — `MUTATE_START` / `MUTATE_OK` / `MUTATE_FAIL`.
 *                       Reorder / rename / uninstall ALL share this
 *                       lifecycle (server-authoritative: every
 *                       mutation returns the post-mutation ordered
 *                       list and we REPLACE local state with it; no
 *                       optimistic flip per brief § 4.5).
 *   3. Build-me       — `BUILD_ME_START` / `BUILD_ME_OK` / `BUILD_ME_FAIL`.
 *   4. Error banner   — `DISMISS_ERROR` clears `error` without re-
 *                       fetching.
 *
 * Same shape + discipline as `project-state-reducer.ts` (P5.2). The
 * provider in `launcher-state.tsx` is the React seam that dispatches
 * these actions in response to client fetches + user input.
 */

import type { LauncherEntry } from './launcher-client';

export interface LauncherStateError {
  /** Stable identifier — e.g. 'not_found', 'unauthorized', 'network'. */
  code: string;
  /** Human-readable message safe to surface inline. */
  message: string;
}

export interface LauncherState {
  /** True while the initial fetch (or a refresh) is in flight. */
  loading: boolean;
  /** Resolved entries once GET succeeds. Server-sorted ASC by reorder_index. */
  entries: LauncherEntry[];
  /** Last error from a failed GET / mutation / build-me; cleared on success or DISMISS_ERROR. */
  error: LauncherStateError | null;
  /** True while a reorder / rename / uninstall is in flight. */
  mutating: boolean;
  /** True while a build-me send is in flight (the modal stays open during submit). */
  building_me: boolean;
}

export const EMPTY_LAUNCHER_STATE: LauncherState = Object.freeze({
  loading: false,
  entries: [],
  error: null,
  mutating: false,
  building_me: false,
});

export type LauncherAction =
  | { type: 'LOAD_START' }
  | { type: 'LOAD_OK'; entries: LauncherEntry[] }
  | { type: 'LOAD_FAIL'; error: LauncherStateError }
  | { type: 'MUTATE_START' }
  | { type: 'MUTATE_OK'; entries: LauncherEntry[] }
  | { type: 'MUTATE_FAIL'; error: LauncherStateError }
  | { type: 'BUILD_ME_START' }
  | { type: 'BUILD_ME_OK' }
  | { type: 'BUILD_ME_FAIL'; error: LauncherStateError }
  | { type: 'DISMISS_ERROR' };

export function launcherStateReducer(
  state: LauncherState,
  action: LauncherAction,
): LauncherState {
  switch (action.type) {
    case 'LOAD_START':
      return { ...state, loading: true, error: null };
    case 'LOAD_OK':
      return {
        ...state,
        loading: false,
        entries: action.entries,
        error: null,
      };
    case 'LOAD_FAIL':
      return {
        ...state,
        loading: false,
        error: action.error,
      };
    case 'MUTATE_START':
      return { ...state, mutating: true, error: null };
    case 'MUTATE_OK':
      return {
        ...state,
        mutating: false,
        entries: action.entries,
        error: null,
      };
    case 'MUTATE_FAIL':
      return {
        ...state,
        mutating: false,
        error: action.error,
      };
    case 'BUILD_ME_START':
      return { ...state, building_me: true, error: null };
    case 'BUILD_ME_OK':
      return { ...state, building_me: false };
    case 'BUILD_ME_FAIL':
      return {
        ...state,
        building_me: false,
        error: action.error,
      };
    case 'DISMISS_ERROR':
      return { ...state, error: null };
    default:
      return state;
  }
}

/**
 * Wraps a thrown value into the typed `LauncherStateError`. Recognises
 * `LauncherClientError` (carries `.code`) and falls back to `unknown`
 * for plain `Error` / non-Error throws.
 */
export function toLauncherStateError(err: unknown): LauncherStateError {
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
