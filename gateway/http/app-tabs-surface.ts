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
   * Composed Cores state (bundled registry + resolved launcher labels). When
   * supplied alongside `installations`, the surface folds installed Cores'
   * `project_tab` surfaces into the resolved tab set. Omit for a builtin-only
   * surface.
   */
  cores?: CoresModuleState
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
  const { auth, cores, installations } = opts
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

      if (isGlobal) {
        const coreTabs =
          cores !== undefined && installations !== undefined
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
        cores !== undefined && installations !== undefined
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

/** Map installed Core slugs → tab contributions via the registry's manifests. */
function coreTabsFromSlugs(
  cores: CoresModuleState,
  slugs: readonly string[],
  project_id: string | null,
): CoreTabContribution[] {
  const out: CoreTabContribution[] = []
  for (const slug of slugs) {
    const core = cores.registry.get(slug)
    if (core === null) continue
    const tabSurface = core.manifest.ui_components.find((c) => c.surface === 'project_tab')
    if (tabSurface === undefined) continue
    const label = cores.launcherIcons.get(slug)?.label ?? slug
    const target =
      project_id === null
        ? tabSurface.entry_point
        : tabSurface.entry_point.replaceAll('<project_id>', project_id)
    out.push({ core_slug: slug, label, target })
  }
  return out
}
