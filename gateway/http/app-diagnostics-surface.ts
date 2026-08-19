/**
 * @neutronai/gateway/http — diagnostics surface (unit O5 + app remote reports).
 *
 * Owns three routes:
 *
 *   - `GET /api/app/admin/diagnostics`   compose EXISTING per-instance state
 *                                        (gbrain latch, credential-pool health,
 *                                        REPL registry, cron last-fire, import
 *                                        jobs, recent events) into one report so
 *                                        "why is memory / chat / import broken?"
 *                                        is answerable without journalctl.
 *   - `POST /api/app/admin/diagnostics/reports`  accept a batch of CLIENT-side
 *                                        error reports from the owner's mobile
 *                                        app and persist them on the host.
 *   - `GET  /api/app/admin/diagnostics/reports`  read that history back.
 *
 * WHY THE REPORTS ROUTES LIVE HERE
 * --------------------------------
 * Until this landed, the only way to see why the app failed on the owner's
 * phone was to ask them to plug in a USB cable and run `adb logcat`. That cost
 * hours per incident and produced wrong diagnoses. The app now reports to the
 * owner's OWN gateway — no Sentry, no third party, no account — which is the
 * only shape compatible with a self-hosted product.
 *
 * These routes are a deliberate, narrow exception to O5's read-only mandate
 * (below): the POST is an APPEND to a bounded diagnostics log, not a control-
 * plane action like `app-admin-surface.ts`'s `/gateway/restart`. It is
 * owner-gated by the SAME bearer + instance-slug check as the read route —
 * there is no unauthenticated write path, which is precisely why the app keeps
 * a persisted queue and delivers on the next AUTHENTICATED launch instead.
 *
 * WHAT THE REPORTS DO NOT CONTAIN: no bearer, no credential, no header dump, no
 * app configuration. `gateway/diagnostics/client-report-redaction.ts` scrubs
 * every inbound payload again on arrival (the app already scrubbed before
 * sending) so the host never writes a token to disk even if the client is old,
 * modified, or buggy.
 *
 * HONEST LIMIT: this captures JAVASCRIPT errors only. A native crash — e.g. a
 * provider dying during Android process start, before any JS has run — produces
 * NO report, because no JS ever executed to catch it. Those still need logcat
 * or an emulator. See `docs/AS_BUILT.md` § App remote diagnostics.
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
 * READ-ONLY (the O5 report route): the injected `diagnostics` closure composes
 * existing reads only (see `gateway/diagnostics/`). No writes, no
 * degrade-decision changes. The client-reports routes above are the only
 * mutation this surface performs, and it writes to nothing but its own log.
 *
 * `recent_events` reads O4's operational `system_events` journal (unit O4 is
 * now merged — #319), STRICTLY scoped to this instance's slug (see
 * `listRecentForScope`). Project-scoped degrade decisions surface here — e.g.
 * `core_install_failed` (X2's `install-bundled.ts`) and `cron_job_error` (the
 * cron scheduler), both emitted WITH a `project_slug` — so "why is a Core / a
 * scheduled job broken?" is answerable from the journal tail without journalctl.
 *
 * NOT-YET-SURFACED (accepted deferral): several degrade emitters persist their
 * rows with NULL scope — `credential_all_cooldown`, `repl_session_capped`,
 * `import_orphaned` — and NULL is excluded from this instance-scoped read because
 * it is ambiguous (process-wide vs an emitter that omitted its scope) and those
 * payloads carry instance-specific identifiers, so surfacing them would disclose
 * one project's data into another's report. Those faults remain visible through
 * their OWN dedicated diagnostics sections (credentials / repl-registry /
 * import-jobs). Re-including them in `recent_events` needs the emitter-scoping
 * audit (O4 territory) — tracked follow-up.
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
import { sanitizeBatch } from '../diagnostics/client-report-redaction.ts'
import type { ClientReportRecord, ClientReportStore } from '../diagnostics/client-report-store.ts'
import { jsonError, jsonResponse, ownerSlugMismatch, resolveBearer } from './surface-kit.ts'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('app-diagnostics')

const DIAGNOSTICS_PATH = '/api/app/admin/diagnostics'
const REPORTS_PATH = '/api/app/admin/diagnostics/reports'

/**
 * Hard ceiling on a single ingest body. Enforced BEFORE `JSON.parse` so a
 * hostile-but-authenticated caller cannot make the gateway allocate a huge
 * object graph. 128 KiB is ~4x a full 100-event report with long stacks.
 */
export const MAX_REPORT_BODY_BYTES = 128 * 1024

/** Default + ceiling for `GET .../reports?limit=`. */
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200

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
  /**
   * Where accepted client reports are persisted + read back from. REQUIRED —
   * remote diagnostics ships ON, as the product, with no env gate and no
   * "reports disabled" code path to drift out of test coverage.
   */
  client_reports: ClientReportStore
  /** Injectable clock for the `received_at` stamp (tests pin it). */
  now?: () => number
}

export interface AppDiagnosticsSurface {
  /** Returns the `Response` for a diagnostics route, or `null` to fall through. */
  handler: (req: Request) => Promise<Response | null>
}

export function createAppDiagnosticsSurface(
  opts: AppDiagnosticsSurfaceOptions,
): AppDiagnosticsSurface {
  const { auth, project_slug, diagnostics, client_reports } = opts
  const now = opts.now ?? ((): number => Date.now())

  /**
   * Owner-gate — identical to app-admin-surface.ts: a valid bearer that
   * resolves to THIS instance's slug. Unauthenticated / wrong-slug callers must
   * never read internal state, and (for the ingest route) must never be able to
   * write a line into the operator's log.
   *
   * Returns the resolved identity AND the raw presented bearer. The raw token
   * is used for ONE thing: as an exact needle the redactor removes from the
   * payload. It is never logged, never persisted, never echoed.
   */
  const gate = async (
    req: Request,
  ): Promise<{ user_id: string; bearer: string } | Response> => {
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
      // LOG IT. A refused ingest is otherwise perfectly silent on BOTH sides:
      // the client is fire-and-forget, and the operator's only view of this
      // route is the reports file — which stays empty, and an empty file reads
      // exactly like "nothing went wrong". That is how web switch timings
      // reached nobody for a day (2026-08-15) while the owner hand-pasted them
      // into chat. The token is never included: `resolved.code` names WHY
      // without naming the credential.
      moduleLog.warn('report_ingest_refused', { status, code: resolved.code })
      return jsonError(status, resolved.code, resolved.message)
    }
    if (ownerSlugMismatch(resolved.project_slug, project_slug)) {
      // The SECOND refusal branch, and it needs its own line: a wrong-slug
      // bearer never reaches the resolver-error path above, so instrumenting
      // only that one left the most likely real-world refusal — a client
      // presenting a project-scoped token to an owner-scoped route — as silent
      // as before. Caught by the test, not by reading.
      moduleLog.warn('report_ingest_refused', { status: 403, code: 'project_mismatch' })
      return jsonError(
        403,
        'project_mismatch',
        `bearer project '${resolved.project_slug}' does not match gateway project '${project_slug}'`,
      )
    }
    const header = req.headers.get('authorization') ?? ''
    const bearer = header.slice('bearer '.length).trim()
    return { user_id: resolved.user_id, bearer }
  }

  return {
    handler: async (req) => {
      const url = new URL(req.url)

      // The more-specific path is matched FIRST; `/diagnostics` is an exact
      // comparison so the two can never shadow each other, but ordering it
      // this way keeps that independent of how the exact match is written.
      if (url.pathname === REPORTS_PATH) {
        if (req.method === 'POST') return await ingestReports(req)
        if (req.method === 'GET') return await listReports(req, url)
        return jsonError(
          405,
          'method_not_allowed',
          `method '${req.method}' not allowed on ${REPORTS_PATH}`,
        )
      }

      if (url.pathname !== DIAGNOSTICS_PATH) return null

      if (req.method !== 'GET') {
        return jsonError(405, 'method_not_allowed', `method '${req.method}' not allowed on ${DIAGNOSTICS_PATH}`)
      }

      const gated = await gate(req)
      if (gated instanceof Response) return gated

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

  async function ingestReports(req: Request): Promise<Response> {
    const gated = await gate(req)
    if (gated instanceof Response) return gated

    // Cheap pre-check on the declared length, then the authoritative check on
    // what actually arrived (a client may lie about / omit content-length).
    const declared = Number(req.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_REPORT_BODY_BYTES) {
      return jsonError(413, 'payload_too_large', `body exceeds ${MAX_REPORT_BODY_BYTES} bytes`)
    }
    let raw: string
    try {
      raw = await req.text()
    } catch {
      return jsonError(400, 'unreadable_body', 'could not read request body')
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_REPORT_BODY_BYTES) {
      return jsonError(413, 'payload_too_large', `body exceeds ${MAX_REPORT_BODY_BYTES} bytes`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return jsonError(400, 'invalid_json', 'body must be JSON: { reports: [...] }')
    }

    // Redact BEFORE anything else touches the payload — including the presented
    // bearer as an exact needle. Nothing downstream ever sees the raw values.
    const batch = sanitizeBatch(parsed, [gated.bearer])
    if (batch.reports.length === 0) {
      moduleLog.warn('report_ingest_refused', { status: 400, code: 'no_reports' })
      return jsonError(400, 'no_reports', 'body contained no usable reports')
    }

    const received_at = now()
    const records: ClientReportRecord[] = batch.reports.map((report) => ({
      received_at,
      user_id: gated.user_id,
      report,
    }))
    try {
      client_reports.append(records)
    } catch (err) {
      // Fail LOUD: the device keeps its queue on a non-2xx, so a swallowed
      // write here would destroy the only copy of the report.
      return jsonError(
        500,
        'report_persist_failed',
        `could not persist client reports: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return jsonResponse(200, { ok: true, accepted: records.length, dropped: batch.dropped })
  }

  async function listReports(req: Request, url: URL): Promise<Response> {
    const gated = await gate(req)
    if (gated instanceof Response) return gated
    const requested = Number(url.searchParams.get('limit') ?? '')
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_LIST_LIMIT)
      : DEFAULT_LIST_LIMIT
    return jsonResponse(200, { ok: true, reports: client_reports.list(limit) })
  }
}

