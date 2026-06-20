/**
 * @neutronai/app — tasks tab pure formatters (P5.4).
 *
 * Extracted from `components/TaskCreateModal.tsx` /
 * `components/TaskEditModal.tsx` so they remain importable from
 * `bun-test` without pulling in `react-native` (which throws at
 * module-load under the bun-test runtime). Same pattern as
 * `lib/task-row-formatters.ts`.
 */

/**
 * Normalise a user-typed due date to an ISO-8601 string the gateway
 * accepts. Accepts `YYYY-MM-DD` (treated as midnight UTC of that day)
 * or any string that already parses as ISO-8601; otherwise returns
 * the raw input and lets the gateway reject it inline.
 */
export function normalizeDueDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T00:00:00.000Z`;
  }
  return raw;
}
