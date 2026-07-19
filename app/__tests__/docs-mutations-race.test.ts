/**
 * @neutronai/app — D7 BEHAVIOURAL race-guard + argument-fidelity
 * coverage for `useDocMutations` (ALL seven write paths, EVERY await
 * boundary).
 *
 * The app suite has no RN mount / hook-render harness (no
 * `@testing-library/react-native`; `react-test-renderer` is deprecated
 * in React 19). To still get EXECUTABLE proof that the extracted
 * mutation hook enforces the single-gate race guard, this test stubs
 * `react`'s hook dispatcher (ordered slots + a committed-effect runner,
 * à la O5's DiagnosticsPane test) and drives the REAL `useDocMutations`
 * closures against a fake `DocsClient` whose calls resolve on command
 * and RECORD their arguments.
 *
 * What it locks (the "fixed 4×" invariants + the D7 review asks):
 *   • BAILS at EVERY await boundary — a committed project switch while
 *     ANY step of a multi-await mutation is pending invalidates the
 *     token, so no later state / network call lands. Deleting the guard
 *     after any await (client call, fetchTree, fetchFile, loadHistory)
 *     turns a boundary test red (mutation-verified).
 *   • ARGUMENT fidelity — save/create/rename/delete/revert/upload call
 *     the client with the right project_id, path, content and
 *     `expected_modified_at`, so a wrong-target regression fails.
 *   • ERROR boundaries — the Save 409 flips `conflict` (draft
 *     preserved), a generic reject surfaces `error`.
 *   • The destructive binary-delete confirm clears on a committed
 *     switch (Codex D7-r1).
 *
 * The gate reset is a COMMITTED-phase effect (Codex D7-r2), so the
 * harness runs effects after every render — a switch only invalidates
 * once the B render is committed, exactly like React.
 */

import { beforeEach, describe, expect, it } from 'bun:test';
import * as RealReact from 'react';

import { DocsClientError } from '../lib/docs-client';
import { type HookRuntime } from '../lib/hook-runtime';
import { useDocMutations as realUseDocMutations } from '../features/docs/use-doc-mutations';

// ── ordered-slot react hook stub with a committed-effect runner ───────
type Slot = { v?: unknown; current?: unknown; lastDeps?: unknown[]; cleanup?: unknown };
let slots: Slot[] = [];
let idx = 0;
let frameEffects: { slot: Slot; fn: () => unknown; deps: unknown[] }[] = [];

function depsEqual(a: unknown[] | undefined, b: unknown[]): boolean {
  if (a === undefined || a.length !== b.length) return false;
  return a.every((x, i) => Object.is(x, b[i]));
}

// INJECTED into `useDocMutations` via its optional `hooks: HookRuntime`
// parameter (see `lib/hook-runtime.ts`) — NOT installed globally. The old
// `mock.module('react', ...)` here was process-global in bun and survived
// `mock.restore()`, so it silently replaced react for every test file that
// ran after this one (~92 failures of the form `ReactSharedInternals.S`
// inside react-dom). Injection scopes the stub to this file's own calls.
const reactStub = {
  // `useReducer` is unused by `useDocMutations`; the real one satisfies the
  // HookRuntime contract without pretending to a behaviour under test.
  useReducer: RealReact.useReducer,
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
} as unknown as HookRuntime;

// The hook drivers below pass DELIBERATELY PARTIAL fixtures (a `DocFile`
// with only the fields the code path reads, a bare `CommitSummary`, …).
// That was type-invisible while these modules were `await import`ed into an
// `any`; with the static imports it would now be a compile error, so each
// hook is aliased through one explicit loose signature. This preserves the
// pre-existing typing of the drivers EXACTLY — no assertion is relaxed.
type LooseHook = (params: any, hooks: HookRuntime) => any;
const useDocMutations = realUseDocMutations as LooseHook;
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

// ── deferred async ops with argument capture ──────────────────────────
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Every awaited dependency (client method OR the fetchTree/fetchFile/
// loadHistory params) is a deferred op so a test can pause at ANY
// boundary, switch projects, then resolve.
type Op =
  | 'tree'
  | 'writeFile'
  | 'moveFile'
  | 'deleteFile'
  | 'deleteFolder'
  | 'deleteBinariesUnderPrefix'
  | 'revert'
  | 'deleteBinary'
  | 'uploadBinary'
  | 'fetchTree'
  | 'fetchFile'
  | 'loadHistory';
const OPS: Op[] = [
  'tree',
  'writeFile',
  'moveFile',
  'deleteFile',
  'deleteFolder',
  'deleteBinariesUnderPrefix',
  'revert',
  'deleteBinary',
  'uploadBinary',
  'fetchTree',
  'fetchFile',
  'loadHistory',
];

interface Trackers {
  setFile: unknown[];
  setSelectedPath: unknown[];
  setMode: unknown[];
  setDraftContent: unknown[];
  setTree: unknown[];
  setConflict: unknown[];
  setError: unknown[];
  setRevertConfirm: unknown[];
  setPreviewVersion: unknown[];
}
let calls: Trackers;
let q: Record<Op, { d: Deferred<unknown>; args: unknown[] }[]>;
let served: Record<Op, number>;

let fakeClient: any;

function op(name: Op, args: unknown[], value?: unknown): Promise<unknown> {
  const d = deferred<unknown>();
  q[name].push({ d, args });
  if (value !== undefined) {
    // convenience default for ops whose result shape matters
    (d as { defaultValue?: unknown }).defaultValue = value;
  }
  return d.promise;
}

/** Resolve the oldest un-served call of `name`; then flush microtasks. */
async function settle(name: Op, value: unknown = null): Promise<void> {
  const i = served[name]++;
  q[name][i]!.d.resolve(value);
  await flush();
}
/** Reject the oldest un-served call of `name`; then flush microtasks. */
async function fail(name: Op, err: unknown): Promise<void> {
  const i = served[name]++;
  q[name][i]!.d.reject(err);
  await flush();
}
function argsOf(name: Op, i = 0): unknown[] {
  return q[name][i]!.args;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

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
    setConflict: [],
    setError: [],
    setRevertConfirm: [],
    setPreviewVersion: [],
  };
  q = {} as Record<Op, { d: Deferred<unknown>; args: unknown[] }[]>;
  served = {} as Record<Op, number>;
  for (const name of OPS) {
    q[name] = [];
    served[name] = 0;
  }
  fakeClient = {
    tree: (...args: unknown[]) => op('tree', args),
    writeFile: (...args: unknown[]) => op('writeFile', args),
    moveFile: (...args: unknown[]) => op('moveFile', args),
    deleteFile: (...args: unknown[]) => op('deleteFile', args),
    deleteFolder: (...args: unknown[]) => op('deleteFolder', args),
    deleteBinariesUnderPrefix: (...args: unknown[]) => op('deleteBinariesUnderPrefix', args),
    revert: (...args: unknown[]) => op('revert', args),
    deleteBinary: (...args: unknown[]) => op('deleteBinary', args),
    uploadBinary: (...args: unknown[]) => op('uploadBinary', args),
  };
});

const OPEN_FILE = { path: 'notes/a.md', content: 'hello', modified_at: 111, size_bytes: 5 };
const FILE_NODE = { kind: 'file' as const, path: OPEN_FILE.path, name: 'a.md' };

function render(project_id: string, client: unknown = fakeClient) {
  idx = 0;
  frameEffects = [];
  // Deliberate test harness: `useDocMutations` is driven directly against
  // the stubbed react dispatcher, not from a real component render.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const api = useDocMutations(
    {
      client,
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
      fetchFile: (...a: unknown[]) => op('fetchFile', a) as Promise<void>,
      fetchTree: (...a: unknown[]) => op('fetchTree', a) as Promise<void>,
      setTree: (v: unknown) => calls.setTree.push(v),
      loadHistory: (...a: unknown[]) => op('loadHistory', a) as Promise<void>,
      setPreviewVersion: (v: unknown) => calls.setPreviewVersion.push(v),
      setHistoryEntries: () => {},
      setHistoryCursor: () => {},
      setHistoryOpen: () => {},
      setRevertConfirm: (v: unknown) => calls.setRevertConfirm.push(v),
      setRevertingSha: () => {},
    },
    reactStub,
  );
  commitEffects();
  return api;
}

// ── handleSave ────────────────────────────────────────────────────────
describe('handleSave', () => {
  it('COMMITS with the right args (project_id, path, content, expected_modified_at)', async () => {
    const api = render('A');
    const p = api.handleSave();
    expect(argsOf('writeFile')).toEqual([
      'A',
      { path: 'notes/a.md', content: 'edited body', expected_modified_at: 111 },
    ]);
    await settle('writeFile', { size_bytes: 12, modified_at: 222 });
    await settle('fetchTree');
    await p;
    expect(calls.setFile.length).toBe(1);
    expect(calls.setMode).toContain('view');
  });

  it('BAILS on switch while writeFile is pending', async () => {
    const api = render('A');
    const p = api.handleSave();
    render('B');
    await settle('writeFile', { size_bytes: 12, modified_at: 222 });
    await p;
    expect(calls.setFile.length).toBe(0);
    expect(calls.setMode).not.toContain('view');
  });

  it('surfaces a 409 as conflict (draft preserved), NOT error', async () => {
    const api = render('A');
    const p = api.handleSave();
    await fail('writeFile', new DocsClientError('doc_modified_conflict', 'changed', 409, null));
    await p;
    expect(calls.setConflict).toContain(true);
    // handleSave clears error to null up front; the 409 arm must NOT set
    // any error MESSAGE, and must never touch the draft (edit preserved).
    expect(calls.setError.every((v) => v === null)).toBe(true);
    expect(calls.setDraftContent.length).toBe(0);
  });

  it('surfaces a non-409 reject as error', async () => {
    const api = render('A');
    const p = api.handleSave();
    await fail('writeFile', new DocsClientError('io_error', 'disk full', 500, null));
    await p;
    expect(calls.setError.some((v) => typeof v === 'string')).toBe(true);
    expect(calls.setConflict).not.toContain(true);
  });
});

// ── gate scope includes client/session, not just project (Codex D7-r4) ─
describe('handleSave — scope covers client/session identity, same project', () => {
  it('BAILS when the client/session is replaced mid-save', async () => {
    const api = render('A', fakeClient);
    const p = api.handleSave();
    // Same project, but the auth session refreshed → a NEW DocsClient.
    render('A', { session: 'refreshed' });
    await settle('writeFile', { size_bytes: 12, modified_at: 222 });
    await p;
    expect(calls.setFile.length).toBe(0);
    expect(calls.setMode).not.toContain('view');
  });

  it('BAILS when the client goes null (logout) mid-save', async () => {
    const api = render('A', fakeClient);
    const p = api.handleSave();
    render('A', null); // logout: client → null, same project
    await settle('writeFile', { size_bytes: 12, modified_at: 222 });
    await p;
    expect(calls.setFile.length).toBe(0);
    expect(calls.setMode).not.toContain('view');
  });
});

// ── busy flags clear when their OWN op settles (no stuck spinner) ─────
// Intentional pre-D7 contract, faithfully preserved (Codex D7-r5): the
// mutation busy-flags (`saving`, `uploadingBinary`, `revertingSha`)
// clear UNCONDITIONALLY in `finally` — unlike the read-loading flags
// (fetchTree / loadHistory) which clear only-when-latest. Rationale
// (documented in the original handleSave): the shared `mutateGate` is
// bumped by ANY mutation, so a save/upload/revert whose token is
// superseded (by a scope switch OR a concurrent same-project mutation)
// must STILL clear its own button — a "clear only when latest" policy
// would leave the button permanently disabled (stuck spinner). These
// tests pin that no-stuck-spinner property.
describe('mutation busy flags never get stuck', () => {
  it('saving clears even after a mid-save project switch', async () => {
    let api = render('A');
    const p = api.handleSave();
    api = render('A');
    expect(api.saving).toBe(true);
    render('B');
    await settle('writeFile', { size_bytes: 1, modified_at: 2 });
    await p;
    api = render('B');
    expect(api.saving).toBe(false);
  });

  it('uploadingBinary clears even after a mid-upload project switch', async () => {
    const pngFile = { name: 'shot.png' } as unknown as File;
    let api = render('A');
    const p = api.handleUploadBinary(pngFile);
    api = render('A');
    expect(api.uploadingBinary).toBe(true);
    render('B');
    await settle('uploadBinary');
    await p;
    api = render('B');
    expect(api.uploadingBinary).toBe(false);
  });
});

// ── handleCreateFile (4 await boundaries) ─────────────────────────────
describe('handleCreateFile', () => {
  it('COMMITS with the right args (tree probe → writeFile new.md) with no switch', async () => {
    const api = render('A');
    const p = api.handleCreateFile({ folder: 'sub', filename: 'new' });
    expect(argsOf('tree')).toEqual(['A']);
    await settle('tree', { tree: [], file_count: 0 });
    expect(calls.setTree.length).toBe(1);
    expect(argsOf('writeFile')).toEqual(['A', { path: 'sub/new.md', content: '' }]);
    await settle('writeFile', { size_bytes: 0, modified_at: 1 });
    await settle('fetchTree');
    expect(argsOf('fetchFile')).toEqual(['sub/new.md']);
    await settle('fetchFile');
    await p;
    expect(calls.setMode).toContain('edit');
  });

  it('BAILS on switch while the tree probe is pending', async () => {
    const api = render('A');
    const p = api.handleCreateFile({ folder: '', filename: 'new' });
    render('B');
    await settle('tree', { tree: [], file_count: 0 });
    await p;
    expect(calls.setTree.length).toBe(0);
    expect(q.writeFile.length).toBe(0);
  });

  it('BAILS on switch while writeFile is pending (no fetchTree/select)', async () => {
    const api = render('A');
    const p = api.handleCreateFile({ folder: '', filename: 'new' });
    await settle('tree', { tree: [], file_count: 0 });
    render('B');
    await settle('writeFile', { size_bytes: 0, modified_at: 1 });
    await p;
    expect(q.fetchTree.length).toBe(0);
    expect(calls.setSelectedPath.length).toBe(0);
  });

  it('BAILS on switch while fetchTree is pending (no select)', async () => {
    const api = render('A');
    const p = api.handleCreateFile({ folder: '', filename: 'new' });
    await settle('tree', { tree: [], file_count: 0 });
    await settle('writeFile', { size_bytes: 0, modified_at: 1 });
    render('B');
    await settle('fetchTree');
    await p;
    expect(calls.setSelectedPath.length).toBe(0);
    expect(q.fetchFile.length).toBe(0);
  });

  it('BAILS on switch while fetchFile is pending (no setMode edit)', async () => {
    const api = render('A');
    const p = api.handleCreateFile({ folder: '', filename: 'new' });
    await settle('tree', { tree: [], file_count: 0 });
    await settle('writeFile', { size_bytes: 0, modified_at: 1 });
    await settle('fetchTree');
    render('B');
    await settle('fetchFile');
    await p;
    expect(calls.setMode).not.toContain('edit');
  });
});

// ── handleRename (2 await boundaries when path is open) ───────────────
describe('handleRename', () => {
  it('COMMITS with the right args (moveFile from→to) with no switch', async () => {
    const api = render('A');
    const p = api.handleRename(FILE_NODE, ' notes/b.md ');
    expect(argsOf('moveFile')).toEqual(['A', 'notes/a.md', 'notes/b.md']);
    await settle('moveFile');
    expect(argsOf('fetchFile')).toEqual(['notes/b.md']);
    await settle('fetchFile');
    await settle('fetchTree');
    await p;
    expect(calls.setSelectedPath).toContain('notes/b.md');
  });

  it('BAILS on switch while moveFile is pending', async () => {
    const api = render('A');
    const p = api.handleRename(FILE_NODE, 'notes/b.md');
    render('B');
    await settle('moveFile');
    await p;
    expect(calls.setSelectedPath.length).toBe(0);
    expect(q.fetchFile.length).toBe(0);
  });

  it('BAILS on switch while the post-move fetchFile is pending (no fetchTree)', async () => {
    const api = render('A');
    const p = api.handleRename(FILE_NODE, 'notes/b.md');
    await settle('moveFile');
    render('B');
    await settle('fetchFile');
    await p;
    expect(q.fetchTree.length).toBe(0);
  });
});

// ── handleDelete — all FOUR destructive dispatch paths ───────────────
// file → deleteFile, unreferenced-binary → deleteBinary, binary-origin
// folder → deleteBinariesUnderPrefix, ordinary folder → deleteFolder.
// Each path: a COMMIT case (correct client method + args) AND a
// project-switch boundary case (bails at the delete await → no
// fetchTree, no stale clear). The gate guard is shared across the four
// branches, so dropping it turns every BAILS case red (mutation-
// verified); the per-path arg assertions catch wrong routing.
describe('handleDelete — four destructive routes', () => {
  const cases: {
    label: string;
    node: unknown;
    method: Op;
    args: unknown[];
    clearsSelected: boolean; // selectedPath === node.path
  }[] = [
    { label: 'file', node: FILE_NODE, method: 'deleteFile', args: ['A', 'notes/a.md'], clearsSelected: true },
    {
      label: 'unreferenced binary',
      node: { kind: 'binary', path: 'img/a.png', name: 'a.png', referenced_by_count: 0 },
      method: 'deleteBinary',
      args: ['A', 'img/a.png'],
      clearsSelected: false,
    },
    {
      label: 'binary-origin folder (recursive prefix delete)',
      node: { kind: 'folder', origin: 'binary', path: 'img', name: 'img', children: [] },
      method: 'deleteBinariesUnderPrefix',
      args: ['A', 'img'],
      clearsSelected: false,
    },
    {
      label: 'ordinary folder',
      node: { kind: 'folder', path: 'sub', name: 'sub', children: [] },
      method: 'deleteFolder',
      args: ['A', 'sub'],
      clearsSelected: false,
    },
  ];

  for (const c of cases) {
    it(`${c.label} — COMMITS via ${c.method} with the right args`, async () => {
      const api = render('A');
      const p = api.handleDelete(c.node);
      // Correct routing: ONLY the expected method is called, with args.
      expect(q[c.method].length).toBe(1);
      expect(argsOf(c.method)).toEqual(c.args);
      await settle(c.method);
      await settle('fetchTree');
      await p;
      expect(q.fetchTree.length).toBe(1);
      if (c.clearsSelected) expect(calls.setSelectedPath).toContain(null);
    });

    it(`${c.label} — BAILS on switch while ${c.method} is pending`, async () => {
      const api = render('A');
      const p = api.handleDelete(c.node);
      render('B');
      await settle(c.method);
      await p;
      expect(q.fetchTree.length).toBe(0);
      expect(calls.setSelectedPath.length).toBe(0);
    });

    it(`${c.label} — BAILS on client/session switch while ${c.method} is pending`, async () => {
      const api = render('A');
      const p = api.handleDelete(c.node);
      render('A', { session: 'refreshed' }); // same project, new DocsClient
      await settle(c.method);
      await p;
      expect(q.fetchTree.length).toBe(0);
    });
  }
});

// ── handleRevertConfirm (3 await boundaries in the non-deleted arm) ────
describe('handleRevertConfirm', () => {
  const entry = { sha: 'deadbee', message: 'x', author_date: '2026-01-01T00:00:00Z' } as never;

  it('deleted:false — COMMITS with the right args, reloads file + history, closes the confirm', async () => {
    const api = render('A');
    const p = api.handleRevertConfirm(entry);
    expect(argsOf('revert')).toEqual([
      'A',
      { path: 'notes/a.md', target_sha: 'deadbee', expected_modified_at: 111 },
    ]);
    await settle('revert', { deleted: false });
    await settle('fetchFile');
    await settle('loadHistory');
    await p;
    expect(q.fetchFile.length).toBe(1);
    expect(q.loadHistory.length).toBe(1);
    // final guard passed → confirm dismissed + preview cleared
    expect(calls.setRevertConfirm).toContain(null);
    expect(calls.setPreviewVersion).toContain(null);
  });

  it('deleted:false — BAILS on switch while revert is pending (no reload, confirm untouched)', async () => {
    const api = render('A');
    const p = api.handleRevertConfirm(entry);
    render('B');
    await settle('revert', { deleted: false });
    await p;
    expect(q.fetchFile.length).toBe(0);
    expect(q.loadHistory.length).toBe(0);
    expect(calls.setRevertConfirm.length).toBe(0);
  });

  it('deleted:false — BAILS on switch while the post-revert fetchFile is pending (no loadHistory)', async () => {
    const api = render('A');
    const p = api.handleRevertConfirm(entry);
    await settle('revert', { deleted: false });
    render('B');
    await settle('fetchFile');
    await p;
    expect(q.loadHistory.length).toBe(0);
    expect(calls.setRevertConfirm.length).toBe(0);
  });

  it('deleted:false — BAILS on switch while loadHistory is pending (final guard: confirm NOT dismissed)', async () => {
    const api = render('A');
    const p = api.handleRevertConfirm(entry);
    await settle('revert', { deleted: false });
    await settle('fetchFile');
    render('B'); // switch AFTER fetchFile, WHILE loadHistory is pending
    await settle('loadHistory');
    await p;
    // The :267 final guard must bail → confirm/preview NOT written.
    expect(calls.setRevertConfirm.length).toBe(0);
    expect(calls.setPreviewVersion.length).toBe(0);
  });

  it('deleted:true — COMMITS: clears the file surface, refreshes tree, dismisses the confirm', async () => {
    const api = render('A');
    const p = api.handleRevertConfirm(entry);
    await settle('revert', { deleted: true });
    await settle('fetchTree');
    await p;
    expect(q.fetchTree.length).toBe(1);
    expect(q.fetchFile.length).toBe(0); // deleted arm never reloads a body
    expect(calls.setFile).toContain(null);
    expect(calls.setRevertConfirm).toContain(null);
  });

  it('deleted:true — BAILS on switch while the deleted-arm fetchTree is pending (final guard)', async () => {
    const api = render('A');
    const p = api.handleRevertConfirm(entry);
    await settle('revert', { deleted: true });
    render('B'); // switch WHILE the deleted-arm fetchTree is pending
    await settle('fetchTree');
    await p;
    // The :267 final guard must bail → confirm/preview NOT written.
    expect(calls.setRevertConfirm.length).toBe(0);
    expect(calls.setPreviewVersion.length).toBe(0);
  });

  it('surfaces a 409 revert as conflict', async () => {
    const api = render('A');
    const p = api.handleRevertConfirm(entry);
    await fail('revert', new DocsClientError('doc_modified_conflict', 'changed', 409, null));
    await p;
    expect(calls.setConflict).toContain(true);
  });
});

// ── handleConfirmBinaryDelete ─────────────────────────────────────────
describe('handleConfirmBinaryDelete', () => {
  const node = { kind: 'binary' as const, path: 'img/a.png', name: 'a.png' };

  it('COMMITS with the right args (deleteBinary) with no switch', async () => {
    const api = render('A');
    const p = api.handleConfirmBinaryDelete(node);
    expect(argsOf('deleteBinary')).toEqual(['A', 'img/a.png']);
    await settle('deleteBinary');
    await settle('fetchTree');
    await p;
    expect(q.fetchTree.length).toBe(1);
  });

  it('BAILS on switch while deleteBinary is pending', async () => {
    const api = render('A');
    const p = api.handleConfirmBinaryDelete(node);
    render('B');
    await settle('deleteBinary');
    await p;
    expect(q.fetchTree.length).toBe(0);
    expect(calls.setSelectedPath.length).toBe(0);
  });
});

// ── handleUploadBinary ────────────────────────────────────────────────
describe('handleUploadBinary', () => {
  const pngFile = { name: 'shot.png' } as unknown as File;

  it('COMMITS with the right args (uploadBinary into the active dir)', async () => {
    const api = render('A');
    const p = api.handleUploadBinary(pngFile);
    // active file dir is `notes/` → target `notes/shot.png`
    expect(argsOf('uploadBinary')).toEqual(['A', 'notes/shot.png', pngFile]);
    await settle('uploadBinary');
    await settle('fetchTree');
    await p;
    expect(q.fetchTree.length).toBe(1);
  });

  it('BAILS on switch while uploadBinary is pending (no tree refetch, no draft splice)', async () => {
    const api = render('A');
    const p = api.handleUploadBinary(pngFile);
    render('B');
    await settle('uploadBinary');
    await p;
    expect(q.fetchTree.length).toBe(0);
    expect(calls.setDraftContent.length).toBe(0);
  });
});

// ── binaryDeleteTarget confirm modal clears on switch (Codex D7-r1) ────
describe('binaryDeleteTarget confirm modal', () => {
  const referencedBinary = {
    kind: 'binary' as const,
    path: 'img/logo.png',
    name: 'logo.png',
    referenced_by_count: 2,
  };

  it('opens on delete of a referenced binary, then clears when the project switches', async () => {
    let api = render('A');
    await api.handleDelete(referencedBinary); // routes to the confirm (no network)
    api = render('A');
    expect(api.binaryDeleteTarget).toEqual(referencedBinary);
    render('B'); // committed switch → reset effect clears the stale target
    api = render('B');
    expect(api.binaryDeleteTarget).toBeNull();
  });
});
