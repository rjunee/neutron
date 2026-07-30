/**
 * @neutronai/app — where the app OPENS (SPEC § Decisions Log 2026-07-27).
 *
 * Ryan, on device, looking at the projects-list screen: *"I don't want this
 * screen shown. It should just open into the general chat with the rail on the
 * left. Delete this screen completely."* And, on which chat: *"I want the app to
 * open on the chat screen. Most recent project. Or general."*
 *
 * So the entry is a CHAT route, always. The standalone list screen is gone, the
 * rail is the switcher, and there is exactly one entry path — no flag, no
 * "list vs chat" branch.
 *
 * WHY THIS LIVES IN A PURE MODULE. The decision was recorded on 2026-07-27 and
 * the code was never changed; two days later the app still opened on the list.
 * A rule that only exists as a `router.replace` literal inside a component the
 * test suite cannot mount is a rule nothing can assert (the app suite has no RN
 * mount harness — see `project-card-interactivity.test.ts`). `entryRouteForProjects`
 * is the whole decision as a pure function, so `mobile-entry-route.test.ts` can
 * fail when someone points the entry at a non-chat route again.
 *
 * GENERAL IS THE FLOOR, NOT AN ERROR STATE. General is the NO-PROJECT scope
 * (`open/composer.ts` `scope = input.project_id ?? 'general'`), it always
 * exists, and it needs no fetch — so every degenerate case resolves to it: no
 * projects yet, a list of nothing but non-navigable shared projects, or a failed
 * / offline fetch. A network blip at launch must never leave the owner on a
 * spinner or bounce them at a route that no longer exists.
 */

import { GENERAL_PROJECT_ID } from './project-rail-view';
import { fetchProjects, projectCardInteractivity, sortProjectsByActivity, type Project } from './projects';

/**
 * The chat route for one rail id. `GENERAL_PROJECT_ID` (`~general`) travels
 * through the router looking like a project id on purpose — the only chat route
 * is `/projects/[id]/chat` — and it needs no percent-encoding (ISSUES #411),
 * which is why the sentinel is `~general` and not web's `#general`.
 */
export function chatRouteForProject(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/chat`;
}

/** The General (no-project) chat — the app's home, and every fallback's target. */
export const GENERAL_CHAT_ROUTE = chatRouteForProject(GENERAL_PROJECT_ID);

/**
 * The route the app opens on, given whatever project list it managed to load.
 *
 * `null` means "the fetch failed / never ran" and is deliberately treated the
 * same as an empty list: General. Non-navigable (cross-instance `shared`)
 * projects are excluded — their detail loader is local-only, so entering the app
 * on one would open an empty or WRONG local project
 * (`projectCardInteractivity`, the same predicate the rail filters on).
 */
export function entryRouteForProjects(projects: readonly Project[] | null): string {
  if (projects === null) return GENERAL_CHAT_ROUTE;
  const navigable = projects.filter((p) => projectCardInteractivity(p).navigable);
  const mostRecent = sortProjectsByActivity(navigable)[0];
  if (mostRecent === undefined) return GENERAL_CHAT_ROUTE;
  return chatRouteForProject(mostRecent.id);
}

/**
 * Resolve the entry route against the live gateway. NEVER throws and never
 * returns a non-chat route: a fetch failure resolves to General, because being
 * offline at launch is not a reason to show the owner nothing.
 */
export async function resolveEntryRoute(opts: {
  base_url: string;
  token: string;
}): Promise<string> {
  try {
    const { projects } = await fetchProjects(opts);
    return entryRouteForProjects(projects);
  } catch {
    return GENERAL_CHAT_ROUTE;
  }
}
