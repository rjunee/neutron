/**
 * @neutronai/channels/app-ws — wire envelopes for the Expo-app WebSocket
 * surface (P5.1 + P5.2).
 *
 * The shape is intentionally a strict superset of the existing landing
 * `ChatOutbound` (`type: 'agent_message'` etc.) so the Expo client and
 * the landing `chat.ts` client can converge on a single renderer in a
 * later P5 sprint without breaking either surface today.
 *
 * Versioning: every envelope carries `v: 1`. Future envelopes that
 * introduce breaking field shapes bump `v` and ship a new union
 * member — the Expo client drops envelopes whose `v` it doesn't
 * understand.
 *
 * P5.2 — every inbound and outbound envelope (except the synthetic
 * `error` envelope) carries an optional `project_id`. The client
 * tags messages with the active project; the gateway stashes the
 * value on the AppWsAdapter session and echoes it back so the client
 * shows the message in the right project transcript. Per-project
 * routing inside the agent loop is a later P5.x concern — for now
 * the gateway just round-trips the value (sprint roadmap § 4 / P5.2
 * out-of-scope note).
 */

export interface AppWsInboundUserMessage {
  v: 1
  type: 'user_message'
  body: string
  /** Client-generated id used for echo correlation (optional). */
  client_msg_id?: string
  /** P5.2 — project this message belongs to. Optional for back-compat. */
  project_id?: string
  /**
   * P5.1 — image attachment URLs uploaded before the send. The client
   * uploads each attachment via the gateway's upload endpoint, then
   * the returned URL rides on this field. Capped at 8 entries / 512
   * chars per URL by `decodeAppWsInbound` so a malformed client can't
   * push huge arrays through the wire.
   */
  attachments?: ReadonlyArray<string>
}

/**
 * Chat-sync foundation (Phase 1) — gap-fill request. A reconnecting (or
 * second) device sends `{ v:1, type:'resume', after_seq:N }` and the surface
 * replays `WHERE topic_id = ? AND seq > N ORDER BY seq` from the durable
 * message log so the client fills the gap it missed while the socket was
 * down. `after_seq:0` (a cold client with an empty local store) replays the
 * whole transcript (bounded by the server's replay page size).
 */
export interface AppWsInboundResume {
  v: 1
  type: 'resume'
  /** Highest server `seq` the client has already applied locally. */
  after_seq: number
}

/**
 * Track B Phase 4 (delivery + read receipts) — a client reports it has READ
 * (viewed) a message. Delivery is server-tracked (recorded for every connected
 * device at fan-out time), so the only receipt a client sends is `read`. The
 * server attributes it to the SOCKET's device id (stashed at upgrade) — the
 * client never self-reports a device id here, so it can't forge another
 * device's receipt. `seq` is the message's server seq when the client knows it
 * (orders/scopes the replay); omitted otherwise.
 */
export interface AppWsInboundReceipt {
  v: 1
  type: 'receipt'
  message_id: string
  state: 'read'
  seq?: number
}

export type AppWsInbound = AppWsInboundUserMessage

export interface AppWsOutboundSessionReady {
  v: 1
  type: 'session_ready'
  user_id: string
  project_slug: string
  topic_id: string
  ts: number
  /** P5.2 — project_id carried on the upgrade query string. */
  project_id?: string
  /**
   * Chat-sync foundation — the highest persisted `seq` for this topic at
   * connect time. Lets a client that already holds the full transcript skip
   * an unnecessary `resume` round-trip (it only resumes when its local
   * cursor < `last_seen_seq`). Absent when the topic has no persisted
   * messages or the durable log isn't wired.
   */
  last_seen_seq?: number
}

export interface AppWsOutboundUserMessageEcho {
  v: 1
  type: 'user_message'
  user_id: string
  body: string
  message_id: string
  ts: number
  /** Echoed back when the inbound carried one. Lets the client correlate. */
  client_msg_id?: string
  /** P5.2 — echoed so the client can show the message in the right project. */
  project_id?: string
  /** P5.1 — echoed attachments so the optimistic bubble can reconcile. */
  attachments?: ReadonlyArray<string>
  /**
   * Chat-sync foundation — monotonic per-topic sequence assigned on persist.
   * The client orders by `seq` (never by clock) and advances its resume
   * cursor to `max(seq)`. Absent when the durable log isn't wired (legacy
   * in-memory-only behaviour).
   */
  seq?: number
  /**
   * Track B Phase 4 — receipt aggregate carried inline on the message. The
   * server records `delivered` for every device connected at fan-out time and
   * stamps the list here (so a receiving device knows it's been delivered);
   * `read_by` is folded on replay so a reconnecting device sees current read
   * state. Both absent when the receipt log isn't wired.
   */
  delivered_by?: ReadonlyArray<string>
  read_by?: ReadonlyArray<string>
}

export interface AppWsOutboundAgentMessageOption {
  label: string
  body: string
  value: string
  image_url?: string
  decoration?: {
    style?: 'default' | 'destructive' | 'primary'
    icon_custom_emoji_id?: string
  }
}

export interface AppWsOutboundAgentMessageDocRef {
  /** Human-readable label rendered next to the link in the client. */
  label: string
  /** Channel-resolved URL — `neutron://docs/...` for project-scoped. */
  url: string
  /** Owner project_id, or null for vault-legacy references. */
  project_id: string | null
  /** Path relative to the project's `docs/` root (or vault root). */
  path: string
}

/**
 * M2 chat-upload UX — drives the Expo client's upload affordances during
 * onboarding phases that expect a ChatGPT / Claude export ZIP. Mirrors the
 * landing `ChatOutbound.upload_affordance` so a single `phase-prompts`
 * metadata field renders the same drag-drop / file-picker hint across both
 * web chat surfaces. Absent on every other agent_message; the client treats
 * absence as "clear the affordance" so the hint disappears when the engine
 * advances past the import phases.
 */
export interface AppWsOutboundAgentMessageUploadAffordance {
  source: 'chatgpt' | 'claude'
}

export interface AppWsOutboundAgentMessage {
  v: 1
  type: 'agent_message'
  body: string
  message_id: string
  ts: number
  prompt_id?: string
  options?: ReadonlyArray<AppWsOutboundAgentMessageOption>
  allow_freeform?: boolean
  kind?: 'buttons' | 'image-gallery'
  /** Optional inline citations: array of `{ title, url }` pairs. */
  citations?: ReadonlyArray<{ title: string; url: string }>
  /** Optional image URLs the client should render below the body. */
  image_urls?: ReadonlyArray<string>
  /**
   * P7.3 — structured doc references resolved against the app channel.
   * Each entry has a deep-link URL the Expo client can pass to
   * `Linking.openURL(...)` to land in the in-app doc reader at the
   * referenced location. Inline `[label](docs:/...)` markers in
   * `body` are pre-rewritten to the same `neutron://docs/...` URL
   * shape; this field is for the agent's structured-citation slot
   * (the docs-side mirror of `citations`).
   */
  doc_refs?: ReadonlyArray<AppWsOutboundAgentMessageDocRef>
  /** P5.2 — project this agent message belongs to. */
  project_id?: string
  /**
   * ISSUE #18 — top-level deep-link the client should consider navigating
   * to after rendering the message. The Expo client's
   * `<ChatDeepLinkNavigator>` consumes this once per message_id via
   * `router.push(deep_link)`. Cores emit at the top level of the envelope
   * (NOT nested under a Core-private metadata field) so one client-side
   * consumer handles every Core's deep-link uniformly.
   */
  deep_link?: string
  /**
   * M2 chat-upload UX — when set, the Expo client shows a phase-aware hint
   * above the composer + accepts ZIP drag-drop / paste / picker for the
   * advertised source(s). Absence on subsequent agent_messages clears the
   * affordance so the hint disappears as the engine leaves the import
   * phases.
   */
  upload_affordance?: AppWsOutboundAgentMessageUploadAffordance
  /**
   * Chat-sync foundation — monotonic per-topic sequence assigned on persist.
   * Ordering + resume-cursor key, same semantics as the user echo's `seq`.
   * Absent when the durable log isn't wired.
   */
  seq?: number
  /**
   * Track B Phase 4 — receipt aggregate carried inline (same semantics as the
   * user echo). `delivered_by` = devices connected at fan-out; `read_by` folded
   * on replay. The client's UI doesn't show ticks on agent messages, but the
   * read state still drives cross-device unread reconciliation.
   */
  delivered_by?: ReadonlyArray<string>
  read_by?: ReadonlyArray<string>
}

/**
 * P5.1 — streaming chunk for an in-flight agent message.
 *
 * Successive partials for the same `message_id` append to a growing
 * buffer client-side; the final canonical `AppWsOutboundAgentMessage`
 * replaces the buffer with the full body + attaches metadata. The
 * server-side substrate dispatcher does NOT emit these envelopes today
 * (P5.1 ships the client primitive only); a later P5.x sprint wires
 * the chunked-emit path when the agent loop opts in.
 */
export interface AppWsOutboundAgentMessagePartial {
  v: 1
  type: 'agent_message_partial'
  /** Stable id across the stream — the final `agent_message` carries the same id. */
  message_id: string
  /** Text appended to the client buffer. */
  body_delta: string
  /** Server-emit time of this chunk. */
  ts: number
  /** P5.2 parity — project this stream belongs to. */
  project_id?: string
}

export interface AppWsOutboundError {
  v: 1
  type: 'error'
  code: string
  message: string
}

/**
 * Track B Phase 4 — a receipt-state update for one already-delivered message.
 * Fanned out to EVERY device on the topic whenever a device reads a message
 * (or the agent reads an inbound user message). Carries the FULL current
 * aggregate (not a delta) so the client merge is idempotent + order-independent
 * — the same union semantics as the inline `delivered_by`/`read_by` on the
 * message envelope. Also replayed (per message with receipts) after a resume.
 */
export interface AppWsOutboundReceiptUpdate {
  v: 1
  type: 'receipt_update'
  message_id: string
  /** The message's server seq (lets a client scope/ignore stale updates). */
  seq?: number
  delivered_by: ReadonlyArray<string>
  read_by: ReadonlyArray<string>
  ts: number
  /** P5.2 parity — project the underlying message belongs to. */
  project_id?: string
}

export type AppWsOutbound =
  | AppWsOutboundSessionReady
  | AppWsOutboundUserMessageEcho
  | AppWsOutboundAgentMessage
  | AppWsOutboundAgentMessagePartial
  | AppWsOutboundReceiptUpdate
  | AppWsOutboundError

/**
 * Decode an inbound envelope. Returns `null` on a wrong-shape envelope
 * (wrong `v`, wrong `type`, body-not-a-string, oversize body, or "no
 * payload at all" — see {@link payloadIsEmpty}) so the caller can drop
 * the frame without crashing the socket.
 *
 * P5.1 — `body` may now be the empty string when `attachments` is
 * non-empty. The composer enables Send on `draft.trim().length > 0 ||
 * attachments.length > 0` (InputComposer.tsx) — before this change the
 * gateway hard-rejected the attachments-only case, dropping the send
 * silently. Closes Argus r1 BLOCKING #2.
 */
export function decodeAppWsInbound(raw: unknown): AppWsInbound | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['v'] !== 1) return null
  if (e['type'] !== 'user_message') return null
  const body = e['body']
  if (typeof body !== 'string') return null
  if (body.length > MAX_USER_MESSAGE_LEN) return null
  const cleaned_attachments = sanitizeAttachments(e['attachments'])
  // P5.1 — require at least one of body or attachments. The composer
  // gates Send on (body.trim().length > 0 || attachments.length > 0)
  // so allowing both empty here would re-enable the original "missing
  // body" 1006 the bubble-failed regression rode in on.
  if (payloadIsEmpty(body, cleaned_attachments)) return null
  const out: AppWsInboundUserMessage = { v: 1, type: 'user_message', body }
  const client_msg_id = e['client_msg_id']
  if (typeof client_msg_id === 'string' && client_msg_id.length > 0 && client_msg_id.length <= 128) {
    out.client_msg_id = client_msg_id
  }
  const cleaned_project_id = sanitizeProjectId(e['project_id'])
  if (cleaned_project_id !== null) {
    out.project_id = cleaned_project_id
  }
  if (cleaned_attachments !== null) {
    out.attachments = cleaned_attachments
  }
  return out
}

/**
 * Chat-sync foundation — decode a `{ v:1, type:'resume', after_seq:N }`
 * gap-fill control frame. Kept SEPARATE from {@link decodeAppWsInbound} (the
 * message decoder) so message-path consumers keep their narrow
 * `AppWsInboundUserMessage` type. Returns `null` for anything that isn't a
 * well-formed resume; `after_seq` is clamped to a non-negative integer so a
 * malformed cursor can't drive a negative / fractional replay query.
 */
export function decodeAppWsResume(raw: unknown): AppWsInboundResume | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['v'] !== 1) return null
  if (e['type'] !== 'resume') return null
  const raw_after = e['after_seq']
  if (typeof raw_after !== 'number' || !Number.isFinite(raw_after)) return null
  return { v: 1, type: 'resume', after_seq: Math.max(0, Math.trunc(raw_after)) }
}

/**
 * Track B Phase 4 — decode a `{ v:1, type:'receipt', message_id, state:'read' }`
 * read-receipt control frame. SEPARATE from the message + resume decoders so
 * each path keeps its narrow type. Returns `null` for anything malformed. Only
 * `read` is accepted from clients (delivery is server-tracked). The device id
 * is intentionally NOT read from the frame — the surface attributes the receipt
 * to the socket's own device id, so a client can't forge another device's ack.
 */
export function decodeAppWsReceipt(raw: unknown): AppWsInboundReceipt | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['v'] !== 1) return null
  if (e['type'] !== 'receipt') return null
  if (e['state'] !== 'read') return null
  const message_id = e['message_id']
  if (typeof message_id !== 'string' || message_id.length === 0 || message_id.length > 256) {
    return null
  }
  const out: AppWsInboundReceipt = { v: 1, type: 'receipt', message_id, state: 'read' }
  const raw_seq = e['seq']
  if (typeof raw_seq === 'number' && Number.isFinite(raw_seq)) {
    out.seq = Math.max(0, Math.trunc(raw_seq))
  }
  return out
}

/**
 * P5.1 — predicate shared by the WS decoder and the HTTP `/api/app/chat/send`
 * handler so the empty-payload check has identical semantics on both
 * transports. A send is "empty" when the body is the empty string AND
 * no valid attachments rode along. Either one being non-empty is
 * sufficient to forward to the agent loop.
 */
export function payloadIsEmpty(
  body: string,
  attachments: ReadonlyArray<string> | null | undefined,
): boolean {
  if (body.length > 0) return false
  if (attachments !== null && attachments !== undefined && attachments.length > 0) {
    return false
  }
  return true
}

/** Conservative cap. Matches the landing chat's practical client behaviour. */
export const MAX_USER_MESSAGE_LEN = 16_384

/** P5.1 — max attachments per user_message envelope. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8
/** P5.1 — per-attachment URL byte cap (matches the gateway echo). */
export const MAX_ATTACHMENT_URL_LEN = 512

/**
 * P5.1 — sanitize `attachments` from an untrusted source. Returns the
 * cleaned array (always frozen) or `null` to mean "absent / malformed".
 * Rejects on: non-array, > MAX_ATTACHMENTS_PER_MESSAGE entries,
 * non-string entries, entries > MAX_ATTACHMENT_URL_LEN chars, or
 * entries that don't start with `https?://` or `/`. The "starts with
 * /" form is reserved for gateway-relative URLs returned by the
 * upload endpoint (`/api/app/upload/<id>`).
 */
export function sanitizeAttachments(raw: unknown): ReadonlyArray<string> | null {
  if (!Array.isArray(raw)) return null
  if (raw.length === 0) return null
  if (raw.length > MAX_ATTACHMENTS_PER_MESSAGE) return null
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') return null
    if (entry.length === 0 || entry.length > MAX_ATTACHMENT_URL_LEN) return null
    if (!/^(https?:\/\/|\/)/.test(entry)) return null
    out.push(entry)
  }
  return Object.freeze(out)
}

/**
 * P5.2 — bound the project_id field so a malformed client (or attacker)
 * can't push huge strings through the gateway's per-message state.
 * Project ids in the gateway are instance-scoped uuids (or short slugs);
 * 128 chars is generous.
 */
export const MAX_PROJECT_ID_LEN = 128

/**
 * Validate a project_id from an untrusted source (query string or
 * HTTP body). Returns the cleaned value or `null` to mean "absent or
 * malformed". Callers treat both the same — the surface stashes
 * `undefined` on the session, so subsequent echoes omit project_id.
 */
export function sanitizeProjectId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length === 0 || raw.length > MAX_PROJECT_ID_LEN) return null
  // Allow letters, digits, underscores, hyphens, and dots so slug and
  // uuid forms both pass. Reject control chars, quotes, slashes, etc.
  if (!/^[A-Za-z0-9_.-]+$/.test(raw)) return null
  return raw
}

/**
 * Validate a client `platform` flag from the WS upgrade query string
 * or HTTP send body. Used by the surface to route per-session
 * doc-link rendering ('web' → https://app.example.test/projects/
 * <id>/docs?path=..., 'native' → neutron://docs/...). Argus BLOCKING #2.
 */
export function sanitizePlatform(raw: unknown): 'web' | 'native' | null {
  if (raw === 'web' || raw === 'native') return raw
  return null
}

/** Track B Phase 4 — bound the device_id reported on the WS upgrade query
 *  string. Client-minted (a uuid or short opaque token); 128 chars is ample. */
export const MAX_DEVICE_ID_LEN = 128

/**
 * Validate a device_id from the untrusted upgrade query string. Returns the
 * cleaned value or `null` (absent / malformed → the surface mints a synthetic
 * per-connection id so receipt attribution still works, it just isn't stable
 * across reconnects for that client). Same charset as project ids.
 */
export function sanitizeDeviceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length === 0 || raw.length > MAX_DEVICE_ID_LEN) return null
  if (!/^[A-Za-z0-9_.-]+$/.test(raw)) return null
  return raw
}

/** Track B Phase 4 — synthetic device id the gateway attributes to the agent
 *  loop when it reads (picks up) an inbound user message. Lets a single-device
 *  sender see the read tick the moment the agent acts, with no second device.
 *  Mirrors `@neutron/chat-core`'s `AGENT_DEVICE_ID`; the wire value is the bare
 *  string `agent`. */
export const AGENT_DEVICE_ID = 'agent'

/** Synthetic `channel_topic_id` for an Expo session. */
export function appWsTopicId(user_id: string): string {
  return `app:${user_id}`
}

/** Parse `app:<user_id>` back to `user_id`. Returns `null` on mismatch. */
export function parseAppWsTopicId(topic_id: string): string | null {
  if (!topic_id.startsWith('app:')) return null
  const user_id = topic_id.slice('app:'.length)
  return user_id.length > 0 ? user_id : null
}
