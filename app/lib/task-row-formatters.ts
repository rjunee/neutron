/**
 * @neutronai/app — pure formatters for the tasks tab row chips (P5.4).
 *
 * Extracted from `components/TaskRow.tsx` so they remain importable
 * from `bun-test` without pulling in `react-native` (which throws at
 * module-load under the bun-test runtime). Same pattern as
 * `lib/launcher-grid-layout.ts` / `lib/citation-chip-row.tsx`'s
 * helper exports.
 *
 *   - `formatDueDateLabel(due_date)` — strip the time component for
 *     the chip; null when absent.
 *   - `localTodayString(now?)`       — user-local `YYYY-MM-DD` for
 *     "today" bucketing.
 *   - `computeDueKind(due_date, now?)` — 'overdue' | 'today' | 'future'
 *     | null relative to a frozen `now`.
 *   - `formatFocusScore(score)`      — `★ 7.5` to one decimal place;
 *     null when absent / non-finite.
 *   - `priorityChipKind(priority)`   — 'danger' | 'warning' | 'neutral'
 *     mapping for the chip color ramp.
 */

export type DueKind = 'overdue' | 'today' | 'future' | null;
export type ChipKind = 'danger' | 'warning' | 'neutral';

/** Strip the time component for the row label. ISO-8601 input. */
export function formatDueDateLabel(due_date: string | null | undefined): string | null {
  if (due_date === null || due_date === undefined || due_date.length === 0) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(due_date);
  return m === null ? due_date : (m[1] ?? due_date);
}

/**
 * Compute the user's local YYYY-MM-DD for "today". Used to bucket
 * due-date chips into overdue / today / future. Exposed for tests.
 */
export function localTodayString(now: Date = new Date()): string {
  // `en-CA` formats as `YYYY-MM-DD` natively across locales.
  return now.toLocaleDateString('en-CA');
}

export function computeDueKind(
  due_date: string | null | undefined,
  now: Date = new Date(),
): DueKind {
  const label = formatDueDateLabel(due_date);
  if (label === null) return null;
  const today = localTodayString(now);
  if (label < today) return 'overdue';
  if (label === today) return 'today';
  return 'future';
}

export function formatFocusScore(score: number | null | undefined): string | null {
  if (score === null || score === undefined) return null;
  if (!Number.isFinite(score)) return null;
  return `★ ${score.toFixed(1)}`;
}

export function priorityChipKind(priority: number | null | undefined): ChipKind {
  if (priority === 0) return 'danger';
  if (priority === 1) return 'warning';
  return 'neutral';
}

export function dueChipKind(kind: DueKind): ChipKind {
  if (kind === 'overdue') return 'danger';
  if (kind === 'today') return 'warning';
  return 'neutral';
}

/** Alpha hex suffixes consumed by sibling components for tinted chip backgrounds. */
export const ALPHA_TINTS = Object.freeze({
  /** ~22% — backgrounds for danger/warning chips + destructive button. */
  panel: '38' as const,
  /** ~13% — lighter destructive button background. */
  light: '22' as const,
  /** ~35% — destructive button border. */
  border: '5a' as const,
});
