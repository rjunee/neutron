/**
 * @neutronai/gateway/http — the active credential's usage standing.
 *
 *   - `GET /api/app/usage` → `CredentialUsagePayload`: either a measured reading
 *     of the 5-hour and 7-day windows, or `{available:false, reason}`.
 *   - `GET /api/app/usage/dashboard` → `{ pools: PoolSummary[] }`: the same two
 *     windows read off the PERSISTED series, with the pace and the projection
 *     that only a series can produce.
 *
 * ── WHY BOTH LIVE IN ONE SURFACE ─────────────────────────────────────────────
 * The meter answers "how full is the window" from a 60-second in-memory
 * snapshot; the dashboard answers "is this going to run out, and when" from the
 * stored history of those same readings. Same concern, same owner gate, same
 * subject — so they get ONE surface with two paths rather than two surfaces that
 * would each need their own composition field, route slot, gate entry and
 * snapshot row. A second near-identical surface is how one of them quietly stops
 * being wired, which is the defect this codebase keeps re-learning.
 *
 * Always 200 on an authenticated request, including when there is nothing to
 * report. "Unknown" is a legitimate answer here, not an error — a fresh install
 * with no credential is a normal state, and making the client distinguish a 404
 * from a 200 to learn that would put the same three-way branch in two clients
 * instead of one payload. The dashboard follows the same rule: an empty series
 * answers with null windows, not with a failure.
 *
 * Owner-gated like every other `/api/app/*` surface: utilization describes the
 * owner's subscription and is nobody else's business.
 */

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { CredentialUsagePayload } from '@neutronai/contracts/credential-usage.ts'
import type { PoolSummary } from '@neutronai/persistence/usage-samples-store.ts'
import { jsonResponse, resolveBearer } from './surface-kit.ts'

const USAGE_PATH = '/api/app/usage'
const DASHBOARD_PATH = '/api/app/usage/dashboard'

export interface AppUsageSurfaceOptions {
  auth: AppWsAuthResolver
  /** Reads the monitor's in-memory snapshot. Never blocks. */
  snapshot: () => CredentialUsagePayload
  /**
   * Summarises the persisted series, one entry per quota pool.
   *
   * An ARRAY even though exactly one pool exists, so a second subscription can
   * be reported later without changing the payload's shape under a client that
   * has already shipped.
   */
  dashboard: () => ReadonlyArray<PoolSummary>
}

export interface AppUsageSurface {
  handler: (req: Request) => Promise<Response | null>
}

export function createAppUsageSurface(opts: AppUsageSurfaceOptions): AppUsageSurface {
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      // Exact matches, both of them. The meter's path is a PREFIX of the
      // dashboard's, so prefix-matching either one would swallow the other —
      // and the failure would be invisible, because the swallowed route would
      // simply answer with the wrong body rather than 404.
      const isMeter = url.pathname === USAGE_PATH
      const isDashboard = url.pathname === DASHBOARD_PATH
      if (!isMeter && !isDashboard) return null
      if (req.method !== 'GET') {
        return jsonResponse(405, {
          ok: false,
          code: 'method_not_allowed',
          message: `expected GET ${url.pathname}, got ${req.method}`,
        })
      }
      const resolved = await resolveBearer(req, opts.auth)
      if ('code' in resolved) {
        const wireCode = resolved.code === 'missing_bearer' ? 'missing_bearer' : 'unauthorized'
        return jsonResponse(401, {
          ok: false,
          code: wireCode,
          message:
            resolved.code === 'missing_bearer' ? resolved.message : 'authentication required',
        })
      }
      if (isDashboard) return jsonResponse(200, { pools: opts.dashboard() })
      return jsonResponse(200, opts.snapshot())
    },
  }
}
