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
  return `${base}/${descriptor.mount.target}`;
}

/** Map an ordered descriptor list to the shell's `ResolvedTab[]`. */
export function descriptorsToResolvedTabs(
  descriptors: readonly TabDescriptor[],
  project_id: string,
): ResolvedTab[] {
  return descriptors.map((d) => ({
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
export const WORK_TAB_KEY = 'workboard';
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
export function ensureWorkTab(tabs: readonly ResolvedTab[], project_id: string): ResolvedTab[] {
  if (tabs.some((t) => t.key === WORK_TAB_KEY)) return [...tabs];
  const workTab: ResolvedTab = {
    key: WORK_TAB_KEY,
    label: WORK_TAB_LABEL,
    route: `/projects/${encodeURIComponent(project_id)}/${WORK_TAB_KEY}`,
  };
  const chatIdx = tabs.findIndex((t) => t.key === 'chat');
  if (chatIdx < 0) return [...tabs, workTab];
  const out = [...tabs];
  out.splice(chatIdx + 1, 0, workTab);
  return out;
}
