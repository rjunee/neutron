/**
 * @neutronai/app — pure formatters for the global Focus row (P5.6).
 *
 * Extracted from the exploratory MVP route (`app/app/focus.tsx`'s
 * `renderMeta` + `formatDue` + `dotStyle`) so they remain importable
 * from `bun-test` without pulling in `react-native` (which throws at
 * module-load under the bun-test runtime). Same shape as
 * `lib/task-row-formatters.ts` P5.4 established.
 *
 *   - `formatDueRelative(iso, now_ms)` — `in 2h` / `tomorrow` / `5h overdue`
 *     style relative-time string. Null `iso` → `''` (chip not rendered).
 *   - `kindChipLabel(item)`     — `Task` / `Reminder`.
 *   - `projectChipLabel(item)`  — `item.project_id` or the owner-level
 *     label for owner-level rows. Truncated to `PROJECT_CHIP_MAX_CHARS`.
 *   - `bucketDotColor(bucket)`  — `THEME.danger` / `THEME.warning` /
 *     `THEME.text_muted`. No green for `soon` (brief § 4.6).
 *   - `priorityChipKind(prio)`  — `'p0'`..`'p3'` discriminator the row
 *     uses to pick chip colors; null when the chip shouldn't render.
 *   - `dueChipKind(bucket)`     — `'overdue'` / `'today'` / `'soon'`
 *     discriminator for the due-chip color ramp.
 */

import type { FocusBucket, FocusItem } from './focus-client';
import { THEME } from './theme';

/**
 * Per brief § 4.4 — project chip text truncates to ~16 chars so long
 * project_ids don't stretch the row. The chip's max-width does the
 * visual work; this is the secondary safety net for the underlying
 * label string.
 */
export const PROJECT_CHIP_MAX_CHARS = 16;

/** Owner-level project chip label rendered when `project_id === ''`. */
export const INSTANCE_CHIP_LABEL = 'Instance';

/** Discriminator returned by `priorityChipKind`; null when the chip isn't rendered. */
export type PriorityChipKind = 'p0' | 'p1' | 'p2' | 'p3' | null;

/** Discriminator returned by `dueChipKind` — same shape as the bucket id. */
export type DueChipKind = 'overdue' | 'today' | 'soon';

/**
 * Format a due/fire ISO timestamp as a short relative-time string.
 *
 *   - Negative diff → `Xm overdue` / `Xh overdue` / `Xd overdue`.
 *   - Positive diff → `due in Xm` / `due in Xh` / `due in Xd`.
 *   - Null / empty   → empty string (caller skips chip rendering).
 *
 * Pure — `now_ms` is injected so tests can freeze time.
 */
export function formatDueRelative(
  iso: string | null,
  now_ms: number = Date.now(),
): string {
  if (iso === null || iso.length === 0) return '';
  const due_ms = Date.parse(iso);
  if (Number.isNaN(due_ms)) return '';
  const diffMs = due_ms - now_ms;
  const absMin = Math.round(Math.abs(diffMs) / (60 * 1000));
  if (diffMs <= 0) {
    if (absMin < 60) return `${absMin}m overdue`;
    const h = Math.round(absMin / 60);
    if (h < 24) return `${h}h overdue`;
    const d = Math.round(h / 24);
    return `${d}d overdue`;
  }
  if (absMin < 60) return `due in ${absMin}m`;
  const h = Math.round(absMin / 60);
  if (h < 24) return `due in ${h}h`;
  const d = Math.round(h / 24);
  return `due in ${d}d`;
}

/** Display label for the Kind chip on the row. */
export function kindChipLabel(item: Pick<FocusItem, 'kind'>): string {
  return item.kind === 'reminder' ? 'Reminder' : 'Task';
}

/**
 * Display label for the Project chip on the row. Owner-level rows
 * (`project_id === ''`) render the `INSTANCE_CHIP_LABEL` sentinel; the
 * caller uses `isInstanceLevel` to pick the visually-distinct chip
 * register (hairline border vs solid bg).
 */
export function projectChipLabel(item: Pick<FocusItem, 'project_id'>): string {
  const raw = item.project_id;
  if (raw.length === 0) return INSTANCE_CHIP_LABEL;
  if (raw.length <= PROJECT_CHIP_MAX_CHARS) return raw;
  return `${raw.slice(0, PROJECT_CHIP_MAX_CHARS - 1)}…`;
}

/** True when the row is owner-level (no originating project tab). */
export function isInstanceLevel(item: Pick<FocusItem, 'project_id'>): boolean {
  return item.project_id.length === 0;
}

/**
 * Resolve the bucket-tinted dot color. No green for the `soon` bucket
 * by design (brief § 4.6) — soon is informational, not a success
 * signal; adding a `THEME.success` token to support it would be an
 * unjustified over-extension of the palette.
 */
export function bucketDotColor(bucket: FocusBucket): string {
  if (bucket === 'overdue') return THEME.danger;
  if (bucket === 'today') return THEME.warning;
  return THEME.text_muted;
}

/**
 * Resolve the priority chip discriminator. Returns null when the chip
 * shouldn't render — null priority (i.e. reminders, which have no
 * priority axis, or tasks the user never set a priority on).
 *
 * Priority ramp per brief § 4.8: P0 → danger; P1 → warning; P2 →
 * secondary (neutral); P3 → muted (neutral). The Focus row surfaces
 * every set priority including P0 so the visual table in § 4.8 lines
 * up — the MVP's `priority > 0` filter would have suppressed P0 chips
 * (a likely oversight given the brief's explicit P0 → danger row).
 *
 * Per the engineering-plan §B.P6 convention "priority is 0-3 with 2+
 * counted as high" the underlying numeric scale follows the substrate,
 * not the visual treatment — chip color is independent of the
 * gateway's `HIGH_PRIORITY_THRESHOLD` aggregation gate.
 */
export function priorityChipKind(
  priority: number | null,
): PriorityChipKind {
  if (priority === null) return null;
  if (priority <= 0) return 'p0';
  if (priority === 1) return 'p1';
  if (priority === 2) return 'p2';
  return 'p3';
}

/**
 * Resolve the due-chip discriminator. The chip color ramps with the
 * row's bucket (overdue → danger; today → warning; soon → muted).
 */
export function dueChipKind(bucket: FocusBucket): DueChipKind {
  if (bucket === 'overdue') return 'overdue';
  if (bucket === 'today') return 'today';
  return 'soon';
}
