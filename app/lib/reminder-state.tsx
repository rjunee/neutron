/**
 * @neutronai/app — reminder-state Context provider (P5.5).
 *
 * Glues the `RemindersClient` HTTP wrapper, the pure
 * `reminderStateReducer`, and the React tree. Mounted by the
 * reminders-tab route file (`app/app/projects/[id]/reminders.tsx`)
 * and consumed by `<ReminderList>` / `<ReminderRow>` /
 * `<ReminderFilterChips>` / `<ReminderCreateModal>` /
 * `<ReminderEditModal>` via `useReminderState()`.
 *
 * Side effects the provider owns:
 *
 *   1. Fetching `GET /api/app/projects/<id>/reminders?status=pending`
 *      on mount + when `projectId` changes. Filter switches do NOT
 *      re-fetch — bucketing is client-side per brief § 4.2.
 *   2. Re-fetching on `refresh()` (used by the error-banner retry
 *      path + tests).
 *   3. Firing create / snooze / cancel / convertToTask mutations
 *      against the reminders surface. Server-authoritative — every
 *      mutation returns the post-mutation pending list and
 *      `MUTATE_OK` REPLACES local state (no optimistic flip per
 *      brief § 4.9).
 *   4. Disposing in-flight fetches on `projectId` change so a late
 *      response from a previous project tuple can't overwrite the
 *      new project's state. Same `cancelRef` pattern P5.3 + P5.4
 *      established.
 *
 * Test surface: accepts `clientOverride` so unit + integration tests
 * inject a stubbed `RemindersClient` instead of hitting the network.
 * Real builds resolve the bearer via `useAuthSession()` +
 * `loadAppConfig()`.
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
  EMPTY_REMINDER_STATE,
  reminderStateReducer,
  toReminderStateError,
  type ReminderFilterChoice,
  type ReminderState,
  type ReminderStateError,
} from './reminder-state-reducer';
import {
  RemindersClient,
  type ReminderConvertToTaskResult,
  type ReminderItem,
} from './reminders-client';
import { useAuthSession } from './session';

export interface ReminderConvertOutcome {
  ok: boolean;
  task_id?: string;
  linked_reminder_id?: string | null;
}

export interface ReminderStateValue {
  state: ReminderState;
  reminders: ReminderItem[];
  loading: boolean;
  error: ReminderStateError | null;
  mutating: boolean;
  filter: ReminderFilterChoice;
  setFilter(filter: ReminderFilterChoice): void;
  refresh(): Promise<void>;
  create(input: { message: string; fire_at_seconds: number }): Promise<boolean>;
  snooze(reminder_id: string, new_fire_at_seconds: number): Promise<boolean>;
  cancel(reminder_id: string): Promise<boolean>;
  convertToTask(
    reminder_id: string,
    opts?: { title?: string; priority?: number },
  ): Promise<ReminderConvertOutcome>;
  dismissError(): void;
}

const ReminderStateContext = createContext<ReminderStateValue | null>(null);

export function useReminderState(): ReminderStateValue {
  const ctx = useContext(ReminderStateContext);
  if (ctx === null) {
    throw new Error('useReminderState must be used inside <ReminderStateProvider>');
  }
  return ctx;
}

export interface ReminderStateProviderProps extends PropsWithChildren {
  projectId: string;
  /**
   * ISSUE #38 — when set, threaded into the GET list call as
   * `?include_id=<rid>` so the reminder survives the
   * `markFired`-before-push race and stays in the list long enough for
   * the route's highlight + scroll effect to locate it. The reminder
   * push deep-link `resolvePushRoute` emits
   * `/projects/<id>/reminders?reminder_id=<rid>`; the route forwards
   * the value here AND to `<ReminderList>` so the same id drives both
   * the fetch widening AND the visual highlight.
   */
  highlightReminderId?: string | null;
  /**
   * Optional RemindersClient override. Tests inject a stub so the
   * provider is exercisable without a live gateway.
   */
  clientOverride?: RemindersClient;
}

export function ReminderStateProvider({
  projectId,
  highlightReminderId = null,
  clientOverride,
  children,
}: ReminderStateProviderProps) {
  const { user } = useAuthSession();
  const [state, dispatch] = useReducer(reminderStateReducer, EMPTY_REMINDER_STATE);
  const cancelRef = useRef<(() => void) | null>(null);

  const client = useMemo<RemindersClient | null>(() => {
    if (clientOverride !== undefined) return clientOverride;
    if (user === null) return null;
    const cfg = loadAppConfig();
    return new RemindersClient({ base_url: cfg.base_url, token: user.token });
  }, [clientOverride, user]);

  const fetchReminders = useCallback(async (): Promise<void> => {
    if (client === null) return;
    if (typeof projectId !== 'string' || projectId.length === 0) return;
    let cancelled = false;
    cancelRef.current?.();
    cancelRef.current = () => {
      cancelled = true;
    };
    dispatch({ type: 'LOAD_START' });
    try {
      const reminders = await client.list(projectId, {
        include_id: highlightReminderId,
      });
      if (cancelled) return;
      dispatch({ type: 'LOAD_OK', reminders });
    } catch (err) {
      if (cancelled) return;
      dispatch({ type: 'LOAD_FAIL', error: toReminderStateError(err) });
    }
  }, [client, projectId, highlightReminderId]);

  useEffect(() => {
    void fetchReminders();
    return () => {
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, [fetchReminders]);

  // Server-authoritative mutation shape — every mutation route on the
  // app-reminders surface returns the post-mutation pending list.
  // The provider REPLACES state with that list (no optimistic flip
  // per brief § 4.9 — multi-user consistency + post-snooze re-sort
  // make optimistic UI a footgun here).
  const runMutation = useCallback(
    async (
      run: (c: RemindersClient) => Promise<ReminderItem[]>,
    ): Promise<boolean> => {
      if (client === null) return false;
      if (projectId.length === 0) return false;
      dispatch({ type: 'MUTATE_START' });
      try {
        const reminders = await run(client);
        dispatch({ type: 'MUTATE_OK', reminders });
        return true;
      } catch (err) {
        dispatch({ type: 'MUTATE_FAIL', error: toReminderStateError(err) });
        return false;
      }
    },
    [client, projectId],
  );

  const create = useCallback(
    (input: { message: string; fire_at_seconds: number }): Promise<boolean> => {
      return runMutation((c) => c.create(projectId, input.message, input.fire_at_seconds));
    },
    [runMutation, projectId],
  );

  const snooze = useCallback(
    (reminder_id: string, new_fire_at_seconds: number): Promise<boolean> => {
      return runMutation((c) => c.snooze(projectId, reminder_id, new_fire_at_seconds));
    },
    [runMutation, projectId],
  );

  const cancel = useCallback(
    (reminder_id: string): Promise<boolean> => {
      return runMutation((c) => c.cancel(projectId, reminder_id));
    },
    [runMutation, projectId],
  );

  const convertToTask = useCallback(
    async (
      reminder_id: string,
      opts?: { title?: string; priority?: number },
    ): Promise<ReminderConvertOutcome> => {
      if (client === null) return { ok: false };
      if (projectId.length === 0) return { ok: false };
      dispatch({ type: 'MUTATE_START' });
      try {
        const result: ReminderConvertToTaskResult = await client.convertToTask(
          projectId,
          reminder_id,
          opts,
        );
        dispatch({ type: 'MUTATE_OK', reminders: result.reminders });
        return {
          ok: true,
          task_id: result.task_id,
          linked_reminder_id: result.linked_reminder_id,
        };
      } catch (err) {
        dispatch({ type: 'MUTATE_FAIL', error: toReminderStateError(err) });
        return { ok: false };
      }
    },
    [client, projectId],
  );

  const setFilter = useCallback((filter: ReminderFilterChoice) => {
    dispatch({ type: 'SET_FILTER', filter });
  }, []);

  const dismissError = useCallback(() => {
    dispatch({ type: 'DISMISS_ERROR' });
  }, []);

  const value = useMemo<ReminderStateValue>(
    () => ({
      state,
      reminders: state.reminders,
      loading: state.loading,
      error: state.error,
      mutating: state.mutating,
      filter: state.filter,
      setFilter,
      refresh: fetchReminders,
      create,
      snooze,
      cancel,
      convertToTask,
      dismissError,
    }),
    [
      state,
      setFilter,
      fetchReminders,
      create,
      snooze,
      cancel,
      convertToTask,
      dismissError,
    ],
  );

  return (
    <ReminderStateContext.Provider value={value}>
      {children}
    </ReminderStateContext.Provider>
  );
}
