/**
 * @neutronai/gateway/http — Expo/web-app TAB RESOLVER surface (WAVE 3).
 *
 * Per `docs/plans/wave3-tabbed-interface-build-plan.md` § 3.1-3.2. Both
 * clients (mobile RN + web React) fetch their tab set from the engine rather
 * than hardcoding it. Two read-only routes:
 *
 *   - `GET /api/app/projects/<project_id>/tabs`  → ordered project-scope tabs
 *   - `GET /api/app/tabs`                         → ordered global-scope tabs
 *
 * The payload unions BUILTIN descriptors (Chat/Documents/Tasks per-project;
 * Admin global — see `tabs/registry.ts`) with CORE-contributed tabs: the
 * `project_tab` surfaces of Cores installed in the relevant scope. Per-project
 * Cores come from `core_installations`; global Cores from
 * `core_global_installations` (WAVE 3 PR-2).
 *
 * ── Always on (no flag) ─────────────────────────────────────────────────
 * The routes serve unconditionally. Per the SPEC Decisions Log (Ryan,
 * 2026-06-23) WAVE 3 ships WITHOUT feature flags — the PR-1 `enabled` gate
 * (`NEUTRON_TABS_REGISTRY`) is removed. The handler still returns `null` for
 * NON-owned paths so the compose-chain keeps walking downstream (that is path
 * dispatch, not a flag).
 *
 * Core resolution is OPTIONAL: when `cores` + `installations` are supplied the
 * surface folds in Core tabs; when omitted it serves builtins only (a minimal
 * deployment with no Cores wired is still well-formed).
 *
 * Auth shares the app-ws surface contract (Bearer token resolved by
 * `AppWsAuthResolver`), identical to the sibling `/api/app/projects/<id>/*`
 * surfaces. The per-project route additionally validates `project_id`.
 */

import { sanitizeProjectId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { CoreInstallationsStore } from '@neutronai/cores-runtime/installations-store.ts'
import type { CoresModuleState } from '../cores/composer-state.ts'
import {
  resolveGlobalTabs,
  resolveProjectTabs,
  type CoreTabContribution,
} from '@neutronai/tabs/registry.ts'
import { jsonResponse, resolveBearer } from './surface-kit.ts'

export interface AppTabsSurfaceOptions {
  auth: AppWsAuthResolver
  /**
   * LATE-BOUND composed Cores state (bundled registry + resolved launcher
   * labels). When it resolves non-null alongside `installations`, the surface
   * folds installed Cores' tab surfaces into the resolved set. Omit (or
   * resolve null) for a builtin-only surface.
   *
   * A GETTER, not the state itself, and that is load-bearing: the composition
   * root builds this surface long BEFORE `graph.compose()` runs, so the Cores
   * state does not exist yet at construction time. Passing the value directly
   * is what stranded Core tabs at `[]` forever — the composer had nothing to
   * pass, so it passed nothing. The composer now seeds a ref from the
   * `on_cores_ready` post-compose hook and hands the reader in here; the first
   * `/tabs` request after boot sees the live registry.
   */
  cores?: () => CoresModuleState | null
  /**
   * Core installations store — the source of which Cores are installed
   * per-project (`core_installations`) and globally
   * (`core_global_installations`). Required for the Core union; omit for a
   * builtin-only surface.
   */
  installations?: CoreInstallationsStore
}

export interface AppTabsSurface {
  /**
   * HTTP route dispatcher. Returns the `Response` for an owned route, or
   * `null` to indicate the request belongs to a sibling surface. Caller
   * (`compose.ts`) chains downstream.
   */
  handler: (req: Request) => Promise<Response | null>
}

/** Exact-match path for the global tab set. */
const GLOBAL_TABS_PATH = '/api/app/tabs'
/** Matches `/api/app/projects/<project_id>/tabs`; project id is group [1]. */
const PROJECT_TABS_PATH_RE = /^\/api\/app\/projects\/([^/]+)\/tabs$/

export function createAppTabsSurface(opts: AppTabsSurfaceOptions): AppTabsSurface {
  const { auth, cores: readCores, installations } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname

      const isGlobal = pathname === GLOBAL_TABS_PATH
      const projectMatch = PROJECT_TABS_PATH_RE.exec(pathname)
      if (!isGlobal && projectMatch === null) return null

      const method = req.method
      if (method !== 'GET') {
        return jsonResponse(405, {
          ok: false,
          code: 'method_not_allowed',
          message: `method '${method}' not allowed on the tabs surface (GET only)`,
        })
      }

      // Bearer auth — routed inside the surface so the unauth response shape
      // matches the sibling app surfaces (consistent JSON envelope).
      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonResponse(401, { ok: false, code: resolved.code, message: resolved.message })
      }

      // Resolved PER REQUEST, not once at construction: the Cores state lands
      // asynchronously after `graph.compose()`, so a boot-time read would
      // permanently latch the pre-compose `null`.
      const cores = readCores?.() ?? null

      if (isGlobal) {
        const coreTabs =
          cores !== null && installations !== undefined
            ? await gatherGlobalCoreTabs(cores, installations)
            : []
        const tabs = resolveGlobalTabs(coreTabs)
        return jsonResponse(200, { ok: true, scope: 'global', tabs })
      }

      // Per-project route — validate the path-supplied project id.
      const raw_project_id = projectMatch![1] ?? ''
      const project_id = sanitizeProjectId(raw_project_id)
      if (project_id === null) {
        return jsonResponse(400, {
          ok: false,
          code: 'invalid_project_id',
          message: 'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
        })
      }
      const coreTabs =
        cores !== null && installations !== undefined
          ? await gatherProjectCoreTabs(cores, installations, resolved.project_slug, project_id)
          : []
      const tabs = resolveProjectTabs(coreTabs)
      return jsonResponse(200, { ok: true, scope: 'project', project_id, tabs })
    },
  }
}

/**
 * Per-project Core tabs: live installs in `project_slug` (from
 * `core_installations`) whose manifest declares a `project_tab` surface. The
 * `<project_id>` placeholder in the surface entry is substituted to the
 * concrete project.
 */
async function gatherProjectCoreTabs(
  cores: CoresModuleState,
  installations: CoreInstallationsStore,
  project_slug: string,
  project_id: string,
): Promise<CoreTabContribution[]> {
  const installs = await installations.listLive(project_slug)
  return coreTabsFromSlugs(cores, installs.map((r) => r.core_slug), project_id)
}

/**
 * Global Core tabs: live GLOBAL installs (from `core_global_installations`)
 * whose manifest declares a `project_tab` surface. No single project, so the
 * `<project_id>` placeholder is left intact for the client to substitute.
 */
async function gatherGlobalCoreTabs(
  cores: CoresModuleState,
  installations: CoreInstallationsStore,
): Promise<CoreTabContribution[]> {
  const installs = await installations.listGlobalLive()
  return coreTabsFromSlugs(cores, installs.map((r) => r.core_slug), null)
}

/**
 * Read a `const` string out of a ui_component's `props_schema`. The manifest
 * schema types `props_schema` as a free-form JSON-Schema document, so the walk
 * is defensive at every hop — a Core with a malformed or absent schema yields
 * `null` and simply contributes no tab rather than crashing the resolver for
 * every OTHER Core in the list.
 */
function propConst(schema: unknown, prop: string): string | null {
  if (typeof schema !== 'object' || schema === null) return null
  const props = (schema as { properties?: unknown }).properties
  if (typeof props !== 'object' || props === null) return null
  const entry = (props as Record<string, unknown>)[prop]
  if (typeof entry !== 'object' || entry === null) return null
  const value = (entry as { const?: unknown }).const
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Same walk, for the numeric `order` const. */
function propConstNumber(schema: unknown, prop: string): number | null {
  if (typeof schema !== 'object' || schema === null) return null
  const props = (schema as { properties?: unknown }).properties
  if (typeof props !== 'object' || props === null) return null
  const entry = (props as Record<string, unknown>)[prop]
  if (typeof entry !== 'object' || entry === null) return null
  const value = (entry as { const?: unknown }).const
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Map installed Core slugs → tab contributions via the registry's manifests.
 *
 * TWO surfaces contribute, and they differ in what `target` means:
 *
 *   - `project_tab` → a webview. `entry_point` is the URL to frame.
 *   - `app_tab`     → a client-native screen. The route path comes from
 *     `props_schema.properties.path.const`, NOT from `entry_point` — the
 *     entry_point of an `app_tab` is a SOURCE FILE inside the Core package
 *     (`./src/ui/app-tab-surface.ts`), which is meaningless to a client. Every
 *     bundled UI Core declares `app_tab`, so reading `entry_point` here is
 *     what would have shipped a tab pointing at a TypeScript path.
 *
 * `label`/`order` prefer the manifest's own consts (the Core's authoring
 * intent) and fall back to the launcher-icon label, then the slug.
 */
function coreTabsFromSlugs(
  cores: CoresModuleState,
  slugs: readonly string[],
  project_id: string | null,
): CoreTabContribution[] {
  const out: CoreTabContribution[] = []
  for (const slug of slugs) {
    const core = cores.registry.get(slug)
    if (core === null) continue
    const iconLabel = cores.launcherIcons.get(slug)?.label
    const substitute = (raw: string): string =>
      project_id === null ? raw : raw.replaceAll('<project_id>', project_id)

    const webviewSurface = core.manifest.ui_components.find((c) => c.surface === 'project_tab')
    if (webviewSurface !== undefined) {
      out.push({
        core_slug: slug,
        label: iconLabel ?? slug,
        target: substitute(webviewSurface.entry_point),
      })
      continue
    }

    const appTabSurface = core.manifest.ui_components.find((c) => c.surface === 'app_tab')
    if (appTabSurface === undefined) continue
    const path = propConst(appTabSurface.props_schema, 'path')
    // No declared path ⇒ nothing a client could navigate to. Skip rather than
    // guessing a route: a fabricated path renders an error screen, and the
    // Core's launcher tile remains a working way in.
    if (path === null) continue
    const order = propConstNumber(appTabSurface.props_schema, 'order')
    out.push({
      core_slug: slug,
      label: propConst(appTabSurface.props_schema, 'label') ?? iconLabel ?? slug,
      target: substitute(path),
      mount_kind: 'app_route',
      ...(order !== null ? { order } : {}),
    })
  }
  return out
}
