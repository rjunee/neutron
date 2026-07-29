/**
 * @neutronai/app — launcher-state reducer unit tests (P5.3).
 *
 * Pure-function coverage of every transition in the launcher
 * lifecycle: load, mutation, build-me, dismiss-error, plus the
 * `toLauncherStateError` wrapper.
 */

import { describe, expect, it } from 'bun:test';

import type { LauncherEntry } from '../lib/launcher-client';
import {
  EMPTY_LAUNCHER_STATE,
  launcherStateReducer,
  toLauncherStateError,
  type LauncherStateError,
} from '../lib/launcher-state-reducer';

function entry(slug: string, idx: number): LauncherEntry {
  return {
    slug,
    display_name: slug,
    launcher_icon: { kind: 'emoji', value: '🧩' },
    reorder_index: idx,
  };
}

const NETWORK_ERR: LauncherStateError = { code: 'network', message: 'down' };
const OTHER_ERR: LauncherStateError = { code: 'forbidden', message: 'no' };

describe('launcherStateReducer — LOAD lifecycle', () => {
  it('LOAD_START flips loading on and clears error', () => {
    const next = launcherStateReducer(
      { ...EMPTY_LAUNCHER_STATE, error: NETWORK_ERR },
      { type: 'LOAD_START' },
    );
    expect(next.loading).toBe(true);
    expect(next.error).toBeNull();
  });

  it('LOAD_OK lands entries + clears loading + clears error', () => {
    const next = launcherStateReducer(
      { ...EMPTY_LAUNCHER_STATE, loading: true },
      { type: 'LOAD_OK', entries: [entry('notes', 0), entry('tasks_core', 1)] },
    );
    expect(next.loading).toBe(false);
    expect(next.entries).toHaveLength(2);
    expect(next.entries[0]?.slug).toBe('notes');
    expect(next.error).toBeNull();
  });

  it('LOAD_FAIL clears loading + lands error', () => {
    const next = launcherStateReducer(
      { ...EMPTY_LAUNCHER_STATE, loading: true },
      { type: 'LOAD_FAIL', error: NETWORK_ERR },
    );
    expect(next.loading).toBe(false);
    expect(next.error).toEqual(NETWORK_ERR);
  });
});

describe('launcherStateReducer — MUTATE lifecycle', () => {
  const loaded = {
    ...EMPTY_LAUNCHER_STATE,
    entries: [entry('a', 0), entry('b', 1), entry('c', 2)],
  };

  it('MUTATE_START flips mutating on, clears error, preserves entries', () => {
    const next = launcherStateReducer(
      { ...loaded, error: OTHER_ERR },
      { type: 'MUTATE_START' },
    );
    expect(next.mutating).toBe(true);
    expect(next.error).toBeNull();
    expect(next.entries).toHaveLength(3);
  });

  it('MUTATE_OK replaces entries with the server response + clears mutating', () => {
    const replaced = [entry('b', 0), entry('a', 1), entry('c', 2)];
    const next = launcherStateReducer(
      { ...loaded, mutating: true },
      { type: 'MUTATE_OK', entries: replaced },
    );
    expect(next.mutating).toBe(false);
    expect(next.entries).toEqual(replaced);
    expect(next.error).toBeNull();
  });

  it('MUTATE_FAIL clears mutating + lands error + preserves prior entries', () => {
    const next = launcherStateReducer(
      { ...loaded, mutating: true },
      { type: 'MUTATE_FAIL', error: OTHER_ERR },
    );
    expect(next.mutating).toBe(false);
    expect(next.error).toEqual(OTHER_ERR);
    expect(next.entries).toHaveLength(3);
  });
});

describe('launcherStateReducer — BUILD_ME lifecycle', () => {
  it('BUILD_ME_START flips building_me on + clears error', () => {
    const next = launcherStateReducer(
      { ...EMPTY_LAUNCHER_STATE, error: OTHER_ERR },
      { type: 'BUILD_ME_START' },
    );
    expect(next.building_me).toBe(true);
    expect(next.error).toBeNull();
  });

  it('BUILD_ME_OK clears building_me without touching entries', () => {
    const next = launcherStateReducer(
      { ...EMPTY_LAUNCHER_STATE, building_me: true, entries: [entry('x', 0)] },
      { type: 'BUILD_ME_OK' },
    );
    expect(next.building_me).toBe(false);
    expect(next.entries).toHaveLength(1);
  });

  it('BUILD_ME_FAIL clears building_me + lands error', () => {
    const next = launcherStateReducer(
      { ...EMPTY_LAUNCHER_STATE, building_me: true },
      { type: 'BUILD_ME_FAIL', error: NETWORK_ERR },
    );
    expect(next.building_me).toBe(false);
    expect(next.error).toEqual(NETWORK_ERR);
  });
});

describe('launcherStateReducer — DISMISS_ERROR', () => {
  it('clears error without affecting other fields', () => {
    const next = launcherStateReducer(
      {
        ...EMPTY_LAUNCHER_STATE,
        entries: [entry('a', 0)],
        error: NETWORK_ERR,
        mutating: true,
      },
      { type: 'DISMISS_ERROR' },
    );
    expect(next.error).toBeNull();
    expect(next.entries).toHaveLength(1);
    expect(next.mutating).toBe(true);
  });
});

describe('toLauncherStateError', () => {
  it('unwraps a LauncherClientError-shaped object via duck-typing', () => {
    const wrapped = toLauncherStateError({
      code: 'forbidden',
      message: 'nope',
      status: 403,
    });
    expect(wrapped).toEqual({ code: 'forbidden', message: 'nope' });
  });

  it('falls back to "unknown" for a plain Error', () => {
    const wrapped = toLauncherStateError(new Error('boom'));
    expect(wrapped.code).toBe('unknown');
    expect(wrapped.message).toBe('boom');
  });

  it('falls back to "unknown" for a string throw', () => {
    const wrapped = toLauncherStateError('weird');
    expect(wrapped.code).toBe('unknown');
    expect(wrapped.message).toBe('weird');
  });
});
