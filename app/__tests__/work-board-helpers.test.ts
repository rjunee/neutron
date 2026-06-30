/**
 * @neutronai/app — work-board-helpers unit tests (Work Board Phase 1b).
 *
 * Pure presentation derivations: status cycle, activity overlay (sub-agent vs
 * inline), datestamp, board split, reorder neighbor.
 */

import { describe, expect, it } from 'bun:test';

import {
  activityFor,
  formatCompletedDate,
  nextStatus,
  reorderTarget,
  splitBoard,
  statusLabel,
} from '../lib/work-board-helpers';
import type { WorkBoardItem } from '../lib/work-board-client';

function item(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'w',
    project_slug: 't',
    title: 'Item',
    status: 'upcoming',
    sort_order: 1,
    design_doc_ref: null,
    inline_active: false,
    linked_run_id: null,
    created_at: '',
    updated_at: '',
    completed_at: null,
    ...over,
  };
}

describe('nextStatus', () => {
  it('cycles upcoming → in_progress → done; done stays done', () => {
    expect(nextStatus('upcoming')).toBe('in_progress');
    expect(nextStatus('in_progress')).toBe('done');
    expect(nextStatus('done')).toBe('done');
  });
});

describe('statusLabel', () => {
  it('maps each status to a human label', () => {
    expect(statusLabel('upcoming')).toBe('Upcoming');
    expect(statusLabel('in_progress')).toBe('In progress');
    expect(statusLabel('done')).toBe('Done');
  });
});

describe('activityFor', () => {
  it('is a sub-agent when linked_run_id is set', () => {
    const a = activityFor(item({ linked_run_id: 'run_1', status: 'in_progress' }));
    expect(a?.kind).toBe('subagent');
    expect(a?.glyph).toBe('⑂');
    expect(a?.label).toBe('Sub-agent running');
  });

  it('is inline when inline_active is set', () => {
    const a = activityFor(item({ inline_active: true, status: 'in_progress' }));
    expect(a?.kind).toBe('inline');
    expect(a?.glyph).toBe('›');
    expect(a?.label).toBe('Working inline');
  });

  it('sub-agent wins when both are set', () => {
    expect(activityFor(item({ linked_run_id: 'r', inline_active: true }))?.kind).toBe('subagent');
  });

  it('is null when idle', () => {
    expect(activityFor(item())).toBeNull();
  });
});

describe('formatCompletedDate', () => {
  it('returns the YYYY-MM-DD prefix', () => {
    expect(formatCompletedDate('2026-06-22T10:00:00Z')).toBe('2026-06-22');
  });
  it('returns empty for null/empty', () => {
    expect(formatCompletedDate(null)).toBe('');
    expect(formatCompletedDate('')).toBe('');
  });
});

describe('splitBoard', () => {
  it('splits done from active, preserving order', () => {
    const { active, completed } = splitBoard([
      item({ id: 'a', status: 'in_progress' }),
      item({ id: 'b', status: 'done' }),
      item({ id: 'c', status: 'upcoming' }),
    ]);
    expect(active.map((i) => i.id)).toEqual(['a', 'c']);
    expect(completed.map((i) => i.id)).toEqual(['b']);
  });
});

describe('reorderTarget', () => {
  const active = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];
  it('moving up targets the previous neighbor (before)', () => {
    expect(reorderTarget(active, 1, -1)).toEqual({ before: 'a' });
  });
  it('moving down targets the next neighbor (after)', () => {
    expect(reorderTarget(active, 1, 1)).toEqual({ after: 'c' });
  });
  it('is null at the top edge going up', () => {
    expect(reorderTarget(active, 0, -1)).toBeNull();
  });
  it('is null at the bottom edge going down', () => {
    expect(reorderTarget(active, 2, 1)).toBeNull();
  });
});
