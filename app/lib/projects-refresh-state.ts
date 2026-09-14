import { ProjectsClientError } from './projects-client';
import type { Project } from './projects';

export type ProjectsRefreshState =
  | { kind: 'loading'; projects: readonly Project[] }
  | { kind: 'fresh'; projects: readonly Project[] }
  | { kind: 'cached'; projects: readonly Project[]; notice: string }
  | { kind: 'failed'; projects: readonly Project[]; notice: string };

/**
 * What the rail must SHOW for a refresh outcome, or `null` when there is nothing to
 * say. This lives here, not inline at the call site, because it is the wire between
 * the state and the only component that renders it: an inline ternary in the screen
 * can be severed without a single test going red, and a distinction nothing renders
 * is not a distinction the owner can act on.
 */
export function projectsRefreshNotice(
  state: ProjectsRefreshState,
): { kind: 'cached' | 'failed'; text: string } | null {
  return state.kind === 'cached' || state.kind === 'failed'
    ? { kind: state.kind, text: state.notice }
    : null;
}

export const INITIAL_PROJECTS_REFRESH_STATE: ProjectsRefreshState = {
  kind: 'loading',
  projects: [],
};

export function projectsRefreshSucceeded(
  projects: readonly Project[],
): ProjectsRefreshState {
  return { kind: 'fresh', projects };
}

/**
 * Only a transport failure may deliberately retain a previously fetched list.
 * Server and unknown failures are surfaced as failures, never labelled offline.
 */
export function projectsRefreshFailed(
  previous: ProjectsRefreshState,
  error: unknown,
): ProjectsRefreshState {
  if (
    previous.projects.length > 0 &&
    error instanceof ProjectsClientError &&
    (error.code === 'network' || error.code === 'timeout')
  ) {
    return {
      kind: 'cached',
      projects: previous.projects,
      notice: 'Offline — showing saved projects.',
    };
  }

  const code = error instanceof ProjectsClientError ? error.code : null;
  const notice =
    code === 'missing_bearer' || code === 'unauthorized'
      ? 'Projects could not refresh because your session was not accepted. Sign in again.'
      : 'Projects could not refresh. Try again.';
  return { kind: 'failed', projects: previous.projects, notice };
}
