/**
 * @neutronai/landing — the ONE place General changes spelling on the web client.
 *
 * General is spelled differently at three layers and the difference is load-bearing
 * at each one:
 *
 *   • CLIENT SCOPE  `''`         — the rail's General row is `vm.projectId === null`
 *                                  (→ `''`), and the live `work_board_changed` /
 *                                  activity filters key off `(framePid ?? '') === projectId`.
 *                                  A General frame carries NO `project_id`, so General
 *                                  must stay `''` for a snapshot to be applied at all.
 *   • HTTP SEGMENT  `'general'`  — the gateway's `sanitizeProjectId('')` returns null,
 *                                  so an empty segment produces `//docs/tree` and a 400.
 *                                  The surfaces key General on the literal `general`
 *                                  id (`workBoardScopeKey(owner_slug, 'general')`).
 *   • DOCS ROOT     `Projects/general/docs/` — the same `general` id, resolved by
 *                                  `doc-store.ts` as `<owner_home>/Projects/<id>/docs`.
 *
 * WHY THIS FILE EXISTS RATHER THAN A HELPER PER CLIENT. `work-board-client.ts` already
 * carried its own `'' → 'general'` normaliser, and `docs-client.ts` carried none — which
 * is precisely why General's Documents tab could not load: nine URL builders interpolated
 * `''` straight into the path. A second private copy of the rule is how the two drift, so
 * the rule lives once and every client imports it. This mirrors the mobile client's
 * `app/lib/general-scope.ts`, which exists for the same reason.
 *
 * Deliberately dependency-free so any client layer can import it without a cycle.
 */

/** The reserved HTTP path segment + docs-root id for General. */
export const GENERAL_HTTP_ID = 'general'

/**
 * Map a client-side scope id to its HTTP path segment.
 *
 * `''`, `null` and `undefined` all mean General — the shell represents "no project"
 * as `null` and the clients as `''`, and a caller should never have to know which one
 * reached it. Named ids pass through untouched.
 */
export function httpProjectSegment(project_id: string | null | undefined): string {
  if (project_id === null || project_id === undefined || project_id.length === 0) {
    return GENERAL_HTTP_ID
  }
  return project_id
}

/** {@link httpProjectSegment}, percent-encoded for interpolation into a URL. */
export function httpProjectSegmentEncoded(project_id: string | null | undefined): string {
  return encodeURIComponent(httpProjectSegment(project_id))
}
