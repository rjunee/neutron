import { ProjectsClientError } from './projects-client';
import type { Project } from './projects';

export type ProjectsRefreshState =
  | { kind: 'loading'; projects: readonly Project[] }
  | { kind: 'fresh'; projects: readonly Project[] }
  | { kind: 'cached'; projects: readonly Project[]; notice: string; label: string }
  | { kind: 'failed'; projects: readonly Project[]; notice: string; label: string };

/**
 * THE RAIL IS 72 POINTS WIDE (`app/components/ProjectRail.tsx`, `RAIL_WIDTH`), and at
 * the caption size that is about eleven characters per line. A sentence rendered there
 * becomes a tower of two-letter lines that pushes the project list off the screen — so
 * the strip gets a LABEL and the screen reader gets the sentence. Anything longer than
 * this is not a notice, it is a wall.
 */
export const MAX_RAIL_LABEL_CHARS = 11;

/**
 * What the rail must SHOW for a refresh outcome, or `null` when there is nothing to
 * say. This lives here, not inline at the call site, because it is the wire between
 * the state and the only component that renders it: an inline ternary in the screen
 * can be severed without a single test going red, and a distinction nothing renders
 * is not a distinction the owner can act on.
 */
export function projectsRefreshNotice(
  state: ProjectsRefreshState,
): { kind: 'cached' | 'failed'; label: string; text: string } | null {
  return state.kind === 'cached' || state.kind === 'failed'
    ? { kind: state.kind, label: state.label, text: state.notice }
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
      label: 'Offline',
      notice: 'Offline — showing saved projects.',
    };
  }

  const code = error instanceof ProjectsClientError ? error.code : null;
  const rejected = code === 'missing_bearer' || code === 'unauthorized';
  const notice = rejected
    ? 'Projects could not refresh because your session was not accepted. Sign in again.'
    : 'Projects could not refresh. Try again.';
  // A rejected session and an unreachable server need DIFFERENT remedies, so they get
  // different words in the strip too, not one shared "failed".
  return {
    kind: 'failed',
    projects: previous.projects,
    label: rejected ? 'Sign in' : 'No refresh',
    notice,
  };
}
