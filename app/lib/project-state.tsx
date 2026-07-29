/**
 * @neutronai/app — project-state Context provider (P5.2).
 *
 * Glues the `ProjectsClient` HTTP wrapper, the pure
 * `projectStateReducer`, and the React tree. Mounted once at
 * `app/app/projects/[id]/_layout.tsx` per project; child surfaces
 * (`<ProjectHeader>`, `<ProjectSettingsDrawer>`, and any future tab
 * body that reads project metadata) consume the state via
 * `useProjectState()`.
 *
 * The provider owns four side effects:
 *   1. Fetching GET `/api/app/projects/<id>/settings` on mount + when
 *      `project_id` changes.
 *   2. Re-fetching on `refresh()` (used by tests + the drawer's
 *      revert-on-failure flow when stale state needs to be reconciled).
 *   3. Firing PATCH `/api/app/projects/<id>/settings` for privacy_mode
 *      changes with optimistic flip + revert-on-failure.
 *   4. Disposing of in-flight fetches on `project_id` change to avoid
 *      late responses overwriting newer state.
 *
 * Test surface: `<ProjectStateProvider>` accepts `clientOverride` so
 * unit + integration tests inject a stubbed `ProjectsClient` instead
 * of hitting the network. Real builds resolve via `loadAppConfig()` +
 * the bearer token from `useAuthSession()`.
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
  EMPTY_PROJECT_STATE,
  projectStateReducer,
  type ProjectState,
  type ProjectStateError,
} from './project-state-reducer';
import {
  ProjectsClient,
  ProjectsClientError,
  type InviteGenerateResult,
  type PrivacyMode,
  type ProjectSettings,
} from './projects-client';
import { useAuthSession } from './session';

interface ProjectStateValue {
  state: ProjectState;
  project: ProjectSettings | null;
  loading: boolean;
  error: ProjectStateError | null;
  pending_privacy: PrivacyMode | null;
  refresh(): Promise<void>;
  updatePrivacy(mode: PrivacyMode): Promise<void>;
  /**
   * Mint a single-use invite link for this project bound to
   * `invitee_email` (M2.4). Resolves with the link + expiry; rejects
   * (throwing the underlying `ProjectsClientError`) so the modal can
   * render the precise failure reason.
   */
  generateInvite(invitee_email: string): Promise<InviteGenerateResult>;
}

const ProjectStateContext = createContext<ProjectStateValue | null>(null);

export function useProjectState(): ProjectStateValue {
  const ctx = useContext(ProjectStateContext);
  if (ctx === null) {
    throw new Error('useProjectState must be used inside <ProjectStateProvider>');
  }
  return ctx;
}

export interface ProjectStateProviderProps extends PropsWithChildren {
  project_id: string;
  /**
   * Optional ProjectsClient override. Tests + Storybook fixtures inject
   * a stub so the surface is fully exercisable without a real fetch.
   */
  clientOverride?: ProjectsClient;
}

export function ProjectStateProvider({
  project_id,
  clientOverride,
  children,
}: ProjectStateProviderProps) {
  const { user } = useAuthSession();
  const [state, dispatch] = useReducer(projectStateReducer, EMPTY_PROJECT_STATE);
  const cancelRef = useRef<(() => void) | null>(null);

  const client = useMemo<ProjectsClient | null>(() => {
    if (clientOverride !== undefined) return clientOverride;
    if (user === null) return null;
    const cfg = loadAppConfig();
    return new ProjectsClient({ base_url: cfg.gateway_base_url, token: user.token });
  }, [clientOverride, user]);

  const fetchSettings = useCallback(async (): Promise<void> => {
    if (client === null) return;
    if (typeof project_id !== 'string' || project_id.length === 0) return;
    let cancelled = false;
    cancelRef.current?.();
    cancelRef.current = () => {
      cancelled = true;
    };
    dispatch({ type: 'LOAD_START' });
    try {
      const project = await client.getSettings(project_id);
      if (cancelled) return;
      dispatch({ type: 'LOAD_OK', project });
    } catch (err) {
      if (cancelled) return;
      dispatch({ type: 'LOAD_FAIL', error: toStateError(err) });
    }
  }, [client, project_id]);

  useEffect(() => {
    void fetchSettings();
    return () => {
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, [fetchSettings]);

  const updatePrivacy = useCallback(
    async (mode: PrivacyMode): Promise<void> => {
      if (client === null) return;
      const prior = state.project?.privacy_mode ?? null;
      if (prior === null) return;
      if (mode === prior) return;
      dispatch({ type: 'PATCH_PRIVACY_OPTIMISTIC', new_mode: mode });
      try {
        const next = await client.patchPrivacy(project_id, mode);
        dispatch({ type: 'PATCH_PRIVACY_OK', project: next });
      } catch (err) {
        dispatch({
          type: 'PATCH_PRIVACY_FAIL',
          error: toStateError(err),
          prior_mode: prior,
        });
      }
    },
    [client, project_id, state.project?.privacy_mode],
  );

  const generateInvite = useCallback(
    async (invitee_email: string): Promise<InviteGenerateResult> => {
      if (client === null) {
        throw new ProjectsClientError({
          code: 'no_client',
          message: 'not signed in',
          status: 0,
        });
      }
      return client.generateInvite(project_id, invitee_email);
    },
    [client, project_id],
  );

  const value = useMemo<ProjectStateValue>(
    () => ({
      state,
      project: state.project,
      loading: state.loading,
      error: state.error,
      pending_privacy: state.pending_privacy,
      refresh: fetchSettings,
      updatePrivacy,
      generateInvite,
    }),
    [state, fetchSettings, updatePrivacy, generateInvite],
  );

  return <ProjectStateContext.Provider value={value}>{children}</ProjectStateContext.Provider>;
}

function toStateError(err: unknown): ProjectStateError {
  if (err instanceof ProjectsClientError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.field !== null ? { field: err.field } : {}),
    };
  }
  if (err instanceof Error) {
    return { code: 'unknown', message: err.message };
  }
  return { code: 'unknown', message: 'unknown error' };
}
