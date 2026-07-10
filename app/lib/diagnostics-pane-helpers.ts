/**
 * @neutronai/app — DiagnosticsPane pure logic (O5).
 *
 * Extracted OUT of `features/admin/DiagnosticsPane.tsx` so it carries no
 * `react-native` import and is unit-testable under bun:test (same convention as
 * `lib/personality-pane-helpers.ts`). The pane imports these verbatim, so a
 * passing test here proves the pane's load/refresh state machine + the array
 * normalizer that guards `.map()`.
 */

import type { DiagnosticsReport } from './admin-client';

/** Defensive: only iterate real arrays so rendering never throws on a
 *  `.map()` of a non-array (empty/unavailable/malformed collection boundary). */
export function arr<T>(x: T[] | undefined): T[] {
  return Array.isArray(x) ? x : [];
}

export interface DiagnosticsState {
  data: DiagnosticsReport | null;
  loading: boolean;
  error: string | null;
}

export type DiagnosticsAction =
  | { type: 'fetch-start' }
  | { type: 'fetch-success'; report: DiagnosticsReport }
  | { type: 'fetch-error'; error: string };

export const initialDiagnosticsState: DiagnosticsState = { data: null, loading: true, error: null };

/**
 * Pure reducer for the pane's load/refresh lifecycle. Key invariant: a REFRESH
 * FAILURE keeps the previously-loaded `data` (the pane shows stale data + an
 * error banner rather than blanking), and a fetch start clears any prior error
 * while retaining data.
 */
export function diagnosticsReducer(
  state: DiagnosticsState,
  action: DiagnosticsAction,
): DiagnosticsState {
  switch (action.type) {
    case 'fetch-start':
      return { ...state, loading: true, error: null };
    case 'fetch-success':
      return { data: action.report, loading: false, error: null };
    case 'fetch-error':
      return { ...state, loading: false, error: action.error };
    default:
      return state;
  }
}
