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

  async sendReport(report: WebClientReport): Promise<void> {
    await this.fetchImpl(`${this.base_url}${REPORTS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ reports: [report] }),
    })
  }
}
