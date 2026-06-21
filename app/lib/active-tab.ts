/**
 * @neutronai/app — resolve which project tab the current route highlights.
 *
 * Pure + RN-free (only depends on `isLegalTab` from `last-tab-storage`, which
 * is itself eval-time RN-free) so the mapping is unit-testable under bun
 * without rendering the layout.
 *
 * The five locked tabs (chat / launcher / tasks / reminders / docs) each
 * highlight themselves. The project shell also hosts NON-tab sub-routes —
 * `chat-sync` (the Phase-2 offline-sync surface, reached via `router.push`,
 * not in the tab bar yet), plus `notes` / `cores` / `backups`. Those must
 * highlight NOTHING: returning the `chat` fallback for an unknown leaf both
 * shadows the Chat tab AND — because the tab bar treats `key === activeTab`
 * as a no-op — LOCKS the user out of tapping Chat to return (Argus IMPORTANT,
 * PR #11). So a known non-tab leaf maps to `null` (no highlight, every tab tap
 * navigates); only the bare project route (no tab segment) defaults to `chat`.
 */

import { isLegalTab, type LastTabValue } from './last-tab-storage';

/** The five locked project tabs. Mirrors `ProjectTabKey` in `ProjectTabBar`
 *  (same string union) without importing that RN component. */
export type ActiveProjectTab = LastTabValue;

/**
 * Known sub-routes under `projects/[id]/` that are NOT one of the five tabs.
 * Each highlights no tab so it neither shadows nor locks the tab bar.
 */
const NON_TAB_SUBROUTES: ReadonlySet<string> = new Set([
  'chat-sync',
  'notes',
  'cores',
  'backups',
]);

/**
 * Map the current route segments to the highlighted tab.
 *  - a legal tab leaf → that tab;
 *  - a known non-tab leaf (chat-sync/notes/cores/backups) → `null` (highlight
 *    none; tapping any tab, including Chat, still navigates);
 *  - anything else, including the bare `projects/[id]` index → `chat` default.
 */
export function activeTabFromSegments(segments: readonly string[]): ActiveProjectTab | null {
  const last = segments[segments.length - 1] ?? '';
  if (isLegalTab(last)) return last;
  if (NON_TAB_SUBROUTES.has(last)) return null;
  return 'chat';
}
