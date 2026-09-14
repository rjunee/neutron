import { ProjectsClientError } from './projects-client';
import type { Project } from './projects';

export type ProjectsRefreshState =
  | { kind: 'loading'; projects: readonly Project[] }
  | { kind: 'fresh'; projects: readonly Project[] }
  | { kind: 'cached'; projects: readonly Project[]; notice: string }
  | { kind: 'failed'; projects: readonly Project[]; notice: string };

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
