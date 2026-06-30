/**
 * @neutronai/tabs — engine-side TAB DESCRIPTOR + RESOLVER (WAVE 3, PR-1).
 *
 * Per `docs/plans/wave3-tabbed-interface-build-plan.md` § 3.1 and SPEC.md
 * WAVE 3 ("Tabbed project shell + Cores install-scope"). The single source
 * of truth for which tabs a project (or the global shell) renders is an
 * engine-side resolver that BOTH clients (mobile RN + web React) consume
 * over HTTP — tabs are NOT hardcoded in either client.
 *
 * ── Scope (PR-1 + PR-2) ─────────────────────────────────────────────────
 * BUILTIN tabs:
 *   - per-project (scope='project'): Chat, Plan (work_board), Documents
 *   - global      (scope='global'):  Admin
 * (Tasks is no longer a builtin — it returns as a Core webview tab, WAVE 3.)
 * PR-2 adds the CORE union: installed Cores' `project_tab` surfaces are
 * folded in as `source='core'` descriptors. This file STAYS PURE — it does
 * NOT read the DB or load packages. The HTTP layer resolves which Cores are
 * installed (per-project via `core_installations`, global via
 * `core_global_installations`), reads each Core's manifest, and passes the
 * resulting `CoreTabContribution[]` into `resolveTabs`. The registry just
 * prepends the builtins and orders the union — which keeps it trivially
 * unit-testable and identical across both clients.
 *
 * ── Descriptor shape (reconciliation note) ──────────────────────────────
 * The plan tagged the descriptor shape `[estimate] — confirm in-PR`. Two
 * reconciliations are confirmed here:
 *   1. `mount.kind` is `'builtin' | 'webview'` (not the plan's three-value
 *      `native-route | react-view | webview`). A descriptor is engine-side
 *      and client-agnostic — it cannot know whether the consumer is mobile
 *      (RN route) or web (React component). So a builtin tab carries
 *      `kind:'builtin'` + a stable `target` key, and each client maps that
 *      key to its own native view. Core tabs (PR-2) carry `kind:'webview'`
 *      + the core's `project_tab` URL.
 *   2. `source` is the `'builtin' | 'core'` discriminant (the dispatch brief
 *      called this `kind`). v2 will add `'custom'` for user-built tabs — the
 *      union is left open at the type level but no `'custom'` value is
 *      emitted now.
 */

/** Where a tab lives: inside one project, or in the global app shell. */
export type TabScope = 'project' | 'global'

/**
 * Who contributes the tab. `'builtin'` = engine-native (PR-1). `'core'` =
 * contributed by an installed Core's `project_tab` surface (PR-2). v2 will
 * add `'custom'` (user-built tabs) — do NOT emit it before that wave.
 */
export type TabSource = 'builtin' | 'core' | 'custom'

/**
 * How a client renders the tab body.
 *   - `'builtin'`: the client renders its OWN native view keyed by the
 *     descriptor `key` (an `expo-router` route on mobile, a React component
 *     on web). `target` is the stable route/view key.
 *   - `'webview'`: render the contributing Core's `project_tab` entry in a
 *     sandboxed webview/iframe at `target` (PR-2). `<project_id>` in the
 *     URL is substituted by the resolver, mirroring `open_app_tab`.
 */
export type TabMountKind = 'builtin' | 'webview'

export interface TabMount {
  kind: TabMountKind
  /** builtin → route/view key; webview → resolved URL. */
  target: string
}

export interface TabDescriptor {
  /** Stable identity. Builtin: `'chat' | 'work_board' | 'documents' | 'admin'`. */
  key: string
  /** Human label rendered on the tab. */
  label: string
  scope: TabScope
  source: TabSource
  /** Set only when `source === 'core'` (PR-2). Absent for builtins. */
  core_slug?: string
  /**
   * Ascending sort key. Builtin tabs are spaced by 10 so PR-2 can slot
   * Core-contributed tabs BETWEEN builtins without renumbering.
   */
  order: number
  mount: TabMount
}

/**
 * The static builtin tab set. Per-project tabs first
 * (Chat / Plan / Documents), then the global Admin tab. `target` keys match the
 * existing client routes: mobile `app/app/projects/[id]/{chat,workboard,docs}.tsx`
 * + the Admin surface.
 *
 * Order is spaced by 10 so a tab can slot between two existing ones without
 * renumbering; the Plan (work_board) tab sits at **order 5** — right after Chat,
 * before Documents — per the Work Board master plan §1/§9 (the live work-tracker
 * is the orchestrator's external memory, so it ranks just below the
 * conversation). Tasks is intentionally absent — it returns as a Core-contributed
 * webview tab (WAVE 3), NOT an engine builtin.
 */
const BUILTIN_TABS: readonly TabDescriptor[] = Object.freeze([
  {
    key: 'chat',
    label: 'Chat',
    scope: 'project',
    source: 'builtin',
    order: 0,
    mount: { kind: 'builtin', target: 'chat' },
  },
  {
    // User-facing label is "Plan" (Ryan directive). The internal key, target,
    // tool names (`work_board_*`), CSS (`cwb-`), and DB table keep the
    // `work_board` identifier — only the visible label reads "Plan".
    key: 'work_board',
    label: 'Plan',
    scope: 'project',
    source: 'builtin',
    order: 5,
    mount: { kind: 'builtin', target: 'workboard' },
  },
  {
    key: 'documents',
    label: 'Documents',
    scope: 'project',
    source: 'builtin',
    order: 10,
    mount: { kind: 'builtin', target: 'docs' },
  },
  // NOTE: the builtin `tasks` tab was REMOVED (Ryan directive, WAVE 3) — Tasks
  // returns as a Core-contributed webview tab via the `CoreTabContribution`
  // union, NOT as an engine builtin. Do not re-add a hardcoded tasks tab.
  {
    key: 'admin',
    label: 'Admin',
    scope: 'global',
    source: 'builtin',
    order: 0,
    mount: { kind: 'builtin', target: 'admin' },
  },
])

/**
 * A Core-contributed tab, gathered by the HTTP layer from an installed Core's
 * manifest `project_tab` ui_component. The registry stays pure — callers
 * resolve installs + manifests and pass the contributions in.
 *
 * For the per-project endpoint, `target` has `<project_id>` already
 * substituted to the concrete project; for the global endpoint it keeps the
 * `<project_id>` placeholder (the client substitutes per project at nav time,
 * mirroring `open_app_tab`).
 */
export interface CoreTabContribution {
  /** Slug of the contributing Core (→ descriptor `core_slug`). */
  core_slug: string
  /** Tab label; the HTTP layer falls back to the slug when unnamed. */
  label: string
  /** Webview URL/entry the client renders for this Core's tab. */
  target: string
}

/**
 * Base `order` for Core-contributed tabs. Builtins occupy 0/5/10 (project)
 * and 0 (global); Cores slot AFTER them. Install order is preserved by adding
 * the contribution index, so two Cores keep a stable relative order.
 */
const CORE_TAB_ORDER_BASE = 100

/** Build a Core-contributed descriptor for a given scope + contribution. */
function coreDescriptor(
  scope: TabScope,
  c: CoreTabContribution,
  index: number,
): TabDescriptor {
  return {
    key: `core:${c.core_slug}`,
    label: c.label,
    scope,
    source: 'core',
    core_slug: c.core_slug,
    order: CORE_TAB_ORDER_BASE + index,
    mount: { kind: 'webview', target: c.target },
  }
}

/** Deep-freeze a descriptor so callers can't mutate the shared builtin set. */
function cloneDescriptor(d: TabDescriptor): TabDescriptor {
  return {
    key: d.key,
    label: d.label,
    scope: d.scope,
    source: d.source,
    ...(d.core_slug !== undefined ? { core_slug: d.core_slug } : {}),
    order: d.order,
    mount: { kind: d.mount.kind, target: d.mount.target },
  }
}

/**
 * Resolve the ordered tab descriptors for a scope: the builtin tabs for that
 * scope, UNIONed with the supplied Core contributions, sorted ascending by
 * `order` (builtins first, Cores after). The return is a fresh array of fresh
 * objects every call, so callers (and the HTTP surface that JSON-encodes them)
 * can never mutate the shared builtin set.
 *
 * `cores` defaults to empty — passing no contributions yields the builtin-only
 * result (the pre-PR-2 behaviour), so callers that don't resolve installs are
 * unaffected.
 */
export function resolveTabs(
  scope: TabScope,
  cores: readonly CoreTabContribution[] = [],
): TabDescriptor[] {
  const builtins = BUILTIN_TABS.filter((t) => t.scope === scope).map(cloneDescriptor)
  const coreTabs = cores.map((c, i) => coreDescriptor(scope, c, i))
  return [...builtins, ...coreTabs].sort((a, b) => a.order - b.order)
}

/** Per-project tab descriptors: Chat/Plan/Documents + per-project Core tabs. */
export function resolveProjectTabs(
  cores: readonly CoreTabContribution[] = [],
): TabDescriptor[] {
  return resolveTabs('project', cores)
}

/** Global tab descriptors: builtin Admin + globally-installed Core tabs. */
export function resolveGlobalTabs(
  cores: readonly CoreTabContribution[] = [],
): TabDescriptor[] {
  return resolveTabs('global', cores)
}
