/**
 * @neutronai/app — DiagnosticsPane COMPONENT-BOUNDARY tests (O5).
 *
 * The repo's app suite has no RN mount harness (no @testing-library/react-native;
 * react-test-renderer is deprecated in React 19). To still get EXECUTABLE
 * coverage of the wiring that pure-helper tests can't reach — fetch-on-mount, the
 * refresh handler, the error banner, and the initial spinner — this test stubs
 * `react-native` host components (so the element tree is inspectable) and drives
 * the component's hooks directly (no renderer, no new deps). It catches the exact
 * mutations that would otherwise pass: deleting the mount effect's `fetchOne()`
 * or removing the refresh `onPress`.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as RealReact from 'react';

import type { DiagnosticsReport } from '../lib/admin-client';
import type { DiagnosticsAction, DiagnosticsState } from '../lib/diagnostics-pane-helpers';

// ── react-native host stubs: each primitive becomes an inspectable element with
//    its props (testID, onPress, accessibilityState, children) preserved. ──────
const rnStub = (name: string) =>
  function Stub(props: Record<string, unknown>) {
    return RealReact.createElement(name, props, props.children as RealReact.ReactNode);
  };
mock.module('react-native', () => ({
  View: rnStub('View'),
  Text: rnStub('Text'),
  Pressable: rnStub('Pressable'),
  ScrollView: rnStub('ScrollView'),
  ActivityIndicator: rnStub('ActivityIndicator'),
  StyleSheet: { create: (s: Record<string, unknown>) => s },
}));

// ── react hook control: useReducer returns a test-set [state, dispatch]; the
//    mount effect is captured so we can invoke it; useCallback/useMemo pass thru. ─
let currentState: DiagnosticsState;
let capturedEffect: (() => void) | null = null;
let dispatched: DiagnosticsAction[] = [];
const reactStub = {
  ...RealReact,
  useReducer: () => [currentState, (a: DiagnosticsAction) => dispatched.push(a)] as const,
  useEffect: (fn: () => void) => {
    capturedEffect = fn;
  },
  useCallback: <T>(fn: T) => fn,
};
mock.module('react', () => ({ ...reactStub, default: reactStub }));

// Imported AFTER the mocks are registered.
const { DiagnosticsPane } = await import('../features/admin/DiagnosticsPane');

interface El {
  type: unknown;
  props: Record<string, unknown>;
}
function isEl(x: unknown): x is El {
  return typeof x === 'object' && x !== null && 'props' in x && 'type' in x;
}

/**
 * Mini-renderer: expand every function-component element by INVOKING it (Section,
 * Row, and the RN host stubs are pure — no hooks), leaving a tree of host
 * (string-type) elements whose props (testID, onPress, disabled, string
 * children) are directly inspectable. DiagnosticsPane itself is already invoked
 * by the caller (its hooks are mocked), so we never re-invoke it here.
 */
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand);
  if (!isEl(node)) return node;
  if (typeof node.type === 'function') {
    return expand((node.type as (p: Record<string, unknown>) => unknown)(node.props));
  }
  return { type: node.type, props: { ...node.props, children: expand(node.props.children) } };
}

function* walk(node: unknown): Generator<El> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
    return;
  }
  if (!isEl(node)) return;
  yield node;
  yield* walk(node.props.children);
}
function findByTestId(tree: unknown, id: string): El | undefined {
  for (const el of walk(expand(tree))) if (el.props.testID === id) return el;
  return undefined;
}
function hasHostType(tree: unknown, type: string): boolean {
  for (const el of walk(expand(tree))) if (el.type === type) return true;
  return false;
}
function textContains(tree: unknown, needle: string): boolean {
  for (const el of walk(expand(tree))) {
    const c = el.props.children;
    const parts = Array.isArray(c) ? c : [c];
    if (parts.some((x) => typeof x === 'string' && x.includes(needle))) return true;
  }
  return false;
}

function report(slug: string): DiagnosticsReport {
  return {
    generated_at: 1,
    project_slug: slug,
    gbrain: { available: true, status: 'ok' },
    credentials: { available: false, note: 'not wired on this gateway' },
    repl_sessions: { available: true, sessions: [] },
    cron_jobs: { available: true, jobs: [] },
    import_jobs: { available: true, jobs: [] },
    recent_events: { available: true, events: [] },
  };
}

/** Flush pending microtasks so a fire-and-forget `void fetchOne()` settles. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeClient(impl?: () => Promise<DiagnosticsReport>) {
  const calls = { n: 0 };
  const client = {
    getDiagnostics: () => {
      calls.n += 1;
      return impl ? impl() : Promise.resolve(report('demo'));
    },
  };
  return { client: client as unknown as import('../lib/admin-client').AdminClient, calls };
}

beforeEach(() => {
  capturedEffect = null;
  dispatched = [];
  currentState = { data: null, loading: true, error: null };
});
afterEach(() => {
  // no-op; mock.module registrations persist for the file (all tests share them)
});

describe('DiagnosticsPane component boundary', () => {
  it('fetches on mount and dispatches fetch-start → fetch-success (resolved)', async () => {
    const rep = report('demo');
    const { client, calls } = makeClient(() => Promise.resolve(rep));
    DiagnosticsPane({ client }); // registers the mount effect via our useEffect stub
    expect(capturedEffect).not.toBeNull();
    await capturedEffect!(); await flush(); // run the mount effect + settle
    // wiring regression (removing `void fetchOne()`) would leave this at 0.
    expect(calls.n).toBe(1);
    // and it drives the reducer through the correct ORDERED lifecycle.
    expect(dispatched).toEqual([
      { type: 'fetch-start' },
      { type: 'fetch-success', report: rep },
    ]);
  });

  it('a REJECTED mount fetch dispatches fetch-start → fetch-error (with the formatted message)', async () => {
    const { client } = makeClient(() => Promise.reject(new Error('network boom')));
    DiagnosticsPane({ client });
    await capturedEffect!();
    await flush();
    expect(dispatched[0]).toEqual({ type: 'fetch-start' });
    expect(dispatched[1]?.type).toBe('fetch-error');
    expect((dispatched[1] as { error: string }).error).toContain('network boom');
  });

  it('initial load renders ONLY the spinner (no report yet)', () => {
    const { client } = makeClient();
    currentState = { data: null, loading: true, error: null };
    const tree = DiagnosticsPane({ client });
    expect(hasHostType(tree, 'ActivityIndicator')).toBe(true);
    expect(findByTestId(tree, 'admin-diagnostics-refresh')).toBeUndefined();
  });

  it('loaded state renders sections + a working Refresh control that re-fetches', async () => {
    const { client, calls } = makeClient();
    currentState = { data: report('demo'), loading: false, error: null };
    const tree = DiagnosticsPane({ client });
    // sections rendered (at least the section cards + their titles are present)
    const sectionIds = [...walk(expand(tree))]
      .map((el) => el.props.testID)
      .filter((id): id is string => typeof id === 'string' && id.startsWith('admin-diagnostics-'));
    expect(sectionIds.length).toBeGreaterThanOrEqual(6); // 6 diagnostic sections
    expect(textContains(tree, 'Memory (gbrain)')).toBe(true);
    expect(textContains(tree, 'Import jobs')).toBe(true);
    // refresh control present + wired
    const refresh = findByTestId(tree, 'admin-diagnostics-refresh');
    expect(refresh).toBeDefined();
    const onPress = refresh!.props.onPress as (() => void) | undefined;
    expect(typeof onPress).toBe('function');
    dispatched = []; // ignore any mount dispatches; focus on the refresh press
    await (onPress as () => Promise<void>)();
    // the onPress handler must call fetchOne → getDiagnostics (regression: removed onPress)
    expect(calls.n).toBe(1);
    // and drive the same ordered lifecycle as mount.
    expect(dispatched.map((d) => d.type)).toEqual(['fetch-start', 'fetch-success']);
  });

  it('error state renders the error banner', () => {
    const { client } = makeClient();
    currentState = { data: report('demo'), loading: false, error: 'network down' };
    const tree = DiagnosticsPane({ client });
    expect(textContains(tree, 'network down')).toBe(true);
  });

  it('refresh-in-flight keeps the report on screen (spinner NOT full-screen) + disables the button', () => {
    const { client } = makeClient();
    currentState = { data: report('demo'), loading: true, error: null };
    const tree = DiagnosticsPane({ client });
    // report still visible (not blanked to a bare spinner)
    expect(findByTestId(tree, 'admin-diagnostics-refresh')).toBeDefined();
    const refresh = findByTestId(tree, 'admin-diagnostics-refresh')!;
    expect(refresh.props.disabled).toBe(true);
    expect(textContains(tree, 'Refreshing')).toBe(true);
  });
});
