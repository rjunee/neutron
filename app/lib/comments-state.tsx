/**
 * @neutronai/app — comments-state Context provider (P7.2 S3).
 *
 * Glues the `DocsClient` HTTP wrapper to the side-pane `<CommentsSidePane>`
 * component. Mounted by the docs reader / editor route file
 * (`app/app/projects/[id]/docs.tsx`) once a doc is open, and consumed by
 * the side-pane component via `useCommentsState()`.
 *
 * Side effects the provider owns:
 *
 *   1. Fetching `GET /api/app/projects/<id>/docs/comments?path=<doc_path>`
 *      on mount + when `project_id` or `doc_path` changes. Uses the
 *      `RequestGate` pattern from `lib/docs-client.ts:723-737` so a
 *      late-landing response from a previous tuple cannot overwrite
 *      the current tuple's state (mirrors how the docs tab guards its
 *      tree / file / mutate fetches).
 *   2. Resetting the gate on doc-switch AND project-switch (the effect
 *      depends on both keys + `client`).
 *   3. Optimistic mutators for the three side-pane gestures (reply,
 *      resolve, escalate) — each one mutates `threads` immediately so
 *      the UI feels instant, then dispatches the HTTP call. On
 *      failure, the next refetch reconciles to server truth (the
 *      mutator rolls back to a previous snapshot on error).
 *
 * Mirrors the context pattern from `lib/task-state.tsx` — same
 * `clientOverride` test seam, same `useAuthSession()` token wiring,
 * same `useMemo`-stable value shape.
 *
 * S3 scope-locked simplifications:
 *   - No `comment_resolved` projection column on the gateway; the side-
 *     pane decides "is this thread resolved?" purely from
 *     `latest_event_kind === 'comment_resolved'` on the row the gateway
 *     supplies. Absent field → treated as active (forward-compat with
 *     S1+S2 gateways).
 *   - Optimistic-escalate flips a per-thread `escalated_this_session`
 *     flag so the button hides after the first user-triggered tap;
 *     this is in-memory only (does not persist across refetch).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';

import { loadAppConfig } from './config';
import {
  DocsClient,
  RequestGate,
  type ThreadSummary,
} from './docs-client';
import { useAuthSession } from './session';

export interface CommentsStateError {
  code: string;
  message: string;
}

export interface CommentsStateValue {
  threads: ThreadSummary[];
  loading: boolean;
  error: CommentsStateError | null;
  /** Thread IDs the user has escalated in this side-pane session.
   *  In-memory only — the button hides after a successful tap, but
   *  re-mounting the pane resets the set so the user can re-escalate. */
  escalatedThisSession: ReadonlySet<string>;
  /** Per-thread mutation lock — true while a resolve / escalate /
   *  reply is in flight. The card disables the button so a double-tap
   *  can't fire two events. */
  mutatingThreadIds: ReadonlySet<string>;
  refetch(): Promise<void>;
  /**
   * Optimistically increment `reply_count` + `last_reply_at` on the
   * matching thread, then POST. On failure, refetch (canonical reply
   * lands as the next render).
   */
  postReply(thread_root_id: string, body: string): Promise<boolean>;
  /**
   * Optimistically flip the thread's `latest_event_kind` to
   * `'comment_resolved'`, then POST. On failure, refetch.
   */
  resolveThread(thread_root_id: string): Promise<boolean>;
  /**
   * Optimistically add the thread to `escalatedThisSession`, then POST.
   * On failure, remove from the set + refetch.
   */
  escalateThread(thread_root_id: string, note?: string): Promise<boolean>;
  dismissError(): void;
}

const CommentsStateContext = createContext<CommentsStateValue | null>(null);

export function useCommentsState(): CommentsStateValue {
  const ctx = useContext(CommentsStateContext);
  if (ctx === null) {
    throw new Error('useCommentsState must be used inside <CommentsProvider>');
  }
  return ctx;
}

export interface CommentsProviderProps extends PropsWithChildren {
  project_id: string;
  doc_path: string;
  /**
   * Optional client override. Tests inject a stub so the provider is
   * exercisable without a live gateway (mirrors `TaskStateProvider`'s
   * `clientOverride` seam).
   */
  clientOverride?: DocsClient;
}

function toCommentsStateError(err: unknown): CommentsStateError {
  if (err instanceof Error) {
    // DocsClientError extends Error and carries a `code` field; we
    // duck-type via the message prefix to avoid an import cycle.
    const maybeCode = (err as { code?: unknown }).code;
    const code = typeof maybeCode === 'string' && maybeCode.length > 0
      ? maybeCode
      : 'request_failed';
    return { code, message: err.message };
  }
  return { code: 'request_failed', message: String(err) };
}

export function CommentsProvider({
  project_id,
  doc_path,
  clientOverride,
  children,
}: CommentsProviderProps) {
  const { user } = useAuthSession();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<CommentsStateError | null>(null);
  const [escalatedThisSession, setEscalatedThisSession] = useState<Set<string>>(
    () => new Set(),
  );
  const [mutatingThreadIds, setMutatingThreadIds] = useState<Set<string>>(
    () => new Set(),
  );

  const gate = useMemo(() => new RequestGate(), []);
  const cancelRef = useRef<(() => void) | null>(null);

  const client = useMemo<DocsClient | null>(() => {
    if (clientOverride !== undefined) return clientOverride;
    if (user === null) return null;
    const cfg = loadAppConfig();
    return new DocsClient({ base_url: cfg.base_url, token: user.token });
  }, [clientOverride, user]);

  const fetchThreads = useCallback(async (): Promise<void> => {
    if (client === null) return;
    if (project_id.length === 0 || doc_path.length === 0) {
      setThreads([]);
      return;
    }
    const token = gate.acquire();
    let cancelled = false;
    cancelRef.current?.();
    cancelRef.current = () => {
      cancelled = true;
    };
    setLoading(true);
    setError(null);
    try {
      const { threads: rows } = await client.listComments(project_id, doc_path);
      if (cancelled || !gate.isLatest(token)) return;
      setThreads(rows);
    } catch (err) {
      if (cancelled || !gate.isLatest(token)) return;
      setError(toCommentsStateError(err));
    } finally {
      if (!cancelled && gate.isLatest(token)) setLoading(false);
    }
  }, [client, project_id, doc_path, gate]);

  useEffect(() => {
    // Project OR doc switch — invalidate every in-flight fetch and
    // reset the in-memory session flags (the resolve / escalate state
    // is doc-scoped; switching to a different doc must not carry a
    // stale "already escalated this session" flag through).
    gate.reset();
    setEscalatedThisSession(new Set());
    setMutatingThreadIds(new Set());
    setThreads([]);
    void fetchThreads();
    return () => {
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, [fetchThreads, gate, project_id, doc_path]);

  const lockThread = useCallback((thread_root_id: string) => {
    setMutatingThreadIds((prev) => {
      if (prev.has(thread_root_id)) return prev;
      const next = new Set(prev);
      next.add(thread_root_id);
      return next;
    });
  }, []);

  const unlockThread = useCallback((thread_root_id: string) => {
    setMutatingThreadIds((prev) => {
      if (!prev.has(thread_root_id)) return prev;
      const next = new Set(prev);
      next.delete(thread_root_id);
      return next;
    });
  }, []);

  const postReply = useCallback(
    async (thread_root_id: string, body: string): Promise<boolean> => {
      if (client === null) return false;
      const trimmed = body.trim();
      if (trimmed.length === 0) return false;
      lockThread(thread_root_id);
      const prev = threads;
      // Optimistic — bump `last_reply_at` so the thread sorts to the
      // top of the active list immediately. The next refetch reconciles
      // to the server's canonical reply_count + created_at.
      const now = Date.now();
      setThreads((cur) =>
        cur.map((t) =>
          t.thread_root_id === thread_root_id
            ? { ...t, last_reply_at: now, reply_count: t.reply_count + 1 }
            : t,
        ),
      );
      try {
        await client.replyToComment(project_id, thread_root_id, trimmed);
        await fetchThreads();
        return true;
      } catch (err) {
        // Roll back the optimistic counter and surface the error.
        setThreads(prev);
        setError(toCommentsStateError(err));
        return false;
      } finally {
        unlockThread(thread_root_id);
      }
    },
    [client, project_id, threads, fetchThreads, lockThread, unlockThread],
  );

  const resolveThread = useCallback(
    async (thread_root_id: string): Promise<boolean> => {
      if (client === null) return false;
      lockThread(thread_root_id);
      const prev = threads;
      // Optimistic — flip the latest_event_kind so the card moves into
      // the collapsed "Resolved (N)" section immediately.
      setThreads((cur) =>
        cur.map((t) =>
          t.thread_root_id === thread_root_id
            ? { ...t, latest_event_kind: 'comment_resolved' as const }
            : t,
        ),
      );
      try {
        await client.resolveComment(project_id, thread_root_id);
        await fetchThreads();
        return true;
      } catch (err) {
        setThreads(prev);
        setError(toCommentsStateError(err));
        return false;
      } finally {
        unlockThread(thread_root_id);
      }
    },
    [client, project_id, threads, fetchThreads, lockThread, unlockThread],
  );

  const escalateThread = useCallback(
    async (thread_root_id: string, note?: string): Promise<boolean> => {
      if (client === null) return false;
      lockThread(thread_root_id);
      // Optimistic — hide the escalate button immediately. Roll back
      // on failure so the user can retry.
      setEscalatedThisSession((cur) => {
        if (cur.has(thread_root_id)) return cur;
        const next = new Set(cur);
        next.add(thread_root_id);
        return next;
      });
      try {
        await client.escalateToChat(project_id, thread_root_id, note);
        // No refetch — the event lands as `escalate_to_chat` but
        // doesn't change the thread's visible state in the pane. The
        // chat surface absorbs it on its next turn.
        return true;
      } catch (err) {
        setEscalatedThisSession((cur) => {
          if (!cur.has(thread_root_id)) return cur;
          const next = new Set(cur);
          next.delete(thread_root_id);
          return next;
        });
        setError(toCommentsStateError(err));
        return false;
      } finally {
        unlockThread(thread_root_id);
      }
    },
    [client, project_id, lockThread, unlockThread],
  );

  const dismissError = useCallback(() => setError(null), []);

  const value = useMemo<CommentsStateValue>(
    () => ({
      threads,
      loading,
      error,
      escalatedThisSession,
      mutatingThreadIds,
      refetch: fetchThreads,
      postReply,
      resolveThread,
      escalateThread,
      dismissError,
    }),
    [
      threads,
      loading,
      error,
      escalatedThisSession,
      mutatingThreadIds,
      fetchThreads,
      postReply,
      resolveThread,
      escalateThread,
      dismissError,
    ],
  );

  return (
    <CommentsStateContext.Provider value={value}>{children}</CommentsStateContext.Provider>
  );
}
