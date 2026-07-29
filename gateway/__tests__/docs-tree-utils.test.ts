/**
 * P7.1 round-2 blocker #2 — `findNodeByPath` regression coverage.
 *
 * The new-file modal in `app/app/projects/[id]/docs.tsx` now consults
 * `findNodeByPath` against the latest tree BEFORE PUTing an empty body,
 * because a PUT to an existing path silently truncates the doc (the
 * gateway treats PUT as create-or-overwrite, and the editor only opens
 * AFTER the write — meaning data is gone before the user sees what
 * they collided with). This file pins the helper's behaviour so the
 * regression can't sneak back in via tree-shape changes.
 */

import { describe, expect, it } from 'bun:test';

import {
  RequestGate,
  findNodeByPath,
  freshEditorState,
  type DocTreeNode,
} from '@neutronai/app/lib/docs-client';

function folder(path: string, name: string, children: DocTreeNode[]): DocTreeNode {
  return {
    kind: 'folder',
    path,
    name,
    size_bytes: null,
    modified_at: null,
    content_type: null,
    referenced_by_count: null,
    origin: 'markdown',
    children,
  };
}

function file(path: string, name: string): DocTreeNode {
  return {
    kind: 'file',
    path,
    name,
    size_bytes: 0,
    modified_at: Date.now(),
    content_type: null,
    referenced_by_count: null,
    origin: null,
    children: [],
  };
}

describe('findNodeByPath', () => {
  const tree: DocTreeNode[] = [
    folder('notes', 'notes', [
      file('notes/brainstorm.md', 'brainstorm.md'),
      folder('notes/sub', 'sub', [file('notes/sub/nested.md', 'nested.md')]),
    ]),
    folder('refs', 'refs', []),
    file('README.md', 'README.md'),
  ];

  it('finds a root-level file', () => {
    const hit = findNodeByPath(tree, 'README.md');
    expect(hit?.kind).toBe('file');
    expect(hit?.name).toBe('README.md');
  });

  it('finds a nested file via recursion', () => {
    const hit = findNodeByPath(tree, 'notes/sub/nested.md');
    expect(hit?.kind).toBe('file');
    expect(hit?.name).toBe('nested.md');
  });

  it('finds a folder node', () => {
    const hit = findNodeByPath(tree, 'notes/sub');
    expect(hit?.kind).toBe('folder');
  });

  it('returns null for an unknown path', () => {
    expect(findNodeByPath(tree, 'notes/missing.md')).toBeNull();
    expect(findNodeByPath(tree, 'totally-unrelated.md')).toBeNull();
  });

  it('returns null on an empty tree', () => {
    expect(findNodeByPath([], 'README.md')).toBeNull();
  });
});

/**
 * P7.1 round-4 BLOCKING #2 — `freshEditorState` is the single source
 * of truth for the docs-tab's per-file state reset. The project-change
 * effect in `app/app/projects/[id]/docs.tsx` applies every field via
 * the matching setter so a freshly-loaded project never inherits the
 * previous project's open-file UI. Without this reset, navigating
 * A → B left A's `file` + `selectedPath` + `draftContent` + `mode` in
 * state while `project_id` was now B, and pressing Save silently wrote
 * A's content to the same relative path under project B.
 */
describe('freshEditorState (round-4 BLOCKING #2)', () => {
  it('returns the empty/initial editor state for a fresh project', () => {
    const s = freshEditorState();
    expect(s.file).toBeNull();
    expect(s.selectedPath).toBeNull();
    expect(s.draftContent).toBe('');
    expect(s.mode).toBe('view');
    expect(s.conflict).toBe(false);
    expect(s.error).toBeNull();
    expect(s.existingFileConflict).toBeNull();
    expect(s.actionSheet).toBeNull();
    expect(s.renameTarget).toBeNull();
    expect(s.newFileOpen).toBe(false);
  });

  it('includes tree:[] so the project-change effect resets the tree pane (round-7 BLOCKING #2)', () => {
    // Round-7 BLOCKING #2 — `tree` was previously omitted from the
    // reset surface, so an A → B project switch left A's tree
    // rendered under B. Adding `tree: []` to the shape forces the
    // project-change effect to applyit before fetchTree() so the row
    // press never reads/writes B with A's paths even if B's fetch
    // errors and never replaces the array.
    const s = freshEditorState();
    expect(Array.isArray(s.tree)).toBe(true);
    expect(s.tree).toEqual([]);
  });

  it('returns a fresh object on every call (no shared reference)', () => {
    // Each project-change effect applies the result via setters, but
    // making the helper return a new object every call prevents a
    // future bug where a caller mutates the returned shape.
    const a = freshEditorState();
    const b = freshEditorState();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    // Tree array must also be a fresh reference per call.
    expect(a.tree).not.toBe(b.tree);
  });
});

/**
 * P7.1 round-4 IMPORTANT #3 — `RequestGate` guards `fetchTree` and
 * `fetchFile` against late responses. A fast file-A → file-B click (or
 * a project switch mid-load) could let A's slower response land last
 * and leave the editor displaying B's content with A's open-file
 * state; subsequent Saves would target the wrong file.
 */
describe('RequestGate (round-4 IMPORTANT #3)', () => {
  it('acquires monotonically increasing tokens', () => {
    const gate = new RequestGate();
    expect(gate.acquire()).toBe(1);
    expect(gate.acquire()).toBe(2);
    expect(gate.acquire()).toBe(3);
  });

  it('reports the latest token as latest', () => {
    const gate = new RequestGate();
    const t1 = gate.acquire();
    expect(gate.isLatest(t1)).toBe(true);
  });

  it('invalidates older tokens once a newer one is acquired', () => {
    const gate = new RequestGate();
    const t1 = gate.acquire();
    const t2 = gate.acquire();
    expect(gate.isLatest(t1)).toBe(false);
    expect(gate.isLatest(t2)).toBe(true);
  });

  it('models the fetchFile race: A then B before A resolves', () => {
    // Trigger fetchFile(A) — acquire token a.
    const gate = new RequestGate();
    const a = gate.acquire();
    // Trigger fetchFile(B) before A resolves — acquire token b.
    const b = gate.acquire();
    // A resolves now: its resolver must NOT apply state.
    expect(gate.isLatest(a)).toBe(false);
    // B resolves later: its resolver MUST apply state.
    expect(gate.isLatest(b)).toBe(true);
  });

  it('reset() invalidates every in-flight token', () => {
    // Models the project-change effect: a tree/file fetch from project
    // A must not apply once project_id has switched to B, even if no
    // new fetch on the gate has been issued yet.
    const gate = new RequestGate();
    const t1 = gate.acquire();
    gate.reset();
    expect(gate.isLatest(t1)).toBe(false);
    // A subsequent acquire returns the new latest.
    const t2 = gate.acquire();
    expect(gate.isLatest(t2)).toBe(true);
  });

  it('simulates handleSave end-to-end: project switch mid-await → NO setFile/setMode/fetchTree fires (round-5 BLOCKING #1)', async () => {
    // Higher-fidelity reproduction of the round-5 BLOCKING #1 bug:
    // wrap the save lifecycle (acquire → await writeFile → guard →
    // apply state) in the exact shape `handleSave` uses, then trigger
    // the project switch *between* the await and the resolver. Asserts
    // that none of the post-await setters fire — proving that A's
    // `file` closure can't be re-installed into B's now-reset screen.
    const saveGate = new RequestGate();
    const calls = {
      setFile: 0,
      setMode: 0,
      fetchTree: 0,
      setSaving: 0,
    };

    let resolveWrite: (() => void) | null = null;
    const writePromise = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });

    async function handleSaveLike(): Promise<void> {
      const token = saveGate.acquire();
      calls.setSaving += 1;
      try {
        await writePromise;
        if (!saveGate.isLatest(token)) return;
        calls.setFile += 1;
        calls.setMode += 1;
        calls.fetchTree += 1;
      } finally {
        // setSaving(false) always fires — the spinner clears even if
        // the token was invalidated by a project switch. The bail
        // guard above protects the *content* setters (which would
        // re-install A's closure into B's screen) but not the spinner.
        calls.setSaving += 1;
      }
    }

    const savePromise = handleSaveLike();

    // Project switch on A → B: project-change effect resets every gate.
    saveGate.reset();

    // Now resolve the in-flight writeFile.
    expect(resolveWrite).not.toBeNull();
    resolveWrite!();
    await savePromise;

    // setSaving fires twice (entry true, finally false) — the spinner
    // clears even though the rest of the resolver bailed.
    expect(calls.setSaving).toBe(2);
    // None of the post-await content setters fired — the resolver
    // bailed BEFORE re-installing A's closure into B's screen.
    expect(calls.setFile).toBe(0);
    expect(calls.setMode).toBe(0);
    expect(calls.fetchTree).toBe(0);
  });

  it('simulates handleCreateFile: project switch mid-await → NO setSelectedPath/fetchFile/setMode fires (round-7 BLOCKING #1)', async () => {
    // Round-7 BLOCKING #1 — handleCreateFile previously did
    //   await client.tree(...); setTree(...);
    //   if (existing) return; await client.writeFile(...);
    //   setNewFileOpen(false); await fetchTree(); setSelectedPath(...);
    //   await fetchFile(...); setMode('edit');
    // If `project_id` flipped mid-await, A's newly-created path
    // landed in B's editor; the next Save in B then writeFile(B,
    // A.path, B.draftContent). Same bug class round-6 closed for
    // handleSave only. The mutateGate now covers all four mutation
    // handlers (save / create / rename / delete) so each handler
    // bails BEFORE any state setter that would re-install A's
    // closure into B's screen.
    const mutateGate = new RequestGate();
    const calls = {
      setTree: 0,
      setNewFileOpen: 0,
      setSelectedPath: 0,
      fetchFile: 0,
      setMode: 0,
      setError: 0,
    };

    let resolveTreeCall: ((value: { tree: never[] }) => void) | null = null;
    const treePromise = new Promise<{ tree: never[] }>((resolve) => {
      resolveTreeCall = resolve;
    });

    async function handleCreateFileLike(): Promise<void> {
      const token = mutateGate.acquire();
      try {
        const latest = await treePromise;
        if (!mutateGate.isLatest(token)) return;
        calls.setTree += 1;
        // findNodeByPath would consult latest.tree here — irrelevant
        // for the race, we just need an await before the writeFile.
        void latest;
        // Skip the rest of the awaits — once the first guard bails,
        // none of the downstream setters can fire (early return).
        calls.setNewFileOpen += 1;
        calls.setSelectedPath += 1;
        calls.fetchFile += 1;
        calls.setMode += 1;
      } catch {
        if (!mutateGate.isLatest(token)) return;
        calls.setError += 1;
      }
    }

    const handlerPromise = handleCreateFileLike();
    // Project switch on A → B mid-await.
    mutateGate.reset();
    expect(resolveTreeCall).not.toBeNull();
    resolveTreeCall!({ tree: [] });
    await handlerPromise;

    // EVERY post-await setter must NOT have fired — the guard
    // bailed before setTree, so A's create state can't land under B.
    expect(calls.setTree).toBe(0);
    expect(calls.setNewFileOpen).toBe(0);
    expect(calls.setSelectedPath).toBe(0);
    expect(calls.fetchFile).toBe(0);
    expect(calls.setMode).toBe(0);
    expect(calls.setError).toBe(0);
  });

  it('simulates handleRename: project switch mid-await → NO setSelectedPath/fetchFile/fetchTree fires (round-7 BLOCKING #1)', async () => {
    // Round-7 BLOCKING #1 — same bug class on handleRename. After
    // `await client.moveFile(...)`, the previous code did
    // `setRenameTarget(null); setActionSheet(null); if (selectedPath
    // === node.path) { setSelectedPath(cleaned); await
    // fetchFile(cleaned); } await fetchTree();` — A's renamed path
    // landed in B's editor, and B's Save would write B with A's
    // new path.
    const mutateGate = new RequestGate();
    const calls = {
      setRenameTarget: 0,
      setActionSheet: 0,
      setSelectedPath: 0,
      fetchFile: 0,
      fetchTree: 0,
    };

    let resolveMove: (() => void) | null = null;
    const movePromise = new Promise<void>((resolve) => {
      resolveMove = resolve;
    });

    async function handleRenameLike(): Promise<void> {
      const token = mutateGate.acquire();
      await movePromise;
      if (!mutateGate.isLatest(token)) return;
      calls.setRenameTarget += 1;
      calls.setActionSheet += 1;
      calls.setSelectedPath += 1;
      calls.fetchFile += 1;
      calls.fetchTree += 1;
    }

    const handlerPromise = handleRenameLike();
    mutateGate.reset();
    expect(resolveMove).not.toBeNull();
    resolveMove!();
    await handlerPromise;

    expect(calls.setRenameTarget).toBe(0);
    expect(calls.setActionSheet).toBe(0);
    expect(calls.setSelectedPath).toBe(0);
    expect(calls.fetchFile).toBe(0);
    expect(calls.fetchTree).toBe(0);
  });

  it('simulates handleDelete: project switch mid-await → NO setSelectedPath/setFile/fetchTree fires (round-7 BLOCKING #1)', async () => {
    // Round-7 BLOCKING #1 — same bug class on handleDelete. After
    // `await client.deleteFile(...)`, the previous code did
    // `setActionSheet(null); if (selectedPath === node.path) {
    // setSelectedPath(null); setFile(null); } await fetchTree();` —
    // A's deletion side-effects (clearing the open file, refreshing
    // the tree) landed on B's screen and silently wiped B's open
    // file when path-strings happened to collide.
    const mutateGate = new RequestGate();
    const calls = {
      setActionSheet: 0,
      setSelectedPath: 0,
      setFile: 0,
      fetchTree: 0,
    };

    let resolveDelete: (() => void) | null = null;
    const deletePromise = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });

    async function handleDeleteLike(): Promise<void> {
      const token = mutateGate.acquire();
      await deletePromise;
      if (!mutateGate.isLatest(token)) return;
      calls.setActionSheet += 1;
      calls.setSelectedPath += 1;
      calls.setFile += 1;
      calls.fetchTree += 1;
    }

    const handlerPromise = handleDeleteLike();
    mutateGate.reset();
    expect(resolveDelete).not.toBeNull();
    resolveDelete!();
    await handlerPromise;

    expect(calls.setActionSheet).toBe(0);
    expect(calls.setSelectedPath).toBe(0);
    expect(calls.setFile).toBe(0);
    expect(calls.fetchTree).toBe(0);
  });

  it('models the handleSave race: save on project A, project switch to B mid-await (round-5 BLOCKING #1)', () => {
    // Round-5 BLOCKING #1 — `handleSave` previously did
    //   `await client.writeFile(...)` then unconditionally
    //   `setFile({...file, ...})`, `setMode('view')`, `fetchTree()`.
    // If the project_id flipped mid-save, A's response re-installed
    // A's `file` (path + content + mtime) into B's now-reset screen.
    // The next Save in B would then writeFile(B, A.path, A.content) —
    // exact cross-project silent write that round-4 was supposed to
    // close, still live on the write path. The fix mirrors the
    // fetchFile/fetchTree race guard: a dedicated `saveGate` token,
    // bailed by the project-change effect's `saveGate.reset()`.
    const saveGate = new RequestGate();
    // handleSave on project A acquires a save token.
    const token = saveGate.acquire();
    // Project switch to B: effect resets every gate.
    saveGate.reset();
    // writeFile resolves now (or rejects). The resolver MUST bail
    // before applying any setFile/setMode/fetchTree.
    expect(saveGate.isLatest(token)).toBe(false);
  });
});
