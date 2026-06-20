/**
 * @neutronai/app — task-state Context provider (P5.4).
 *
 * Glues the `TasksClient` HTTP wrapper, the pure `taskStateReducer`,
 * and the React tree. Mounted by the tasks-tab route file
 * (`app/app/projects/[id]/tasks.tsx`) and consumed by `<TaskList>` /
 * `<TaskRow>` / `<TaskFilterChips>` / `<TaskCreateModal>` /
 * `<TaskEditModal>` via `useTaskState()`.
 *
 * Side effects the provider owns:
 *
 *   1. Fetching `GET /api/app/projects/<id>/tasks` on mount + when
 *      `projectId` or `filter` changes. Uses the P5.4-locked default
 *      `?order=focus_score` so the P6 focus_score column is
 *      user-visible on every render (brief § 4.2).
 *   2. Re-fetching on `refresh()` (used by the error-banner retry
 *      path + tests).
 *   3. Firing create / update / complete / cancel / delete mutations
 *      against the tasks surface. Server-authoritative — every
 *      mutation re-fetches the filtered list and `MUTATE_OK`
 *      REPLACES tasks (no optimistic flip per brief § 4.9).
 *   4. The `toggleDone(task)` convenience — open→complete /
 *      done→update({status: 'open'}) / cancelled→no-op. Surfaced as
 *      a single typed call so `<TaskRow>`'s checkbox handler stays
 *      one line.
 *   5. Disposing in-flight fetches on `projectId` / `filter` change
 *      so a late response from a previous tuple can't overwrite the
 *      new tuple's state. Same `cancelRef` pattern P5.3 established.
 *
 * Test surface: accepts `clientOverride` so unit + integration
 * tests inject a stubbed `TasksClient` instead of hitting the
 * network. Real builds resolve the bearer via `useAuthSession()` +
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
import { useAuthSession } from './session';
import {
  EMPTY_TASK_STATE,
  taskStateReducer,
  toTaskStateError,
  type FilterChoice,
  type TaskState,
  type TaskStateError,
} from './task-state-reducer';
import {
  TasksClient,
  type CreateTaskInput,
  type Task,
  type TaskOrder,
  type TaskStatusFilter,
  type UpdateTaskInput,
} from './tasks-client';

/**
 * Locked default sort for the tasks tab per brief § 4.2 — surfaces
 * the P6 focus_score column without requiring a UI gesture. A future
 * sprint can flip this via the task-styles preset (P5.7).
 */
const DEFAULT_ORDER: TaskOrder = 'focus_score';

export interface TaskStateValue {
  state: TaskState;
  tasks: Task[];
  loading: boolean;
  error: TaskStateError | null;
  mutating: boolean;
  filter: FilterChoice;
  setFilter(filter: FilterChoice): void;
  refresh(): Promise<void>;
  create(input: CreateTaskInput): Promise<boolean>;
  update(task_id: string, patch: UpdateTaskInput): Promise<boolean>;
  complete(task_id: string): Promise<boolean>;
  cancel(task_id: string): Promise<boolean>;
  delete(task_id: string): Promise<boolean>;
  toggleDone(task: Task): Promise<boolean>;
  dismissError(): void;
}

const TaskStateContext = createContext<TaskStateValue | null>(null);

export function useTaskState(): TaskStateValue {
  const ctx = useContext(TaskStateContext);
  if (ctx === null) {
    throw new Error('useTaskState must be used inside <TaskStateProvider>');
  }
  return ctx;
}

export interface TaskStateProviderProps extends PropsWithChildren {
  projectId: string;
  /**
   * Optional TasksClient override. Tests inject a stub so the
   * provider is exercisable without a live gateway.
   */
  clientOverride?: TasksClient;
}

export function TaskStateProvider({
  projectId,
  clientOverride,
  children,
}: TaskStateProviderProps) {
  const { user } = useAuthSession();
  const [state, dispatch] = useReducer(taskStateReducer, EMPTY_TASK_STATE);
  const cancelRef = useRef<(() => void) | null>(null);

  const client = useMemo<TasksClient | null>(() => {
    if (clientOverride !== undefined) return clientOverride;
    if (user === null) return null;
    const cfg = loadAppConfig();
    return new TasksClient({ base_url: cfg.base_url, token: user.token });
  }, [clientOverride, user]);

  const fetchTasks = useCallback(async (): Promise<void> => {
    if (client === null) return;
    if (typeof projectId !== 'string' || projectId.length === 0) return;
    let cancelled = false;
    cancelRef.current?.();
    cancelRef.current = () => {
      cancelled = true;
    };
    dispatch({ type: 'LOAD_START' });
    try {
      const tasks = await client.list(
        projectId,
        state.filter as TaskStatusFilter,
        DEFAULT_ORDER,
      );
      if (cancelled) return;
      dispatch({ type: 'LOAD_OK', tasks });
    } catch (err) {
      if (cancelled) return;
      dispatch({ type: 'LOAD_FAIL', error: toTaskStateError(err) });
    }
  }, [client, projectId, state.filter]);

  useEffect(() => {
    void fetchTasks();
    return () => {
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, [fetchTasks]);

  // Server-authoritative mutation shape — every action `await`s the
  // single-row response (so the gateway has committed) then refires
  // the filtered list so the row's new sort position + the rest of
  // the filter-set is canonical. Cheap (< 500 rows in the realistic
  // envelope; gateway in-process at P5.4) and dodges the
  // optimistic-divergence footgun (§ 4.9).
  const runMutation = useCallback(
    async (run: (c: TasksClient) => Promise<unknown>): Promise<boolean> => {
      if (client === null) return false;
      if (projectId.length === 0) return false;
      dispatch({ type: 'MUTATE_START' });
      try {
        await run(client);
        const tasks = await client.list(
          projectId,
          state.filter as TaskStatusFilter,
          DEFAULT_ORDER,
        );
        dispatch({ type: 'MUTATE_OK', tasks });
        return true;
      } catch (err) {
        dispatch({ type: 'MUTATE_FAIL', error: toTaskStateError(err) });
        return false;
      }
    },
    [client, projectId, state.filter],
  );

  const create = useCallback(
    (input: CreateTaskInput): Promise<boolean> => {
      return runMutation((c) => c.create(projectId, input));
    },
    [runMutation, projectId],
  );

  const update = useCallback(
    (task_id: string, patch: UpdateTaskInput): Promise<boolean> => {
      return runMutation((c) => c.update(projectId, task_id, patch));
    },
    [runMutation, projectId],
  );

  const complete = useCallback(
    (task_id: string): Promise<boolean> => {
      return runMutation((c) => c.complete(projectId, task_id));
    },
    [runMutation, projectId],
  );

  const cancel = useCallback(
    (task_id: string): Promise<boolean> => {
      return runMutation((c) => c.cancel(projectId, task_id));
    },
    [runMutation, projectId],
  );

  const del = useCallback(
    (task_id: string): Promise<boolean> => {
      return runMutation((c) => c.delete(projectId, task_id));
    },
    [runMutation, projectId],
  );

  const toggleDone = useCallback(
    async (task: Task): Promise<boolean> => {
      if (task.status === 'cancelled') return false;
      if (task.status === 'open') {
        return runMutation((c) => c.complete(projectId, task.id));
      }
      return runMutation((c) => c.update(projectId, task.id, { status: 'open' }));
    },
    [runMutation, projectId],
  );

  const setFilter = useCallback((filter: FilterChoice) => {
    dispatch({ type: 'SET_FILTER', filter });
  }, []);

  const dismissError = useCallback(() => {
    dispatch({ type: 'DISMISS_ERROR' });
  }, []);

  const value = useMemo<TaskStateValue>(
    () => ({
      state,
      tasks: state.tasks,
      loading: state.loading,
      error: state.error,
      mutating: state.mutating,
      filter: state.filter,
      setFilter,
      refresh: fetchTasks,
      create,
      update,
      complete,
      cancel,
      delete: del,
      toggleDone,
      dismissError,
    }),
    [
      state,
      setFilter,
      fetchTasks,
      create,
      update,
      complete,
      cancel,
      del,
      toggleDone,
      dismissError,
    ],
  );

  return (
    <TaskStateContext.Provider value={value}>{children}</TaskStateContext.Provider>
  );
}
