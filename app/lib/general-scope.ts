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
 *   - the HTTP PATH SEGMENT is `'general'` on every project-scoped app surface
 *     EXCEPT reminders, and those surfaces 400 on anything else:
 *     `sanitizeProjectId('~general')` → null → `invalid_project_id`, and an empty
 *     segment produces a `//docs` double slash that matches no route at all.
 *     Reminders is the exception and the direction of travel: it RESERVES
 *     `~general` server-side (`gateway/http/app-reminders-surface.ts`
 *     `resolveScopeSegment`), so for that one surface the segment is the sentinel
 *     itself. Do not read the `'general'` half as universal — it was, until
 *     `httpScopeSegment` below existed.
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
 * UNTOUCHED — including one that merely STARTS with the sentinel (the match is
 * exact, never a prefix).
 *
 * ⚠️ A PROJECT LITERALLY NAMED `general` PRODUCES THE SAME SEGMENT AS THE SCOPE,
 * AND THIS MAPPING CANNOT TELL THEM APART. The `~` sentinel is collision-proof on
 * the CLIENT — that is what ISSUES #410 bought, and the docblock above says so —
 * but the segment it maps to is a legal project id, and an instance can have a
 * project whose id is exactly `general` (`project-rail-view.ts`, which records
 * #410). So the rail's two entries — the General scope and that project — address
 * ONE server-side scope: the docs store roots both at
 * `<owner_home>/Projects/general/docs`.
 *
 * REMINDERS NO LONGER USES THIS FUNCTION — use {@link httpScopeSegment} for any
 * surface that reserves a segment for the no-project scope. Reminders was about to
 * put create/snooze/cancel across this seam in the change that added them, so the
 * server learned the reserved segment instead
 * (`gateway/http/app-reminders-surface.ts` `resolveScopeSegment`). NOT because it
 * was the only mutating surface here — see below, two of the remaining four write
 * through this function today.
 *
 * STILL OPEN for docs / tabs / work-board / activity, which pre-date this module.
 * TWO OF THOSE FOUR MUTATE, and an earlier version of this docblock called all
 * four "reads" — they are not, and the distinction is the whole reason reminders
 * was worth splitting off:
 *
 *   - `docs-client.ts` — `writeFile`, `moveFile`, `createFolder`, `uploadBinary`,
 *     `deleteFile`, `deleteFolder`, `deleteBinary`, `deleteBinariesUnderPrefix`.
 *   - `work-board-client.ts` — `create`, `update`, `complete`, `reorder`,
 *     `delete`, `start`.
 *   - `tabs-client.ts` and `activity-client.ts` really are reads.
 *
 * (Named by SYMBOL, not by line: this docblock has already shipped one stale
 * `file:line` citation that a later commit in the same branch shifted.)
 *
 * So the residual is a wrong-scope WRITE on two clients, not a wrong-scope read
 * on four. It is still not fixed HERE because closing it means moving General's
 * existing content off `general` — `Projects/general/docs` is a directory with
 * files in it — so it is a migration in its own lane, filed as #183, and NOT a
 * rider on a push fix. Do NOT "close" it by changing the constant below: that
 * orphans every General doc already written.
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

/**
 * Map a client-side scope id to its HTTP PATH SEGMENT on a surface that RESERVES
 * a segment for the no-project scope.
 *
 * The difference from {@link httpProjectSegment} is the only thing that matters
 * here: General keeps the `~general` sentinel all the way to the server instead
 * of collapsing onto `general`. `~` is outside the gateway's project-id alphabet,
 * so the segment a project can wear and the segment the SCOPE wears are disjoint
 * by construction — the General scope and a project literally named `general`
 * cannot address the same rows, which under `httpProjectSegment` they do.
 *
 * Use this for any project-scoped surface that MUTATES. Reminders is the one
 * SERVER surface that has learned the reserved segment today
 * (`reminders-client.ts` → `gateway/http/app-reminders-surface.ts`
 * `resolveScopeSegment`). The other four clients still share `httpProjectSegment`
 * and its collision — and two of them (docs, work-board) mutate through it, so
 * "the other clients", NOT "the read-only clients": they are not waiting on this
 * function, they are waiting on the #183 migration recorded above. Moving one of
 * them here before its server surface reserves the segment turns its collision
 * into a 400.
 *
 * A server that has not learned the reserved segment answers `~general` with
 * `invalid_project_id`, so this is not a drop-in for `httpProjectSegment` — the
 * two halves have to agree, which is why they are named differently rather than
 * flagged.
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
