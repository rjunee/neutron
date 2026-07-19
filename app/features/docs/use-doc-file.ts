/**
 * @neutronai/app — `useDocFile`: the open-file cluster of the docs tab
 * (D7 refactor). Owns the per-file state (`file`, `selectedPath`,
 * `mode`, `draftContent`, `conflict`) plus the tab-wide `error`
 * banner state, the file-read gate, `fetchFile`, the 409
 * draft-preserve `handleReload`, and the relative-image
 * `resolveBinary` resolver.
 *
 * The 409 draft-preserve invariant: a `doc_modified_conflict` on Save
 * (see `useDocMutations`) flips `conflict` WITHOUT touching
 * `draftContent`, so the user's unsaved edit survives until they press
 * Reload — which re-fetches the canonical body via `fetchFile`.
 */


import { type BinarySourceResolver } from '../../lib/markdown-render';
import {
  DocsClient,
  freshEditorState,
  type DocFile,
} from '../../lib/docs-client';
import { reactHooks, type HookRuntime } from '../../lib/hook-runtime';
import { useProjectScopedAsync } from './use-project-scoped-async';
import { formatError, normalizeRel, type EditorMode } from './docs-shared';

export interface UseDocFile {
  file: DocFile | null;
  setFile: React.Dispatch<React.SetStateAction<DocFile | null>>;
  selectedPath: string | null;
  setSelectedPath: React.Dispatch<React.SetStateAction<string | null>>;
  mode: EditorMode;
  setMode: React.Dispatch<React.SetStateAction<EditorMode>>;
  draftContent: string;
  setDraftContent: React.Dispatch<React.SetStateAction<string>>;
  conflict: boolean;
  setConflict: React.Dispatch<React.SetStateAction<boolean>>;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  fetchFile: (path: string) => Promise<void>;
  handleReload: () => Promise<void>;
  resolveBinary: BinarySourceResolver | undefined;
}

export function useDocFile(
  params: {
    client: DocsClient | null;
    project_id: string;
  },
  /** Injectable dispatcher — see `lib/hook-runtime.ts`. Real React by default. */
  hooks: HookRuntime = reactHooks,
): UseDocFile {
  const { useCallback, useEffect, useMemo, useState } = hooks;
  const { client, project_id } = params;
  const fileGate = useProjectScopedAsync(project_id, client, hooks);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<DocFile | null>(null);
  const [mode, setMode] = useState<EditorMode>('view');
  const [draftContent, setDraftContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<boolean>(false);

  const fetchFile = useCallback(
    async (path: string) => {
      if (client === null) return;
      const token = fileGate.acquire();
      setError(null);
      setConflict(false);
      try {
        const next = await client.readFile(project_id, path);
        if (!fileGate.isLatest(token)) return;
        setFile(next);
        setDraftContent(next.content);
        setMode('view');
      } catch (err) {
        if (!fileGate.isLatest(token)) return;
        setError(formatError(err));
      }
    },
    [client, project_id, fileGate],
  );

  const handleReload = useCallback(async () => {
    if (file === null) return;
    setConflict(false);
    await fetchFile(file.path);
  }, [file, fetchFile]);

  /**
   * P7.5 — resolve relative `![alt](file.png)` references in markdown
   * against `GET /docs/binary?path=...`. Threaded into `<RenderMarkdown
   * binarySource={resolveBinary} />` so the markdown preview renders
   * inline images served by the gateway with the same bearer token.
   * Resolution uses the active file's directory as the base; absolute
   * URLs (`https://...`) skip this resolver entirely.
   */
  const activeFilePath = file?.path ?? null;
  const resolveBinary: BinarySourceResolver | undefined = useMemo(() => {
    if (client === null) return undefined;
    return (relPath: string) => {
      if (/^[a-z]+:\/\//i.test(relPath)) return null;
      if (relPath.startsWith('#')) return null;
      const base = activeFilePath !== null && activeFilePath.includes('/')
        ? activeFilePath.slice(0, activeFilePath.lastIndexOf('/'))
        : '';
      const joined = base.length > 0 ? `${base}/${relPath}` : relPath;
      const normalized = normalizeRel(joined);
      if (normalized === null) return null;
      return client.binaryUrl(project_id, normalized);
    };
  }, [client, activeFilePath, project_id]);

  // Project change: reset every per-file field BEFORE the tree refetch
  // (the gate itself is invalidated on a committed switch by
  // `useProjectScopedAsync`). Without this, navigating A → B leaves A's
  // open file + selectedPath + draftContent + mode in state while
  // `project_id` is now B; pressing Save (or letting any mid-flight
  // create/rename/delete resolve) silently writes A's content under
  // project B. Fires on `project_id`/`client` change — the same trigger
  // the pre-D7 single project-change effect used (its `fetchTree` dep
  // was `f(client, project_id)`).
  useEffect(() => {
    const fresh = freshEditorState();
    setFile(fresh.file);
    setSelectedPath(fresh.selectedPath);
    setDraftContent(fresh.draftContent);
    setMode(fresh.mode);
    setConflict(fresh.conflict);
    setError(fresh.error);
  }, [project_id, client]);

  return {
    file,
    setFile,
    selectedPath,
    setSelectedPath,
    mode,
    setMode,
    draftContent,
    setDraftContent,
    conflict,
    setConflict,
    error,
    setError,
    fetchFile,
    handleReload,
    resolveBinary,
  };
}
