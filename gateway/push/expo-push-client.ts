/**
 * @neutronai/gateway/push — Expo Push API client.
 *
 * P5.6 — thin HTTP wrapper around https://exp.host/--/api/v2/push/send,
 * the public Expo Push API. The Expo client (managed workflow) hands the
 * gateway opaque `ExponentPushToken[...]` strings; this module pushes a
 * batch of `{to, title, body, data?}` messages and surfaces non-OK
 * tickets as logged errors (the v1 brief defers ticket-receipt polling).
 *
 * Key Expo Push API contract points:
 *   * Max 100 messages per HTTP request (we chunk internally).
 *   * 200 OK with `{data: PushTicket[]}` even when individual tickets
 *     report `status: 'error'`. We aggregate errors so the upstream
 *     dispatcher can log them without throwing per-token.
 *   * The endpoint accepts gzipped bodies; we send uncompressed JSON to
 *     keep the implementation small. Typical payload is well under the
 *     1MB limit.
 *
 * Per SPEC.md § Phases→Steps (P5.6) +
 * docs/engineering-plan.md § B.P5.
 */

export const DEFAULT_EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send'

/**
 * The Expo Push API caps a single request at 100 messages.
 * https://docs.expo.dev/push-notifications/sending-notifications/#message-format
 */
export const EXPO_PUSH_BATCH_SIZE = 100

/**
 * One push message in the Expo Push API request body. We only model the
 * fields P5.6 needs — title + body + opaque data payload + sound. The
 * full schema (priority, category, channelId, ttl, badge, etc.) is
 * deliberately omitted; the wow-moment / per-Core push API in M3 can
 * extend this.
 */
export interface ExpoPushMessage {
  /** The opaque `ExponentPushToken[...]` minted by the Expo client. */
  to: string
  /** Notification title — usually the project / agent name. */
  title?: string
  /** Body text — the reminder's stored `message` for v1. */
  body: string
  /**
   * Opaque payload delivered to the client's notification handler.
   * For v1 we ship `{ kind: 'reminder', reminder_id, project_slug }`
   * so the client can deep-link in a follow-up sprint.
   */
  data?: Record<string, unknown>
  /** Optional system sound. 'default' is the conventional opt-in. */
  sound?: 'default' | null
}

/**
 * One ticket entry returned by the Expo Push API per submitted message.
 * Tickets with `status: 'error'` carry a `details.error` reason — most
 * commonly `'DeviceNotRegistered'` (the device uninstalled the app).
 * Our dispatcher logs these so a future cleanup pass can prune dead
 * tokens; v1 does not auto-prune.
 */
export interface ExpoPushTicket {
  status: 'ok' | 'error'
  id?: string
  message?: string
  details?: {
    error?:
      | 'DeviceNotRegistered'
      | 'InvalidCredentials'
      | 'MessageTooBig'
      | 'MessageRateExceeded'
      | 'MismatchSenderId'
      | string
    [k: string]: unknown
  }
}

export interface ExpoPushSendResult {
  /** Tickets in the same order as the submitted messages. */
  tickets: ExpoPushTicket[]
  /** Convenience flag — true iff every ticket reported `ok`. */
  ok: boolean
}

/** Minimal fetch typing so the client is injectable from tests. */
export type ExpoFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean
  status: number
  text: () => Promise<string>
  json: () => Promise<unknown>
}>

export interface ExpoPushClient {
  send(messages: ExpoPushMessage[]): Promise<ExpoPushSendResult>
}

export interface ExpoPushClientOptions {
  endpoint?: string
  /** Optional access token — Expo accepts unauthenticated calls today,
   *  but anonymous traffic is rate-limited; the production gateway sets
   *  EXPO_ACCESS_TOKEN once a Managed account is provisioned. */
  access_token?: string
  /** Inject a fetch impl in tests; defaults to global `fetch`. */
  fetch?: ExpoFetch
  /**
   * Override the batch chunk size for tests. Production stays on the
   * 100-cap default; tests use a tiny number to exercise chunking
   * without manufacturing 200 fake tokens.
   */
  batch_size?: number
}

/**
 * Build an Expo Push API client. The returned `send()` chunks messages
 * into ≤ batch_size batches, POSTs each in sequence (Expo recommends
 * serial requests to stay under their per-second cap), and concatenates
 * the resulting tickets in submission order.
 *
 * Errors:
 *   * Non-200 HTTP from Expo → throws (the dispatcher catches and logs).
 *   * Network failure → throws (same).
 *   * Per-ticket `status: 'error'` → surfaced in the returned tickets;
 *     `ok` flag set to `false`. NOT thrown — partial success is normal
 *     when one device uninstalled the app while others are still active.
 */
export function createExpoPushClient(options: ExpoPushClientOptions = {}): ExpoPushClient {
  const endpoint = options.endpoint ?? DEFAULT_EXPO_PUSH_ENDPOINT
  const fetchImpl: ExpoFetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const batchSize = options.batch_size ?? EXPO_PUSH_BATCH_SIZE
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error('ExpoPushClient: batch_size must be a positive number')
  }
  return {
    async send(messages) {
      if (messages.length === 0) {
        return { tickets: [], ok: true }
      }
      const tickets: ExpoPushTicket[] = []
      for (let i = 0; i < messages.length; i += batchSize) {
        const chunk = messages.slice(i, i + batchSize)
        const headers: Record<string, string> = {
          accept: 'application/json',
          'accept-encoding': 'gzip, deflate',
          'content-type': 'application/json',
        }
        if (options.access_token !== undefined && options.access_token.length > 0) {
          headers.authorization = `Bearer ${options.access_token}`
        }
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(chunk),
        })
        if (!res.ok) {
          const text = await safeText(res)
          throw new ExpoPushError(
            `Expo Push API ${res.status}: ${truncate(text, 200)}`,
            res.status,
          )
        }
        const json = (await res.json()) as { data?: ExpoPushTicket[] } | null
        const data = json?.data ?? []
        if (!Array.isArray(data)) {
          throw new ExpoPushError(
            `Expo Push API returned non-array data: ${JSON.stringify(json).slice(0, 200)}`,
            res.status,
          )
        }
        for (const t of data) tickets.push(t)
      }
      const ok = tickets.every((t) => t.status === 'ok')
      return { tickets, ok }
    },
  }
}

export class ExpoPushError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ExpoPushError'
    this.status = status
  }
}

async function safeText(
  res: { text: () => Promise<string> },
): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
