/**
 * @neutronai/app — launcher-state Context provider (P5.3).
 *
 * Glues the `LauncherClient` HTTP wrapper, the pure
 * `launcherStateReducer`, and the React tree. Mounted by the launcher
 * route file (`app/app/projects/[id]/launcher.tsx`) and consumed by
 * the route + `<LauncherGrid>` / `<LauncherItemMenu>` /
 * `<LauncherRenameModal>` / `<LauncherBuildMeModal>` children via
 * `useLauncherState()`.
 *
 * The provider owns five side effects:
 *   1. Fetching `GET /api/app/projects/<id>/launcher` on mount + when
 *      `projectId` changes.
 *   2. Re-fetching on `refresh()` (used by tests + the error-banner
 *      retry path when the user explicitly recovers).
 *   3. Firing reorder / rename / uninstall mutations against the
 *      launcher surface. Server-authoritative — the response is the
 *      post-mutation ordered list and `MUTATE_OK` REPLACES state.
 *   4. Firing the build-me chat-send via the typed
 *      `LauncherClient.sendBuildMePrompt(...)` so the production-
 *      composer guard test reaches the same wire path.
 *   5. Disposing in-flight fetches on `projectId` change so a late
 *      response from the previous project can't overwrite the new
 *      project's state.
 *
 * Test surface: `<LauncherStateProvider>` accepts `clientOverride` so
 * unit tests inject a stubbed `LauncherClient` instead of hitting the
 * network. Real builds resolve via `loadAppConfig()` + the bearer
 * token from `useAuthSession()`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type PropsWithChildren,
} from 'react';

import { loadAppConfig } from './config';
import {
  EMPTY_LAUNCHER_STATE,
  launcherStateReducer,
  toLauncherStateError,
  type LauncherState,
  type LauncherStateError,
} from './launcher-state-reducer';
import {
  LauncherClient,
  type LauncherEntry,
} from './launcher-client';
import { useAuthSession } from './session';

export interface LauncherStateValue {
  state: LauncherState;
  entries: LauncherEntry[];
  loading: boolean;
  error: LauncherStateError | null;
  mutating: boolean;
  building_me: boolean;
  refresh(): Promise<void>;
  reorder(slug: string, new_index: number): Promise<void>;
  rename(slug: string, display_name: string): Promise<void>;
  uninstall(slug: string): Promise<void>;
  sendBuildMe(prompt: string): Promise<boolean>;
  dismissError(): void;
}

const LauncherStateContext = createContext<LauncherStateValue | null>(null);

export function useLauncherState(): LauncherStateValue {
  const ctx = useContext(LauncherStateContext);
  if (ctx === null) {
    throw new Error('useLauncherState must be used inside <LauncherStateProvider>');
  }
  return ctx;
}

export interface LauncherStateProviderProps extends PropsWithChildren {
  projectId: string;
  /**
   * Optional LauncherClient override. Tests inject a stub so the
   * provider is exercisable without a live gateway.
   */
  clientOverride?: LauncherClient;
}

export function LauncherStateProvider({
  projectId,
  clientOverride,
  children,
}: LauncherStateProviderProps) {
  const { user } = useAuthSession();
  const [state, dispatch] = useReducer(launcherStateReducer, EMPTY_LAUNCHER_STATE);
  const cancelRef = useRef<(() => void) | null>(null);

  const client = useMemo<LauncherClient | null>(() => {
    if (clientOverride !== undefined) return clientOverride;
    if (user === null) return null;
    const cfg = loadAppConfig();
    return new LauncherClient({ base_url: cfg.base_url, token: user.token });
  }, [clientOverride, user]);

  const fetchEntries = useCallback(async (): Promise<void> => {
    if (client === null) return;
    if (typeof projectId !== 'string' || projectId.length === 0) return;
    let cancelled = false;
    cancelRef.current?.();
    cancelRef.current = () => {
      cancelled = true;
    };
    dispatch({ type: 'LOAD_START' });
    try {
      const entries = await client.list(projectId);
      if (cancelled) return;
      dispatch({ type: 'LOAD_OK', entries });
    } catch (err) {
      if (cancelled) return;
      dispatch({ type: 'LOAD_FAIL', error: toLauncherStateError(err) });
    }
  }, [client, projectId]);

  useEffect(() => {
    void fetchEntries();
    return () => {
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, [fetchEntries]);

  const reorder = useCallback(
    async (slug: string, new_index: number): Promise<void> => {
      if (client === null) return;
      dispatch({ type: 'MUTATE_START' });
      try {
        const entries = await client.reorder(projectId, slug, new_index);
        dispatch({ type: 'MUTATE_OK', entries });
      } catch (err) {
        dispatch({ type: 'MUTATE_FAIL', error: toLauncherStateError(err) });
      }
    },
    [client, projectId],
  );

  const rename = useCallback(
    async (slug: string, display_name: string): Promise<void> => {
      if (client === null) return;
      dispatch({ type: 'MUTATE_START' });
      try {
        const entries = await client.rename(projectId, slug, display_name);
        dispatch({ type: 'MUTATE_OK', entries });
      } catch (err) {
        dispatch({ type: 'MUTATE_FAIL', error: toLauncherStateError(err) });
      }
    },
    [client, projectId],
  );

  const uninstall = useCallback(
    async (slug: string): Promise<void> => {
      if (client === null) return;
      dispatch({ type: 'MUTATE_START' });
      try {
        const entries = await client.uninstall(projectId, slug);
        dispatch({ type: 'MUTATE_OK', entries });
      } catch (err) {
        dispatch({ type: 'MUTATE_FAIL', error: toLauncherStateError(err) });
      }
    },
    [client, projectId],
  );

  const sendBuildMe = useCallback(
    async (prompt: string): Promise<boolean> => {
      if (client === null) return false;
      dispatch({ type: 'BUILD_ME_START' });
      try {
        await client.sendBuildMePrompt({ project_id: projectId, prompt });
        dispatch({ type: 'BUILD_ME_OK' });
        return true;
      } catch (err) {
        dispatch({ type: 'BUILD_ME_FAIL', error: toLauncherStateError(err) });
        return false;
      }
    },
    [client, projectId],
  );

  const dismissError = useCallback(() => {
    dispatch({ type: 'DISMISS_ERROR' });
  }, []);

  const value = useMemo<LauncherStateValue>(
    () => ({
      state,
      entries: state.entries,
      loading: state.loading,
      error: state.error,
      mutating: state.mutating,
      building_me: state.building_me,
      refresh: fetchEntries,
      reorder,
      rename,
      uninstall,
      sendBuildMe,
      dismissError,
    }),
    [state, fetchEntries, reorder, rename, uninstall, sendBuildMe, dismissError],
  );

  return (
    <LauncherStateContext.Provider value={value}>{children}</LauncherStateContext.Provider>
  );
}
