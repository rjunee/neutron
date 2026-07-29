/**
 * @neutronai/app — D7 BEHAVIOURAL coverage for the READ-side docs hooks
 * (`useDocFile`, `useDocTree`, `useDocHistory`, `useDeepLinkAnchor`).
 *
 * Same rigor as `docs-mutations-race.test.ts`: the react hook dispatcher
 * is stubbed with ordered slots + a committed-effect runner, and the
 * REAL hooks are driven against a fake `DocsClient` whose reads resolve
 * on command. Each negative test is mutation-verified — the comment on
 * it names the guard whose removal turns it red.
 *
 * The race class under test (P7.1 round-4 IMPORTANT #3): a slow read /
 * tree / history response landing AFTER a newer request (or a project /
 * client switch) must be DROPPED before it stomps state — the
 * `isLatest(token)`-before-setState guards in each hook.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import * as RealReact from 'react';

import { DocsClientError } from '../lib/docs-client';
import { type HookRuntime } from '../lib/hook-runtime';
import { useDocFile as realUseDocFile } from '../features/docs/use-doc-file';
import { useDocHistory as realUseDocHistory } from '../features/docs/use-doc-history';
import { useDocTree as realUseDocTree } from '../features/docs/use-doc-tree';
import { useDeepLinkAnchor as realUseDeepLinkAnchor } from '../features/docs/use-deep-link-anchor';

// The hook drivers below pass DELIBERATELY PARTIAL fixtures (a `DocFile`
// with only the fields the code path reads, a bare `CommitSummary`, …).
// That was type-invisible while these modules were `await import`ed into an
// `any`; with the static imports it would now be a compile error, so each
// hook is aliased through one explicit loose signature. This preserves the
// pre-existing typing of the drivers EXACTLY — no assertion is relaxed.
type LooseHook = (params: any, hooks: HookRuntime) => any;
const useDocFile = realUseDocFile as LooseHook;
const useDocTree = realUseDocTree as LooseHook;
const useDocHistory = realUseDocHistory as LooseHook;
const useDeepLinkAnchor = realUseDeepLinkAnchor as LooseHook;

// ── ordered-slot react hook stub + committed-effect runner ────────────
type Slot = { v?: unknown; current?: unknown; lastDeps?: unknown[]; cleanup?: unknown };
let slots: Slot[] = [];
let idx = 0;
let frameEffects: { slot: Slot; fn: () => unknown; deps: unknown[] }[] = [];

function depsEqual(a: unknown[] | undefined, b: unknown[]): boolean {
  if (a === undefined || a.length !== b.length) return false;
  return a.every((x, i) => Object.is(x, b[i]));
}
// The stub is INJECTED into each hook under test (their optional
// `hooks: HookRuntime` parameter — see `lib/hook-runtime.ts`), never
// installed globally. `mock.module('react', ...)` was the old mechanism;
// it is process-global in bun and is NOT undone by `mock.restore()`, so
// it left every later test in the run rendering against this stub
// (~92 failures, all `ReactSharedInternals.S` inside react-dom). With
// injection the substitution is scoped to these call sites, so nothing
// here can depend on — or affect — test file execution ORDER.
//
// Real react is spread in so the non-dispatcher members of `HookRuntime`
// (`useReducer`, unused by these hooks) are genuine; the five dispatcher
// hooks below are the ones under test control. (react-native is not
// involved: `useDeepLinkAnchor`'s `ScrollView` is a type-only import.)
const reactStub = {
  ...RealReact,
  useState<T>(init: T | (() => T)): [T, (n: T | ((p: T) => T)) => void] {
    const i = idx++;
    if (slots[i] === undefined) slots[i] = { v: typeof init === 'function' ? (init as () => T)() : init };
    const slot = slots[i]!;
    return [slot.v as T, (n) => { slot.v = typeof n === 'function' ? (n as (p: T) => T)(slot.v as T) : n; }];
  },
  useRef<T>(init: T): { current: T } {
    const i = idx++;
    if (slots[i] === undefined) slots[i] = { current: init };
    return slots[i] as { current: T };
  },
  useMemo<T>(fn: () => T): T {
    const i = idx++;
    if (slots[i] === undefined) slots[i] = { v: fn() };
    return slots[i]!.v as T;
  },
  useCallback<T>(fn: T): T { return fn; },
  useEffect(fn: () => unknown, deps: unknown[]): void {
    const i = idx++;
    if (slots[i] === undefined) slots[i] = {};
    frameEffects.push({ slot: slots[i]!, fn, deps });
  },
} as unknown as HookRuntime;
// NB: react-native is NOT mocked and NOT imported by any hook under test.
// All four read hooks are RN-runtime-free — useDeepLinkAnchor's
// `ScrollView` is a type-only import — so this suite never loads (or
// mocks) react-native. That matters: real react-native won't parse in
// bun (Flow), and MOCKING it corrupts real-RN named imports for
// chunk-mates under run-tests.sh's per-process file grouping. The
// react-native-dependent PANES (docs-ui) get their own RENDER coverage in
// docs-panes-render.test.ts, which mocks react-native the way
// diagnostics-pane-render.test.ts does.

function commitEffects(): void {
  for (const e of frameEffects) {
    if (!depsEqual(e.slot.lastDeps, e.deps)) {
      if (typeof e.slot.cleanup === 'function') (e.slot.cleanup as () => void)();
      const c = e.fn();
      e.slot.cleanup = typeof c === 'function' ? c : undefined;
      e.slot.lastDeps = e.deps;
    }
  }
}

// ── deferred reads keyed by op name + index ───────────────────────────
interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void; }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
type Op = 'readFile' | 'tree' | 'history' | 'getVersion';
let q: Record<Op, { d: Deferred<unknown>; args: unknown[] }[]>;
function op(name: Op, args: unknown[]): Promise<unknown> {
  const d = deferred<unknown>();
  q[name].push({ d, args });
  return d.promise;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
async function settleAt(name: Op, i: number, value: unknown): Promise<void> { q[name][i]!.d.resolve(value); await flush(); }
async function failAt(name: Op, i: number, err: unknown): Promise<void> { q[name][i]!.d.reject(err); await flush(); }
function argsAt(name: Op, i: number): unknown[] { return q[name][i]!.args; }

interface Calls {
  setError: unknown[];
  setSelectedPath: unknown[];
  setFile: unknown[];
  fetchFile: unknown[];
}
let calls: Calls;
let client: any;

function resetHarness(): void {
  slots = [];
  idx = 0;
  frameEffects = [];
  q = { readFile: [], tree: [], history: [], getVersion: [] };
  calls = { setError: [], setSelectedPath: [], setFile: [], fetchFile: [] };
  client = {
    readFile: (...a: unknown[]) => op('readFile', a),
    tree: (...a: unknown[]) => op('tree', a),
    history: (...a: unknown[]) => op('history', a),
    getVersion: (...a: unknown[]) => op('getVersion', a),
  };
}

// The hooks are now plain STATIC imports: with the dispatcher injected
// there is no mock to register before the module graph links, so no
// import-ordering dance is needed (and no `mock.restore()` to get wrong).
beforeEach(() => {
  resetHarness();
});

// Harness drives the hooks directly against the stubbed dispatcher.
function drive<T>(fn: () => T): T { idx = 0; frameEffects = []; const r = fn(); commitEffects(); return r; }

// ── useDocFile ────────────────────────────────────────────────────────
describe('useDocFile — read race guard (:66)', () => {
  const renderFile = (project_id: string, c = client) => drive(() => useDocFile({ client: c, project_id }, reactStub));

  it('overlapping reads: the NEWER read wins; the older late response is dropped', async () => {
    let api = renderFile('P');
    api.fetchFile('a.md'); // token1, readFile[0]
    api.fetchFile('b.md'); // token2, readFile[1]
    await settleAt('readFile', 1, { path: 'b.md', content: 'BBB', size_bytes: 3, modified_at: 2 });
    await settleAt('readFile', 0, { path: 'a.md', content: 'AAA', size_bytes: 3, modified_at: 1 }); // stale
    api = renderFile('P');
    // Remove the `if (!fileGate.isLatest(token)) return` after readFile → 'AAA' wins → red.
    expect(api.file?.content).toBe('BBB');
    expect(api.file?.path).toBe('b.md');
  });

  it('project switch mid-read: the in-flight result is discarded', async () => {
    let api = renderFile('P');
    api.fetchFile('a.md'); // token1
    renderFile('Q'); // committed switch → fileGate reset
    await settleAt('readFile', 0, { path: 'a.md', content: 'AAA', size_bytes: 3, modified_at: 1 });
    api = renderFile('Q');
    // Remove the guard → 'AAA' lands under project Q → red.
    expect(api.file).toBeNull();
  });

  it('client/session switch mid-read: the in-flight result is discarded', async () => {
    let api = renderFile('P');
    api.fetchFile('a.md');
    renderFile('P', { ...client }); // same project, new DocsClient
    await settleAt('readFile', 0, { path: 'a.md', content: 'AAA', size_bytes: 3, modified_at: 1 });
    api = renderFile('P', client);
    expect(api.file).toBeNull();
  });

  it('read error surfaces via error, file stays null', async () => {
    let api = renderFile('P');
    api.fetchFile('a.md');
    await failAt('readFile', 0, new DocsClientError('io_error', 'boom', 500, null));
    api = renderFile('P');
    expect(typeof api.error).toBe('string');
    expect(api.file).toBeNull();
  });
});

// ── useDocTree ────────────────────────────────────────────────────────
describe('useDocTree — tree race guard + loading cleanup', () => {
  const setError = (v: unknown) => calls.setError.push(v);
  const renderTree = (project_id: string, c = client) =>
    drive(() => useDocTree({ client: c, project_id, setError }, reactStub));

  it('fetches on mount and commits the tree', async () => {
    let api = renderTree('P'); // mount effect → tree[0]
    expect(argsAt('tree', 0)).toEqual(['P']);
    await settleAt('tree', 0, { tree: [{ kind: 'file', path: 'x.md', name: 'x.md' }], file_count: 1 });
    api = renderTree('P');
    expect(api.tree.length).toBe(1);
    expect(api.loadingTree).toBe(false);
  });

  it('switch mid-fetch: the stale tree response is dropped', async () => {
    renderTree('P'); // tree[0] (token1)
    renderTree('Q'); // gate reset + refetch tree[1] (token2)
    await settleAt('tree', 1, { tree: [{ kind: 'file', path: 'b.md', name: 'b.md' }], file_count: 1 });
    await settleAt('tree', 0, { tree: [{ kind: 'file', path: 'a.md', name: 'a.md' }], file_count: 1 }); // stale
    const api = renderTree('Q');
    // Remove the guard after client.tree → 'a.md' overwrites 'b.md' → red.
    expect(api.tree.map((n: { path: string }) => n.path)).toEqual(['b.md']);
  });

  it('a superseded fetch does NOT clear loadingTree (conditional finally)', async () => {
    renderTree('P'); // tree[0] token1, loadingTree true
    renderTree('Q'); // tree[1] token2, loadingTree true
    await settleAt('tree', 0, { tree: [], file_count: 0 }); // stale resolves; guard drops
    const api = renderTree('Q');
    // Make the finally unconditional → stale call clears loading while
    // the newer fetch is still pending → red.
    expect(api.loadingTree).toBe(true);
  });

  it('tree fetch error clears loading and surfaces error', async () => {
    renderTree('P'); // tree[0]
    await failAt('tree', 0, new DocsClientError('io_error', 'boom', 500, null));
    const api = renderTree('P');
    expect(api.loadingTree).toBe(false);
    expect(calls.setError.length).toBeGreaterThan(0);
    expect(api.tree.length).toBe(0);
  });
});

// ── useDocHistory ─────────────────────────────────────────────────────
describe('useDocHistory — history race guard (:84)', () => {
  const setError = (v: unknown) => calls.setError.push(v);
  const FILE = { path: 'notes/a.md', content: '', size_bytes: 0, modified_at: 1 };
  const renderHist = (project_id: string, c = client, file = FILE) =>
    drive(() => useDocHistory({ client: c, project_id, file, setError }, reactStub));
  const entry = (sha: string) => ({ sha, message: sha, author_date: '2026-01-01T00:00:00Z' });

  it('newer load wins; the older late page is dropped', async () => {
    let api = renderHist('P');
    api.loadHistory('a.md'); // token1, history[0]
    api.loadHistory('a.md'); // token2, history[1]
    await settleAt('history', 1, { history: [entry('bbb')], next_cursor: null });
    await settleAt('history', 0, { history: [entry('aaa')], next_cursor: null }); // stale
    api = renderHist('P');
    // Remove the guard after client.history → 'aaa' replaces 'bbb' → red.
    expect(api.historyEntries.map((e: { sha: string }) => e.sha)).toEqual(['bbb']);
  });

  it('switch mid-fetch: the stale history is discarded', async () => {
    let api = renderHist('P');
    api.loadHistory('a.md'); // token1
    renderHist('Q'); // gate reset
    await settleAt('history', 0, { history: [entry('aaa')], next_cursor: null });
    api = renderHist('Q');
    expect(api.historyEntries.length).toBe(0);
  });

  it('versioning_unavailable error sets the unavailable flag + clears loading', async () => {
    let api = renderHist('P');
    api.loadHistory('a.md');
    await failAt('history', 0, new DocsClientError('versioning_unavailable', 'no vcs', 501, null));
    api = renderHist('P');
    expect(api.historyUnavailable).toBe(true);
    expect(api.historyLoading).toBe(false);
    expect(api.historyEntries.length).toBe(0);
  });

  it('a generic history error surfaces via error + clears loading', async () => {
    let api = renderHist('P');
    api.loadHistory('a.md');
    await failAt('history', 0, new DocsClientError('io_error', 'boom', 500, null));
    api = renderHist('P');
    expect(calls.setError.length).toBeGreaterThan(0);
    expect(api.historyLoading).toBe(false);
  });

  // ── handlePreviewVersion (getVersion → setPreviewVersion) ──
  it('preview COMMITS with the right args (project_id, sha, file.path)', async () => {
    let api = renderHist('P');
    api.handlePreviewVersion(entry('v1'));
    expect(argsAt('getVersion', 0)).toEqual(['P', 'v1', 'notes/a.md']);
    await settleAt('getVersion', 0, { sha: 'v1', content: 'V1', message: 'v1' });
    api = renderHist('P');
    expect((api.previewVersion as { sha: string }).sha).toBe('v1');
  });

  it('preview: newer request wins; the older late version is dropped', async () => {
    let api = renderHist('P');
    api.handlePreviewVersion(entry('a')); // token1, getVersion[0]
    api.handlePreviewVersion(entry('b')); // token2, getVersion[1]
    await settleAt('getVersion', 1, { sha: 'b', content: 'B', message: 'b' });
    await settleAt('getVersion', 0, { sha: 'a', content: 'A', message: 'a' }); // stale
    api = renderHist('P');
    // Remove the guard at use-doc-history.ts:129 → 'a' overwrites 'b' → red.
    expect((api.previewVersion as { sha: string }).sha).toBe('b');
  });

  it('preview: project switch mid-fetch discards the stale version', async () => {
    let api = renderHist('P');
    api.handlePreviewVersion(entry('a')); // token1
    renderHist('Q'); // committed switch → historyGate reset
    await settleAt('getVersion', 0, { sha: 'a', content: 'A', message: 'a' });
    api = renderHist('Q');
    expect(api.previewVersion).toBeNull();
  });

  it('preview: client/session switch mid-fetch discards the stale version', async () => {
    let api = renderHist('P');
    api.handlePreviewVersion(entry('a'));
    renderHist('P', { ...client }); // same project, new DocsClient
    await settleAt('getVersion', 0, { sha: 'a', content: 'A', message: 'a' });
    api = renderHist('P', client);
    expect(api.previewVersion).toBeNull();
  });

  it('preview: a getVersion error surfaces via error, no version committed', async () => {
    let api = renderHist('P');
    api.handlePreviewVersion(entry('a'));
    await failAt('getVersion', 0, new DocsClientError('io_error', 'boom', 500, null));
    api = renderHist('P');
    expect(calls.setError.length).toBeGreaterThan(0);
    expect(api.previewVersion).toBeNull();
  });

  it('preview: a stale getVersion error after a switch is DROPPED (catch guard)', async () => {
    const api = renderHist('P');
    api.handlePreviewVersion(entry('a')); // token1
    renderHist('Q'); // switch → historyGate reset invalidates token1
    await failAt('getVersion', 0, new DocsClientError('io_error', 'boom', 500, null));
    // Remove the catch guard at use-doc-history.ts:132 → the stale error
    // lands under project Q → setError fires → red.
    expect(calls.setError.length).toBe(0);
  });
});

// ── useDeepLinkAnchor ─────────────────────────────────────────────────
describe('useDeepLinkAnchor — auto-select (:116) + malformed no-op', () => {
  const base = {
    file: null as unknown,
    selectedPath: null as unknown,
    mode: 'view' as const,
    setFile: (v: unknown) => calls.setFile.push(v),
    setSelectedPath: (v: unknown) => calls.setSelectedPath.push(v),
    fetchFile: (...a: unknown[]) => { calls.fetchFile.push(a); return Promise.resolve(); },
  };
  const renderAnchor = (over: Record<string, unknown>) =>
    drive(() => useDeepLinkAnchor({ loadingTree: false, ...base, ...over }, reactStub));

  it('a valid markdown anchor selects the target + fetches it', () => {
    renderAnchor({ pathParam: 'notes/a.md' });
    // Break the auto-select effect (drop setSelectedPath / the else-fetch) → red.
    expect(calls.setSelectedPath).toContain('notes/a.md');
    expect(calls.fetchFile).toContainEqual(['notes/a.md']);
  });

  it('does NOT select while the tree is still loading', () => {
    renderAnchor({ pathParam: 'notes/a.md', loadingTree: true });
    // Remove the `if (loadingTree) return` guard → premature selection → red.
    expect(calls.setSelectedPath.length).toBe(0);
    expect(calls.fetchFile.length).toBe(0);
  });

  it('a binary anchor renders via BinaryPreview (setFile(null)), never fetched as markdown', () => {
    renderAnchor({ pathParam: 'img/logo.png' });
    // Remove the isBinaryExtension branch → fetchFile('img/logo.png') 4xxs → red.
    expect(calls.setSelectedPath).toContain('img/logo.png');
    expect(calls.setFile).toContain(null);
    expect(calls.fetchFile.length).toBe(0);
  });

  it('no anchor param is a no-op (no throw, no selection)', () => {
    expect(() => renderAnchor({ pathParam: undefined })).not.toThrow();
    expect(calls.setSelectedPath.length).toBe(0);
    expect(calls.fetchFile.length).toBe(0);
  });

  it('malformed line/range params degrade to no-highlight without throwing', () => {
    let api!: ReturnType<typeof renderAnchor>;
    expect(() => {
      api = renderAnchor({ pathParam: 'notes/a.md', lineParam: 'abc', rangeParam: 'x-y' });
    }).not.toThrow();
    expect(api.deepLinkPath).toBe('notes/a.md');
    expect(api.highlightSpan).toBeNull();
  });

  it('exposes ?folder as folderPath', () => {
    const api = renderAnchor({ folderParam: 'sub/dir' });
    expect(api.folderPath).toBe('sub/dir');
  });
});
