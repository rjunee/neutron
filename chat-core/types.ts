/**
 * @neutronai/chat-core — shared, transport-agnostic types.
 *
 * The append-only chat-sync model (research doc §5/§7): every message is
 * immutable, single-author, and ordered by a server-assigned monotonic
 * per-topic `seq`. Clients de-duplicate on a stable identity
 * (`client_msg_id` for user sends, `message_id` otherwise), order by `seq`
 * (NEVER by clock), and reconcile their optimistic bubble when the server
 * echo carries the same `client_msg_id`.
 */

import type { WireAgentMessageOption } from '@neutronai/wire-types'

export type MessageRole = 'user' | 'agent'

/**
 * P1b (onboarding / quick-reply buttons) — one selectable option attached to an
 * agent message. `label` is the visible face, `value` is the routing key the
 * client posts back (NOT `label`), `body` is the canonical text, and
 * `image_url` drives image-gallery thumbnails. Transport-agnostic so the web
 * (React) and mobile (RN) surfaces render from one shape.
 *
 * L6 (option-shape unification): this is now an ALIAS of the ONE canonical
 * {@link WireAgentMessageOption} in `@neutronai/wire-types` — it was one of
 * three byte-identical declarations (with the app-ws envelope's
 * `AppWsOutboundAgentMessageOption` and the deleted `app/lib/ws-envelope.ts`
 * mirror). Kept under its historic name so every `chat-core` consumer is
 * unchanged.
 */
export type ChatMessageOption = WireAgentMessageOption

/** P1b — the render mode for an agent message's option set. */
export type PromptKind = 'buttons' | 'image-gallery'

/**
 * P1b — upload affordance carried by an onboarding agent message: the client
 * should surface a hint + accept the named export ZIP source. Absence on a
 * later agent message clears the affordance. Mirrors
 * `AppWsOutboundAgentMessageUploadAffordance`.
 */
export interface ChatMessageUploadAffordance {
  source: 'chatgpt' | 'claude'
}

/**
 * P7.3 / web-search — an inline source citation attached to an agent message.
 * Mirrors the `agent_message` envelope's `citations[]` (`{ title, url }`). Immutable
 * wire data (no rev), persisted + replayed like {@link ChatMessageOption options}.
 */
export interface ChatMessageCitation {
  title: string
  url: string
}

/**
 * P7.3 — a structured doc reference carried on an agent message: a deep-link the
 * client renders as a tappable "linked doc" chip. Mirrors the app-ws envelope's
 * `AppWsOutboundAgentMessageDocRef`. Immutable wire data.
 */
export interface ChatMessageDocRef {
  /** Human-readable label rendered next to the link. */
  label: string
  /** Channel-resolved URL (`neutron://docs/...` for project-scoped). */
  url: string
  /** Owner project_id, or null for vault-legacy references. */
  project_id: string | null
  /** Path relative to the project's `docs/` root (or vault root). */
  path: string
}

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
 *  - `failed` — GAP-4: handed to the socket but no ack arrived within the
 *    ack-timeout window, so the socket was (silently) lost. A terminal-until-
 *    retried state that lets the UI swap the stuck 🕓 clock for a retry
 *    affordance. NOT a lost send: it is re-driven (idempotently, on
 *    `client_msg_id`) on the next reconnect and reconciles to `acked` when the
 *    echo finally lands.
 *  - `acked`  — the server echo (with `seq` + `message_id`) has reconciled
 *    it. Inbound agent/user messages from the server are born `acked`.
 *
 * Status only ever advances (`queued` → `sent` → `failed` → `acked`); a later
 * echo always wins, so a `failed` row that is re-sent and finally echoed lands
 * on `acked`. See {@link SendStatus} rank in store.ts.
 */
export type SendStatus = 'queued' | 'sent' | 'failed' | 'acked'

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
  /**
   * P1b (onboarding / quick-reply buttons) — selectable options the client
   * renders below an agent message's body. Optional + additive; absent on user
   * messages and on agent messages with no prompt. Immutable wire data (no
   * rev): a re-delivery / resume carries the same set.
   */
  options?: readonly ChatMessageOption[] | null
  /** P1b — the outstanding-prompt id the chosen option is posted back against. */
  prompt_id?: string | null
  /** P1b — whether the user may also reply with free text (not just a button). */
  allow_freeform?: boolean | null
  /** P1b — render mode for {@link options} (`buttons` default vs gallery). */
  kind?: PromptKind | null
  /** P1b — upload affordance for an onboarding import phase (clears on absence). */
  upload_affordance?: ChatMessageUploadAffordance | null
  /** P7.3 — agent inline image URLs (rendered as a gallery under the body).
   *  Distinct from {@link attachments} (the user's own uploaded images). */
  image_urls?: readonly string[] | null
  /** P7.3 / web-search — inline source citations on an agent message. */
  citations?: readonly ChatMessageCitation[] | null
  /** P7.3 — structured doc references (tappable deep-link chips). */
  doc_refs?: readonly ChatMessageDocRef[] | null
  /** ISSUE #18 — top-level deep-link the client navigates to once per message. */
  deep_link?: string | null
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
  /**
   * P1b (onboarding / quick-reply buttons) — agent-message metadata carried
   * through from the `agent_message` envelope. All optional + absent on user
   * messages, so the back-compat path (no buttons) is byte-identical.
   */
  options?: readonly ChatMessageOption[] | null
  prompt_id?: string | null
  allow_freeform?: boolean | null
  kind?: PromptKind | null
  upload_affordance?: ChatMessageUploadAffordance | null
  image_urls?: readonly string[] | null
  citations?: readonly ChatMessageCitation[] | null
  doc_refs?: readonly ChatMessageDocRef[] | null
  deep_link?: string | null
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
 * P1b (onboarding / quick-reply buttons) — wire envelope a client sends when the
 * user taps an option. `choice_value` is the option's `value` (the routing key,
 * NOT the visible `label`); `prompt_id` correlates it to the server's
 * outstanding-prompt store. `freeform_text` carries an optional free-text reply
 * when the prompt allowed it. Mirrors the Expo app's post-back shape.
 */
export interface OutboundButtonChoice {
  v: 1
  type: 'button_choice'
  prompt_id: string
  choice_value: string
  freeform_text?: string
}

/**
 * Stale-store reset detection (M1) — extract the server's reported high-water
 * `seq` from a `session_ready` control frame, or `null` when it's absent /
 * malformed / not a `session_ready` frame.
 *
 * The app-ws surface stamps `last_seen_seq` = `MAX(seq)` for the topic at
 * connect, OMITTING it when 0 (a fresh topic, or a deployment with no durable
 * log). A client compares this against its local resume cursor: a server value
 * STRICTLY LOWER than the cursor means the per-topic seq counter regressed — the
 * server was wiped / reinstalled under us (a fresh install restarts seq at 1) —
 * so the stale local transcript must be cleared + re-synced. `null` is NEVER a
 * reset signal: an absent field can't distinguish a fresh wipe from a no-durable-
 * log deployment, where clearing would destroy the only copy of the transcript.
 *
 * Defensive (return `null`, never throw), matching the other frame decoders.
 */
export function parseSessionReadyMaxSeq(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['type'] !== 'session_ready') return null
  const v = e['last_seen_seq']
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.trunc(v)
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

  // P1b (onboarding / quick-reply buttons) — preserve agent-message metadata.
  // Only ever present on `agent_message` envelopes; absent fields stay absent so
  // a plain user message (or a button-less agent message) normalizes identically
  // to before.
  const options = parseOptions(e['options'])
  if (options !== null) out.options = options
  const rawPromptId = e['prompt_id']
  if (typeof rawPromptId === 'string' && rawPromptId.length > 0) out.prompt_id = rawPromptId
  if (typeof e['allow_freeform'] === 'boolean') out.allow_freeform = e['allow_freeform']
  const rawKind = e['kind']
  if (rawKind === 'buttons' || rawKind === 'image-gallery') out.kind = rawKind
  const upload = parseUploadAffordance(e['upload_affordance'])
  if (upload !== null) out.upload_affordance = upload
  // P7.3 — inline agent images, citations, doc references, and the top-level
  // deep-link. All optional + absent on user messages, so a plain message
  // normalizes identically to before.
  const imageUrls = parseStringArray(e['image_urls'])
  if (imageUrls !== null) out.image_urls = imageUrls
  const citations = parseCitations(e['citations'])
  if (citations !== null) out.citations = citations
  const docRefs = parseDocRefs(e['doc_refs'])
  if (docRefs !== null) out.doc_refs = docRefs
  if (typeof e['deep_link'] === 'string' && (e['deep_link'] as string).length > 0) {
    out.deep_link = e['deep_link'] as string
  }
  return out
}

/** Parse an untrusted value into a clean `ChatMessageCitation[]` (drops entries
 *  missing a non-empty `url`; defaults `title` to the url), or `null` when empty. */
export function parseCitations(raw: unknown): readonly ChatMessageCitation[] | null {
  if (!Array.isArray(raw)) return null
  const out: ChatMessageCitation[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const c = entry as Record<string, unknown>
    const url = c['url']
    if (typeof url !== 'string' || url.length === 0) continue
    const title = typeof c['title'] === 'string' && c['title'].length > 0 ? (c['title'] as string) : url
    out.push({ title, url })
  }
  return out.length > 0 ? out : null
}

/** Parse an untrusted value into a clean `ChatMessageDocRef[]` (drops entries
 *  missing a non-empty `url`), or `null` when empty/not an array. */
export function parseDocRefs(raw: unknown): readonly ChatMessageDocRef[] | null {
  if (!Array.isArray(raw)) return null
  const out: ChatMessageDocRef[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const d = entry as Record<string, unknown>
    const url = d['url']
    if (typeof url !== 'string' || url.length === 0) continue
    const label = typeof d['label'] === 'string' && d['label'].length > 0 ? (d['label'] as string) : url
    const path = typeof d['path'] === 'string' ? (d['path'] as string) : ''
    const project_id = typeof d['project_id'] === 'string' && d['project_id'].length > 0 ? (d['project_id'] as string) : null
    out.push({ label, url, project_id, path })
  }
  return out.length > 0 ? out : null
}

/** Parse an untrusted value into a clean `ChatMessageOption[]` (drops malformed
 *  entries; defaults `body` to `label`), or `null` when empty/not an array. */
export function parseOptions(raw: unknown): readonly ChatMessageOption[] | null {
  if (!Array.isArray(raw)) return null
  const out: ChatMessageOption[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const o = entry as Record<string, unknown>
    const label = o['label']
    const value = o['value']
    if (typeof label !== 'string' || label.length === 0) continue
    if (typeof value !== 'string' || value.length === 0) continue
    const body = typeof o['body'] === 'string' ? (o['body'] as string) : label
    const opt: ChatMessageOption = { label, body, value }
    if (typeof o['image_url'] === 'string' && (o['image_url'] as string).length > 0) {
      opt.image_url = o['image_url'] as string
    }
    const dec = o['decoration']
    if (dec !== null && typeof dec === 'object') {
      const d = dec as Record<string, unknown>
      const decoration: NonNullable<ChatMessageOption['decoration']> = {}
      const style = d['style']
      if (style === 'default' || style === 'destructive' || style === 'primary') decoration.style = style
      if (typeof d['icon_custom_emoji_id'] === 'string') {
        decoration.icon_custom_emoji_id = d['icon_custom_emoji_id'] as string
      }
      if (Object.keys(decoration).length > 0) opt.decoration = decoration
    }
    out.push(opt)
  }
  return out.length > 0 ? out : null
}

/** Parse an untrusted value into a {@link ChatMessageUploadAffordance}, or
 *  `null` when the source isn't one of the recognised export sources. */
export function parseUploadAffordance(raw: unknown): ChatMessageUploadAffordance | null {
  if (raw === null || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  if (u['source'] === 'chatgpt' || u['source'] === 'claude') return { source: u['source'] }
  return null
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
    const key = `${emoji}\x00${device_id}`
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
