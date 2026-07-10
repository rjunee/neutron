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
 * HONEST PARTIAL — deferred sections (accepted deferrals, tracked follow-ups):
 * O5 surfaces every source reachable read-only from this seam. Three spec items
 * are DELIBERATELY not surfaced here because each is blocked on other work, and
 * forcing them would breach the additive/read-only mandate or fabricate data:
 *   - core_install failures → after unit X2 (`defineCore()` manifest⊄handlers
 *     hard-fail / `/api/cores` degraded surface). `CoresModuleState.failures` is
 *     in-process graph-module state with no read handle at this seam; consume
 *     X2's surface in a follow-up instead of threading a bespoke graph ref now.
 *   - system_events rename → after unit O4 (which creates `system_events`). The
 *     events section reads `gateway_events` (onboarding/gateway telemetry) and is
 *     LABELLED as such — it is NOT the operational system_events journal yet.
 *   - REPL `lastDataAt` → needs a persistence decision (it is an in-memory
 *     PtySession field, absent from repl-registry.json, unreachable off-process);
 *     surfacing it would be a behaviour change, out of O5's read-only scope. The
 *     repl_sessions section omits it rather than render a fabricated timestamp.
 */

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { DiagnosticsReport } from '../diagnostics/diagnostics-report.ts'
import { ownerSlugMismatch } from './auth-helpers.ts'

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

interface ResolvedAuth {
  user_id: string
  project_slug: string
}

interface AuthFailure {
  code: string
  message: string
}

async function resolveBearer(
  req: Request,
  auth: AppWsAuthResolver,
): Promise<ResolvedAuth | AuthFailure> {
  const header = req.headers.get('authorization') ?? ''
  if (!header.toLowerCase().startsWith('bearer ')) {
    return { code: 'missing_bearer', message: 'expected Authorization: Bearer <token>' }
  }
  const token = header.slice('bearer '.length).trim()
  const resolved = await auth.resolve(token)
  if ('code' in resolved) return { code: resolved.code, message: resolved.message }
  return { user_id: resolved.user_id, project_slug: resolved.project_slug }
}

function jsonError(status: number, code: string, message: string): Response {
  return jsonResponse(status, { ok: false, code, message })
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
