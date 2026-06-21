/**
 * @neutron/chat-core — shared, transport-agnostic types.
 *
 * The append-only chat-sync model (research doc §5/§7): every message is
 * immutable, single-author, and ordered by a server-assigned monotonic
 * per-topic `seq`. Clients de-duplicate on a stable identity
 * (`client_msg_id` for user sends, `message_id` otherwise), order by `seq`
 * (NEVER by clock), and reconcile their optimistic bubble when the server
 * echo carries the same `client_msg_id`.
 */

export type MessageRole = 'user' | 'agent'

/**
 * Lifecycle of a locally-originated message:
 *  - `queued` — written to the local store, not yet handed to the socket
 *    (offline, or buffered before flush).
 *  - `sent`   — handed to the socket; awaiting the server echo.
 *  - `acked`  — the server echo (with `seq` + `message_id`) has reconciled
 *    it. Inbound agent/user messages from the server are born `acked`.
 */
export type SendStatus = 'queued' | 'sent' | 'acked'

/**
 * The canonical local representation of a chat message. Nullable (not
 * optional) fields keep construction trivial under
 * `exactOptionalPropertyTypes` and map cleanly to SQL columns in a Store
 * implementation.
 */
export interface ChatMessage {
  topic_id: string
  /** Stable client idempotency key. Always present — generated on enqueue
   *  for user sends; for inbound agent messages we synthesize one from the
   *  server `message_id` so every row has a uniform primary identity. */
  client_msg_id: string
  /** Server-assigned id; null until the server echoes. */
  message_id: string | null
  /** Monotonic per-topic sequence; null until the server assigns one. */
  seq: number | null
  role: MessageRole
  body: string
  project_id: string | null
  attachments: readonly string[] | null
  created_at: number
  status: SendStatus
}

/**
 * A normalized inbound chat envelope as the sync engine consumes it. The WS
 * client parses raw JSON; {@link normalizeInbound} maps the app-ws wire
 * envelopes (`user_message` echo / `agent_message`) into this shape. Control
 * envelopes (`session_ready`, `error`, typing brackets) are NOT messages and
 * normalize to `null`.
 */
export interface InboundChatMessage {
  role: MessageRole
  message_id: string
  seq: number | null
  body: string
  client_msg_id: string | null
  project_id: string | null
  attachments: readonly string[] | null
  created_at: number
}

/** Wire envelope a client sends to deliver a user message. */
export interface OutboundUserMessage {
  v: 1
  type: 'user_message'
  body: string
  client_msg_id: string
  project_id?: string
  attachments?: readonly string[]
}

/** Wire envelope a client sends to request a gap-fill replay. */
export interface OutboundResume {
  v: 1
  type: 'resume'
  after_seq: number
}

/**
 * Normalize a parsed server frame into an {@link InboundChatMessage}, or
 * `null` when the frame is not a renderable message (control frame, wrong
 * shape, missing required fields). Defensive by design: a malformed field
 * drops the frame rather than throwing, mirroring the server decoder's
 * "wrong shape → drop" posture.
 */
export function normalizeInbound(raw: unknown): InboundChatMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  const type = e['type']
  let role: MessageRole
  if (type === 'user_message') role = 'user'
  else if (type === 'agent_message') role = 'agent'
  else return null

  const message_id = e['message_id']
  if (typeof message_id !== 'string' || message_id.length === 0) return null
  const body = typeof e['body'] === 'string' ? (e['body'] as string) : ''

  let seq: number | null = null
  const rawSeq = e['seq']
  if (typeof rawSeq === 'number' && Number.isFinite(rawSeq)) {
    seq = Math.trunc(rawSeq)
  }

  let client_msg_id: string | null = null
  const rawCmid = e['client_msg_id']
  if (typeof rawCmid === 'string' && rawCmid.length > 0) client_msg_id = rawCmid

  let project_id: string | null = null
  const rawPid = e['project_id']
  if (typeof rawPid === 'string' && rawPid.length > 0) project_id = rawPid

  let attachments: readonly string[] | null = null
  const rawAtt = e['attachments']
  if (Array.isArray(rawAtt)) {
    const cleaned = rawAtt.filter((x): x is string => typeof x === 'string')
    if (cleaned.length > 0) attachments = cleaned
  }

  let created_at = 0
  const rawTs = e['ts']
  if (typeof rawTs === 'number' && Number.isFinite(rawTs)) created_at = rawTs

  return { role, message_id, seq, body, client_msg_id, project_id, attachments, created_at }
}

/**
 * Stable primary identity for a message: the client idempotency key when
 * present, else the server message id. Used by the Store to collapse the
 * optimistic bubble and the server echo into one row, and to de-dup a
 * re-delivered message.
 */
export function messageIdentity(
  client_msg_id: string | null | undefined,
  message_id: string | null | undefined,
): string | null {
  if (client_msg_id !== null && client_msg_id !== undefined && client_msg_id.length > 0) {
    return `c:${client_msg_id}`
  }
  if (message_id !== null && message_id !== undefined && message_id.length > 0) {
    return `m:${message_id}`
  }
  return null
}
