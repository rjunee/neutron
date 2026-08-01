/**
 * landing/chat-react — usage-meter client.
 *
 * One endpoint, one shape: `GET /api/app/usage` answers with the active
 * credential's standing or with a reason there is nothing to show. The server
 * already holds a cached reading, so this is a cheap read the client can repeat
 * on a timer without doing any work upstream.
 *
 * A REJECTED FETCH RESOLVES TO "UNKNOWN", NEVER TO ZERO. An older gateway does
 * not mount this route at all, so a 404 is a perfectly ordinary answer for a
 * client that has been updated ahead of its server — and the only correct
 * response to it is to draw the plain divider, exactly as before the meter
 * existed. Every failure path funnels to the same place.
 */

import { GatewayHttpClient, type GatewayHttpClientOptions } from '@neutronai/client-core'

/** Mirrors `@neutronai/contracts/credential-usage.ts`. Re-declared rather than
 *  imported so the browser bundle keeps no gateway-side dependency — the same
 *  convention `activity-client.ts` and `work-board-client.ts` follow. */
export type UsageUnavailableReason =
  | 'no_credential'
  | 'not_measured_yet'
  | 'unsupported_credential'
  | 'probe_failed'

export type UsagePayload =
  | {
      available: true
      session: number
      weekly: number
      session_reset_at?: number
      weekly_reset_at?: number
      measured_at: number
    }
  | { available: false; reason: UsageUnavailableReason }

/** The answer used whenever the server could not be asked or did not answer in
 *  a shape we recognise. */
export const USAGE_UNKNOWN: UsagePayload = { available: false, reason: 'probe_failed' }

function decodeUsage(raw: unknown): UsagePayload {
  if (typeof raw !== 'object' || raw === null) return USAGE_UNKNOWN
  const rec = raw as Record<string, unknown>
  if (rec['available'] !== true) {
    const reason = rec['reason']
    return typeof reason === 'string'
      ? { available: false, reason: reason as UsageUnavailableReason }
      : USAGE_UNKNOWN
  }
  const session = rec['session']
  const weekly = rec['weekly']
  const measured_at = rec['measured_at']
  if (
    typeof session !== 'number' ||
    typeof weekly !== 'number' ||
    typeof measured_at !== 'number'
  ) {
    // Claims to be available but isn't carrying numbers — treat as unknown
    // rather than coercing, so a malformed payload can never draw a bar.
    return USAGE_UNKNOWN
  }
  return { available: true, session, weekly, measured_at }
}

export class WebUsageClient extends GatewayHttpClient {
  constructor(opts: GatewayHttpClientOptions) {
    super(opts)
  }

  /** Never rejects. A transport error, a 401, or an unmounted route all mean
   *  "no meter", which is a display state rather than an error to surface. */
  async fetchUsage(): Promise<UsagePayload> {
    try {
      const raw = await this.req<unknown>('/api/app/usage')
      return decodeUsage(raw)
    } catch {
      return USAGE_UNKNOWN
    }
  }
}
