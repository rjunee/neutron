/**
 * @neutronai/gateway/http — the active credential's usage standing.
 *
 *   - `GET /api/app/usage` → `CredentialUsagePayload`: either a measured reading
 *     of the 5-hour and 7-day windows, or `{available:false, reason}`.
 *
 * Always 200 on an authenticated request, including when there is nothing to
 * report. "Unknown" is a legitimate answer here, not an error — a fresh install
 * with no credential is a normal state, and making the client distinguish a 404
 * from a 200 to learn that would put the same three-way branch in two clients
 * instead of one payload.
 *
 * Owner-gated like every other `/api/app/*` surface: utilization describes the
 * owner's subscription and is nobody else's business.
 */

import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type { CredentialUsagePayload } from '@neutronai/contracts/credential-usage.ts'
import { jsonResponse, resolveBearer } from './surface-kit.ts'

const USAGE_PATH = '/api/app/usage'

export interface AppUsageSurfaceOptions {
  auth: AppWsAuthResolver
  /** Reads the monitor's in-memory snapshot. Never blocks. */
  snapshot: () => CredentialUsagePayload
}

export interface AppUsageSurface {
  handler: (req: Request) => Promise<Response | null>
}

export function createAppUsageSurface(opts: AppUsageSurfaceOptions): AppUsageSurface {
  return {
    handler: async (req) => {
      const url = new URL(req.url)
      if (url.pathname !== USAGE_PATH) return null
      if (req.method !== 'GET') {
        return jsonResponse(405, {
          ok: false,
          code: 'method_not_allowed',
          message: `expected GET ${USAGE_PATH}, got ${req.method}`,
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
      return jsonResponse(200, opts.snapshot())
    },
  }
}
