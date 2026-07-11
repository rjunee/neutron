/**
 * @neutronai/app — D7 BEHAVIOURAL race-guard coverage for
 * `useDocMutations`.
 *
 * The app suite has no RN mount / hook-render harness (no
 * `@testing-library/react-native`; `react-test-renderer` is deprecated
 * in React 19). To still get EXECUTABLE proof that the extracted
 * mutation hook actually enforces the single-gate race guard — not just
 * that the `isLatest` token strings are present — this test stubs
 * `react`'s hook dispatcher (ordered slots, à la O5's DiagnosticsPane
 * test) and drives the REAL `useDocMutations` closures against a fake
 * `DocsClient` whose network calls resolve on command.
 *
 * The load-bearing scenario (P7.1 round-5→7, "fixed 4×"): a mutation is
 * in flight when the user switches projects. Re-rendering the hook with
 * a new `project_id` trips `useProjectScopedAsync`'s render-phase
 * reset, which invalidates the in-flight token. When the network call
 * finally resolves, the resolver MUST bail before committing any state
 * (so project A's content / path can't land under project B). Deleting
 * any `if (!mutateGate.isLatest(token)) return;` guard flips one of
 * these assertions red.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// ── ordered-slot react hook stub ──────────────────────────────────────
// Slots persist across renders (useState / useRef / useMemo keep their
// value); `idx` resets each render so call-order maps to the same slot,
// exactly like React's rules-of-hooks.
type Slot = { v?: unknown; current?: unknown };
let slots: Slot[] = [];
let idx = 0;

function beginRender(): void {
  idx = 0;
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
  useEffect(): void {
    // Effects are irrelevant to the render-phase gate reset under test.
  },
};
mock.module('react', () => reactStub);

// ── deferred network promises ─────────────────────────────────────────
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

// ── shared call trackers (the cross-cluster PARAM setters) ────────────
interface Trackers {
  setFile: unknown[];
  setSelectedPath: unknown[];
  setMode: unknown[];
  setDraftContent: unknown[];
  setConflict: unknown[];
  setError: unknown[];
  fetchTreeCalls: number;
  fetchFileCalls: number;
}
let calls: Trackers;

let useDocMutations: any;
let fakeClient: any;
// deferred queues per method
let writeFileD: Deferred<{ size_bytes: number; modified_at: number }>[];
let deleteBinaryD: Deferred<unknown>[];
let uploadBinaryD: Deferred<unknown>[];

beforeEach(async () => {
  slots = [];
  idx = 0;
  calls = {
    setFile: [],
    setSelectedPath: [],
    setMode: [],
    setDraftContent: [],
    setConflict: [],
    setError: [],
    fetchTreeCalls: 0,
    fetchFileCalls: 0,
  };
  writeFileD = [];
  deleteBinaryD = [];
  uploadBinaryD = [];
  fakeClient = {
    writeFile: () => {
      const d = deferred<{ size_bytes: number; modified_at: number }>();
      writeFileD.push(d);
      return d.promise;
    },
    deleteBinary: () => {
      const d = deferred<unknown>();
      deleteBinaryD.push(d);
      return d.promise;
    },
    uploadBinary: () => {
      const d = deferred<unknown>();
      uploadBinaryD.push(d);
      return d.promise;
    },
  };
  ({ useDocMutations } = await import('../features/docs/use-doc-mutations'));
});

afterEach(() => {
  mock.restore();
});

const OPEN_FILE = { path: 'notes/a.md', content: 'hello', modified_at: 111, size_bytes: 5 };

// A stable param object so the captured render-1 closures reference the
// same trackers across renders. `project_id` is swapped per render to
// drive the project switch.
function renderMutations(project_id: string) {
  beginRender();
  // Deliberate test harness: `useDocMutations` is driven directly against
  // the stubbed react dispatcher, not from a real component render.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useDocMutations({
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
    setConflict: (v: unknown) => calls.setConflict.push(v),
    setError: (v: unknown) => calls.setError.push(v),
    fetchFile: async () => {
      calls.fetchFileCalls += 1;
    },
    fetchTree: async () => {
      calls.fetchTreeCalls += 1;
    },
    setTree: () => {},
    loadHistory: async () => {},
    setPreviewVersion: () => {},
    setHistoryEntries: () => {},
    setHistoryCursor: () => {},
    setHistoryOpen: () => {},
    setRevertConfirm: () => {},
    setRevertingSha: () => {},
  });
}

describe('useDocMutations — handleSave honours the mutate gate across a project switch', () => {
  it('COMMITS when no switch happens (positive control)', async () => {
    const api = renderMutations('A');
    const p = api.handleSave();
    writeFileD[0]!.resolve({ size_bytes: 12, modified_at: 222 });
    await p;
    // isLatest(token) is still true → the new body is committed.
    expect(calls.setFile.length).toBe(1);
    expect(calls.setMode).toContain('view');
  });

  it('BAILS when the project switches mid-save (no cross-project write)', async () => {
    const api = renderMutations('A');
    const p = api.handleSave(); // acquires token on the shared gate
    renderMutations('B'); // project switch → render-phase gate reset
    writeFileD[0]!.resolve({ size_bytes: 12, modified_at: 222 });
    await p;
    // Token invalidated before the resolver → NO setFile / setMode.
    expect(calls.setFile.length).toBe(0);
    expect(calls.setMode).not.toContain('view');
  });
});

describe('useDocMutations — handleConfirmBinaryDelete honours the gate across a switch', () => {
  const node = { kind: 'binary' as const, path: 'img/a.png', name: 'a.png' };

  it('COMMITS (refreshes tree) when no switch happens', async () => {
    const api = renderMutations('A');
    const p = api.handleConfirmBinaryDelete(node);
    deleteBinaryD[0]!.resolve(null);
    await p;
    expect(calls.fetchTreeCalls).toBe(1);
  });

  it('BAILS (no tree refetch, no clear) when the project switches mid-delete', async () => {
    const api = renderMutations('A');
    const p = api.handleConfirmBinaryDelete(node);
    renderMutations('B');
    deleteBinaryD[0]!.resolve(null);
    await p;
    expect(calls.fetchTreeCalls).toBe(0);
    expect(calls.setSelectedPath.length).toBe(0);
  });
});

describe('useDocMutations — handleUploadBinary honours the gate across a switch', () => {
  // A minimal File-like the isBinaryExtension('.png') check accepts.
  const pngFile = { name: 'shot.png' } as unknown as File;

  it('COMMITS (refreshes tree) when no switch happens', async () => {
    const api = renderMutations('A');
    const p = api.handleUploadBinary(pngFile);
    uploadBinaryD[0]!.resolve(null);
    await p;
    expect(calls.fetchTreeCalls).toBe(1);
  });

  it('BAILS (no tree refetch, no draft splice) when the project switches mid-upload', async () => {
    const api = renderMutations('A');
    const p = api.handleUploadBinary(pngFile);
    renderMutations('B');
    uploadBinaryD[0]!.resolve(null);
    await p;
    expect(calls.fetchTreeCalls).toBe(0);
    expect(calls.setDraftContent.length).toBe(0);
  });
});
