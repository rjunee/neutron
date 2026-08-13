/**
 * @neutronai/app — registry tab → mobile route mapping (WAVE 3 PR-3).
 *
 * Pure + RN-free (no `react-native` import) so the descriptor→route mapping
 * and the active-tab resolution are unit-testable under `bun test` without
 * rendering the layout — same convention as the (now-superseded)
 * `active-tab.ts` it replaces.
 *
 * The engine resolver (`tabs/registry.ts`) is the single source of truth for
 * which tabs a project renders. This module translates each engine
 * `TabDescriptor` into the two things the mobile shell needs:
 *
 *   1. a `route` to navigate to on tap, and
 *   2. a stable `key` for the active highlight.
 *
 * Builtin descriptors render the client's own native expo-router route
 * (`mount.target` is the route leaf — `chat` | `docs` | `tasks`). Core
 * descriptors render in a webview at the Core's `project_tab` URL, reached via
 * the generic `projects/[id]/cores/[slug]` route with the URL + label passed
 * as query params.
 */

import type { TabDescriptor } from './tabs-client';
import { isLegalTab, type LastTabValue } from './last-tab-storage';

/**
 * One tab the {@link ProjectTabBar} renders. A builtin native key, a registry
 * descriptor key (`'documents'`), or a Core key (`'core:<slug>'`). Defined here
 * (RN-free) rather than in the RN component so the mapping logic — and this
 * type — stay unit-testable under `bun test`. `ProjectTabBar` re-exports it.
 */
export interface ProjectTabSpec {
  key: string;
  label: string;
}

/**
 * The legacy hardcoded tab set (chat / Apps / tasks / reminders / docs). Per
 * the WAVE 3 PR-3 brief this survives ONLY as the PRE-FETCH loading default —
 * what the bar shows before `GET /api/app/projects/<id>/tabs` returns (or if it
 * errors). It is NOT a flag-gated alternate path. Once the fetch resolves the
 * bar renders the engine-resolved registry set instead.
 */
export const PROJECT_TABS: readonly ProjectTabSpec[] = [
  { key: 'chat', label: 'Chat' },
  { key: 'launcher', label: 'Apps' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'reminders', label: 'Reminders' },
  { key: 'docs', label: 'Docs' },
  { key: 'settings', label: 'Settings' },
];

/** A registry tab resolved to everything the mobile shell needs to render it. */
export interface ResolvedTab {
  /** Stable identity for the active highlight + `testID`. */
  key: string;
  /** Human label rendered on the tab. */
  label: string;
  /** Absolute expo-router path navigated to on tap. */
  route: string;
}

/**
 * Known sub-routes under `projects/[id]/` that are NOT tabs. Each highlights
 * no tab so it neither shadows nor locks the tab bar (Argus IMPORTANT, PR #11:
 * a shadowed Chat tab would be un-tappable). `cores` (bare, no slug) is here
 * too — only a concrete `cores/<slug>` is a tab. Ported from `active-tab.ts`.
 */
const NON_TAB_SUBROUTES: ReadonlySet<string> = new Set([
  'notes',
  'cores',
  'backups',
]);

/** The route segment the generic Core webview tab lives under. */
const CORE_ROUTE_SEGMENT = 'cores';

/** The top-level segment the project routes hang off (`/projects/<id>/…`). */
const PROJECTS_ROOT_SEGMENT = 'projects';

/** Strip a leading `core:` prefix off a descriptor/tab key, if present. */
function coreSlugOf(descriptor: TabDescriptor): string {
  return descriptor.core_slug ?? descriptor.key.replace(/^core:/, '');
}

/**
 * Resolve the expo-router route for one descriptor.
 *  - builtin → `/projects/<id>/<mount.target>` (the native route leaf).
 *  - webview (Core) → `/projects/<id>/cores/<slug>?url=<encoded>&label=<encoded>`.
 *    The Core's `project_tab` URL (already `<project_id>`-substituted by the
 *    engine for project-scope tabs) rides in the `url` query param.
 */
export function resolveTabRoute(descriptor: TabDescriptor, project_id: string): string {
  const base = `/projects/${encodeURIComponent(project_id)}`;
  if (descriptor.mount.kind === 'webview') {
    const slug = coreSlugOf(descriptor);
    const params = new URLSearchParams({
      url: descriptor.mount.target,
      label: descriptor.label,
    });
    return `${base}/${CORE_ROUTE_SEGMENT}/${encodeURIComponent(slug)}?${params.toString()}`;
  }
  // `app_route` — a Core-contributed screen that lives IN this client. The
  // engine already substituted `<project_id>` on the project-scope endpoint, so
  // the target is a complete expo-router path and is used verbatim. (The
  // launcher's tap handler resolves the same manifest path the same way.)
  if (descriptor.mount.kind === 'app_route') {
    return descriptor.mount.target;
  }
  return `${base}/${descriptor.mount.target}`;
}

/**
 * The route leaves this client actually implements under `app/app/projects/[id]/`.
 * Used to enforce the renderability rule (see `TabMountKind`): the engine
 * resolves one tab set for every client, so a descriptor naming a screen this
 * app does not ship must be DROPPED rather than rendered as a dead tab that
 * navigates to a "route not found" page.
 */
const RENDERABLE_ROUTE_LEAVES: ReadonlySet<string> = new Set([
  'chat',
  'workboard',
  'docs',
  'settings',
  'launcher',
  'tasks',
  'reminders',
]);

/** The trailing path segment of a route path, ignoring any query string. */
function pathLeaf(path: string): string {
  const bare = path.split('?')[0] ?? '';
  const parts = bare.split('/').filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? '';
}

/**
 * True when this client can actually render the descriptor's body. Webview
 * tabs always qualify (the generic `cores/[slug]` route frames any URL);
 * `builtin` and `app_route` tabs must name a screen this app ships.
 */
export function canRenderTab(descriptor: TabDescriptor): boolean {
  if (descriptor.mount.kind === 'webview') return true;
  if (descriptor.mount.kind === 'app_route') {
    return RENDERABLE_ROUTE_LEAVES.has(pathLeaf(descriptor.mount.target));
  }
  return RENDERABLE_ROUTE_LEAVES.has(descriptor.mount.target);
}

/** Map an ordered descriptor list to the shell's `ResolvedTab[]`, dropping any
 *  tab whose screen this client doesn't implement. */
export function descriptorsToResolvedTabs(
  descriptors: readonly TabDescriptor[],
  project_id: string,
): ResolvedTab[] {
  return descriptors.filter(canRenderTab).map((d) => ({
    key: d.key,
    label: d.label,
    route: resolveTabRoute(d, project_id),
  }));
}

/**
 * The PRE-FETCH loading default: the legacy hardcoded `PROJECT_TABS` (Chat /
 * Apps / Tasks / Reminders / Docs) resolved to native routes. This is what the
 * bar shows before the `/tabs` fetch returns (or if it errors). Per the PR-3
 * brief, `PROJECT_TABS` survives ONLY in this role — not as a flag-gated
 * alternate path.
 */
export function loadingTabsForProject(project_id: string): ResolvedTab[] {
  return PROJECT_TABS.map((t: ProjectTabSpec) => ({
    key: t.key,
    label: t.label,
    route: `/projects/${encodeURIComponent(project_id)}/${t.key}`,
  }));
}

/** The trailing path segment of a route, ignoring any query string. */
function routeLeaf(route: string): string {
  const path = route.split('?')[0] ?? '';
  const parts = path.split('/').filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? '';
}

/** True when a resolved route targets the generic Core webview surface. */
function isCoreRoute(route: string): boolean {
  const path = route.split('?')[0] ?? '';
  return path.includes(`/${CORE_ROUTE_SEGMENT}/`);
}

/**
 * Resolve which tab the current route highlights, given the tab set CURRENTLY
 * rendered (loading default or fetched registry set). Route-driven so it
 * naturally tracks whatever set is live:
 *  - a `cores/<slug>` leaf → the Core tab whose slug matches (else null);
 *  - a builtin leaf matching a rendered tab's route leaf → that tab;
 *  - a known non-tab leaf (chat-sync / notes / backups / bare cores) → null;
 *  - the bare project route (`/projects/<id>`) → the Chat tab if present;
 *  - ANY OTHER unmatched leaf → null (NOT Chat).
 *
 * IMPORTANT — `segments` must be the CONCRETE path segments (e.g. from
 * `usePathname()` split on `/`), NOT expo-router's `useSegments()`, which
 * returns the file-route TOKENS (`['projects','[id]','cores','[slug]']`) for
 * dynamic routes — those never carry the real `<id>`/`<slug>` so Core tabs
 * would never match.
 *
 * The last bullet is load-bearing: a legacy `launcher`/`reminders` route that
 * is no longer in the registry set must highlight NOTHING — default-
 * highlighting Chat there would make the bar suppress the very tap that lets
 * the user escape the obsolete route (the PR #11 shadow-and-lock class).
 */
export function activeTabKeyFromSegments(
  segments: readonly string[],
  tabs: readonly ResolvedTab[],
): string | null {
  const leaf = segments[segments.length - 1] ?? '';
  const parent = segments[segments.length - 2];

  // Concrete Core webview route: /projects/<id>/cores/<slug>.
  if (parent === CORE_ROUTE_SEGMENT && leaf.length > 0) {
    const match = tabs.find((t) => isCoreRoute(t.route) && routeLeaf(t.route) === leaf);
    return match?.key ?? null;
  }

  // Builtin native leaf — match against the rendered tabs' route leaves.
  const builtinMatch = tabs.find((t) => !isCoreRoute(t.route) && routeLeaf(t.route) === leaf);
  if (builtinMatch !== undefined) return builtinMatch.key;

  if (NON_TAB_SUBROUTES.has(leaf)) return null;

  // Bare project route (`/projects/<id>` — the leaf IS the id, its parent is
  // `projects`): default to the Chat tab. Every other unmatched leaf → null.
  if (parent === PROJECTS_ROOT_SEGMENT) {
    const chat = tabs.find((t) => !isCoreRoute(t.route) && routeLeaf(t.route) === 'chat');
    return chat?.key ?? null;
  }
  return null;
}

/**
 * Validate a Core `project_tab` URL before handing it to a webview/iframe or
 * the system browser. Only `http(s)` is allowed — `javascript:`, `data:`, and
 * other schemes are rejected so a malformed/hostile manifest entry can't drive
 * a script-injection or local-resource load. Returns the trimmed URL or null.
 */
export function sanitizeCoreTabUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return trimmed;
}

/**
 * The legal per-device last-tab value for the current route leaf, or null when
 * the leaf is not a persistable native tab (e.g. a Core webview tab or the
 * `documents` registry tab whose route leaf is `docs`). `index.tsx` redirects
 * to this on a bare project open. Core tabs are intentionally NOT persisted —
 * `last-tab-storage` only knows the locked native set.
 */
export function lastTabValueForLeaf(leaf: string): LastTabValue | null {
  return isLegalTab(leaf) ? leaf : null;
}

/**
 * The stable key + route leaf for the mobile Work tab (M1 UX REDESIGN PR-6).
 * Points at the existing `app/app/projects/[id]/workboard.tsx` screen. Not a
 * persistable `LastTabValue` (deliberately absent from `LEGAL_TABS`) so it
 * highlights + renders its live-run badge without being remembered as the
 * default reopened tab — `lastTabValueForLeaf('workboard')` returns null.
 */
/**
 * The Work tab's REGISTRY KEY — the identity the gateway sends and the value
 * badges are keyed by. This is `work_board`, matching `tabs/registry.ts`.
 *
 * It is NOT the same string as the route leaf below, and conflating the two was
 * ISSUES #404: this constant used to be `'workboard'` (the leaf), so
 * `ensureWorkTab` compared a registry key against a route leaf, never matched
 * the tab the API had already sent, and injected a SECOND one. The device
 * showed `Chat | Work | Work | Documents`. Verified against the live payload,
 * which returns exactly four tabs — `chat`, `work_board`, `documents`,
 * `settings` — so the duplicate was entirely client-side.
 *
 * The same mismatch silently mis-keyed the live-run badge: `tabBadges` is built
 * with this constant and `ProjectTabBar` looks badges up by `tab.key`, so the
 * badge attached to the injected phantom rather than to the real tab.
 */
export const WORK_TAB_KEY = 'work_board';
/**
 * The Work tab's ROUTE LEAF — the file route under `app/app/projects/[id]/`,
 * which is `workboard.tsx`. Mirrors the registry's `mount.target`. Kept separate
 * from the key ON PURPOSE; they differ, and #404 is what happens when they are
 * assumed equal.
 */
export const WORK_TAB_ROUTE_LEAF = 'workboard';
const WORK_TAB_LABEL = 'Work';

/**
 * Ensure the mobile Work tab is present in the rendered set, inserted right
 * after Chat (mirroring the signed-off mobile prototype's Chat · Work · Docs
 * order). The Work board screen ships as a route but the tab registry does not
 * emit a Work descriptor, so the mobile shell injects it here — ONE code path
 * over BOTH the loading default and the fetched registry set (idempotent: a set
 * that already carries a `workboard` tab is returned unchanged). This is where
 * the current project's `live_runs` badge lands (PR-1 #180).
 */
/**
 * The tab keys the GENERAL (no-project) scope can actually serve.
 *
 * General is not a project row, so the tab set has to be narrowed to the
 * surfaces that exist without one. All three do:
 *   - `chat` — General has its own real warm session,
 *   - `work_board` — its board is the owner-slug scope key, which is also where
 *     every pre-scoping legacy row and every agent `work_board_*` write lands,
 *   - `documents` — rooted at `Projects/general/docs` server-side.
 *
 * Everything else in the registry set is project-only and would render a raw
 * validator string or an empty pane: `settings` reads a project row that does
 * not exist (the layout already synthesises `GENERAL_SCOPE_PROJECT` for the
 * chrome precisely because there is nothing to fetch), `launcher` lists a
 * project's installed Cores, and a Core `project_tab` is project-scoped by
 * definition.
 *
 * Registry ORDER is preserved, so the three arrive as Chat (0) / Work (5) /
 * Documents (10) — the owner-specified Chat · Work · Docs, with Docs third in
 * General exactly as it is in a named project.
 *
 * This is a KEY allow-list, not a route/label one: keys are the registry's
 * stable identity, and matching on labels or route leaves is what produced
 * ISSUES #404 (a registry key compared against a route leaf, injecting a
 * duplicate tab).
 */
const GENERAL_TAB_KEYS: ReadonlySet<string> = new Set(['chat', WORK_TAB_KEY, 'documents']);

/**
 * Narrow a resolved tab set to what the General scope can serve, preserving
 * order. A named project's set passes through untouched — callers gate on the
 * rail sentinel, so this is only ever applied to General.
 */
export function generalScopeTabs(tabs: readonly ResolvedTab[]): ResolvedTab[] {
  return tabs.filter((t) => GENERAL_TAB_KEYS.has(t.key));
}

export function ensureWorkTab(tabs: readonly ResolvedTab[], project_id: string): ResolvedTab[] {
  if (tabs.some((t) => t.key === WORK_TAB_KEY)) return [...tabs];
  const workTab: ResolvedTab = {
    key: WORK_TAB_KEY,
    label: WORK_TAB_LABEL,
    route: `/projects/${encodeURIComponent(project_id)}/${WORK_TAB_ROUTE_LEAF}`,
  };
  const chatIdx = tabs.findIndex((t) => t.key === 'chat');
  if (chatIdx < 0) return [...tabs, workTab];
  const out = [...tabs];
  out.splice(chatIdx + 1, 0, workTab);
  return out;
}
