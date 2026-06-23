/**
 * @neutronai/tabs — engine-side TAB DESCRIPTOR + RESOLVER (WAVE 3, PR-1).
 *
 * Per `docs/plans/wave3-tabbed-interface-build-plan.md` § 3.1 and SPEC.md
 * WAVE 3 ("Tabbed project shell + Cores install-scope"). The single source
 * of truth for which tabs a project (or the global shell) renders is an
 * engine-side resolver that BOTH clients (mobile RN + web React) consume
 * over HTTP — tabs are NOT hardcoded in either client.
 *
 * ── PR-1 scope (this file) ──────────────────────────────────────────────
 * v1 resolves BUILTIN tabs ONLY:
 *   - per-project (scope='project'): Chat, Documents, Tasks
 *   - global      (scope='global'):  Admin
 * Core-contributed tabs (`source='core'`) and the install-scope union come
 * in PR-2 — the descriptor + resolver are deliberately shaped to slot them
 * in without a breaking change (see the `source`/`order` notes below). This
 * file does NOT read `core_installations`; it emits a static builtin list.
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
  /** Stable identity. Builtin: `'chat' | 'documents' | 'tasks' | 'admin'`. */
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
 * The static builtin tab set. Per-project tabs first (Chat/Documents/Tasks),
 * then the global Admin tab. `target` keys match the existing client routes:
 * mobile `app/app/projects/[id]/{chat,docs,tasks}.tsx` + the Admin surface.
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
    key: 'documents',
    label: 'Documents',
    scope: 'project',
    source: 'builtin',
    order: 10,
    mount: { kind: 'builtin', target: 'docs' },
  },
  {
    key: 'tasks',
    label: 'Tasks',
    scope: 'project',
    source: 'builtin',
    order: 20,
    mount: { kind: 'builtin', target: 'tasks' },
  },
  {
    key: 'admin',
    label: 'Admin',
    scope: 'global',
    source: 'builtin',
    order: 0,
    mount: { kind: 'builtin', target: 'admin' },
  },
])

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
 * Resolve the ordered tab descriptors for a scope.
 *
 * PR-1: builtin descriptors only, sorted ascending by `order`. The return is
 * a fresh array of fresh objects every call, so callers (and the HTTP
 * surface that JSON-encodes them) can never mutate the shared builtin set.
 *
 * PR-2 will extend this to UNION the `project_tab` surfaces of Cores
 * installed in the relevant scope — the signature will grow a cores arg;
 * the builtin prefix stays.
 */
export function resolveTabs(scope: TabScope): TabDescriptor[] {
  return BUILTIN_TABS.filter((t) => t.scope === scope)
    .map(cloneDescriptor)
    .sort((a, b) => a.order - b.order)
}

/** Per-project tab descriptors (Chat, Documents, Tasks in v1). */
export function resolveProjectTabs(): TabDescriptor[] {
  return resolveTabs('project')
}

/** Global tab descriptors (Admin in v1). */
export function resolveGlobalTabs(): TabDescriptor[] {
  return resolveTabs('global')
}
