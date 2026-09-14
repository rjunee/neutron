import { describe, expect, it } from 'bun:test';

import { ProjectsClientError } from '../lib/projects-client';
import {
  INITIAL_PROJECTS_REFRESH_STATE,
  projectsRefreshFailed,
  projectsRefreshNotice,
  projectsRefreshSucceeded,
} from '../lib/projects-refresh-state';
import type { Project } from '../lib/projects';

const PROJECT: Project = {
  id: 'alpha',
  name: 'Alpha',
  description: '',
  emoji: 'A',
  last_activity_ms: 1,
  unread_count: 0,
  members: [],
  persona: '',
  privacy_mode: 'private',
  kind: 'solo',
  origin_instance: 'local',
};

function failure(code: string, status: number): ProjectsClientError {
  return new ProjectsClientError({ code, status, message: code });
}

describe('projects refresh outcomes', () => {
  it('a successful response replaces the old list and is fresh', () => {
    const state = projectsRefreshSucceeded([PROJECT]);
    expect(state).toEqual({ kind: 'fresh', projects: [PROJECT] });
  });

  it('an offline refresh deliberately retains a fetched list and labels it saved', () => {
    const fresh = projectsRefreshSucceeded([PROJECT]);
    const state = projectsRefreshFailed(fresh, failure('network', 0));
    expect(state.kind).toBe('cached');
    expect(state.projects).toBe(fresh.projects);
    expect(state.kind === 'cached' && state.notice).toContain('showing saved projects');
  });

  it('a missing bearer is surfaced and is never classified as cached', () => {
    const fresh = projectsRefreshSucceeded([PROJECT]);
    const state = projectsRefreshFailed(fresh, failure('missing_bearer', 401));
    expect(state.kind).toBe('failed');
    expect(state.projects).toBe(fresh.projects);
    expect(state.kind === 'failed' && state.notice).toContain('session was not accepted');
  });

  it('offline without a fetched list is a surfaced failure, not an empty cache', () => {
    const state = projectsRefreshFailed(INITIAL_PROJECTS_REFRESH_STATE, failure('network', 0));
    expect(state.kind).toBe('failed');
    expect(state.projects).toEqual([]);
  });

  it('unknown failures default to surfaced failure', () => {
    const state = projectsRefreshFailed(projectsRefreshSucceeded([PROJECT]), new Error('boom'));
    expect(state.kind).toBe('failed');
    expect(state.kind === 'failed' && state.notice).toContain('Try again');
  });
});

describe('what the rail is told to show', () => {
  // THE WIRE, not the state. Severing the screen's `notice` prop reddens nothing
  // unless the mapping it calls is itself pinned: a distinction no component renders
  // is not a distinction the owner can act on.
  it('says nothing while loading or when the list is fresh', () => {
    expect(projectsRefreshNotice(INITIAL_PROJECTS_REFRESH_STATE)).toBeNull();
    expect(projectsRefreshNotice(projectsRefreshSucceeded([PROJECT]))).toBeNull();
  });

  it('hands the rail a cached notice for a deliberately served cache', () => {
    const cached = projectsRefreshFailed(projectsRefreshSucceeded([PROJECT]), failure('network', 0));
    expect(projectsRefreshNotice(cached)).toEqual({
      kind: 'cached',
      text: cached.kind === 'cached' ? cached.notice : '',
    });
  });

  it('hands the rail a FAILED notice for a missing bearer — a different channel, not a different word', () => {
    const failed = projectsRefreshFailed(
      projectsRefreshSucceeded([PROJECT]),
      failure('missing_bearer', 401),
    );
    const notice = projectsRefreshNotice(failed);
    expect(notice?.kind).toBe('failed');
    // The two outcomes must not be able to arrive at the rail wearing the same badge.
    const cached = projectsRefreshFailed(projectsRefreshSucceeded([PROJECT]), failure('network', 0));
    expect(notice?.kind).not.toBe(projectsRefreshNotice(cached)?.kind);
    expect(notice?.text).not.toBe(projectsRefreshNotice(cached)?.text);
  });
});
