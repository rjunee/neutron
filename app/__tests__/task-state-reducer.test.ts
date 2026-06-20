/**
 * @neutronai/app — task-state reducer unit tests (P5.4).
 *
 * Pure-function coverage of every transition in the tasks lifecycle:
 * load, filter, mutation, dismiss-error, plus the `toTaskStateError`
 * wrapper. Mirrors the launcher-state reducer tests (P5.3) — same
 * shape, plus a new SET_FILTER axis.
 */

import { describe, expect, it } from 'bun:test';

import type { Task } from '../lib/tasks-client';
import {
  EMPTY_TASK_STATE,
  FILTER_CHOICES,
  taskStateReducer,
  toTaskStateError,
  type TaskStateError,
} from '../lib/task-state-reducer';

function task(id: string, status: 'open' | 'done' | 'cancelled' = 'open'): Task {
  return {
    id,
    project_slug: 't',
    project_id: 'p',
    title: `Task ${id}`,
    description: null,
    status,
    priority: null,
    due_date: null,
    owner_persona: null,
    source: null,
    created_at: '2026-05-20T00:00:00Z',
    updated_at: '2026-05-20T00:00:00Z',
    completed_at: null,
    focus_score: null,
  };
}

const NETWORK_ERR: TaskStateError = { code: 'network', message: 'down' };
const OTHER_ERR: TaskStateError = { code: 'forbidden', message: 'no' };

describe('taskStateReducer — LOAD lifecycle', () => {
  it('LOAD_START flips loading on and clears error', () => {
    const next = taskStateReducer(
      { ...EMPTY_TASK_STATE, error: NETWORK_ERR },
      { type: 'LOAD_START' },
    );
    expect(next.loading).toBe(true);
    expect(next.error).toBeNull();
  });

  it('LOAD_OK lands tasks + clears loading + clears error', () => {
    const next = taskStateReducer(
      { ...EMPTY_TASK_STATE, loading: true },
      { type: 'LOAD_OK', tasks: [task('a'), task('b')] },
    );
    expect(next.loading).toBe(false);
    expect(next.tasks).toHaveLength(2);
    expect(next.tasks[0]?.id).toBe('a');
    expect(next.error).toBeNull();
  });

  it('LOAD_FAIL clears loading + lands error + preserves prior tasks', () => {
    const next = taskStateReducer(
      { ...EMPTY_TASK_STATE, loading: true, tasks: [task('keep')] },
      { type: 'LOAD_FAIL', error: NETWORK_ERR },
    );
    expect(next.loading).toBe(false);
    expect(next.error).toEqual(NETWORK_ERR);
    expect(next.tasks).toHaveLength(1);
  });
});

describe('taskStateReducer — SET_FILTER', () => {
  it('flips filter but preserves tasks (provider re-fetch handles the next load)', () => {
    const next = taskStateReducer(
      { ...EMPTY_TASK_STATE, tasks: [task('a'), task('b', 'done')] },
      { type: 'SET_FILTER', filter: 'done' },
    );
    expect(next.filter).toBe('done');
    expect(next.tasks).toHaveLength(2);
  });

  it('preserves loading + mutating + error across the filter flip', () => {
    const next = taskStateReducer(
      { ...EMPTY_TASK_STATE, loading: true, mutating: true, error: OTHER_ERR },
      { type: 'SET_FILTER', filter: 'all' },
    );
    expect(next.filter).toBe('all');
    expect(next.loading).toBe(true);
    expect(next.mutating).toBe(true);
    expect(next.error).toEqual(OTHER_ERR);
  });

  it('exposes the three expected filter choices', () => {
    expect(FILTER_CHOICES.map((c) => c.value)).toEqual(['open', 'done', 'all']);
  });
});

describe('taskStateReducer — MUTATE lifecycle', () => {
  const loaded = {
    ...EMPTY_TASK_STATE,
    tasks: [task('a'), task('b'), task('c')],
  };

  it('MUTATE_START flips mutating on, clears error, preserves tasks', () => {
    const next = taskStateReducer(
      { ...loaded, error: OTHER_ERR },
      { type: 'MUTATE_START' },
    );
    expect(next.mutating).toBe(true);
    expect(next.error).toBeNull();
    expect(next.tasks).toHaveLength(3);
  });

  it('MUTATE_OK replaces tasks with the server response + clears mutating', () => {
    const replaced = [task('a'), task('c', 'done')];
    const next = taskStateReducer(
      { ...loaded, mutating: true },
      { type: 'MUTATE_OK', tasks: replaced },
    );
    expect(next.mutating).toBe(false);
    expect(next.tasks).toEqual(replaced);
    expect(next.error).toBeNull();
  });

  it('MUTATE_FAIL clears mutating + lands error + preserves prior tasks', () => {
    const next = taskStateReducer(
      { ...loaded, mutating: true },
      { type: 'MUTATE_FAIL', error: OTHER_ERR },
    );
    expect(next.mutating).toBe(false);
    expect(next.error).toEqual(OTHER_ERR);
    expect(next.tasks).toHaveLength(3);
  });
});

describe('taskStateReducer — DISMISS_ERROR', () => {
  it('clears error without affecting other fields', () => {
    const next = taskStateReducer(
      {
        ...EMPTY_TASK_STATE,
        tasks: [task('a')],
        error: NETWORK_ERR,
        mutating: true,
        filter: 'done',
      },
      { type: 'DISMISS_ERROR' },
    );
    expect(next.error).toBeNull();
    expect(next.tasks).toHaveLength(1);
    expect(next.mutating).toBe(true);
    expect(next.filter).toBe('done');
  });
});

describe('toTaskStateError', () => {
  it('unwraps a TasksClientError-shaped object via duck-typing', () => {
    const wrapped = toTaskStateError({
      code: 'forbidden',
      message: 'nope',
      status: 403,
    });
    expect(wrapped).toEqual({ code: 'forbidden', message: 'nope' });
  });

  it('falls back to "unknown" for a plain Error', () => {
    const wrapped = toTaskStateError(new Error('boom'));
    expect(wrapped.code).toBe('unknown');
    expect(wrapped.message).toBe('boom');
  });

  it('falls back to "unknown" for a string throw', () => {
    const wrapped = toTaskStateError('weird');
    expect(wrapped.code).toBe('unknown');
    expect(wrapped.message).toBe('weird');
  });

  it('falls back to "unknown" for object without a string message', () => {
    const wrapped = toTaskStateError({ code: 'oops' });
    expect(wrapped.code).toBe('unknown');
  });
});
