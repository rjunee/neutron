/**
 * @neutronai/app — `useDocHistory`: the P7.4 version-history cluster of
 * the docs tab (D7 refactor). Owns the history-pane state
 * (`historyOpen`, `historyEntries`, `historyCursor`,
 * `historyUnavailable`, `previewVersion`, `revertingSha`,
 * `revertConfirm`), the history-read gate, and the read-side handlers
 * (`loadHistory`, `handleToggleHistory`, `handlePreviewVersion`,
 * `handleExitPreview`).
 *
 * The revert ACTION is a mutation and lives in `useDocMutations` (it
 * takes the single mutate gate); this hook exposes the history setters
 * + `loadHistory` it needs. `loadHistoryRef` lets the composition's
 * `handleSelect` (declared before `loadHistory` in the pre-D7 source
 * order) refresh history for a newly-selected file without a
 * stale-closure trap.
 */

import {
  DocsClient,
  DocsClientError,
  type CommitSummary,
  type DocFile,
  type VersionContent,
} from '../../lib/docs-client';
import { reactHooks, type HookRuntime } from '../../lib/hook-runtime';
import { useProjectScopedAsync } from './use-project-scoped-async';
import { formatError } from './docs-shared';

export interface UseDocHistory {
  historyOpen: boolean;
  setHistoryOpen: React.Dispatch<React.SetStateAction<boolean>>;
  historyLoading: boolean;
  historyEntries: CommitSummary[];
  setHistoryEntries: React.Dispatch<React.SetStateAction<CommitSummary[]>>;
  historyCursor: string | null;
  setHistoryCursor: React.Dispatch<React.SetStateAction<string | null>>;
  historyUnavailable: boolean;
  setHistoryUnavailable: React.Dispatch<React.SetStateAction<boolean>>;
  previewVersion: VersionContent | null;
  setPreviewVersion: React.Dispatch<React.SetStateAction<VersionContent | null>>;
  revertingSha: string | null;
  setRevertingSha: React.Dispatch<React.SetStateAction<string | null>>;
  revertConfirm: CommitSummary | null;
  setRevertConfirm: React.Dispatch<React.SetStateAction<CommitSummary | null>>;
  loadHistory: (rel: string, cursor?: string) => Promise<void>;
  loadHistoryRef: React.MutableRefObject<((rel: string, cursor?: string) => void) | null>;
  handleToggleHistory: () => void;
  handlePreviewVersion: (entry: CommitSummary) => Promise<void>;
  handleExitPreview: () => void;
}

export function useDocHistory(
  params: {
    client: DocsClient | null;
    project_id: string;
    file: DocFile | null;
    setError: React.Dispatch<React.SetStateAction<string | null>>;
  },
  /** Injectable dispatcher — see `lib/hook-runtime.ts`. Real React by default. */
  hooks: HookRuntime = reactHooks,
): UseDocHistory {
  const { useCallback, useEffect, useRef, useState } = hooks;
  const { client, project_id, file, setError } = params;
  const historyGate = useProjectScopedAsync(project_id, client, hooks);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<CommitSummary[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<VersionContent | null>(null);
  const [revertingSha, setRevertingSha] = useState<string | null>(null);
  const [revertConfirm, setRevertConfirm] = useState<CommitSummary | null>(null);
  // Ref so handleSelect (declared above loadHistory in the composition)
  // can refresh history when the user picks a different file with the
  // history pane open. Set by the effect below.
  const loadHistoryRef = useRef<((rel: string, cursor?: string) => void) | null>(null);

  const loadHistory = useCallback(
    async (rel: string, cursor?: string) => {
      if (client === null) return;
      const token = historyGate.acquire();
      setHistoryLoading(true);
      try {
        const opts: { cursor?: string } = {};
        if (cursor !== undefined) opts.cursor = cursor;
        const page = await client.history(project_id, rel, opts);
        if (!historyGate.isLatest(token)) return;
        setHistoryUnavailable(false);
        setHistoryEntries((prev) =>
          cursor === undefined ? page.history : [...prev, ...page.history],
        );
        setHistoryCursor(page.next_cursor);
      } catch (err) {
        if (!historyGate.isLatest(token)) return;
        if (err instanceof DocsClientError && err.code === 'versioning_unavailable') {
          setHistoryUnavailable(true);
          setHistoryEntries([]);
          setHistoryCursor(null);
        } else {
          setError(formatError(err));
        }
      } finally {
        if (historyGate.isLatest(token)) setHistoryLoading(false);
      }
    },
    [client, project_id, historyGate, setError],
  );

  // Keep the ref synced with the latest loadHistory closure so
  // handleSelect (declared earlier in source order) can call into the
  // current version without a stale-closure trap.
  useEffect(() => {
    loadHistoryRef.current = loadHistory;
  }, [loadHistory]);

  const handleToggleHistory = useCallback(() => {
    if (file === null) return;
    const next = !historyOpen;
    setHistoryOpen(next);
    setPreviewVersion(null);
    if (next) {
      void loadHistory(file.path);
    }
  }, [file, historyOpen, loadHistory]);

  const handlePreviewVersion = useCallback(
    async (entry: CommitSummary) => {
      if (client === null || file === null) return;
      const token = historyGate.acquire();
      try {
        const v = await client.getVersion(project_id, entry.sha, file.path);
        if (!historyGate.isLatest(token)) return;
        setPreviewVersion(v);
      } catch (err) {
        if (!historyGate.isLatest(token)) return;
        setError(formatError(err));
      }
    },
    [client, file, project_id, historyGate, setError],
  );

  const handleExitPreview = useCallback(() => {
    setPreviewVersion(null);
  }, []);

  // Project change: reset the history-pane surface. (The gate is
  // invalidated on a committed switch by `useProjectScopedAsync`.) Fires on the
  // same `project_id`/`client` trigger as the pre-D7 single effect.
  useEffect(() => {
    setHistoryOpen(false);
    setHistoryEntries([]);
    setHistoryCursor(null);
    setHistoryUnavailable(false);
    setPreviewVersion(null);
    setRevertConfirm(null);
    setRevertingSha(null);
  }, [project_id, client]);

  return {
    historyOpen,
    setHistoryOpen,
    historyLoading,
    historyEntries,
    setHistoryEntries,
    historyCursor,
    setHistoryCursor,
    historyUnavailable,
    setHistoryUnavailable,
    previewVersion,
    setPreviewVersion,
    revertingSha,
    setRevertingSha,
    revertConfirm,
    setRevertConfirm,
    loadHistory,
    loadHistoryRef,
    handleToggleHistory,
    handlePreviewVersion,
    handleExitPreview,
  };
}
