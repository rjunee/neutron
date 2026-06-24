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
 * A per-message acknowledgement (Track B Phase 4 — delivery + read receipts).
 * `delivered` means a device received the message over the socket (the server
 * records this for every connected device at fan-out time); `read` means a
 * device — or the synthetic `agent` reader — has viewed it. `read` implies
 * `delivered`; the per-message receipt ladder only ever advances.
 */
export type ReceiptState = 'delivered' | 'read'

/** The synthetic device id the server attributes to the agent loop when it
 *  reads (processes) an inbound user message. Lets a single-device sender see
 *  "read" ticks the moment the agent picks the message up, with no second
 *  human device required. */
export const AGENT_DEVICE_ID = 'agent'

/** Track B Phase 4 — an emoji reaction a user (device) adds to / removes from
 *  a single message. */
export type ReactionAction = 'add' | 'remove'

/**
 * Track B Phase 4 (edit/delete) — the two mutations a message's AUTHOR can
 * apply to a message it sent: rewrite the body (`edit`) or tombstone it
 * (`delete`). Unlike reactions (which any device may add to any message), an
 * edit/delete is author-only: the server enforces that the mutating party is
 * the message's author (a human device may mutate `user` messages; the agent
 * may mutate `agent` messages). Agent-native parity falls out — the same
 * mechanism an agent uses to edit/delete its own message.
 */
export type EditAction = 'edit' | 'delete'

/**
 * Track B Phase 4 — one active emoji reaction on a message, attributed to the
 * device that added it. The canonical per-message reaction state is a set of
 * these `(emoji, device_id)` pairs; the render layer groups them by emoji into
 * the "👍 3" chips a UI shows. Attribution is server-set from the socket's
 * device id (a client can't forge another device's reaction), mirroring how
 * read receipts are attributed.
 */
export interface MessageReaction {
  emoji: string
  device_id: string
}

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
  /**
   * Track B Phase 4 — device ids that have received (delivered) this message.
   * Server-tracked: the gateway records every connected device at fan-out time
   * and stamps the list on the outbound envelope. Optional + additive so every
   * existing construction site stays valid; absent/undefined is treated as the
   * empty set. Merged by set-union, so receipts only ever accumulate.
   */
  delivered_to?: readonly string[] | null
  /**
   * Track B Phase 4 — device ids (and the synthetic {@link AGENT_DEVICE_ID})
   * that have read this message. A user message's bubble shows the read tick
   * once `read_by` contains any device other than the sender's own. Merged by
   * set-union; monotonic.
   */
  read_by?: readonly string[] | null
  /**
   * Track B Phase 4 (reactions) — the FULL current set of active emoji
   * reactions on this message, one `(emoji, device_id)` pair per reaction.
   * Optional + additive; absent/null means no reactions. Unlike receipts (which
   * only ever accumulate), reactions can be REMOVED, so this set is NOT merged
   * by union — it is replaced wholesale by the highest-{@link reactions_rev}
   * aggregate the server fans (last-writer-wins by `rev`), which is what lets a
   * removal actually clear a reaction. See {@link pickReactionState}.
   */
  reactions?: readonly MessageReaction[] | null
  /**
   * Track B Phase 4 (reactions) — monotonic per-message reaction revision. The
   * server bumps it on every add/remove for the message; the client keeps the
   * `reactions` aggregate carrying the highest `rev` and ignores a stale lower
   * one, so applying reaction updates is idempotent + order-independent even
   * though the set itself isn't monotonic. Null when the message has never had
   * a reaction.
   */
  reactions_rev?: number | null
  /**
   * Track B Phase 4 (edit/delete) — unix-ms time this message was last edited
   * (or deleted), null when it has never been mutated. The render layer shows an
   * "edited" marker when this is set on a non-deleted message. Governed by
   * {@link edit_rev} (last-writer-wins), NOT a union — mirrors reactions.
   */
  edited_at?: number | null
  /**
   * Track B Phase 4 (edit/delete) — true once the author tombstones the message.
   * The body is cleared to `''` and the UI renders a "message deleted"
   * placeholder. Tombstone, not a row removal, so the message keeps its `seq`
   * slot and every device converges. Governed by {@link edit_rev}.
   */
  deleted?: boolean | null
  /**
   * Track B Phase 4 (edit/delete) — monotonic per-message edit revision. The
   * server bumps it on every edit/delete; the client keeps whichever edit
   * aggregate (body + edited_at + deleted) carries the highest `rev` and ignores
   * a stale lower one, so applying edit updates is idempotent + order-independent.
   * Null when the message has never been edited or deleted. See
   * {@link pickEditState}.
   */
  edit_rev?: number | null
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
  /** Track B Phase 4 — receipt state carried inline on the message envelope
   *  (the server stamps the connected devices at fan-out + folds the persisted
   *  aggregate on replay). Null/absent when no receipts apply. */
  delivered_to?: readonly string[] | null
  read_by?: readonly string[] | null
}

/**
 * A receipt-state update for a single already-delivered message (Track B
 * Phase 4). Carries the FULL current aggregate (not a delta) so applying it is
 * idempotent and order-independent — the same union-merge contract the message
 * apply path uses. Produced by {@link normalizeReceiptUpdate} from a
 * `receipt_update` wire frame.
 */
export interface InboundReceiptUpdate {
  message_id: string
  seq: number | null
  delivered_by: readonly string[]
  read_by: readonly string[]
}

/**
 * A reaction-state update for a single message (Track B Phase 4). Carries the
 * FULL current set of active reactions (not a delta) plus the monotonic `rev`,
 * so applying it is idempotent + order-independent: the client keeps whichever
 * aggregate has the highest `rev` and drops a stale one. Produced by {@link
 * normalizeReactionUpdate} from a `reaction_update` wire frame.
 */
export interface InboundReactionUpdate {
  message_id: string
  seq: number | null
  /** Monotonic per-message reaction revision (last-writer-wins key). */
  rev: number
  /** The full current set of active `(emoji, device_id)` reactions. */
  reactions: readonly MessageReaction[]
}

/**
 * An edit-state update for a single message (Track B Phase 4 — edit/delete).
 * Carries the message's current body + tombstone flag + the monotonic `rev`, so
 * applying it is idempotent + order-independent: the client keeps whichever
 * aggregate has the highest `rev`. Produced by {@link normalizeEditUpdate} from
 * an `edit_update` wire frame. A `deleted` update carries an empty `body`.
 */
export interface InboundEditUpdate {
  message_id: string
  seq: number | null
  /** Monotonic per-message edit revision (last-writer-wins key). */
  rev: number
  /** The message's current body after the edit (`''` for a delete tombstone). */
  body: string
  /** True when the message has been tombstoned (deleted). */
  deleted: boolean
  /** unix-ms time the edit/delete happened, null when unknown. */
  edited_at: number | null
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
 * Wire envelope a client sends to report it has read (viewed) a message
 * (Track B Phase 4). The server attributes it to the socket's device id — the
 * client does NOT self-report a device id, so a malicious client can't forge
 * another device's receipt. `seq` is the message's server seq when the client
 * knows it (lets the server order/replay the receipt); omitted otherwise.
 */
export interface OutboundReceipt {
  v: 1
  type: 'receipt'
  message_id: string
  state: ReceiptState
  seq?: number
}

/**
 * Wire envelope a client sends to add or remove an emoji reaction on a message
 * (Track B Phase 4). The server attributes it to the SOCKET's device id — the
 * client never self-reports a device id here, so it can't forge another
 * device's reaction (same anti-forge posture as {@link OutboundReceipt}). `seq`
 * is the message's server seq when the client knows it; omitted otherwise.
 */
export interface OutboundReaction {
  v: 1
  type: 'reaction'
  message_id: string
  emoji: string
  action: ReactionAction
  seq?: number
}

/**
 * Wire envelope a client sends to edit or delete a message it authored (Track B
 * Phase 4). The server authorizes it against the message's author (a human
 * device may mutate `user` messages; the agent may mutate `agent` messages) and
 * fans an `edit_update` back to every device. `body` is the new text on an
 * `edit` and is omitted/ignored on a `delete`. `seq` is the message's server
 * seq when the client knows it; omitted otherwise.
 */
export interface OutboundEdit {
  v: 1
  type: 'edit'
  message_id: string
  action: EditAction
  body?: string
  seq?: number
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

  // Track B Phase 4 — receipt state carried inline on the message envelope.
  const delivered_to = parseStringArray(e['delivered_by'])
  const read_by = parseStringArray(e['read_by'])

  const out: InboundChatMessage = {
    role,
    message_id,
    seq,
    body,
    client_msg_id,
    project_id,
    attachments,
    created_at,
  }
  if (delivered_to !== null) out.delivered_to = delivered_to
  if (read_by !== null) out.read_by = read_by
  return out
}

/**
 * Normalize a parsed `receipt_update` wire frame into an
 * {@link InboundReceiptUpdate}, or `null` when the frame is not a well-formed
 * receipt update. Defensive (drop, never throw), matching {@link
 * normalizeInbound}. The aggregate arrays default to empty when malformed.
 */
export function normalizeReceiptUpdate(raw: unknown): InboundReceiptUpdate | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['type'] !== 'receipt_update') return null
  const message_id = e['message_id']
  if (typeof message_id !== 'string' || message_id.length === 0) return null

  let seq: number | null = null
  const rawSeq = e['seq']
  if (typeof rawSeq === 'number' && Number.isFinite(rawSeq)) seq = Math.trunc(rawSeq)

  return {
    message_id,
    seq,
    delivered_by: parseStringArray(e['delivered_by']) ?? [],
    read_by: parseStringArray(e['read_by']) ?? [],
  }
}

/**
 * Normalize a parsed `reaction_update` wire frame into an {@link
 * InboundReactionUpdate}, or `null` when the frame is malformed. Defensive
 * (drop, never throw), matching {@link normalizeReceiptUpdate}. The reaction
 * list defaults to empty (an all-removed message) and `rev` to 0 when absent.
 */
export function normalizeReactionUpdate(raw: unknown): InboundReactionUpdate | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['type'] !== 'reaction_update') return null
  const message_id = e['message_id']
  if (typeof message_id !== 'string' || message_id.length === 0) return null

  let seq: number | null = null
  const rawSeq = e['seq']
  if (typeof rawSeq === 'number' && Number.isFinite(rawSeq)) seq = Math.trunc(rawSeq)

  let rev = 0
  const rawRev = e['rev']
  if (typeof rawRev === 'number' && Number.isFinite(rawRev)) rev = Math.max(0, Math.trunc(rawRev))

  return { message_id, seq, rev, reactions: parseReactions(e['reactions']) }
}

/**
 * Normalize a parsed `edit_update` wire frame into an {@link InboundEditUpdate},
 * or `null` when malformed. Defensive (drop, never throw), matching {@link
 * normalizeReactionUpdate}. A `deleted` update normalizes `body` to `''`; `rev`
 * defaults to 0 and `edited_at` to null when absent.
 */
export function normalizeEditUpdate(raw: unknown): InboundEditUpdate | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['type'] !== 'edit_update') return null
  const message_id = e['message_id']
  if (typeof message_id !== 'string' || message_id.length === 0) return null

  let seq: number | null = null
  const rawSeq = e['seq']
  if (typeof rawSeq === 'number' && Number.isFinite(rawSeq)) seq = Math.trunc(rawSeq)

  let rev = 0
  const rawRev = e['rev']
  if (typeof rawRev === 'number' && Number.isFinite(rawRev)) rev = Math.max(0, Math.trunc(rawRev))

  const deleted = e['deleted'] === true
  const body = !deleted && typeof e['body'] === 'string' ? (e['body'] as string) : ''

  let edited_at: number | null = null
  const rawAt = e['edited_at']
  if (typeof rawAt === 'number' && Number.isFinite(rawAt)) edited_at = Math.trunc(rawAt)

  return { message_id, seq, rev, body, deleted, edited_at }
}

/** Parse an untrusted value into a clean `MessageReaction[]` (drops malformed
 *  entries; de-dups + sorts canonically so the value is byte-stable). */
export function parseReactions(raw: unknown): readonly MessageReaction[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: MessageReaction[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const r = entry as Record<string, unknown>
    const emoji = r['emoji']
    const device_id = r['device_id']
    if (typeof emoji !== 'string' || emoji.length === 0) continue
    if (typeof device_id !== 'string' || device_id.length === 0) continue
    const key = `${emoji} ${device_id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ emoji, device_id })
  }
  return sortReactions(out)
}

/** Canonical order for a reaction set: by emoji, then device id. Keeps the
 *  stored/wire value byte-stable regardless of arrival order. */
export function sortReactions(reactions: readonly MessageReaction[]): MessageReaction[] {
  return [...reactions].sort((a, b) =>
    a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0,
  )
}

/** Parse an untrusted value into a clean string array, or `null` when it isn't
 *  a non-empty array of strings. Shared by the message + receipt decoders. */
function parseStringArray(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) return null
  const cleaned = raw.filter((x): x is string => typeof x === 'string' && x.length > 0)
  return cleaned.length > 0 ? cleaned : null
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
