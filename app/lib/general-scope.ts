/**
 * @neutronai/app — the ONE place the General scope changes spelling.
 *
 * General is not a project row; it is the no-project scope. It has THREE names,
 * and they are not interchangeable:
 *
 *   - the mobile RAIL id / route segment is `'~general'`
 *     (`project-rail-view.ts` `GENERAL_PROJECT_ID`). `~` is deliberately OUTSIDE
 *     the gateway's `[A-Za-z0-9_.-]` project-id alphabet so the sentinel can
 *     never collide with a real project, and deliberately untouched by
 *     `encodeURIComponent` so it survives being a URL path segment.
 *   - the shared client chat SCOPE is `''` (`railIdToScope`), which the live
 *     `work_board_changed` filter and the app-ws URL both require.
 *   - the HTTP PATH SEGMENT is the reserved `'~general'` sentinel on every
 *     project-scoped app surface.
 *
 * WHY THIS MODULE EXISTS RATHER THAN A FOURTH COPY OF THE MAPPING. The rail id
 * reached the gateway RAW on two surfaces at once, and each failed in its own
 * way for the same reason:
 *
 *   - `GET /api/app/projects/~general/tabs` → 400. The layout SWALLOWS that
 *     error by design ("whatever this scope already had stands"), so General
 *     silently kept the PRE-FETCH loading default forever — the legacy
 *     Chat/Apps/Tasks/Reminders/Docs/Settings set, with no Work tab and Docs in
 *     fifth place. It looked like a tab-ORDER bug and was a failed fetch.
 *   - `GET /api/app/projects/~general/docs/tree` → 400, rendered as the raw
 *     validator string `invalid_project_id: project_id must be 1-128 chars from
 *     [A-Za-z0-9_.-]` where General's docs should be.
 *
 * `work-board-client.ts` and `activity-client.ts` had ALREADY each hit this and
 * each fixed it with its own private `RAIL_GENERAL_ID` const plus a parity test
 * pinning it back to the rail. Two copies is a convention; four is a defect
 * generator — the fifth client to talk to a project-scoped surface would have
 * been the fifth to forget. So the mapping lives here once and they all delegate.
 *
 * Zero imports ON PURPOSE (not even `project-rail-view`, which is why the two
 * earlier clients duplicated instead of importing): every consumer is a
 * unit-tested RN-free client, and this module must not drag a dependency chain
 * into any of them. The parity test in `general-scope.test.ts` pins the constant
 * to the rail's, so the duplication cannot drift.
 */

/**
 * The mobile rail's General id — `project-rail-view.ts` `GENERAL_PROJECT_ID`.
 * Duplicated (not imported) to keep this module import-free; the parity test
 * pins the two together.
 */
export const RAIL_GENERAL_ID = '~general';

/** Former HTTP spelling, retained for decoding legacy notification fixtures. */
export const GENERAL_HTTP_ID = 'general';

/**
 * Map a client-side scope id to its HTTP PATH SEGMENT on a surface that RESERVES
 * a segment for the no-project scope.
 *
 * General keeps the `~general` sentinel all the way to the server instead
 * of collapsing onto `general`. `~` is outside the gateway's project-id alphabet,
 * so the segment a project can wear and the segment the SCOPE wears are disjoint
 * by construction — the General scope and a project literally named `general`
 * cannot address the same rows.
 *
 * All project-scoped app clients and their server surfaces share this spelling.
 */
export function httpScopeSegment(project_id: string | null | undefined): string {
  if (project_id === null || project_id === undefined || project_id.length === 0) {
    return RAIL_GENERAL_ID;
  }
  return project_id;
}

/**
 * {@link httpScopeSegment}, percent-encoded for interpolation into a URL.
 *
 * `encodeURIComponent` leaves `~` alone (RFC 3986 unreserved), so the General
 * segment survives as the literal `~general` — the same property that made `~`
 * the right sentinel for the route in the first place (`project-rail-view.ts`).
 */
export function httpScopeSegmentEncoded(project_id: string | null | undefined): string {
  return encodeURIComponent(httpScopeSegment(project_id));
}
