/**
 * @neutronai/gateway/http — read-only diagnostics surface (unit O5).
 *
 * Owns exactly ONE route:
 *
 *   - `GET /api/app/admin/diagnostics`   compose EXISTING per-instance state
 *                                        (gbrain latch, credential-pool health,
 *                                        REPL registry, cron last-fire, import
 *                                        jobs, recent events) into one report so
 *                                        "why is memory / chat / import broken?"
 *                                        is answerable without journalctl.
 *
 * WHY A DEDICATED SURFACE (not a route on `app-admin-surface.ts`)
 * --------------------------------------------------------------
 * The `/api/app/admin/*` family (`app-admin-surface.ts`) is currently UNMOUNTED
 * in Open — `createAppAdminSurface` is never wired into `open/composer.ts`, so
 * its side-effectful routes (`POST /gateway/restart`, max-oauth mint, project-
 * backup mutations) are dead. Mounting that whole surface to add one read-only
 * route would resurrect those write routes — a behaviour change outside O5's
 * additive / read-only mandate. This surface mounts ONLY the read-only
 * diagnostics route, owner-gated with the SAME bearer + instance-slug gate the
 * admin surface uses, and returns `null` for every other path so it never
 * shadows a sibling (including `/healthz`, which stays byte-identical).
 *
 * READ-ONLY: the injected `diagnostics` closure composes existing reads only
 * (see `gateway/diagnostics/`). No writes, no degrade-decision changes.
 *
 * `recent_events` reads O4's operational `system_events` journal (unit O4 is
 * now merged — #319). That journal already carries every band's deliberate
 * silent-degrade decisions, so `core_install_failed` (emitted by X2's
 * `install-bundled.ts`), `credential_all_cooldown`, `repl_session_capped`,
 * `cron_job_error`, `import_orphaned`, … all surface here for free — the
 * question "why is memory / chat / import / a Core broken?" is answerable from
 * the journal tail without journalctl.
 *
 * HONEST PARTIAL — remaining accepted deferrals (tracked follow-ups):
 *   - a DEDICATED `core_install` section (beyond the `core_install_failed`
 *     rows already in `recent_events`) → `CoresModuleState.failures` is
 *     in-process graph-module state built by `installBundledCores` DEEP in
 *     `composeProductionGraph`, with no read handle at this composer seam.
 *     Threading a bespoke graph ref just to duplicate what the journal already
 *     shows would be a cross-module change beyond O5's additive/read-only
 *     mandate; consume X2's `/api/cores` degraded surface in a follow-up.
 *   - `GET /healthz?deep=1` → the default `/healthz` is served by the boot
 *     shell's terminal `defaultHealthzHandler` (`gateway/index.ts`), which
 *     holds only `{ project_slug, bootedAt }`. A deep variant would thread a
 *     diagnostics provider through the composition contract into the boot shell
 *     AND — since `/healthz` is UNAUTHENTICATED (load-balancer liveness) —
 *     demands a deliberate coarse-summary-vs-full-report decision so it cannot
 *     leak internal state (latch reasons, credential cooldowns, REPL pids). The
 *     full report is already reachable owner-gated at this endpoint + via
 *     `neutron doctor`; deferred rather than half-built.
 *   - REPL `lastDataAt` → needs a persistence decision (it is an in-memory
 *     PtySession field, absent from repl-registry.json, unreachable off-process);
 *     surfacing it would be a behaviour change, out of O5's read-only scope. The
 *     repl_sessions section omits it rather than render a fabricated timestamp.
 */

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { DiagnosticsReport } from '../diagnostics/diagnostics-report.ts'
import { jsonError, jsonResponse, ownerSlugMismatch, resolveBearer } from './surface-kit.ts'

const DIAGNOSTICS_PATH = '/api/app/admin/diagnostics'

export interface AppDiagnosticsSurfaceOptions {
  auth: AppWsAuthResolver
  /** Per-instance slug — the bearer must resolve to THIS slug (instance boundary). */
  project_slug: string
  /**
   * Compose the read-only diagnostics report from in-process state. Evaluated
   * at request time so every section reflects live state. Fail-soft: individual
   * sections degrade to `{ available: false }` internally; a throw here is
   * caught and surfaced as a 500 so a broken source never crashes the process.
   */
  diagnostics: () => Promise<DiagnosticsReport> | DiagnosticsReport
}

export interface AppDiagnosticsSurface {
  /** Returns the `Response` for the diagnostics route, or `null` to fall through. */
  handler: (req: Request) => Promise<Response | null>
}

export function createAppDiagnosticsSurface(
  opts: AppDiagnosticsSurfaceOptions,
): AppDiagnosticsSurface {
  const { auth, project_slug, diagnostics } = opts
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      if (url.pathname !== DIAGNOSTICS_PATH) return null

      if (req.method !== 'GET') {
        return jsonError(405, 'method_not_allowed', `method '${req.method}' not allowed on ${DIAGNOSTICS_PATH}`)
      }

      // Owner-gate — identical to app-admin-surface.ts: a valid bearer that
      // resolves to THIS instance's slug. Unauthenticated / wrong-slug callers
      // must never read internal state.
      const resolved = await resolveBearer(req, auth)
      if ('code' in resolved) {
        // The real HS256 resolver performs the instance-slug cross-check
        // INTERNALLY and returns `project_mismatch` as an auth error (before it
        // ever yields an identity). That is an authorization / instance-boundary
        // failure — surface it as 403, matching the explicit `ownerSlugMismatch`
        // branch below (which covers a resolver whose own slug differs, e.g.
        // dev-bypass). Every other resolver error (missing / malformed / expired
        // / bad-signature token) is an AUTHENTICATION failure → 401.
        const status = resolved.code === 'project_mismatch' ? 403 : 401
        return jsonError(status, resolved.code, resolved.message)
      }
      if (ownerSlugMismatch(resolved.project_slug, project_slug)) {
        return jsonError(
          403,
          'project_mismatch',
          `bearer project '${resolved.project_slug}' does not match gateway project '${project_slug}'`,
        )
      }

      let report: DiagnosticsReport
      try {
        report = await diagnostics()
      } catch (err) {
        return jsonError(
          500,
          'diagnostics_failed',
          `diagnostics composition failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      return jsonResponse(200, { ok: true, diagnostics: report as unknown as Record<string, unknown> })
    },
  }
}

