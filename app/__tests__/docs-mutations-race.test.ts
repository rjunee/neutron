/**
 * @neutronai/app — D7 BEHAVIOURAL race-guard coverage for
 * `useDocMutations` (ALL seven write paths).
 *
 * The app suite has no RN mount / hook-render harness (no
 * `@testing-library/react-native`; `react-test-renderer` is deprecated
 * in React 19). To still get EXECUTABLE proof that the extracted
 * mutation hook enforces the single-gate race guard — not just that the
 * `isLatest` token strings are present — this test stubs `react`'s hook
 * dispatcher (ordered slots + a committed-effect runner, à la O5's
 * DiagnosticsPane test) and drives the REAL `useDocMutations` closures
 * against a fake `DocsClient` whose network calls resolve on command.
 *
 * The load-bearing scenario (P7.1 round-5→7, "fixed 4×"): a mutation is
 * in flight when the user switches projects. Re-rendering + committing
 * the hook with a new `project_id` runs `useProjectScopedAsync`'s reset
 * effect, which invalidates the in-flight token. When the network call
 * resolves, the resolver MUST bail before committing any state (so
 * project A's content / path can't land under project B). Each mutation
 * gets a positive control (COMMITS with no switch) and a negative
 * (BAILS mid-switch); deleting any `isLatest` guard turns a BAILS
 * assertion red (mutation-verified).
 *
 * The gate reset is now a COMMITTED-phase effect (Codex D7-r2), so the
 * harness runs effects after every render — a switch only invalidates
 * once the B render is committed, exactly like React.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// ── ordered-slot react hook stub with a committed-effect runner ───────
type Slot = { v?: unknown; current?: unknown; lastDeps?: unknown[]; cleanup?: unknown };
let slots: Slot[] = [];
let idx = 0;
let frameEffects: { slot: Slot; fn: () => unknown; deps: unknown[] }[] = [];

function depsEqual(a: unknown[] | undefined, b: unknown[]): boolean {
  if (a === undefined || a.length !== b.length) return false;
  return a.every((x, i) => Object.is(x, b[i]));
}

const reactStub = {
  useState<T>(init: T | (() => T)): [T, (next: T | ((p: T) => T)) => void] {
    const i = idx++;
    if (slots[i] === undefined) {
      slots[i] = { v: typeof init === 'function' ? (init as () => T)() : init };
    }
    const slot = slots[i]!;
    const setter = (next: T | ((p: T) => T)) => {
      slot.v = typeof next === 'function' ? (next as (p: T) => T)(slot.v as T) : next;
    };
    return [slot.v as T, setter];
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
  useCallback<T>(fn: T): T {
    return fn;
  },
  useEffect(fn: () => unknown, deps: unknown[]): void {
    const i = idx++;
    if (slots[i] === undefined) slots[i] = {};
    frameEffects.push({ slot: slots[i]!, fn, deps });
  },
};
mock.module('react', () => reactStub);

/** Run captured effects whose deps changed since the last commit. */
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

// ── deferred network promises + call counters ─────────────────────────
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Method = 'tree' | 'writeFile' | 'moveFile' | 'deleteFile' | 'revert' | 'deleteBinary' | 'uploadBinary';

interface Trackers {
  setFile: unknown[];
  setSelectedPath: unknown[];
  setMode: unknown[];
  setDraftContent: unknown[];
  setTree: unknown[];
  setError: unknown[];
  fetchTreeCalls: number;
  fetchFileCalls: number;
  loadHistoryCalls: number;
  clientCalls: Record<Method, number>;
}
let calls: Trackers;
let queues: Record<Method, Deferred<unknown>[]>;

let useDocMutations: any;
let fakeClient: any;

function pushCall<T>(m: Method): Promise<T> {
  calls.clientCalls[m] += 1;
  const d = deferred<T>();
  queues[m].push(d as Deferred<unknown>);
  return d.promise;
}

beforeEach(async () => {
  slots = [];
  idx = 0;
  frameEffects = [];
  calls = {
    setFile: [],
    setSelectedPath: [],
    setMode: [],
    setDraftContent: [],
    setTree: [],
    setError: [],
    fetchTreeCalls: 0,
    fetchFileCalls: 0,
    loadHistoryCalls: 0,
    clientCalls: { tree: 0, writeFile: 0, moveFile: 0, deleteFile: 0, revert: 0, deleteBinary: 0, uploadBinary: 0 },
  };
  queues = { tree: [], writeFile: [], moveFile: [], deleteFile: [], revert: [], deleteBinary: [], uploadBinary: [] };
  fakeClient = {
    tree: () => pushCall<{ tree: unknown[]; file_count: number }>('tree'),
    writeFile: () => pushCall<{ size_bytes: number; modified_at: number }>('writeFile'),
    moveFile: () => pushCall<unknown>('moveFile'),
    deleteFile: () => pushCall<unknown>('deleteFile'),
    revert: () => pushCall<{ deleted: boolean }>('revert'),
    deleteBinary: () => pushCall<unknown>('deleteBinary'),
    uploadBinary: () => pushCall<unknown>('uploadBinary'),
  };
  ({ useDocMutations } = await import('../features/docs/use-doc-mutations'));
});

afterEach(() => {
  mock.restore();
});

const OPEN_FILE = { path: 'notes/a.md', content: 'hello', modified_at: 111, size_bytes: 5 };

// Render + commit the REAL hook against the stubbed dispatcher. Swapping
// `project_id` between calls drives a committed project switch.
function render(project_id: string) {
  idx = 0;
  frameEffects = [];
  // Deliberate test harness: `useDocMutations` is driven directly against
  // the stubbed react dispatcher, not from a real component render.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const api = useDocMutations({
    client: fakeClient,
    project_id,
    file: OPEN_FILE,
    selectedPath: OPEN_FILE.path,
    draftContent: 'edited body',
    mode: 'edit',
    setFile: (v: unknown) => calls.setFile.push(v),
    setSelectedPath: (v: unknown) => calls.setSelectedPath.push(v),
    setDraftContent: (v: unknown) => calls.setDraftContent.push(v),
    setMode: (v: unknown) => calls.setMode.push(v),
    setConflict: () => {},
    setError: (v: unknown) => calls.setError.push(v),
    fetchFile: async () => {
      calls.fetchFileCalls += 1;
    },
    fetchTree: async () => {
      calls.fetchTreeCalls += 1;
    },
    setTree: (v: unknown) => calls.setTree.push(v),
    loadHistory: async () => {
      calls.loadHistoryCalls += 1;
    },
    setPreviewVersion: () => {},
    setHistoryEntries: () => {},
    setHistoryCursor: () => {},
    setHistoryOpen: () => {},
    setRevertConfirm: () => {},
    setRevertingSha: () => {},
  });
  commitEffects();
  return api;
}

// Flush the microtask queue so awaited resolver continuations run.
const flush = () => new Promise((r) => setTimeout(r, 0));

const FILE_NODE = { kind: 'file' as const, path: OPEN_FILE.path, name: 'a.md' };

describe('handleSave — mutate gate across a project switch', () => {
  it('COMMITS with no switch (positive control)', async () => {
    const api = render('A');
    const p = api.handleSave();
    queues.writeFile[0]!.resolve({ size_bytes: 12, modified_at: 222 });
    await p;
    expect(calls.setFile.length).toBe(1);
    expect(calls.setMode).toContain('view');
  });

  it('BAILS on mid-save switch (no cross-project write)', async () => {
    const api = render('A');
    const p = api.handleSave();
    render('B'); // committed switch → reset effect invalidates the token
    queues.writeFile[0]!.resolve({ size_bytes: 12, modified_at: 222 });
    await p;
    expect(calls.setFile.length).toBe(0);
    expect(calls.setMode).not.toContain('view');
  });
});

describe('handleCreateFile — gate guard after the first await (client.tree)', () => {
  it('COMMITS with no switch (proceeds to writeFile)', async () => {
    const api = render('A');
    const p = api.handleCreateFile({ folder: '', filename: 'new' });
    queues.tree[0]!.resolve({ tree: [], file_count: 0 });
    await flush();
    queues.writeFile[0]!.resolve({ size_bytes: 0, modified_at: 1 });
    await p;
    expect(calls.setTree.length).toBe(1);
    expect(calls.clientCalls.writeFile).toBe(1);
  });

  it('BAILS on switch mid-create (no setTree, no writeFile)', async () => {
    const api = render('A');
    const p = api.handleCreateFile({ folder: '', filename: 'new' });
    render('B');
    queues.tree[0]!.resolve({ tree: [], file_count: 0 });
    await p;
    expect(calls.setTree.length).toBe(0);
    expect(calls.clientCalls.writeFile).toBe(0);
  });
});

describe('handleRename — gate guard after client.moveFile', () => {
  it('COMMITS with no switch (refreshes tree)', async () => {
    const api = render('A');
    const p = api.handleRename(FILE_NODE, 'notes/b.md');
    queues.moveFile[0]!.resolve(null);
    await flush();
    // selectedPath === node.path → fetchFile then fetchTree.
    await p;
    expect(calls.fetchTreeCalls).toBe(1);
  });

  it('BAILS on switch mid-rename (no tree refetch)', async () => {
    const api = render('A');
    const p = api.handleRename(FILE_NODE, 'notes/b.md');
    render('B');
    queues.moveFile[0]!.resolve(null);
    await p;
    expect(calls.fetchTreeCalls).toBe(0);
  });
});

describe('handleDelete (file) — gate guard after client.deleteFile', () => {
  it('COMMITS with no switch (refreshes tree)', async () => {
    const api = render('A');
    const p = api.handleDelete(FILE_NODE);
    queues.deleteFile[0]!.resolve(null);
    await p;
    expect(calls.fetchTreeCalls).toBe(1);
  });

  it('BAILS on switch mid-delete (no tree refetch, no clear)', async () => {
    const api = render('A');
    const p = api.handleDelete(FILE_NODE);
    render('B');
    queues.deleteFile[0]!.resolve(null);
    await p;
    expect(calls.fetchTreeCalls).toBe(0);
    expect(calls.setSelectedPath.length).toBe(0);
  });
});

describe('handleRevertConfirm — gate guard after client.revert', () => {
  const entry = { sha: 'deadbee', message: 'x', author_date: '2026-01-01T00:00:00Z' } as never;

  it('COMMITS with no switch (reloads file + history)', async () => {
    const api = render('A');
    const p = api.handleRevertConfirm(entry);
    queues.revert[0]!.resolve({ deleted: false });
    await p;
    expect(calls.fetchFileCalls).toBe(1);
    expect(calls.loadHistoryCalls).toBe(1);
  });

  it('BAILS on switch mid-revert (no reload)', async () => {
    const api = render('A');
    const p = api.handleRevertConfirm(entry);
    render('B');
    queues.revert[0]!.resolve({ deleted: false });
    await p;
    expect(calls.fetchFileCalls).toBe(0);
    expect(calls.loadHistoryCalls).toBe(0);
  });
});

describe('handleConfirmBinaryDelete — gate guard after client.deleteBinary', () => {
  const node = { kind: 'binary' as const, path: 'img/a.png', name: 'a.png' };

  it('COMMITS with no switch (refreshes tree)', async () => {
    const api = render('A');
    const p = api.handleConfirmBinaryDelete(node);
    queues.deleteBinary[0]!.resolve(null);
    await p;
    expect(calls.fetchTreeCalls).toBe(1);
  });

  it('BAILS on switch mid-delete (no tree refetch)', async () => {
    const api = render('A');
    const p = api.handleConfirmBinaryDelete(node);
    render('B');
    queues.deleteBinary[0]!.resolve(null);
    await p;
    expect(calls.fetchTreeCalls).toBe(0);
    expect(calls.setSelectedPath.length).toBe(0);
  });
});

describe('handleUploadBinary — gate guard after client.uploadBinary', () => {
  const pngFile = { name: 'shot.png' } as unknown as File;

  it('COMMITS with no switch (refreshes tree)', async () => {
    const api = render('A');
    const p = api.handleUploadBinary(pngFile);
    queues.uploadBinary[0]!.resolve(null);
    await p;
    expect(calls.fetchTreeCalls).toBe(1);
  });

  it('BAILS on switch mid-upload (no tree refetch, no draft splice)', async () => {
    const api = render('A');
    const p = api.handleUploadBinary(pngFile);
    render('B');
    queues.uploadBinary[0]!.resolve(null);
    await p;
    expect(calls.fetchTreeCalls).toBe(0);
    expect(calls.setDraftContent.length).toBe(0);
  });
});

describe('binaryDeleteTarget confirm modal — cleared on a committed project switch (Codex D7-r1)', () => {
  const referencedBinary = {
    kind: 'binary' as const,
    path: 'img/logo.png',
    name: 'logo.png',
    referenced_by_count: 2,
  };

  it('opens the confirm on delete, then clears it when the project switches', async () => {
    let api = render('A');
    // A binary still referenced routes to the confirm modal (no network).
    await api.handleDelete(referencedBinary);
    // Re-render A to observe the committed modal target.
    api = render('A');
    expect(api.binaryDeleteTarget).toEqual(referencedBinary);
    // Switch to B: the committed reset effect must clear the stale
    // destructive-confirm target so it can't delete under project B.
    render('B');
    api = render('B');
    expect(api.binaryDeleteTarget).toBeNull();
  });
});
