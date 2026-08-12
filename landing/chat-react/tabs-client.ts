/**
 * landing/chat-react — web project TAB RESOLVER client (WAVE 3 PR-4).
 *
 * The web twin of the mobile `app/lib/tabs-client.ts`. A thin fetch wrapper for
 * the engine's tab-resolver surface:
 *
 *   GET /api/app/projects/<project_id>/tabs  → ordered project-scope tabs
 *
 * The engine (`tabs/registry.ts` + `gateway/http/app-tabs-surface.ts`) is the
 * SINGLE SOURCE OF TRUTH for which tabs a project renders — builtin
 * Chat/Plan/Documents UNIONed with the `project_tab` surfaces of Cores
 * installed in that project (Tasks is Core-contributed, not a builtin). The web
 * `ProjectShell` consumes this list instead
 * of hardcoding tabs. Always on — no feature flag (SPEC Decisions Log,
 * 2026-06-23).
 *
 * Wire shapes mirror the engine types in `tabs/registry.ts` byte-for-byte. We
 * re-declare them here (rather than import across the workspace boundary) so the
 * browser bundle stays free of a gateway dependency — the same convention the
 * sibling `app/lib/tabs-client.ts` follows on mobile.
 *
 * Auth + base URL mirror the chat-attachment surface: the app-ws bearer token
 * (`config.token`) and the page origin (`config.origin`). Pure given an injected
 * `fetchImpl`, so it unit-tests without a DOM or a live server.
 */

// L6 — the `TabDescriptor` wire shape (+ `TabScope` / `TabSource` /
// `TabMountKind` / `TabMount`) is owned by the node-free
// `@neutronai/wire-types` leaf. This client used to re-declare it BY HAND (a
// comment-only mirror of `tabs/registry.ts`); it now imports + re-exports the
// ONE source, so the mirror-parity test is a plain import-and-use contract.
import type { TabDescriptor } from '@neutronai/wire-types'

export type {
  TabDescriptor,
  TabMount,
  TabMountKind,
  TabScope,
  TabSource,
} from '@neutronai/wire-types'

interface ProjectTabsResponse {
  ok: boolean
  scope: 'project'
  project_id: string
  tabs: TabDescriptor[]
}

interface GlobalTabsResponse {
  ok: boolean
  scope: 'global'
  tabs: TabDescriptor[]
}

export class TabsClientError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`)
    this.name = 'TabsClientError'
    this.code = code
    this.status = status
  }
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export interface TabsClientOptions {
  /** Page origin (`https://host`); the surface lives at `/api/app/...`. */
  base_url: string
  /** App-ws bearer token (`config.token`). */
  token: string
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: FetchImpl
}

/**
 * The guaranteed pre-fetch / fallback tab: just Chat. Mirrors the builtin
 * descriptor the engine emits, so the bar always has a Chat tab (and the
 * existing `ChatApp` mounts immediately) before — or even if — the `/tabs`
 * fetch resolves. Unlike mobile's `loadingTabsForProject`, web had no prior tab
 * set, so showing only the real Chat tab pre-fetch avoids a flicker of
 * not-yet-confirmed tabs.
 */
const CHAT_TAB_LITERAL: TabDescriptor = {
  key: 'chat',
  label: 'Chat',
  scope: 'project',
  source: 'builtin',
  order: 0,
  mount: { kind: 'builtin', target: 'chat' },
}
export const CHAT_TAB: TabDescriptor = Object.freeze(CHAT_TAB_LITERAL)

/**
 * The Work descriptor injected into GENERAL's tab set (M1 — "General has no Work
 * view" fix). The engine's global tab set is Admin-only (`resolveGlobalTabs` in
 * `tabs/registry.ts`), so General — which renders `[CHAT_TAB, ...globalTabs]` —
 * had no `workboard` descriptor and thus no desktop slide-out pane / narrow Work
 * tab, even though General's board IS backend-reachable (the `owner_slug` scope
 * key). We inject the SAME builtin `work_board` descriptor named projects get, so
 * the existing `ProjectShell` machinery (the `showPane` gate + the narrow-width
 * tab) lights up for General with ZERO branch — mirroring how the mobile shell
 * injects its Work tab via `ensureWorkTab`. Scoped `global` because it rides the
 * General/global tab set; the surface it opens is General's `owner_slug` board
 * (the client scopes General as `projectId === ''`, which the work-board client
 * maps to the `'general'` HTTP id — see `workBoardPathSegment`).
 */
const GENERAL_WORK_TAB_LITERAL: TabDescriptor = {
  key: 'work_board',
  label: 'Work',
  scope: 'global',
  source: 'builtin',
  order: 5,
  mount: { kind: 'builtin', target: 'workboard' },
}
export const GENERAL_WORK_TAB: TabDescriptor = Object.freeze(GENERAL_WORK_TAB_LITERAL)

/**
 * The Documents descriptor injected into GENERAL's tab set.
 *
 * Same shape of gap as the Work tab above, and found the same way: the owner had a
 * General work card whose plan-doc link did nothing, because General's tab set was
 * Chat + Work + Admin and the doc-link resolver waits for a `docs` tab that never
 * arrived. The engine's global set is Admin-only, so no `documents` descriptor was
 * ever produced for General even though its docs ARE backend-reachable — the store
 * roots them at `<owner_home>/Projects/general/docs`, the same rule every named
 * project follows.
 *
 * `order: 6` puts it directly after Work, so General reads chat → work → docs, which
 * is the ordering named projects already have and the one the owner asked for.
 */
const GENERAL_DOCS_TAB_LITERAL: TabDescriptor = {
  key: 'documents',
  label: 'Docs',
  scope: 'global',
  source: 'builtin',
  order: 6,
  mount: { kind: 'builtin', target: 'docs' },
}
export const GENERAL_DOCS_TAB: TabDescriptor = Object.freeze(GENERAL_DOCS_TAB_LITERAL)

export class WebTabsClient {
  private readonly base_url: string
  private readonly token: string
  private readonly fetchImpl: FetchImpl

  constructor(opts: TabsClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  /** Resolve the ordered project-scope tab descriptors for one project. */
  async listProjectTabs(project_id: string): Promise<TabDescriptor[]> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/tabs`
    const body = await this.req<ProjectTabsResponse>(path)
    return body?.tabs ?? []
  }

  /**
   * Resolve the ordered GLOBAL-scope tab descriptors (builtin Admin + globally
   * installed Core tabs). The web shell folds these in alongside the per-project
   * tabs so the owner can reach the Admin / Integrations surface in the UI.
   */
  async listGlobalTabs(): Promise<TabDescriptor[]> {
    const body = await this.req<GlobalTabsResponse>('/api/app/tabs')
    return body?.tabs ?? []
  }

  private async req<T extends { tabs?: TabDescriptor[] }>(path: string): Promise<T | null> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.base_url}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.token}` },
      })
    } catch (err) {
      throw new TabsClientError('network', err instanceof Error ? err.message : 'network error', 0)
    }
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      // fall through to the status-coded error below
    }
    if (!res.ok) {
      const body = json as { code?: string; message?: string } | null
      const code = body?.code ?? 'request_failed'
      const message = body?.message ?? `HTTP ${res.status}`
      throw new TabsClientError(code, message, res.status)
    }
    return json as T | null
  }
}

/**
 * Validate a Core `project_tab` URL before handing it to an `<iframe>`. Only
 * `http(s)` is allowed — `javascript:`, `data:`, and other schemes are rejected
 * so a malformed/hostile manifest entry can't drive a script-injection or
 * local-resource load. Returns the trimmed URL or null. Mirrors
 * `sanitizeCoreTabUrl` in the mobile `app/lib/project-tabs.ts`.
 */
export function sanitizeCoreTabUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return trimmed
}

/**
 * The `app_route` view keys this client implements, keyed by the TERMINAL
 * segment of the descriptor's route path (`/projects/p1/tasks` → `tasks`).
 *
 * An `app_route` tab is a Core-contributed screen that lives IN the client, so
 * the engine cannot know whether a given client ships it — web has no Apps
 * launcher, and a future Core may target only mobile. This set is the web's
 * half of the renderability rule (see `TabMountKind`).
 */
const APP_ROUTE_VIEWS: ReadonlySet<string> = new Set(['tasks'])

/** The `builtin` view targets this client renders (see `TabContent`). */
const BUILTIN_VIEWS: ReadonlySet<string> = new Set([
  'chat',
  'docs',
  'workboard',
  'admin',
  'settings',
])

/** The terminal path segment of an `app_route` target, ignoring any query. */
export function appRouteView(target: string): string {
  const bare = target.split('?')[0] ?? ''
  const parts = bare.split('/').filter((p) => p.length > 0)
  return parts[parts.length - 1] ?? ''
}

/**
 * True when this client can actually render the descriptor's body. Webview tabs
 * always qualify (any http(s) URL can be framed); `builtin` and `app_route`
 * tabs must name a view this bundle ships.
 *
 * Filtering here rather than rendering a placeholder is deliberate: the engine
 * serves ONE tab set to both clients, and a tab that opens onto an empty pane
 * is worse for the owner than a tab that isn't offered.
 */
export function canRenderTab(descriptor: TabDescriptor): boolean {
  if (descriptor.mount.kind === 'webview') return true
  if (descriptor.mount.kind === 'app_route') {
    return APP_ROUTE_VIEWS.has(appRouteView(descriptor.mount.target))
  }
  return BUILTIN_VIEWS.has(descriptor.mount.target)
}
