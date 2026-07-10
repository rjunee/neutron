/**
 * @neutronai/app — DiagnosticsPane pure-logic tests (O5).
 *
 * Convention (same as `personality-pane-helpers.test.ts`, `comments-side-pane.test.tsx`):
 * the app bun:test suite does NOT mount React Native components. The pane's
 * load-bearing logic — its load/refresh state machine + the array-normalizer
 * that guards `.map()` — is extracted into pure exports and covered here.
 * JSX-render coverage is the agent-browser smoke pass.
 */

import { describe, expect, it } from 'bun:test';

import {
  arr,
  diagnosticsReducer,
  initialDiagnosticsState,
  str,
  type DiagnosticsState,
} from '../lib/diagnostics-pane-helpers';
import type { DiagnosticsReport } from '../lib/admin-client';

function report(slug: string): DiagnosticsReport {
  return {
    generated_at: 1,
    project_slug: slug,
    gbrain: { available: true, status: 'ok' },
    credentials: { available: false },
    repl_sessions: { available: true, sessions: [] },
    cron_jobs: { available: true, jobs: [] },
    import_jobs: { available: true, jobs: [] },
    recent_events: { available: true, events: [] },
  };
}

describe('diagnosticsReducer', () => {
  it('starts loading with no data/error', () => {
    expect(initialDiagnosticsState).toEqual({ data: null, loading: true, error: null });
  });

  it('initial load: start → success populates data, clears loading', () => {
    const started = diagnosticsReducer(initialDiagnosticsState, { type: 'fetch-start' });
    expect(started).toEqual({ data: null, loading: true, error: null });
    const done = diagnosticsReducer(started, { type: 'fetch-success', report: report('demo') });
    expect(done.loading).toBe(false);
    expect(done.error).toBeNull();
    expect(done.data?.project_slug).toBe('demo');
  });

  it('initial load FAILURE surfaces the error with no data', () => {
    const started = diagnosticsReducer(initialDiagnosticsState, { type: 'fetch-start' });
    const failed = diagnosticsReducer(started, { type: 'fetch-error', error: 'boom' });
    expect(failed).toEqual({ data: null, loading: false, error: 'boom' });
  });

  it('REFRESH FAILURE after a prior success KEEPS the loaded data (shows stale + error)', () => {
    const loaded: DiagnosticsState = {
      data: report('demo'),
      loading: false,
      error: null,
    };
    // Refresh begins — clears the prior error, keeps data, shows loading.
    const refreshing = diagnosticsReducer(loaded, { type: 'fetch-start' });
    expect(refreshing.data?.project_slug).toBe('demo');
    expect(refreshing.loading).toBe(true);
    expect(refreshing.error).toBeNull();
    // Refresh fails — data is RETAINED, error is set.
    const refreshFailed = diagnosticsReducer(refreshing, { type: 'fetch-error', error: 'network down' });
    expect(refreshFailed.data?.project_slug).toBe('demo'); // <- not blanked
    expect(refreshFailed.loading).toBe(false);
    expect(refreshFailed.error).toBe('network down');
  });

  it('refresh SUCCESS replaces stale data and clears the error', () => {
    const stale: DiagnosticsState = { data: report('old'), loading: false, error: 'was-broken' };
    const started = diagnosticsReducer(stale, { type: 'fetch-start' });
    const fresh = diagnosticsReducer(started, { type: 'fetch-success', report: report('new') });
    expect(fresh.data?.project_slug).toBe('new');
    expect(fresh.error).toBeNull();
  });
});

describe('str (safe Text-child coercion — every rendered scalar type)', () => {
  it('passes strings through', () => {
    expect(str('hello')).toBe('hello');
    expect(str('')).toBe('');
  });
  it('stringifies numbers, booleans, bigints', () => {
    expect(str(42)).toBe('42');
    expect(str(0)).toBe('0');
    expect(str(true)).toBe('true');
    expect(str(false)).toBe('false');
    expect(str(10n)).toBe('10');
  });
  it('collapses null / undefined to the fallback', () => {
    expect(str(null)).toBe('—');
    expect(str(undefined)).toBe('—');
    expect(str(null, '?')).toBe('?');
  });
  it('collapses NON-PRIMITIVES (object/array/function/symbol) to the fallback — never a React object child', () => {
    // These are exactly the values React rejects as a Text child.
    expect(str({})).toBe('—');
    expect(str({ model: 'x' })).toBe('—');
    expect(str([1, 2, 3])).toBe('—');
    expect(str(() => 1)).toBe('—');
    expect(str(Symbol('s'))).toBe('—');
    expect(str({}, 'n/a')).toBe('n/a');
  });
});

describe('arr (array normalizer for empty/unavailable collection boundaries)', () => {
  it('returns [] for undefined / non-array, passes real arrays through', () => {
    expect(arr(undefined)).toEqual([]);
    expect(arr(null as unknown as unknown[])).toEqual([]);
    expect(arr('x' as unknown as unknown[])).toEqual([]);
    expect(arr([1, 2])).toEqual([1, 2]);
    expect(arr([])).toEqual([]);
  });
});
