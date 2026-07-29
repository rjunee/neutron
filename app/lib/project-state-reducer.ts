/**
 * @neutronai/app — project-state reducer (P5.2).
 *
 * Pure, React-free reducer for the project-settings provider. Covers
 * the GET fetch lifecycle (`LOAD_START` / `LOAD_OK` / `LOAD_FAIL`) and
 * the PATCH-privacy optimistic-flip cycle
 * (`PATCH_PRIVACY_OPTIMISTIC` / `PATCH_PRIVACY_OK` / `PATCH_PRIVACY_FAIL`).
 *
 * Pure-function discipline matches `chat-streaming.ts` (P5.1): no
 * React imports, no side effects, deterministic state transitions.
 * The provider in `project-state.tsx` is the React seam that
 * dispatches these actions in response to fetches + user input.
 */

import type { PrivacyMode, ProjectSettings } from './projects-client';

export interface ProjectStateError {
  /** Stable identifier — e.g. 'not_found', 'unauthorized', 'network'. */
  code: string;
  /** Human-readable message safe to surface inline. */
  message: string;
  /** Optional field name for whitelist-style errors. */
  field?: string;
}

export interface ProjectState {
  /** True while the initial fetch (or a refresh) is in flight. */
  loading: boolean;
  /** Resolved settings doc once GET succeeds. */
  project: ProjectSettings | null;
  /** Last error from a failed GET or PATCH; cleared on success. */
  error: ProjectStateError | null;
  /**
   * When non-null, indicates a PATCH-privacy is in flight. Used by the
   * drawer to disable further taps + show a subtle pending indicator
   * on the segmented control.
   */
  pending_privacy: PrivacyMode | null;
}

export const EMPTY_PROJECT_STATE: ProjectState = Object.freeze({
  loading: false,
  project: null,
  error: null,
  pending_privacy: null,
});

export type ProjectAction =
  | { type: 'LOAD_START' }
  | { type: 'LOAD_OK'; project: ProjectSettings }
  | { type: 'LOAD_FAIL'; error: ProjectStateError }
  | { type: 'PATCH_PRIVACY_OPTIMISTIC'; new_mode: PrivacyMode }
  | { type: 'PATCH_PRIVACY_OK'; project: ProjectSettings }
  | { type: 'PATCH_PRIVACY_FAIL'; error: ProjectStateError; prior_mode: PrivacyMode };

export function projectStateReducer(
  state: ProjectState,
  action: ProjectAction,
): ProjectState {
  switch (action.type) {
    case 'LOAD_START':
      return { ...state, loading: true, error: null };
    case 'LOAD_OK':
      return {
        loading: false,
        project: action.project,
        error: null,
        pending_privacy: null,
      };
    case 'LOAD_FAIL':
      return {
        loading: false,
        project: null,
        error: action.error,
        pending_privacy: null,
      };
    case 'PATCH_PRIVACY_OPTIMISTIC': {
      // No-op when the project hasn't loaded yet — patching against
      // empty state would create a phantom project.
      if (state.project === null) return state;
      return {
        ...state,
        project: { ...state.project, privacy_mode: action.new_mode },
        pending_privacy: action.new_mode,
        error: null,
      };
    }
    case 'PATCH_PRIVACY_OK':
      return {
        ...state,
        project: action.project,
        pending_privacy: null,
        error: null,
      };
    case 'PATCH_PRIVACY_FAIL': {
      if (state.project === null) {
        return { ...state, pending_privacy: null, error: action.error };
      }
      return {
        ...state,
        project: { ...state.project, privacy_mode: action.prior_mode },
        pending_privacy: null,
        error: action.error,
      };
    }
    default:
      return state;
  }
}
