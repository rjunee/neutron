/**
 * @neutronai/app — diagnostics ingest client.
 *
 * Thin fetch wrapper around the owner's OWN gateway
 * (`POST /api/app/admin/diagnostics/reports`, served by
 * `gateway/http/app-diagnostics-surface.ts`). Mirrors the `DevicesClient` /
 * `TasksClient` shape: base URL + bearer at construction, one method per route.
 *
 * There is no third-party endpoint, no SaaS SDK, and no fallback destination.
 * Neutron Open is self-hosted; diagnostics that required an external account
 * would not be the same product.
 */

import type { ClientReport } from './diagnostic-report';

export const REPORTS_PATH = '/api/app/admin/diagnostics/reports';

export interface DiagnosticsClientOptions {
  base_url: string;
  /** The session bearer. Sent as the `Authorization` header and NEVER placed
   *  in a report body — see `lib/diagnostic-redact.ts`. */
  token: string;
  fetchFn?: typeof globalThis.fetch;
}

export interface SendReportsResult {
  ok: boolean;
  status: number;
  accepted: number;
  /** Populated on failure; safe to surface in the UI (carries no credential). */
  message?: string;
}

export class DiagnosticsClient {
  private readonly base_url: string;
  private readonly token: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(opts: DiagnosticsClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  /**
   * Deliver a batch. Resolves a RESULT rather than throwing on a transport
   * failure — the caller (the queue flush) treats "not delivered" as ordinary
   * and retries next launch, so an exception would just be ceremony.
   */
  async sendReports(reports: readonly ClientReport[]): Promise<SendReportsResult> {
    if (reports.length === 0) return { ok: true, status: 200, accepted: 0 };
    try {
      const res = await this.fetchFn(`${this.base_url}${REPORTS_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ reports }),
      });
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          accepted: 0,
          message: `gateway answered ${res.status}`,
        };
      }
      const body = (await res.json().catch(() => null)) as
        | { accepted?: unknown }
        | null;
      // `accepted` is the gateway's own count of what it PERSISTED, and it is
      // what authorises the queue to prune. A 2xx whose body does not carry it
      // came from something other than a Neutron gateway (a proxy, a captive
      // portal), so we report 0 and keep the reports: a stalled queue is
      // recoverable — it is capped and evicts oldest-first — while a wrongly
      // pruned crash report is gone for good.
      const accepted = typeof body?.accepted === 'number' ? body.accepted : 0;
      return { ok: true, status: res.status, accepted };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        accepted: 0,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
