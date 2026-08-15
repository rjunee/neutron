/**
 * landing/chat-react — diagnostics ingest client (web).
 *
 * Mirrors the mobile client's base URL + bearer construction and its one method
 * for `POST /api/app/admin/diagnostics/reports`. The bearer is carried only in
 * the Authorization header; report bodies never contain it.
 */

export const REPORTS_PATH = '/api/app/admin/diagnostics/reports'

export interface WebClientReport {
  schema: number
  report_id: string
  created_at: number
  origin: string
  reason: 'perf'
  app: { version: string; build: string | null; platform: 'web'; os_version: string | null }
  session: { signed_in: boolean }
  events: Array<{
    at: number
    level: 'info'
    kind: string
    message: string
    context: Record<string, unknown>
  }>
}

/**
 * A report the server refused. Carries the STATUS, because the status is the
 * whole diagnosis: 401/403 is the bearer, 400 is the payload, 5xx is the box.
 * Without it a caller can only say "sending failed", which is what left this
 * broken silently.
 */
export class DiagnosticsSendError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`diagnostics report rejected: HTTP ${status} from ${path}`)
    this.name = 'DiagnosticsSendError'
  }
}

export interface WebDiagnosticsClientOptions {
  base_url: string
  token: string
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

export class WebDiagnosticsClient {
  private readonly base_url: string
  private readonly token: string
  private readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>

  constructor(opts: WebDiagnosticsClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  /**
   * POST one report. THROWS on a non-2xx, naming the status.
   *
   * It used to `await` the fetch and discard the Response. Combined with the
   * caller's `.catch(() => undefined)` that made a rejected report invisible
   * TWICE, and it stayed that way for as long as anyone looked: measured on the
   * owner's instance 2026-08-15, `diagnostics/client-reports.jsonl` held four
   * reports — all mobile `push_registration_failed`, not one web switch report
   * — while he had spent the day pasting the same switch timings into chat by
   * hand, because the pipeline built so he would not have to was reporting
   * nothing and failing at nothing.
   *
   * ⇒ a fire-and-forget send may drop a REPORT; it may never drop the FACT that
   * it dropped one. The status is the only thing that distinguishes "nothing to
   * report" from "everything rejected".
   */
  async sendReport(report: WebClientReport): Promise<void> {
    const res = await this.fetchImpl(`${this.base_url}${REPORTS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ reports: [report] }),
    })
    if (!res.ok) {
      throw new DiagnosticsSendError(res.status, REPORTS_PATH)
    }
  }
}
