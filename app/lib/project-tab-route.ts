/**
 * @neutronai/app — the route a project OPENS on, resolved from the id you
 * already hold.
 *
 * WHY THIS IS ITS OWN MODULE, AND NOT A STEP INSIDE THE WAYPOINT SCREEN.
 *
 * `/projects/<id>` is a waypoint: it resolves this device's last tab for the
 * scope and hands off to `/projects/<id>/<tab>`. To do that it has to ask the
 * ROUTER which scope it is standing in — and the router is not a reliable
 * answer to that question mid-navigation.
 *
 * Observed on device (2026-07-31), instrumented, on the rail-tap path (the
 * project names below are neutralised):
 *
 *     press=harbor; rail:tap=harbor:cur=willow;
 *     wp:mount=harbor;      ← the waypoint resolved the RIGHT scope
 *     wp:mount=willow;   ← …then the router re-reported the PREVIOUS one
 *     wp:go=willow/chat  ← …and the handoff went there
 *
 * The revert is structural, not a glitch. The project shell is ONE root-stack
 * screen named `projects/[id]` (`app/app/_layout.tsx`), and expo-router only
 * treats a dynamic segment as diverging when the route NAME is exactly
 * `[id]` — `matchDynamicName` is `/^\[([^[\]]+?)\]$/`, which does not match
 * `projects/[id]` (expo-router 6.0.24, `build/matchers.js`). So an in-app
 * switch from one project to another never diverges at the root: the action
 * lands on the CHILD navigator and the root route keeps `params.id` pointing at
 * the project you started from. Anything that later re-derives the scope from
 * the router can therefore be handed that stale id, and the waypoint did not
 * merely READ it — it navigated on it.
 *
 * The fix is to stop asking. A rail tap already knows, exactly and
 * unambiguously, which project was tapped; resolving the tab HERE lets the
 * caller navigate straight to the final route in one hop, with the id carried
 * in a closure instead of re-read from lagging state. The waypoint keeps
 * existing for the entries that genuinely have no id in hand — a cold start or
 * a deep link to `/projects/<id>` — and it now latches the first scope it
 * resolves so a revert cannot redirect it either.
 */

import { lastTabStorage, type LastTabValue } from './last-tab-storage';

/** Where a project opens when this device has no stored preference. */
export const DEFAULT_TAB: LastTabValue = 'chat';

/**
 * How long the last-tab preference may take before the handoff goes ahead
 * without it. Short on purpose: this is the difference between landing on the
 * tab you left and landing on Chat, and no owner would trade a second of
 * staring at a spinner for it.
 */
export const LAST_TAB_READ_TIMEOUT_MS = 1_200;

/** The stored tab, or `null` if it is missing, illegal, slow, or broken. */
export async function preferredTab(projectId: string): Promise<LastTabValue | null> {
  const read = (async (): Promise<LastTabValue | null> => {
    try {
      return await lastTabStorage().get(projectId);
    } catch {
      return null;
    }
  })();
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<null>((resolve) => {
        handle = setTimeout(() => {
          resolve(null);
        }, LAST_TAB_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

/** `/projects/<id>/<tab>`, the only route shape a switch ever navigates to. */
function routeFor(projectId: string, tab: LastTabValue): string {
  return `/projects/${encodeURIComponent(projectId)}/${tab}`;
}

/**
 * The FINAL route for a project id — never a waypoint. The read cannot fail the
 * caller: a missing, illegal, slow or broken preference resolves to Chat.
 */
export async function projectTabRoute(projectId: string): Promise<string> {
  const stored = await preferredTab(projectId);
  return routeFor(projectId, stored ?? DEFAULT_TAB);
}

/**
 * The same route, or `null` when this device's preference is not yet in memory.
 *
 * WHY A SECOND ENTRY POINT. `projectTabRoute` is correct but it is a promise,
 * and a promise means the tap does nothing at all until a microtask (on native,
 * an AsyncStorage bridge round-trip) has come back. That pause is the whole gap
 * between "instant" and "it takes a moment": nothing on screen acknowledges the
 * tap while it runs. The preference is a per-device value only this process
 * writes, so after the shell has primed it once
 * (`LastTabStore.prime`, called with the rail's project list) the answer is
 * simply known, and the navigation can happen in the same tick as the press.
 *
 * `null` is honest, not a fallback: it means "not known yet", and the caller
 * awaits the real read rather than guessing Chat and landing the owner on the
 * wrong tab.
 */
export function projectTabRouteSync(projectId: string): string | null {
  const store = lastTabStorage();
  if (!store.knows(projectId)) return null;
  return routeFor(projectId, store.peek(projectId) ?? DEFAULT_TAB);
}
