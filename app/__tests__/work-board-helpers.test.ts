/**
 * @neutronai/app — work-board-helpers unit tests (Work Board Phase 1b; M1 UX
 * redesign row derivations).
 *
 * Pure presentation derivations: status cycle, phase tag / dot / round (bound
 * run progress), retry/play gating, short datestamp, board split, reorder
 * neighbor + drag-drop reorder target.
 */

import { describe, expect, it } from 'bun:test';

import {
  canPlay,
  dragReorderTarget,
  dotState,
  formatCompletedShort,
  isLinkedRunning,
  isRetry,
  nextStatus,
  reorderTarget,
  roundText,
  splitBoard,
  statusLabel,
  stepTag,
} from '../lib/work-board-helpers';
import type { RunProgress, WorkBoardItem } from '../lib/work-board-client';

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

function progress(over: Partial<RunProgress> = {}): RunProgress {
  return {
    run_id: 'r1',
    phase_label: 'building',
    step_label: 'building',
    round: 1,
    started_at: '',
    last_advanced_at: '',
    elapsed_ms: 0,
    stalled: false,
    stalled_ms: null,
    pr: null,
    verdict: null,
    failure_reason: null,
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

describe('stepTag + roundText derive from step_label (M1 redesign)', () => {
  it('building → "Building" tag + round N', () => {
    const rp = progress({ step_label: 'building', round: 2 });
    expect(stepTag(rp)).toEqual({ label: 'Building', colorKey: 'build' });
    expect(roundText(rp)).toBe('round 2');
  });

  it('reviewing → "Reviewing" tag + round N', () => {
    const rp = progress({ step_label: 'reviewing', round: 3 });
    expect(stepTag(rp)).toEqual({ label: 'Reviewing', colorKey: 'review' });
    expect(roundText(rp)).toBe('round 3');
  });

  it('fixing → "Fixing" tag + round N', () => {
    const rp = progress({ step_label: 'fixing', round: 4 });
    expect(stepTag(rp)).toEqual({ label: 'Fixing', colorKey: 'fix' });
    expect(roundText(rp)).toBe('round 4');
  });

  it('merging → "Merging" tag + round N', () => {
    const rp = progress({ step_label: 'merging', round: 5 });
    expect(stepTag(rp)).toEqual({ label: 'Merging', colorKey: 'merge' });
    expect(roundText(rp)).toBe('round 5');
  });

  it('done (terminal) → "Merged" tag, NO round', () => {
    const rp = progress({ step_label: 'done' });
    expect(stepTag(rp)).toEqual({ label: 'Merged', colorKey: 'merge' });
    expect(roundText(rp)).toBeNull();
  });

  it('failed (terminal) → "Failed" tag, NO round', () => {
    const rp = progress({ step_label: 'failed' });
    expect(stepTag(rp)).toEqual({ label: 'Failed', colorKey: 'failed' });
    expect(roundText(rp)).toBeNull();
  });

  it('derives from phase_label when step_label is missing (legacy/rolling-deploy GET)', () => {
    // The HTTP list() path returns raw server rows; a legacy gateway can omit
    // step_label. stepTag must derive from phase_label instead of returning
    // undefined (which the row would treat as non-null → crash). Codex P2.
    const legacy = progress({ phase_label: 'reviewing', round: 2 });
    delete (legacy as { step_label?: unknown }).step_label;
    expect(stepTag(legacy)).toEqual({ label: 'Reviewing', colorKey: 'review' });
    expect(roundText(legacy)).toBe('round 2');
    const legacyMerged = progress({ phase_label: 'merged' });
    delete (legacyMerged as { step_label?: unknown }).step_label;
    expect(stepTag(legacyMerged)).toEqual({ label: 'Merged', colorKey: 'merge' });
    expect(roundText(legacyMerged)).toBeNull();
  });

  it('is null/idle for an unbound item (no run_progress)', () => {
    expect(stepTag(undefined)).toBeNull();
    expect(roundText(undefined)).toBeNull();
  });
});

describe('dotState', () => {
  it('pulses in the phase colour while a run walks building→reviewing→fixing→merging', () => {
    expect(dotState(item({ run_progress: progress({ step_label: 'building' }) }))).toEqual({
      colorKey: 'build',
      pulse: true,
    });
    expect(dotState(item({ run_progress: progress({ step_label: 'reviewing' }) }))).toEqual({
      colorKey: 'review',
      pulse: true,
    });
    expect(dotState(item({ run_progress: progress({ step_label: 'fixing' }) }))).toEqual({
      colorKey: 'fix',
      pulse: true,
    });
    expect(dotState(item({ run_progress: progress({ step_label: 'merging' }) }))).toEqual({
      colorKey: 'merge',
      pulse: true,
    });
  });

  it('is solid (no pulse) on a terminal run', () => {
    expect(dotState(item({ run_progress: progress({ step_label: 'done' }) }))).toEqual({
      colorKey: 'merge',
      pulse: false,
    });
    expect(dotState(item({ run_progress: progress({ step_label: 'failed' }) }))).toEqual({
      colorKey: 'failed',
      pulse: false,
    });
  });

  it('falls back to item.status when there is no run_progress', () => {
    expect(dotState(item({ status: 'done' }))).toEqual({ colorKey: 'merge', pulse: false });
    expect(dotState(item({ status: 'in_progress' }))).toEqual({ colorKey: 'build', pulse: true });
    expect(dotState(item({ status: 'upcoming' }))).toEqual({ colorKey: 'upcoming', pulse: false });
  });
});

describe('isLinkedRunning / canPlay / isRetry', () => {
  it('a plain upcoming card can play (start) and is not a retry', () => {
    const it1 = item();
    expect(canPlay(it1)).toBe(true);
    expect(isRetry(it1)).toBe(false);
  });

  it('a card bound to a live (non-terminal) run cannot play and is linked-running', () => {
    const it1 = item({ linked_run_id: 'r1', run_progress: progress({ step_label: 'building' }) });
    expect(isLinkedRunning(it1)).toBe(true);
    expect(canPlay(it1)).toBe(false);
  });

  it('a card with a failed run_progress retries', () => {
    const it1 = item({ run_progress: progress({ step_label: 'failed', phase_label: 'failed' }) });
    expect(isRetry(it1)).toBe(true);
    expect(canPlay(it1)).toBe(true);
  });

  it('a card with a lingering linked_run_id (no live progress) retries', () => {
    const it1 = item({ linked_run_id: 'r1' });
    expect(isRetry(it1)).toBe(true);
  });

  it('in_progress / done items never show play', () => {
    expect(canPlay(item({ status: 'in_progress' }))).toBe(false);
    expect(canPlay(item({ status: 'done' }))).toBe(false);
  });
});

describe('formatCompletedShort', () => {
  it('renders a month-abbrev + day datestamp', () => {
    expect(formatCompletedShort('2026-07-02T10:00:00Z')).toBe('Jul 2');
    expect(formatCompletedShort('2026-01-09T00:00:00Z')).toBe('Jan 9');
  });
  it('returns empty for null/empty/unparseable', () => {
    expect(formatCompletedShort(null)).toBe('');
    expect(formatCompletedShort('')).toBe('');
    expect(formatCompletedShort('not-a-date')).toBe('');
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

describe('reorderTarget (accessibility-action single-step move)', () => {
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

describe('dragReorderTarget (drag-drop reorder persistence)', () => {
  const active = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' }), item({ id: 'd' })];

  it('dragging DOWN onto a later row places the source AFTER it', () => {
    expect(dragReorderTarget(active, 'a', 'c')).toEqual({ after: 'c' });
  });

  it('dragging UP onto an earlier row places the source BEFORE it', () => {
    expect(dragReorderTarget(active, 'd', 'b')).toEqual({ before: 'b' });
  });

  it('is a no-op dropping onto itself', () => {
    expect(dragReorderTarget(active, 'b', 'b')).toBeNull();
  });

  it('is null when either id is not in the active lane', () => {
    expect(dragReorderTarget(active, 'missing', 'b')).toBeNull();
    expect(dragReorderTarget(active, 'a', 'missing')).toBeNull();
  });
});
