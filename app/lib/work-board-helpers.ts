/**
 * @neutronai/app — WORK BOARD pure presentation helpers (Work Board Phase 1b).
 *
 * Framework-free derivations the row/screen render from. Factored out so the
 * status-dot / activity-glyph / datestamp logic + the reorder neighbor calc are
 * unit-testable without rendering React Native.
 */

import type { WorkBoardItem, WorkBoardStatus } from './work-board-client';

/** The visual treatment of a status dot. Color is mapped in the component. */
export type DotKind = 'upcoming' | 'in_progress' | 'done';

/** The activity overlay for an ACTIVE row, or null when idle. */
export interface Activity {
  /** Glyph rendered next to the dot. */
  glyph: string;
  /** Accessibility label — distinguishes sub-agent vs inline by WORDS, not color. */
  label: string;
  kind: 'subagent' | 'inline';
}

/** Map a status to its dot kind (1:1 today; kept as a seam for future states). */
export function dotKind(status: WorkBoardStatus): DotKind {
  return status;
}

/** Human label for a status (a11y on the advance control). */
export function statusLabel(status: WorkBoardStatus): string {
  if (status === 'in_progress') return 'In progress';
  if (status === 'done') return 'Done';
  return 'Upcoming';
}

/** Cycle a status forward: upcoming → in_progress → done (done stays done). */
export function nextStatus(status: WorkBoardStatus): WorkBoardStatus {
  if (status === 'upcoming') return 'in_progress';
  if (status === 'in_progress') return 'done';
  return 'done';
}

/**
 * The activity overlay for an item, or null when idle. A bound trident run
 * (`linked_run_id`) is a sub-agent (fork `⑂`); an `inline_active` marker is
 * in-topic work (caret `›`). Sub-agent takes precedence if (somehow) both set.
 */
export function activityFor(item: WorkBoardItem): Activity | null {
  if (item.linked_run_id !== null && item.linked_run_id.length > 0) {
    return { glyph: '⑂', label: 'Sub-agent running', kind: 'subagent' };
  }
  if (item.inline_active) {
    return { glyph: '›', label: 'Working inline', kind: 'inline' };
  }
  return null;
}

/** Short `YYYY-MM-DD` datestamp for a completed row; '' when unparseable. */
export function formatCompletedDate(completed_at: string | null): string {
  if (completed_at === null || completed_at.length === 0) return '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(completed_at);
  return m !== null ? (m[1] as string) : completed_at;
}

/** Split a board snapshot into the active lane + the completed history. */
export function splitBoard(items: readonly WorkBoardItem[]): {
  active: WorkBoardItem[];
  completed: WorkBoardItem[];
} {
  const active: WorkBoardItem[] = [];
  const completed: WorkBoardItem[] = [];
  for (const it of items) {
    if (it.status === 'done') completed.push(it);
    else active.push(it);
  }
  return { active, completed };
}

/**
 * The reorder target for moving the active item at `index` by `dir` (-1 up, +1
 * down). Returns `{ before }` / `{ after }` of the neighbor, or null at a lane
 * edge (no-op).
 */
export function reorderTarget(
  active: readonly WorkBoardItem[],
  index: number,
  dir: -1 | 1,
): { before: string } | { after: string } | null {
  const target = index + dir;
  if (target < 0 || target >= active.length) return null;
  const neighbor = active[target];
  if (neighbor === undefined) return null;
  return dir === -1 ? { before: neighbor.id } : { after: neighbor.id };
}
