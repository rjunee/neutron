/**
 * @neutronai/app — what the project shell's CONTENT PANE shows (mobile defect,
 * 2026-07-29).
 *
 * THE BUG THIS MODULE EXISTS TO KILL. `app/projects/[id]/_layout.tsx` gated the
 * WHOLE shell on the settings fetch:
 *
 *     if (project === null) {
 *       if (loading) return <View style={[container, centered]}><ActivityIndicator/></View>
 *       return <ProjectNotFoundFallback .../>
 *     }
 *
 * A rail tap does `router.replace('/projects/<id>')`, the layout stays mounted
 * across the `[id]` change, `useProjectState()` refetches — and for the frames
 * where the new scope's doc has not landed the shell returned ONLY a centred
 * spinner. That tore down the rail, the header and the tab bar and rebuilt all of
 * it when the fetch resolved. Switching projects therefore was not "slow
 * rendering"; it was a full teardown/rebuild of the persistent chrome on every
 * tap.
 *
 * THE INVARIANT. The rail, header and tab bar are persistent chrome. They are
 * mounted for the whole life of a project scope and MUST NOT unmount because a
 * fetch is in flight. Only the content pane has a loading state. This module is
 * the whole decision as a pure function so a test can pin it — the same reason
 * `entry-route.ts` exists (a rule that lives only as an early `return` inside a
 * component this suite cannot mount is a rule nothing can assert).
 *
 * WHY THE ERROR, NOT `loading`, DECIDES "not found". The old gate read
 * `loading` to tell "still fetching" from "definitively absent", which is
 * unreliable: on the render where the route changes, the fetch effect has NOT
 * run yet, so `loading` is still false while `project` is already null for this
 * scope — and the old gate rendered "Project not found" in that gap. The honest
 * signal is the ERROR: `projectStateReducer` sets one on every `LOAD_FAIL` and
 * `toStateError` never yields null, so a genuinely missing project always
 * arrives here with an error attached. No error and no project means only that
 * we have not been told yet.
 *
 * This cannot hang on a spinner forever: the caller only reaches this module with
 * a signed-in user and a non-empty scope id, which is exactly the condition under
 * which `fetchSettings` runs rather than returning early.
 */

/** What the content pane renders. The chrome is not part of this decision. */
export type ProjectShellContent =
  /** The scope is resolved — mount `<Slot />`. */
  | { kind: 'ready' }
  /** This scope's identity is still in flight — spinner, INSIDE the chrome. */
  | { kind: 'loading' }
  /** Definitively absent or unreachable — the not-found pane, INSIDE the chrome. */
  | { kind: 'not_found'; message?: string };

export interface ProjectShellContentInput {
  /**
   * True for the synthetic General scope. General is the absence of a project
   * row, so nothing is ever fetched for it and it is never loading and never
   * missing (`_layout.tsx` GENERAL_SCOPE_PROJECT).
   */
  is_general: boolean;
  /** True once THIS scope's settings doc has resolved. */
  has_project: boolean;
  /** THIS scope's load error, if any. Must not be another scope's. */
  error: { message: string } | null;
}

export function projectShellContent(input: ProjectShellContentInput): ProjectShellContent {
  // General never fetches, so it is always ready — before any other rule, or a
  // stale error from a previous scope could 404 the scope that cannot 404.
  if (input.is_general) return { kind: 'ready' };
  if (input.has_project) return { kind: 'ready' };
  if (input.error !== null) return { kind: 'not_found', message: input.error.message };
  return { kind: 'loading' };
}
