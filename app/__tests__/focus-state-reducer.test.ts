/**
 * @neutronai/app — focus-state reducer unit tests (P5.6).
 *
 * Pure-function coverage of every transition + the `bucketizeSections`
 * helper. Mirrors the P5.4 task-state-reducer + P5.5 reminder-state-
 * reducer tests.
 */

import { describe, expect, it } from 'bun:test';

import type { FocusBucket, FocusItem } from '../lib/focus-client';
import {
  BUCKET_LABELS,
  BUCKET_ORDER,
  bucketizeSections,
  DEFAULT_FOCUS_ORDER,
  EMPTY_FOCUS_STATE,
  focusStateReducer,
  toFocusStateError,
  type FocusStateError,
} from '../lib/focus-state-reducer';

function item(
  id: string,
  bucket: FocusBucket,
  extra: Partial<FocusItem> = {},
): FocusItem {
  return {
    kind: 'task',
    id,
    project_id: 'demo',
    title: `Item ${id}`,
    due_at: null,
    priority: null,
    bucket,
    source: 'tasks',
    origin_source: null,
    focus_score: null,
    ...extra,
  };
}

describe('focusStateReducer', () => {
  it('LOAD_START clears the list + flips loading=true', () => {
    const seeded = focusStateReducer(EMPTY_FOCUS_STATE, {
      type: 'LOAD_OK',
      items: [item('a', 'today')],
      snapshotAt: '2026-05-20T00:00:00Z',
    });
    const next = focusStateReducer(seeded, { type: 'LOAD_START' });
    expect(next.loading).toBe(true);
    expect(next.refreshing).toBe(false);
    expect(next.items).toEqual([]);
    expect(next.sections).toEqual([]);
    expect(next.error).toBeNull();
  });

  it('REFRESH_START preserves the prior list + flips refreshing=true', () => {
    const seeded = focusStateReducer(EMPTY_FOCUS_STATE, {
      type: 'LOAD_OK',
      items: [item('a', 'overdue'), item('b', 'soon')],
      snapshotAt: null,
    });
    const next = focusStateReducer(seeded, { type: 'REFRESH_START' });
    expect(next.refreshing).toBe(true);
    expect(next.loading).toBe(false);
    expect(next.items).toEqual(seeded.items);
    expect(next.sections).toEqual(seeded.sections);
    expect(next.error).toBeNull();
  });

  it('LOAD_OK stores items + derived sections + clears spinners', () => {
    const list = [item('a', 'overdue'), item('b', 'today'), item('c', 'soon')];
    const next = focusStateReducer(
      { ...EMPTY_FOCUS_STATE, loading: true, refreshing: true },
      { type: 'LOAD_OK', items: list, snapshotAt: '2026-05-20T00:00:00Z' },
    );
    expect(next.loading).toBe(false);
    expect(next.refreshing).toBe(false);
    expect(next.items).toEqual(list);
    expect(next.snapshotAt).toBe('2026-05-20T00:00:00Z');
    expect(next.sections).toHaveLength(3);
    expect(next.sections.map((s) => s.bucket)).toEqual([
      'overdue',
      'today',
      'soon',
    ]);
  });

  it('LOAD_OK with empty items yields empty sections', () => {
    const next = focusStateReducer(
      { ...EMPTY_FOCUS_STATE, loading: true },
      { type: 'LOAD_OK', items: [], snapshotAt: null },
    );
    expect(next.sections).toEqual([]);
    expect(next.items).toEqual([]);
    expect(next.loading).toBe(false);
  });

  it('LOAD_OK suppresses empty buckets', () => {
    const list = [item('a', 'today'), item('b', 'soon')];
    const next = focusStateReducer(EMPTY_FOCUS_STATE, {
      type: 'LOAD_OK',
      items: list,
      snapshotAt: null,
    });
    expect(next.sections).toHaveLength(2);
    expect(next.sections.map((s) => s.bucket)).toEqual(['today', 'soon']);
  });

  it('LOAD_FAIL clears spinners + stores error', () => {
    const err: FocusStateError = { code: 'forbidden', message: 'nope' };
    const next = focusStateReducer(
      { ...EMPTY_FOCUS_STATE, loading: true, refreshing: true },
      { type: 'LOAD_FAIL', error: err },
    );
    expect(next.loading).toBe(false);
    expect(next.refreshing).toBe(false);
    expect(next.error).toEqual(err);
  });

  it('DISMISS_ERROR clears error without touching items', () => {
    const seeded = focusStateReducer(
      {
        ...EMPTY_FOCUS_STATE,
        items: [item('a', 'today')],
        sections: bucketizeSections([item('a', 'today')]),
        error: { code: 'x', message: 'y' },
      },
      { type: 'DISMISS_ERROR' },
    );
    expect(seeded.error).toBeNull();
    expect(seeded.items).toHaveLength(1);
    expect(seeded.sections).toHaveLength(1);
  });

  it('REFRESH_START then LOAD_OK replaces items and clears refreshing', () => {
    const seeded = focusStateReducer(EMPTY_FOCUS_STATE, {
      type: 'LOAD_OK',
      items: [item('a', 'today')],
      snapshotAt: null,
    });
    const refreshing = focusStateReducer(seeded, { type: 'REFRESH_START' });
    const fresh = focusStateReducer(refreshing, {
      type: 'LOAD_OK',
      items: [item('b', 'overdue'), item('c', 'today')],
      snapshotAt: null,
    });
    expect(fresh.refreshing).toBe(false);
    expect(fresh.items.map((i) => i.id)).toEqual(['b', 'c']);
    expect(fresh.sections.map((s) => s.bucket)).toEqual(['overdue', 'today']);
  });

  it('unknown action returns the prior state', () => {
    const seeded = focusStateReducer(EMPTY_FOCUS_STATE, {
      type: 'LOAD_OK',
      items: [item('a', 'today')],
      snapshotAt: null,
    });
    const unchanged = focusStateReducer(seeded, {
      // @ts-expect-error — exercising the default branch
      type: 'NOT_A_REAL_ACTION',
    });
    expect(unchanged).toBe(seeded);
  });
});

describe('bucketizeSections', () => {
  it('returns [] for empty input', () => {
    expect(bucketizeSections([])).toEqual([]);
  });

  it('preserves server-canonical order within a bucket', () => {
    const list: FocusItem[] = [
      item('first', 'overdue'),
      item('second', 'soon'),
      item('third', 'overdue'),
    ];
    const sections = bucketizeSections(list);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.bucket).toBe('overdue');
    expect(sections[0]!.items.map((i) => i.id)).toEqual(['first', 'third']);
    expect(sections[1]!.bucket).toBe('soon');
    expect(sections[1]!.items.map((i) => i.id)).toEqual(['second']);
  });

  it('renders buckets in overdue → today → soon order', () => {
    const list: FocusItem[] = [
      item('s', 'soon'),
      item('t', 'today'),
      item('o', 'overdue'),
    ];
    const sections = bucketizeSections(list);
    expect(sections.map((s) => s.bucket)).toEqual(['overdue', 'today', 'soon']);
  });

  it('attaches the locked display label per bucket', () => {
    const sections = bucketizeSections([
      item('a', 'overdue'),
      item('b', 'today'),
      item('c', 'soon'),
    ]);
    for (const s of sections) {
      expect(s.label).toBe(BUCKET_LABELS[s.bucket]);
    }
  });
});

describe('toFocusStateError', () => {
  it('extracts code + message from FocusClientError-shaped throws', () => {
    const e = Object.assign(new Error('forbidden: too cool'), {
      code: 'forbidden',
      status: 403,
    });
    expect(toFocusStateError(e)).toEqual({
      code: 'forbidden',
      message: 'forbidden: too cool',
    });
  });

  it('falls back to unknown for plain Error', () => {
    const e = new Error('boom');
    expect(toFocusStateError(e)).toEqual({ code: 'unknown', message: 'boom' });
  });

  it('falls back to unknown for non-Error throws', () => {
    expect(toFocusStateError('nope')).toEqual({
      code: 'unknown',
      message: 'nope',
    });
  });
});

describe('constants', () => {
  it('BUCKET_ORDER is the server-canonical [overdue, today, soon]', () => {
    expect(BUCKET_ORDER).toEqual(['overdue', 'today', 'soon']);
  });

  it("DEFAULT_FOCUS_ORDER stays 'default' per brief § 4.3", () => {
    expect(DEFAULT_FOCUS_ORDER).toBe('default');
  });
});
