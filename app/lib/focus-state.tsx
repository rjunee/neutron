/**
 * @neutronai/app — focus-state Context provider (P5.6).
 *
 * Glues the `FocusClient` HTTP wrapper, the pure `focusStateReducer`,
 * and the React tree. Mounted by the global focus route file
 * (`app/app/focus.tsx`) and consumed by `<FocusList>` /
 * `<FocusBucketSection>` / `<FocusRow>` / `<FocusHeader>` via
 * `useFocusState()`.
 *
 * Mirrors the P5.4 `<TaskStateProvider>` + P5.5 `<ReminderStateProvider>`
 * shape with the load-only (no-mutation) lifecycle the Focus
 * projection needs:
 *
 *   1. Initial fetch — fires once via `useEffect` on mount; clears
 *      the prior list (LOAD_START → LOAD_OK).
 *   2. Refresh — pull-to-refresh OR manual Refresh button OR the
 *      on-tab-focus auto-refresh hook (`useFocusEffect` from
 *      expo-router) dispatches REFRESH_START → LOAD_OK so the prior
 *      rows stay visible while the spinner plays (brief § 4.9).
 *   3. Disposing in-flight fetches on unmount + on every new fetch so
 *      a late response can't overwrite the new tree's state. Same
 *      `cancelRef` pattern P5.3 + P5.4 + P5.5 established.
 *
 * Test surface: accepts `clientOverride` so unit + integration tests
 * inject a stubbed `FocusClient` instead of hitting the network. Real
 * builds resolve the bearer via `useAuthSession()` + `loadAppConfig()`.
 */

import { useFocusEffect } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';

import { loadAppConfig } from './config';
import {
  FocusClient,
  type CurrentFocusPick,
  type FocusListOptions,
  type FocusOrder,
} from './focus-client';
import {
  bucketizeSections,
  DEFAULT_FOCUS_ORDER,
  EMPTY_FOCUS_STATE,
  focusStateReducer,
  toFocusStateError,
  type BucketSection,
  type FocusState,
  type FocusStateError,
} from './focus-state-reducer';
import { useAuthSession } from './session';
import type { FocusItem } from './focus-client';

export interface FocusStateValue {
  state: FocusState;
  /** Flat server-canonical list (post-cap). */
  items: FocusItem[];
  /** Grouped bucket sections derived once per LOAD_OK. */
  sections: BucketSection[];
  /** True while the initial fetch is in flight (full-screen ActivityIndicator). */
  loading: boolean;
  /** True while a refresh / pull / on-tab-focus refresh is in flight (prior list visible). */
  refreshing: boolean;
  /** Last error from a failed GET. */
  error: FocusStateError | null;
  /** ISO timestamp of the server-side `now` at the last successful load. */
  snapshotAt: string | null;
  /**
   * P6.1 — today's LLM-picked "do this next" task, OR null when there
   * is no pick for today (cron hasn't run, no LLM creds, or the API
   * returned a network error — we fail-soft so the bucket-only view
   * stays usable).
   */
  currentFocus: CurrentFocusPick | null;
  /** Manual Refresh button + pull-to-refresh + on-tab-focus all share this entry point. */
  refresh(): Promise<void>;
  /** Clear the error banner without re-fetching. */
  dismissError(): void;
}

const FocusStateContext = createContext<FocusStateValue | null>(null);

export function useFocusState(): FocusStateValue {
  const ctx = useContext(FocusStateContext);
  if (ctx === null) {
    throw new Error('useFocusState must be used inside <FocusStateProvider>');
  }
  return ctx;
}

export interface FocusStateProviderProps extends PropsWithChildren {
  /**
   * Optional FocusClient override. Tests inject a stub so the provider
   * is exercisable without a live gateway.
   */
  clientOverride?: FocusClient;
  /**
   * Sort opt-in override. Defaults to the brief-locked
   * `DEFAULT_FOCUS_ORDER` (`'default'`) per brief § 4.3 — Focus's
   * value-add is the bucket grouping, not the focus_score. Plumbed for
   * a future P5.7 settings hook that lets per-user preferences flip
   * the lens without a UI re-release.
   */
  order?: FocusOrder;
}

export function FocusStateProvider({
  clientOverride,
  order = DEFAULT_FOCUS_ORDER,
  children,
}: FocusStateProviderProps) {
  const { user } = useAuthSession();
  const [state, dispatch] = useReducer(focusStateReducer, EMPTY_FOCUS_STATE);
  const [currentFocus, setCurrentFocus] = useState<CurrentFocusPick | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  // Mount-vs-refresh distinguisher. The first fetch dispatches
  // LOAD_START (full-screen indicator); every subsequent fetch
  // dispatches REFRESH_START (existing rows stay visible).
  const hasLoadedOnceRef = useRef<boolean>(false);

  const client = useMemo<FocusClient | null>(() => {
    if (clientOverride !== undefined) return clientOverride;
    if (user === null) return null;
    const cfg = loadAppConfig();
    return new FocusClient({ base_url: cfg.base_url, token: user.token });
  }, [clientOverride, user]);

  const fetchCurrentFocus = useCallback(async (): Promise<void> => {
    if (client === null) return;
    // Fail-soft: the hero card is an enhancement, never a blocker. A
    // network error or 5xx leaves the bucket list rendering — we just
    // hide the card by setting null.
    try {
      const pick = await client.getCurrentFocus();
      setCurrentFocus(pick);
    } catch {
      setCurrentFocus(null);
    }
  }, [client]);

  const fetchFocus = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial'): Promise<void> => {
      if (client === null) return;
      let cancelled = false;
      cancelRef.current?.();
      cancelRef.current = () => {
        cancelled = true;
      };
      if (mode === 'refresh' && hasLoadedOnceRef.current) {
        dispatch({ type: 'REFRESH_START' });
      } else {
        dispatch({ type: 'LOAD_START' });
      }
      try {
        // Bucket list + current-focus pick fetched in parallel so the
        // hero card and the buckets land together. A current-focus
        // failure is swallowed inside `fetchCurrentFocus` and never
        // taints the bucket-list outcome.
        const opts: FocusListOptions = { order };
        const [res] = await Promise.all([
          client.list(opts),
          fetchCurrentFocus(),
        ]);
        if (cancelled) return;
        hasLoadedOnceRef.current = true;
        dispatch({
          type: 'LOAD_OK',
          items: res.today,
          snapshotAt: res.now,
        });
      } catch (err) {
        if (cancelled) return;
        dispatch({ type: 'LOAD_FAIL', error: toFocusStateError(err) });
      }
    },
    [client, order, fetchCurrentFocus],
  );

  // Mount-time fetch + cleanup-on-unmount.
  useEffect(() => {
    void fetchFocus('initial');
    return () => {
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, [fetchFocus]);

  // On-tab-focus auto-refresh — preserves the MVP's existing behavior
  // (`focus.tsx:97-105`). Every time the user navigates back to
  // `/focus`, a refresh fires inside the provider; the existing rows
  // stay visible while the new list loads.
  //
  // The hook is called unconditionally to satisfy React's rules-of-
  // hooks; if `client` is null (no session yet) the callback no-ops.
  useFocusEffect(
    useCallback(() => {
      if (client === null) return undefined;
      // Skip the very first focus event — the mount-time `useEffect`
      // above already issued an initial fetch. After that, every
      // re-focus refreshes.
      if (hasLoadedOnceRef.current) {
        void fetchFocus('refresh');
      }
      return undefined;
    }, [client, fetchFocus]),
  );

  const refresh = useCallback(async (): Promise<void> => {
    await fetchFocus('refresh');
  }, [fetchFocus]);

  const dismissError = useCallback(() => {
    dispatch({ type: 'DISMISS_ERROR' });
  }, []);

  const value = useMemo<FocusStateValue>(
    () => ({
      state,
      items: state.items,
      sections: state.sections,
      loading: state.loading,
      refreshing: state.refreshing,
      error: state.error,
      snapshotAt: state.snapshotAt,
      currentFocus,
      refresh,
      dismissError,
    }),
    [state, currentFocus, refresh, dismissError],
  );

  return (
    <FocusStateContext.Provider value={value}>
      {children}
    </FocusStateContext.Provider>
  );
}

// Re-export the bucketizer + section type for callers that need to
// derive sections outside the provider (testing helpers, future
// agent-readable surfaces).
export { bucketizeSections } from './focus-state-reducer';
export type { BucketSection } from './focus-state-reducer';
