/**
 * @neutronai/gateway/http — `/api/cores` admin endpoint (P3 cores wire-up).
 *
 * Per `docs/plans/P3-cores-wireup-sprint-brief.md § 3`. Four routes:
 *
 *   - `GET  /api/cores`            → list bundled-Cores catalog + install state.
 *   - `GET  /api/cores/<slug>`     → full manifest + install record.
 *   - `POST /api/cores/install`    → MARK a Core "installed" (see note).
 *   - `POST /api/cores/uninstall`  → MARK a Core "uninstalled" (see note).
 *
 * IMPORTANT — `install` / `uninstall` are MARK-ONLY (Argus PR #210 minor
 * #4, 2026-05-19). They mutate the `core_installations` row's
 * `uninstalled_at` column but do NOT re-run the Core's install lifecycle
 * hook live. The Core only becomes (or stops being) bootable on the
 * NEXT per-instance gateway restart, when `composeProductionGraph` walks
 * the bundled-Cores registry + runs `installBundledCores`. The
 * lighter-weight option vs. wiring the full lifecycle here was chosen
 * because:
 *
 *   1. Live install needs the same 5 deps the OAuth-reinstall path
 *      threads (projectDb, dataDir, secretsStore, ToolRegistry,
 *      backends) plus a `SecretsPrompter` — and a Core declaring a
 *      `required: true` OAuth secret cannot install without a
 *      pre-resolved oauth_token row anyway, so the user would have to
 *      run /api/cores/oauth/google/start FIRST.
 *   2. The Expo client has a `/api/app/admin/gateway/restart` button
 *      (Open-tier) that the UI can surface alongside the install
 *      response: "Restart instance to activate." The mutation surface
 *      returns `requires_restart: true` so the client can render that
 *      hint without polling.
 *
 * Future work: fold the OAuth-reinstall path's `reinstallFailedCore`
 * helper into a shared lifecycle entry so `/api/cores/install` can
 * actually boot the Core in-process. Tracked under the brief's § 3.3
 * "install/uninstall mutation surface" follow-up.
 *
 * Auth: shared bearer-token middleware via `AppWsAuthResolver`. The
 * resolved `project_slug` is what `CoreInstallationsStore.get(project_slug, slug)`
 * keys against. No auth → 401 with the same JSON envelope shape used
 * by `app-admin-surface.ts`.
 */

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import { jsonResponse, resolveBearer } from './surface-kit.ts'
import type {
  CoreInstallationRecord,
} from '@neutronai/cores-runtime/installations-store.ts'
import type { CoreInstallationsStore } from '@neutronai/cores-runtime/installations-store.ts'
import type { BundledCore } from '@neutronai/cores-runtime/bundled-registry.ts'
import type { CoresModuleState } from '../cores/composer-state.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

const PATH_BASE = '/api/cores'

export type CoreInstallState =
  | 'installed'
  | 'failed'
  | 'not_installed'
  | 'install_failed_runtime'
  | 'install_failed_dependency_missing'

/**
 * Per-slug display metadata for the bundled Tier 1 Cores. Kept here
 * (not in each Core's package.json) so the surface returns ready-to-
 * render strings without each Core needing a top-level `description`
 * field on top of its `"neutron"` manifest block. Future Cores added
 * here gain a row in this map; future marketplace Cores will derive
 * `display_name` + `description` from their npm registry metadata.
 *
 * NOT load-bearing — a slug missing from this map falls back to a
 * humanised version of the slug for `display_name` and an empty
 * string for `description`.
 */
export const CORE_DISPLAY_META: Readonly<Record<string, { display_name: string; description: string }>> = {
  notes: {
    display_name: 'Notes',
    description: 'Capture, organize, and recall freeform notes inside chat.',
  },
  tasks_core: {
    display_name: 'Tasks',
    description: 'Track to-dos, due dates, and project priorities.',
  },
  reminders_core: {
    display_name: 'Reminders',
    description: 'Schedule one-off and recurring reminders that fire in chat + push.',
  },
  calendar_core: {
    display_name: 'Calendar',
    description: 'Read, create, and update events on your Google Calendar.',
  },
  email_managed_core: {
    display_name: 'Email',
    description: 'Read, search, and summarize Gmail; prepare drafts (no sending).',
  },
  research_core: {
    display_name: 'Research',
    description: 'Run multi-source web research and return structured summaries.',
  },
  codegen_core: {
    display_name: 'Codegen',
    description: 'Orchestrate code-generation tasks from chat.',
  },
}

export interface CoreSummary {
  slug: string
  package_name: string
  package_version: string
  source: 'bundled'
  root_dir: string
  /** Humanised name for the launcher / admin UI. */
  display_name: string
  /** One-sentence description for the admin UI. */
  description: string
  capabilities: string[]
  tools: Array<{
    name: string
    description: string
    capability_required: string
  }>
  ui_components: Array<{
    name: string
    entry_point: string
    surface: string
    mount_path?: string
  }>
  /** Manifest-declared OAuth secret labels, if any. The admin UI uses
   *  this to route "Connect Google" buttons to the OAuth surface with
   *  the right labels= query param. */
  required_oauth_labels: string[]
  install_state: CoreInstallState
  install_error?: { code: string; message: string }
}

export interface CoreFull extends CoreSummary {
  manifest: BundledCore['manifest']
  installation?: CoreInstallationRecord
}

export interface CoresSurfaceOptions {
  cores: CoresModuleState
  installations: CoreInstallationsStore
  auth: AppWsAuthResolver
  /** Instance slug — required for install/uninstall mutations so the
   *  surface keys its writes to the per-project install row. */
  project_slug?: string
  /** Project DB — required for the `install_state` column reads + writes
   *  added in this sprint. Optional only for back-compat with the prior
   *  read-only shape; production wires it. */
  projectDb?: ProjectDb
}

export interface CoresSurface {
  /** HTTP dispatcher — returns null for non-owned paths so the
   *  compose chain falls through. */
  handler: (req: Request) => Promise<Response | null>
}

export function createCoresSurface(opts: CoresSurfaceOptions): CoresSurface {
  const { cores, installations, auth } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      if (!pathname.startsWith(PATH_BASE)) return null

      // The OAuth surface owns `/api/cores/oauth/*`; let those fall
      // through so the cores-oauth-surface (mounted alongside) picks
      // them up. Returning `null` from this handler routes back to the
      // composed chain.
      if (pathname.startsWith('/api/cores/oauth/')) return null

      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        return jsonResponse(401, {
          ok: false,
          code: resolved.code,
          message: resolved.message,
        })
      }

      if (pathname === PATH_BASE) {
        if (req.method !== 'GET') {
          return jsonResponse(405, {
            ok: false,
            code: 'method_not_allowed',
            message: `${req.method} not allowed on ${PATH_BASE}`,
          })
        }
        return handleList(cores, installations, resolved.project_slug, opts.projectDb)
      }

      // POST /api/cores/install + /api/cores/uninstall — v1 mutates the
      // `core_installations` row's `uninstalled_at`. Bundled Cores
      // auto-install at boot so "install" is mostly a re-mark of an
      // uninstalled row; "uninstall" marks the row + leaves the
      // capability namespace in place (best-effort cleanup happens on
      // the next boot when the lifecycle skip-installs it).
      if (pathname === `${PATH_BASE}/install` && req.method === 'POST') {
        return await handleInstall(req, cores, installations, resolved.project_slug)
      }
      if (pathname === `${PATH_BASE}/uninstall` && req.method === 'POST') {
        return await handleUninstall(req, cores, installations, resolved.project_slug)
      }

      // /api/cores/<slug>
      const detailMatch = /^\/api\/cores\/([A-Za-z0-9_\-]+)\/?$/.exec(pathname)
      if (detailMatch !== null) {
        if (req.method !== 'GET') {
          return jsonResponse(405, {
            ok: false,
            code: 'method_not_allowed',
            message: `${req.method} not allowed on ${pathname}`,
          })
        }
        const slug = detailMatch[1]!
        return handleDetail(cores, installations, resolved.project_slug, slug, opts.projectDb)
      }

      // Path-prefix match but no route matched the shape — 404 with a
      // structured envelope rather than falling through, so a typo
      // doesn't silently 404 against the gateway's default healthz
      // fallback.
      return jsonResponse(404, {
        ok: false,
        code: 'unknown_route',
        message: `no route at ${pathname}`,
      })
    },
  }
}

async function handleInstall(
  req: Request,
  cores: CoresModuleState,
  installations: CoreInstallationsStore,
  project_slug: string,
): Promise<Response> {
  const body = (await safeJson(req)) as { slug?: unknown } | null
  const slug = typeof body?.slug === 'string' ? body.slug : ''
  if (slug.length === 0) {
    return jsonResponse(400, {
      ok: false,
      code: 'missing_slug',
      message: 'body must include a non-empty `slug` field',
    })
  }
  const core = cores.registry.get(slug)
  if (core === null) {
    return jsonResponse(404, {
      ok: false,
      code: 'unknown_core',
      message: `no bundled core with slug=${slug}`,
    })
  }
  // For v1 we treat install as "clear any uninstalled_at marker so the
  // Core is live again on the next boot". The lifecycle's
  // `installations.record` is an upsert that ALSO clears uninstalled_at,
  // so re-running `record(...)` with the current manifest is the
  // simplest write. Anything that previously held the row (capability
  // namespace, sidecar) is intact.
  //
  // Argus PR #210 minor #4 — this is MARK-ONLY. The Core only becomes
  // live on the NEXT gateway restart. Surface `requires_restart: true`
  // so the Expo client renders a "Restart instance to activate" hint
  // alongside the install confirmation rather than letting the user
  // wonder why the launcher tile is still grey.
  await installations.record({
    owner_slug: project_slug,
    core_slug: core.slug,
    package_name: core.package_name,
    package_version: core.package_version,
    capabilities: [...core.manifest.capabilities],
    data_layout: deriveDataLayout(core),
    ...(deriveDataLayout(core) === 'sidecar'
      ? { sidecar_db_path: deriveSidecarPath(core) }
      : {}),
  })
  return jsonResponse(200, {
    ok: true,
    slug: core.slug,
    requires_restart: true,
    restart_hint: 'POST /api/app/admin/gateway/restart to activate this Core',
  })
}

function deriveDataLayout(core: BundledCore): 'tables' | 'sidecar' {
  // Mirror cores/runtime/data-namespace.ts:decideDataLayout shape: any
  // capability of the form `read:<slug>.events` (Calendar) or any
  // non-`.db` resource lands as sidecar. Production lifecycle handles
  // the real call; we're constructing a row, not re-running install.
  // Default to 'tables' for slugs that already shipped with tables.
  for (const cap of core.manifest.capabilities) {
    if (cap.includes('.events') || cap.includes('.messages') || cap.includes('.drafts')) {
      return 'sidecar'
    }
  }
  return 'tables'
}

function deriveSidecarPath(core: BundledCore): string {
  // Placeholder — production install supplies a real path. For the
  // mutation surface, we use a stable derived value so the upsert
  // doesn't trip on CHECK constraints; the actual sidecar is created
  // by lifecycle.allocateCoreNamespace on the next boot.
  return `cores/${core.slug}.db`
}

async function handleUninstall(
  req: Request,
  cores: CoresModuleState,
  installations: CoreInstallationsStore,
  project_slug: string,
): Promise<Response> {
  const body = (await safeJson(req)) as { slug?: unknown } | null
  const slug = typeof body?.slug === 'string' ? body.slug : ''
  if (slug.length === 0) {
    return jsonResponse(400, {
      ok: false,
      code: 'missing_slug',
      message: 'body must include a non-empty `slug` field',
    })
  }
  const core = cores.registry.get(slug)
  if (core === null) {
    return jsonResponse(404, {
      ok: false,
      code: 'unknown_core',
      message: `no bundled core with slug=${slug}`,
    })
  }
  await installations.markUninstalled(project_slug, slug)
  // Argus PR #210 minor #4 — symmetric with /install: uninstall is
  // also mark-only and the Core continues running until the next
  // gateway restart.
  return jsonResponse(200, {
    ok: true,
    slug,
    requires_restart: true,
    restart_hint: 'POST /api/app/admin/gateway/restart to deactivate this Core',
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

async function handleList(
  cores: CoresModuleState,
  installations: CoreInstallationsStore,
  project_slug: string,
  projectDb?: ProjectDb,
): Promise<Response> {
  const ownerRows = await installations.listForProject(project_slug)
  const ownerBySlug = new Map<string, CoreInstallationRecord>()
  for (const r of ownerRows) ownerBySlug.set(r.core_slug, r)
  const installStateBySlug = await loadInstallStates(projectDb, project_slug)

  const summaries: CoreSummary[] = cores.registry.list().map((core) =>
    summarizeCore(core, cores, ownerBySlug.get(core.slug) ?? null, installStateBySlug),
  )
  return jsonResponse(200, { ok: true, cores: summaries })
}

async function handleDetail(
  cores: CoresModuleState,
  installations: CoreInstallationsStore,
  project_slug: string,
  slug: string,
  projectDb?: ProjectDb,
): Promise<Response> {
  const core = cores.registry.get(slug)
  if (core === null) {
    return jsonResponse(404, {
      ok: false,
      code: 'unknown_core',
      message: `no bundled core with slug=${slug}`,
    })
  }
  const installation = await installations.get(project_slug, slug)
  const installStateBySlug = await loadInstallStates(projectDb, project_slug)
  const summary = summarizeCore(core, cores, installation, installStateBySlug)
  const body: CoreFull = {
    ...summary,
    manifest: core.manifest,
    ...(installation !== null ? { installation } : {}),
  }
  return jsonResponse(200, { ok: true, core: body })
}

async function loadInstallStates(
  projectDb: ProjectDb | undefined,
  project_slug: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (projectDb === undefined) return out
  try {
    const rows = projectDb
      .all<{ core_slug: string; install_state: string }, [string]>(
        `SELECT core_slug, install_state FROM core_installations WHERE project_slug = ?`,
        [project_slug],
      )
    for (const r of rows) {
      if (typeof r.install_state === 'string') out.set(r.core_slug, r.install_state)
    }
  } catch {
    // best-effort — older DBs without the install_state column return
    // empty map; surface still works on the in-memory `installed` map.
  }
  return out
}

function summarizeCore(
  core: BundledCore,
  cores: CoresModuleState,
  installation: CoreInstallationRecord | null,
  installStateBySlug: Map<string, string>,
): CoreSummary {
  // Priority: failed > install_state column > installed > not_installed.
  // A Core can only be in `failures` when this boot's install lifecycle
  // threw; that takes precedence over a stale `core_installations` row.
  // The `install_state` column lets the OAuth disconnect / refresh-
  // invalid-grant paths flag a Core as needing reconnection without
  // re-running install.
  const failure = cores.failures.find((f) => f.core_slug === core.slug)
  let install_state: CoreInstallState
  if (failure !== undefined) {
    install_state = 'failed'
  } else {
    const stored = installStateBySlug.get(core.slug)
    if (stored === 'install_failed_dependency_missing') {
      install_state = 'install_failed_dependency_missing'
    } else if (stored === 'install_failed_runtime') {
      install_state = 'install_failed_runtime'
    } else if (
      cores.installed.has(core.slug) ||
      (installation !== null && installation.uninstalled_at === null)
    ) {
      install_state = 'installed'
    } else {
      install_state = 'not_installed'
    }
  }

  const meta = CORE_DISPLAY_META[core.slug] ?? {
    display_name: humaniseSlug(core.slug),
    description: '',
  }
  const required_oauth_labels = core.manifest.secrets
    .filter((s) => s.kind === 'oauth_token' && s.required)
    .map((s) => s.label)

  return {
    slug: core.slug,
    package_name: core.package_name,
    package_version: core.package_version,
    source: 'bundled',
    root_dir: core.rootDir,
    display_name: meta.display_name,
    description: meta.description,
    capabilities: [...core.manifest.capabilities],
    tools: core.manifest.tools.map((t) => ({
      name: t.name,
      description: t.description,
      capability_required: t.capability_required,
    })),
    ui_components: core.manifest.ui_components.map((c) => ({
      name: c.name,
      entry_point: c.entry_point,
      surface: c.surface,
      ...(c.mount_path !== undefined ? { mount_path: c.mount_path } : {}),
    })),
    required_oauth_labels,
    install_state,
    ...(failure !== undefined
      ? { install_error: { code: failure.code, message: failure.message } }
      : {}),
  }
}

function humaniseSlug(slug: string): string {
  return slug
    .replace(/_/g, ' ')
    .replace(/\bcore\b/i, '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/(^|\s)\S/g, (m) => m.toUpperCase())
}

