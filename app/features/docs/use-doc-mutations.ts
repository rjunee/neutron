/**
 * @neutronai/app — `useDocMutations`: EVERY write path of the docs tab
 * (D7 refactor) — save, create, rename, move, delete, binary upload,
 * binary delete, and history revert — plus the modal/affordance state
 * those writes drive (`newFileOpen`, `actionSheet`, `renameTarget`,
 * `existingFileConflict`, `binaryDeleteTarget`, `uploadingBinary`,
 * `editorSelection`, `dragOver`, `saving`).
 *
 * THE load-bearing invariant (P7.1 round-5→7, fixed 4× across the
 * review history — DO NOT split it): ONE `mutateGate` guards ALL
 * mutations. Every handler `acquire()`s a token before its first
 * await and checks `isLatest(token)` before it re-installs any `file`
 * / `selectedPath` / `mode` state. A project A → B switch mid-mutation
 * calls `mutateGate` reset (render-phase, via `useProjectScopedAsync`)
 * and invalidates the token, so the resolver bails BEFORE writing A's
 * content / path under project B or re-seating A's closures into B's
 * screen. Round-6 fixed this for `handleSave` only; round-7 extended
 * the SAME gate to create/rename/delete — this hook keeps them on one
 * gate by construction.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  DocsClient,
  DocsClientError,
  findNodeByPath,
  isBinaryExtension,
  type CommitSummary,
  type DocFile,
  type DocTreeNode,
  type VersionContent,
} from '../../lib/docs-client';
import { useProjectScopedAsync } from './use-project-scoped-async';
import { formatError, type EditorMode } from './docs-shared';

export interface UseDocMutations {
  saving: boolean;
  newFileOpen: boolean;
  setNewFileOpen: React.Dispatch<React.SetStateAction<boolean>>;
  actionSheet: DocTreeNode | null;
  setActionSheet: React.Dispatch<React.SetStateAction<DocTreeNode | null>>;
  renameTarget: DocTreeNode | null;
  setRenameTarget: React.Dispatch<React.SetStateAction<DocTreeNode | null>>;
  existingFileConflict: string | null;
  setExistingFileConflict: React.Dispatch<React.SetStateAction<string | null>>;
  binaryDeleteTarget: DocTreeNode | null;
  setBinaryDeleteTarget: React.Dispatch<React.SetStateAction<DocTreeNode | null>>;
  uploadingBinary: boolean;
  editorSelection: { start: number; end: number } | null;
  setEditorSelection: React.Dispatch<
    React.SetStateAction<{ start: number; end: number } | null>
  >;
  dragOver: boolean;
  setDragOver: (next: boolean) => void;
  handleUploadBinary: (fileToUpload: File, opts?: { insertAtCaret?: boolean }) => Promise<void>;
  handleEditorDrop: (file: File) => void;
  handleConfirmBinaryDelete: (node: DocTreeNode) => Promise<void>;
  handleRevertConfirm: (entry: CommitSummary) => Promise<void>;
  handleSave: () => Promise<void>;
  handleCreateFile: (input: { folder: string; filename: string }) => Promise<void>;
  handleOpenExisting: () => Promise<void>;
  handleDelete: (node: DocTreeNode) => Promise<void>;
  handleRename: (node: DocTreeNode, to_path: string) => Promise<void>;
}

export function useDocMutations(params: {
  client: DocsClient | null;
  project_id: string;
  // ── file cluster ──
  file: DocFile | null;
  selectedPath: string | null;
  draftContent: string;
  mode: EditorMode;
  setFile: React.Dispatch<React.SetStateAction<DocFile | null>>;
  setSelectedPath: React.Dispatch<React.SetStateAction<string | null>>;
  setDraftContent: React.Dispatch<React.SetStateAction<string>>;
  setMode: React.Dispatch<React.SetStateAction<EditorMode>>;
  setConflict: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  fetchFile: (path: string) => Promise<void>;
  // ── tree cluster ──
  fetchTree: () => Promise<void>;
  setTree: React.Dispatch<React.SetStateAction<DocTreeNode[]>>;
  // ── history cluster ──
  loadHistory: (rel: string, cursor?: string) => Promise<void>;
  setPreviewVersion: React.Dispatch<React.SetStateAction<VersionContent | null>>;
  setHistoryEntries: React.Dispatch<React.SetStateAction<CommitSummary[]>>;
  setHistoryCursor: React.Dispatch<React.SetStateAction<string | null>>;
  setHistoryOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setRevertConfirm: React.Dispatch<React.SetStateAction<CommitSummary | null>>;
  setRevertingSha: React.Dispatch<React.SetStateAction<string | null>>;
}): UseDocMutations {
  const {
    client,
    project_id,
    file,
    selectedPath,
    draftContent,
    mode,
    setFile,
    setSelectedPath,
    setDraftContent,
    setMode,
    setConflict,
    setError,
    fetchFile,
    fetchTree,
    setTree,
    loadHistory,
    setPreviewVersion,
    setHistoryEntries,
    setHistoryCursor,
    setHistoryOpen,
    setRevertConfirm,
    setRevertingSha,
  } = params;

  // THE single mutation gate. Shared by every handler below.
  const mutateGate = useProjectScopedAsync(project_id);

  const [saving, setSaving] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [actionSheet, setActionSheet] = useState<DocTreeNode | null>(null);
  const [renameTarget, setRenameTarget] = useState<DocTreeNode | null>(null);
  const [existingFileConflict, setExistingFileConflict] = useState<string | null>(null);
  const [binaryDeleteTarget, setBinaryDeleteTarget] = useState<DocTreeNode | null>(null);
  const [uploadingBinary, setUploadingBinary] = useState(false);
  // Round-2 MINOR #3 — track the editor TextInput's caret position so the
  // drag-drop handler can splice `![alt](filename)` at the current cursor
  // instead of always appending. Selection is `[start, end]`; we use
  // `start` as the insert point (overwrites the selected range when the
  // user is mid-selection at the time of drop).
  const [editorSelection, setEditorSelection] = useState<{ start: number; end: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  /**
   * P7.5 — upload a binary via the same client method an action-sheet
   * "Insert image" button (or a web drag-drop handler) would call. The
   * active markdown file's directory hosts the uploaded blob; the
   * markdown surface is updated by the caller if needed (drag-drop
   * also splices `![alt](filename)` into the editor, but the standalone
   * upload button just lands the blob in the tree).
   */
  const handleUploadBinary = useCallback(
    async (fileToUpload: File, opts: { insertAtCaret?: boolean } = {}) => {
      if (client === null) return;
      if (!isBinaryExtension(fileToUpload.name)) {
        setError(`Unsupported file type: ${fileToUpload.name}`);
        return;
      }
      const token = mutateGate.acquire();
      setUploadingBinary(true);
      try {
        const activeDir =
          file?.path !== undefined && file.path.includes('/')
            ? file.path.slice(0, file.path.lastIndexOf('/'))
            : '';
        const targetPath = activeDir.length > 0
          ? `${activeDir}/${fileToUpload.name}`
          : fileToUpload.name;
        await client.uploadBinary(project_id, targetPath, fileToUpload);
        if (!mutateGate.isLatest(token)) return;
        // If the editor is open in edit mode, splice the markdown link
        // into the buffer. Round-2 MINOR #3 — drag-drop with caret
        // tracking inserts at the cursor; the standalone upload button
        // (no caret context) appends at the end as before.
        if (mode === 'edit' && file !== null) {
          const insert = `![${fileToUpload.name}](${fileToUpload.name})`;
          if (opts.insertAtCaret && editorSelection !== null) {
            const { start, end } = editorSelection;
            setDraftContent((cur) => {
              const before = cur.slice(0, start);
              const after = cur.slice(end);
              return `${before}${insert}${after}`;
            });
            // Move the caret PAST the inserted markdown so a subsequent
            // edit lands after the image link, not inside the URL.
            setEditorSelection({
              start: start + insert.length,
              end: start + insert.length,
            });
          } else {
            setDraftContent((cur) => `${cur}\n${insert}\n`);
          }
        }
        await fetchTree();
      } catch (err) {
        if (!mutateGate.isLatest(token)) return;
        setError(formatError(err));
      } finally {
        setUploadingBinary(false);
      }
    },
    [client, project_id, file, mode, mutateGate, fetchTree, editorSelection, setError, setDraftContent],
  );

  /**
   * Round-2 MINOR #3 — web-only drag-drop handler for the editor pane.
   * Pulls the first dropped file out of `event.dataTransfer.files`,
   * validates the extension client-side, then routes through
   * `handleUploadBinary` with `insertAtCaret: true` so the markdown
   * image syntax lands at the user's current cursor position rather
   * than appended at the end of the buffer.
   */
  const handleEditorDrop = useCallback(
    (fileToDrop: File) => {
      void handleUploadBinary(fileToDrop, { insertAtCaret: true });
    },
    [handleUploadBinary],
  );

  const handleConfirmBinaryDelete = useCallback(
    async (node: DocTreeNode) => {
      if (client === null) return;
      const token = mutateGate.acquire();
      try {
        await client.deleteBinary(project_id, node.path);
        if (!mutateGate.isLatest(token)) return;
        setBinaryDeleteTarget(null);
        if (selectedPath === node.path) {
          setSelectedPath(null);
        }
        await fetchTree();
      } catch (err) {
        if (!mutateGate.isLatest(token)) return;
        setError(formatError(err));
      }
    },
    [client, project_id, selectedPath, fetchTree, mutateGate, setSelectedPath, setError],
  );

  const handleRevertConfirm = useCallback(
    async (entry: CommitSummary) => {
      if (client === null || file === null) return;
      const token = mutateGate.acquire();
      setRevertingSha(entry.sha);
      setError(null);
      try {
        // Pass the current mtime so a concurrent edit (other tab /
        // device) surfaces the same 409 the normal Save path would.
        // Codex r1 P1.
        const result = await client.revert(project_id, {
          path: file.path,
          target_sha: entry.sha,
          expected_modified_at: file.modified_at,
        });
        if (!mutateGate.isLatest(token)) return;
        if (result.deleted) {
          // Revert restored a deletion state — clear the open file
          // surface, refresh the tree, and close the history pane.
          setFile(null);
          setSelectedPath(null);
          setDraftContent('');
          setMode('view');
          setHistoryEntries([]);
          setHistoryCursor(null);
          setHistoryOpen(false);
          await fetchTree();
        } else {
          // Reload the file body + re-fetch history so the new commit
          // appears at the top of the pane.
          await fetchFile(file.path);
          if (!mutateGate.isLatest(token)) return;
          await loadHistory(file.path);
        }
        if (!mutateGate.isLatest(token)) return;
        setPreviewVersion(null);
        setRevertConfirm(null);
      } catch (err) {
        if (!mutateGate.isLatest(token)) return;
        if (err instanceof DocsClientError && err.code === 'doc_modified_conflict') {
          setConflict(true);
          setRevertConfirm(null);
        } else {
          setError(formatError(err));
        }
      } finally {
        setRevertingSha(null);
      }
    },
    [
      client,
      file,
      project_id,
      mutateGate,
      fetchFile,
      fetchTree,
      loadHistory,
      setRevertingSha,
      setError,
      setFile,
      setSelectedPath,
      setDraftContent,
      setMode,
      setHistoryEntries,
      setHistoryCursor,
      setHistoryOpen,
      setPreviewVersion,
      setRevertConfirm,
      setConflict,
    ],
  );

  const handleSave = useCallback(async () => {
    if (client === null || file === null) return;
    // Acquire a mutate token before the await. If the project_id
    // flips mid-save, the render-phase reset in `useProjectScopedAsync`
    // invalidates this token — the resolver below bails BEFORE
    // re-installing A's `file` closure (path + content + mtime) into
    // B's now-reset screen. Without this, the next Save in B would
    // writeFile(B, A.path, A.content) — exact cross-project silent
    // write. Round-5 BLOCKING #1.
    const token = mutateGate.acquire();
    setSaving(true);
    setError(null);
    try {
      const result = await client.writeFile(project_id, {
        path: file.path,
        content: draftContent,
        expected_modified_at: file.modified_at,
      });
      if (!mutateGate.isLatest(token)) return;
      setFile({
        ...file,
        content: draftContent,
        size_bytes: result.size_bytes,
        modified_at: result.modified_at,
      });
      setMode('view');
      await fetchTree();
    } catch (err) {
      if (!mutateGate.isLatest(token)) return;
      if (err instanceof DocsClientError && err.code === 'doc_modified_conflict') {
        setConflict(true);
      } else {
        setError(formatError(err));
      }
    } finally {
      // Always clear the spinner — even if the token was invalidated
      // by a project switch, the surrounding component keeps living
      // and a stuck `saving=true` would disable the Save button the
      // next time the user enters edit mode in the new project.
      setSaving(false);
    }
  }, [client, file, draftContent, project_id, fetchTree, mutateGate, setError, setFile, setMode, setConflict]);

  const handleCreateFile = useCallback(
    async (input: { folder: string; filename: string }) => {
      if (client === null) return;
      const filename = input.filename.trim();
      if (filename.length === 0) {
        setError('Filename is required.');
        return;
      }
      // Match the gateway's MARKDOWN_EXTENSIONS — `.md` and
      // `.markdown` both pass requireMd. Round-7 IMPORTANT #1.
      const withExt = /\.(md|markdown)$/i.test(filename) ? filename : `${filename}.md`;
      const folder = input.folder.replace(/^\/+|\/+$/g, '');
      const fullPath = folder.length > 0 ? `${folder}/${withExt}` : withExt;
      // Acquire a mutate token. If `project_id` flips mid-await, the
      // render-phase gate reset invalidates this token and the resolver
      // bails BEFORE any state setter fires — without this guard, A's
      // newly-created path landed in B's editor and the next Save
      // silently wrote B with A's content (round-7 BLOCKING #1, same
      // bug class round-6 closed for handleSave only).
      const token = mutateGate.acquire();
      try {
        // Refetch tree first so the existence check sees the freshest
        // server view — PUT is create-or-overwrite, so a stale local
        // tree could let us silently truncate a file another client just
        // wrote.
        const { tree: latestTree } = await client.tree(project_id);
        if (!mutateGate.isLatest(token)) return;
        setTree(latestTree);
        if (findNodeByPath(latestTree, fullPath) !== null) {
          setExistingFileConflict(fullPath);
          return;
        }
        await client.writeFile(project_id, { path: fullPath, content: '' });
        if (!mutateGate.isLatest(token)) return;
        setNewFileOpen(false);
        await fetchTree();
        if (!mutateGate.isLatest(token)) return;
        setSelectedPath(fullPath);
        await fetchFile(fullPath);
        if (!mutateGate.isLatest(token)) return;
        setMode('edit');
      } catch (err) {
        if (!mutateGate.isLatest(token)) return;
        setError(formatError(err));
      }
    },
    [client, project_id, fetchTree, fetchFile, mutateGate, setError, setTree, setSelectedPath, setMode],
  );

  const handleOpenExisting = useCallback(async () => {
    if (existingFileConflict === null) return;
    const fullPath = existingFileConflict;
    setExistingFileConflict(null);
    setNewFileOpen(false);
    setSelectedPath(fullPath);
    await fetchFile(fullPath);
  }, [existingFileConflict, fetchFile, setSelectedPath]);

  const handleDelete = useCallback(
    async (node: DocTreeNode) => {
      if (client === null) return;
      // P7.5 — a binary with referenced_by_count > 0 routes through a
      // confirm dialog so the user can back out before the destructive
      // action; otherwise drop straight through to the delete.
      if (
        node.kind === 'binary' &&
        node.referenced_by_count !== null &&
        node.referenced_by_count > 0
      ) {
        setActionSheet(null);
        setBinaryDeleteTarget(node);
        return;
      }
      // Same mutateGate guard as handleSave / handleCreateFile —
      // without it, project A's delete resolving after the user
      // switches to project B would null out B's open file and
      // re-render A's tree. Round-7 BLOCKING #1.
      const token = mutateGate.acquire();
      try {
        if (node.kind === 'file') {
          await client.deleteFile(project_id, node.path);
        } else if (node.kind === 'binary') {
          await client.deleteBinary(project_id, node.path);
        } else if (node.kind === 'folder' && node.origin === 'binary') {
          // P7.5 round-2 IMPORTANT #5 — phantom-binary folder. The
          // folder doesn't exist on disk (the tree-merge step synthesised
          // it to host a binary leaf), so `deleteFolder` would ENOENT.
          // Route through the binary-recursive delete instead so every
          // binary under the prefix is unlinked in one txn.
          await client.deleteBinariesUnderPrefix(project_id, node.path);
        } else {
          await client.deleteFolder(project_id, node.path);
        }
        if (!mutateGate.isLatest(token)) return;
        setActionSheet(null);
        if (selectedPath === node.path) {
          setSelectedPath(null);
          setFile(null);
        }
        await fetchTree();
      } catch (err) {
        if (!mutateGate.isLatest(token)) return;
        setError(formatError(err));
      }
    },
    [client, project_id, selectedPath, fetchTree, mutateGate, setSelectedPath, setFile, setError],
  );

  const handleRename = useCallback(
    async (node: DocTreeNode, to_path: string) => {
      if (client === null) return;
      const cleaned = to_path.trim();
      if (cleaned.length === 0) {
        setError('New path is required.');
        return;
      }
      // Same mutateGate guard as handleSave / handleCreateFile /
      // handleDelete — without it, project A's rename resolving
      // after the user switches to project B would install A's
      // new path into B's editor and the next Save would write B
      // under A's renamed path. Round-7 BLOCKING #1.
      const token = mutateGate.acquire();
      try {
        if (node.kind === 'file') {
          await client.moveFile(project_id, node.path, cleaned);
        } else {
          throw new Error('Folder rename is not supported in P7.1.');
        }
        if (!mutateGate.isLatest(token)) return;
        setRenameTarget(null);
        setActionSheet(null);
        if (selectedPath === node.path) {
          setSelectedPath(cleaned);
          await fetchFile(cleaned);
          if (!mutateGate.isLatest(token)) return;
        }
        await fetchTree();
      } catch (err) {
        if (!mutateGate.isLatest(token)) return;
        setError(formatError(err));
      }
    },
    [client, project_id, selectedPath, fetchTree, fetchFile, mutateGate, setSelectedPath, setError],
  );

  // Project change: reset the mutation-driven modal/affordance state.
  // (The gate is invalidated render-phase by `useProjectScopedAsync`.)
  // NOTE — matching the pre-D7 project-change effect, this does NOT
  // reset `binaryDeleteTarget` / `uploadingBinary` / `editorSelection`
  // / `dragOver`; those intentionally persist across a switch.
  useEffect(() => {
    setExistingFileConflict(null);
    setActionSheet(null);
    setRenameTarget(null);
    setNewFileOpen(false);
  }, [project_id, client]);

  return {
    saving,
    newFileOpen,
    setNewFileOpen,
    actionSheet,
    setActionSheet,
    renameTarget,
    setRenameTarget,
    existingFileConflict,
    setExistingFileConflict,
    binaryDeleteTarget,
    setBinaryDeleteTarget,
    uploadingBinary,
    editorSelection,
    setEditorSelection,
    dragOver,
    setDragOver,
    handleUploadBinary,
    handleEditorDrop,
    handleConfirmBinaryDelete,
    handleRevertConfirm,
    handleSave,
    handleCreateFile,
    handleOpenExisting,
    handleDelete,
    handleRename,
  };
}
