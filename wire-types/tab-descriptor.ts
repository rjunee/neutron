/**
 * @neutronai/wire-types — engine TAB DESCRIPTOR wire shape (L6).
 *
 * The `TabDescriptor` (+ its `TabScope` / `TabSource` / `TabMountKind` /
 * `TabMount` component types) that the engine's tab-resolver surface serves
 * over HTTP. Extracted out of `tabs/registry.ts` (which re-exports these +
 * keeps the resolver logic, `BUILTIN_TABS`, and `CoreTabContribution`) into
 * this node-free bottom band so BOTH clients import ONE source instead of the
 * hand-mirrored type blocks that used to live in `app/lib/tabs-client.ts` and
 * `landing/chat-react/tabs-client.ts` (both mirror blocks deleted in L6).
 *
 * Node-free: pure structural types.
 */

/** Where a tab lives: inside one project, or in the global app shell. */
export type TabScope = 'project' | 'global'

/**
 * Who contributes the tab. `'builtin'` = engine-native. `'core'` = contributed
 * by an installed Core's `project_tab` surface. `'custom'` (user-built tabs) is
 * reserved for v2 — do NOT emit it before that wave.
 */
export type TabSource = 'builtin' | 'core' | 'custom'

/**
 * How a client renders the tab body.
 *   - `'builtin'`: the client renders its OWN native view keyed by the
 *     descriptor `mount.target` (an `expo-router` route on mobile, a React
 *     component on web).
 *   - `'webview'`: render the contributing Core's `project_tab` entry in a
 *     sandboxed webview/iframe at `mount.target`.
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
  /** Set only when `source === 'core'`. Absent for builtins. */
  core_slug?: string
  /**
   * Ascending sort key. Builtin tabs are spaced by 10 so Core-contributed tabs
   * can slot BETWEEN builtins without renumbering.
   */
  order: number
  mount: TabMount
}
