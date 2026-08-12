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
 *   - the HTTP PATH SEGMENT is `'general'`, and every project-scoped app surface
 *     400s on anything else: `sanitizeProjectId('~general')` → null →
 *     `invalid_project_id`, and an empty segment produces a `//docs` double slash
 *     that matches no route at all.
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

/**
 * The id General answers to ON THE SERVER. `sanitizeProjectId` accepts it, and
 * every project-scoped app surface resolves it like any other id: the Work board
 * collapses it to the owner-slug scope key (`work-board/store.ts`), and the docs
 * store roots it at `<owner_home>/Projects/general/docs`.
 */
export const GENERAL_HTTP_ID = 'general';

/**
 * Map a client-side scope id to its HTTP PATH SEGMENT.
 *
 * Every client-side spelling of General (`null`, `undefined`, `''`, `'~general'`)
 * collapses to `'general'`. Anything else is a project id and passes through
 * UNTOUCHED — including a project literally named `general`, and including one
 * that merely STARTS with the sentinel (the match is exact, never a prefix).
 *
 * Not percent-encoded here: encoding is the caller's job, because a caller
 * interpolating into a URL needs `encodeURIComponent` and a caller comparing
 * against a returned `project_id` does not.
 */
export function httpProjectSegment(project_id: string | null | undefined): string {
  if (project_id === null || project_id === undefined || project_id.length === 0) {
    return GENERAL_HTTP_ID;
  }
  return project_id === RAIL_GENERAL_ID ? GENERAL_HTTP_ID : project_id;
}

/** {@link httpProjectSegment}, percent-encoded for interpolation into a URL. */
export function httpProjectSegmentEncoded(project_id: string | null | undefined): string {
  return encodeURIComponent(httpProjectSegment(project_id));
}
