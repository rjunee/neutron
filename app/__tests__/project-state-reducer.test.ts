/**
 * @neutronai/app — project-state reducer unit tests (P5.2).
 *
 * Pure-function coverage of the project-settings lifecycle: load,
 * load-fail, optimistic privacy patch, server reconcile, and revert.
 */

import { describe, expect, it } from 'bun:test';

import {
  EMPTY_PROJECT_STATE,
  projectStateReducer,
  type ProjectStateError,
} from '../lib/project-state-reducer';
import type { ProjectSettings } from '../lib/projects-client';

function makeProject(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    id: 'neutron',
    name: 'Neutron',
    description: 'Build Neutron itself',
    persona: 'Forge — pragmatic build agent',
    privacy_mode: 'private',
    billing_mode: 'personal',
    members: [{ user_id: 'sam', name: 'Sam', role: 'owner' }],
    ...overrides,
  };
}

const NETWORK_ERR: ProjectStateError = { code: 'network', message: 'timed out' };

describe('projectStateReducer', () => {
  it('LOAD_START flips loading on + clears error', () => {
    const next = projectStateReducer(
      { ...EMPTY_PROJECT_STATE, error: NETWORK_ERR },
      { type: 'LOAD_START' },
    );
    expect(next.loading).toBe(true);
    expect(next.error).toBeNull();
  });

  it('LOAD_OK assigns the project + clears loading/error/pending', () => {
    const project = makeProject();
    const next = projectStateReducer(
      { ...EMPTY_PROJECT_STATE, loading: true, pending_privacy: 'public' },
      { type: 'LOAD_OK', project },
    );
    expect(next.loading).toBe(false);
    expect(next.project).toEqual(project);
    expect(next.error).toBeNull();
    expect(next.pending_privacy).toBeNull();
  });

  it('LOAD_FAIL drops the project + records the error', () => {
    const next = projectStateReducer(
      { ...EMPTY_PROJECT_STATE, project: makeProject() },
      { type: 'LOAD_FAIL', error: NETWORK_ERR },
    );
    expect(next.loading).toBe(false);
    expect(next.project).toBeNull();
    expect(next.error).toEqual(NETWORK_ERR);
  });

  it('PATCH_PRIVACY_OPTIMISTIC flips the local mode + marks pending', () => {
    const project = makeProject({ privacy_mode: 'private' });
    const next = projectStateReducer(
      { ...EMPTY_PROJECT_STATE, project },
      { type: 'PATCH_PRIVACY_OPTIMISTIC', new_mode: 'public' },
    );
    expect(next.project?.privacy_mode).toBe('public');
    expect(next.pending_privacy).toBe('public');
    expect(next.error).toBeNull();
  });

  it('PATCH_PRIVACY_OPTIMISTIC is a no-op when no project has loaded', () => {
    const next = projectStateReducer(EMPTY_PROJECT_STATE, {
      type: 'PATCH_PRIVACY_OPTIMISTIC',
      new_mode: 'public',
    });
    expect(next.project).toBeNull();
    expect(next.pending_privacy).toBeNull();
  });

  it('PATCH_PRIVACY_OK reconciles to the server view', () => {
    const localPending = makeProject({ privacy_mode: 'public' });
    const serverProject = makeProject({ privacy_mode: 'public', description: 'updated' });
    const next = projectStateReducer(
      { ...EMPTY_PROJECT_STATE, project: localPending, pending_privacy: 'public' },
      { type: 'PATCH_PRIVACY_OK', project: serverProject },
    );
    expect(next.project).toEqual(serverProject);
    expect(next.pending_privacy).toBeNull();
    expect(next.error).toBeNull();
  });

  it('PATCH_PRIVACY_FAIL reverts the local privacy_mode + records the error', () => {
    const optimistic = makeProject({ privacy_mode: 'public' });
    const err: ProjectStateError = { code: 'unauthorized', message: 'bad token' };
    const next = projectStateReducer(
      { ...EMPTY_PROJECT_STATE, project: optimistic, pending_privacy: 'public' },
      { type: 'PATCH_PRIVACY_FAIL', error: err, prior_mode: 'private' },
    );
    expect(next.project?.privacy_mode).toBe('private');
    expect(next.pending_privacy).toBeNull();
    expect(next.error).toEqual(err);
  });
});
