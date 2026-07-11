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

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as RealReact from 'react';

import { DocsClientError } from '../lib/docs-client';

// ── ordered-slot react hook stub + committed-effect runner ────────────
type Slot = { v?: unknown; current?: unknown; lastDeps?: unknown[]; cleanup?: unknown };
let slots: Slot[] = [];
let idx = 0;
let frameEffects: { slot: Slot; fn: () => unknown; deps: unknown[] }[] = [];

function depsEqual(a: unknown[] | undefined, b: unknown[]): boolean {
  if (a === undefined || a.length !== b.length) return false;
  return a.every((x, i) => Object.is(x, b[i]));
}
// Spread the REAL react so every other export (useReducer, createElement,
// jsx internals, …) survives — only the five dispatcher hooks are
// overridden. This keeps the mock from breaking any other test file's
// react imports if module isolation ever interleaves. (react-native is
// NOT mocked: useDeepLinkAnchor's `ScrollView` value-import loads the
// real module fine and is never instantiated here.)
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
};
mock.module('react', () => ({ ...reactStub, default: reactStub }));
// react-native can't be loaded in bun (Flow syntax). useDeepLinkAnchor
// value-imports `ScrollView`; stub react-native as a SUPERSET of every
// export any docs module needs so this never loads the real module (and
// is harmless if it wins globally over a sibling suite's narrower stub).
const rnStub = (name: string) => { const C = () => null; Object.defineProperty(C, 'name', { value: name }); return C; };
mock.module('react-native', () => ({
  View: rnStub('View'),
  Text: rnStub('Text'),
  Pressable: rnStub('Pressable'),
  ScrollView: rnStub('ScrollView'),
  TextInput: rnStub('TextInput'),
  ActivityIndicator: rnStub('ActivityIndicator'),
  Image: rnStub('Image'),
  Modal: rnStub('Modal'),
  Linking: { openURL: () => Promise.resolve() },
  Platform: { OS: 'web' },
  StyleSheet: { create: (s: Record<string, unknown>) => s },
  useWindowDimensions: () => ({ width: 1200, height: 800 }),
}));
// The heavy pane children pull Flow-typed deps bun can't parse — stub
// them so `docs-panes` (imported below for the pane-wiring smoke tests)
// loads cheaply. Kept in THIS file (not a separate one) so the docs
// suite only ever registers ONE react-native mock: a 3rd RN-mocking test
// file trips a bun double-mock→real-module resolution bug.
mock.module('../lib/markdown-render', () => ({ RenderMarkdown: rnStub('RenderMarkdown') }));
mock.module('../lib/comments-state', () => ({ CommentsProvider: rnStub('CommentsProvider') }));
mock.module('../components/CommentsSidePane', () => ({ CommentsSidePane: rnStub('CommentsSidePane') }));

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
type Op = 'readFile' | 'tree' | 'history';
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
let hooks: any;
let client: any;

function resetHarness(): void {
  slots = [];
  idx = 0;
  frameEffects = [];
  q = { readFile: [], tree: [], history: [] };
  calls = { setError: [], setSelectedPath: [], setFile: [], fetchFile: [] };
  client = {
    readFile: (...a: unknown[]) => op('readFile', a),
    tree: (...a: unknown[]) => op('tree', a),
    history: (...a: unknown[]) => op('history', a),
  };
}

beforeEach(async () => {
  resetHarness();
  hooks = {
    useDocFile: (await import('../features/docs/use-doc-file')).useDocFile,
    useDocTree: (await import('../features/docs/use-doc-tree')).useDocTree,
    useDocHistory: (await import('../features/docs/use-doc-history')).useDocHistory,
    useDeepLinkAnchor: (await import('../features/docs/use-deep-link-anchor')).useDeepLinkAnchor,
  };
});
// NB: no mock.restore() — mirroring the CI-proven diagnostics-pane-render
// test, the module mocks persist for THIS file. Restoring react-native
// mid-run corrupts its module state for chunk-mates that import the real
// module (run-tests.sh groups files per process). The react stub spreads
// the real module and the RN stub is a superset, so persistence is safe.

// Harness drives the hooks directly against the stubbed dispatcher.
function drive<T>(fn: () => T): T { idx = 0; frameEffects = []; const r = fn(); commitEffects(); return r; }

// ── useDocFile ────────────────────────────────────────────────────────
describe('useDocFile — read race guard (:66)', () => {
  const renderFile = (project_id: string, c = client) => drive(() => hooks.useDocFile({ client: c, project_id }));

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
    drive(() => hooks.useDocTree({ client: c, project_id, setError }));

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
    drive(() => hooks.useDocHistory({ client: c, project_id, file, setError }));
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
    drive(() => hooks.useDeepLinkAnchor({ loadingTree: false, ...base, ...over }));

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

// ── DocViewerPane / DocHistoryPane wiring (item 5) ────────────────────
// The panes are pure (no hooks); we call them directly under the same
// react/react-native stubs and walk the returned element tree for
// testIDs/text that ONLY appear when the pane consumes the hook object.
const panes: any = await import('../features/docs/docs-panes');

function scan(node: unknown, ids: string[], texts: string[]): void {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) { for (const n of node) scan(n, ids, texts); return; }
  if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return; }
  if (typeof node === 'object') {
    const props = (node as { props?: Record<string, unknown> }).props;
    if (props) {
      if (typeof props.testID === 'string') ids.push(props.testID);
      scan(props.children, ids, texts);
    }
  }
}
function tree(el: unknown): { ids: string[]; texts: string[] } {
  const ids: string[] = [];
  const texts: string[] = [];
  scan(el, ids, texts);
  return { ids, texts };
}

describe('DocHistoryPane wiring', () => {
  const baseHistory = {
    historyUnavailable: false,
    historyLoading: false,
    historyEntries: [] as unknown[],
    historyCursor: null,
    revertingSha: null,
    handlePreviewVersion: () => {},
    setRevertConfirm: () => {},
    loadHistory: () => {},
    setHistoryOpen: () => {},
  };
  const file = { path: 'notes/a.md', content: '', size_bytes: 0, modified_at: 1 };

  it('renders a row per historyEntries entry (wired to the hook state)', () => {
    const entry = { sha: 'abc1234', message: 'first commit', author_date: '2026-01-01T00:00:00Z' };
    const { ids, texts } = tree(
      panes.DocHistoryPane({ docHistory: { ...baseHistory, historyEntries: [entry] }, file, wideViewport: true }),
    );
    expect(ids).toContain('docs-history-pane');
    // ONLY present if the pane maps historyEntries → stop mapping → red.
    expect(ids).toContain('docs-history-row-abc1234');
    expect(texts.join(' ')).toContain('first commit');
  });

  it('renders the versioning-unavailable notice when the hook flags it', () => {
    const { texts } = tree(
      panes.DocHistoryPane({ docHistory: { ...baseHistory, historyUnavailable: true }, file, wideViewport: true }),
    );
    expect(texts.join(' ')).toContain('Versioning isn’t available');
  });
});

describe('DocViewerPane wiring', () => {
  const common = {
    docHistory: {
      historyEntries: [] as unknown[],
      historyCursor: null,
      historyOpen: false,
      handleToggleHistory: () => {},
      previewVersion: null,
      handleExitPreview: () => {},
    },
    docMutations: {
      saving: false,
      handleSave: () => {},
      handleEditorDrop: () => {},
      dragOver: false,
      setDragOver: () => {},
      setEditorSelection: () => {},
    },
    anchor: {
      handleScrollToAnchor: () => {},
      formatAnchorLineLabelForSidePane: () => null,
      viewerScrollRef: { current: null },
      highlightSpan: null,
    },
    tree: [],
    client: null,
    project_id: 'P',
    wideViewport: true,
    commentsPaneOpen: false,
    setCommentsPaneOpen: () => {},
    mobilePane: 'editor' as const,
    setMobilePane: () => {},
  };
  const fileState = (over: Record<string, unknown>) => ({
    file: null,
    selectedPath: null,
    mode: 'view' as const,
    draftContent: '',
    conflict: false,
    setDraftContent: () => {},
    setMode: () => {},
    handleReload: () => {},
    resolveBinary: undefined,
    ...over,
  });

  it('renders the viewer surface (docs-viewer) + file path when docFile.file is set', () => {
    const docFile = fileState({ file: { path: 'notes/a.md', content: '# hi', size_bytes: 4, modified_at: 1 }, selectedPath: 'notes/a.md', draftContent: '# hi' });
    const { ids, texts } = tree(panes.DocViewerPane({ ...common, docFile }));
    expect(ids).toContain('docs-viewer');
    expect(texts.join(' ')).toContain('notes/a.md');
  });

  it('renders the empty prompt when docFile.file is null and nothing selected', () => {
    const { ids, texts } = tree(panes.DocViewerPane({ ...common, docFile: fileState({}) }));
    expect(ids).not.toContain('docs-viewer');
    expect(texts.join(' ')).toContain('Pick a doc from the tree');
  });
});
