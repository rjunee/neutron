/**
 * landing/chat-react — `NeutronChatController`: the framework-agnostic data
 * layer that bridges `@neutron/chat-core`'s `WebChatSession` to the
 * assistant-ui `ExternalStoreRuntime`.
 *
 * Why a controller and not "just a hook": the defining Telegram-grade
 * behaviours (optimistic send, gap-free reconnect, durable transcript) all
 * live in `WebChatSession` / the sync engine — but assistant-ui needs (a) a
 * synchronous, snapshot-able view-model and (b) the EPHEMERAL frames the sync
 * layer deliberately drops: `agent_message_partial` (token streaming) and the
 * implicit "agent is replying" typing state. This controller owns exactly that
 * glue:
 *
 *   - it subscribes to the session's `onChange` (durable transcript changed),
 *     `onStatus` (connection), and `onFrame` (raw stream — added additively to
 *     chat-core for this surface);
 *   - it accumulates streaming partials into a live, not-yet-persisted agent
 *     bubble, which the final `agent_message` (persisted via the Store) then
 *     supersedes — so there is never a duplicate and never a flash;
 *   - it derives `isRunning` (the typing indicator) from "a send is awaiting a
 *     reply OR a stream is in flight";
 *   - it caches a synchronous {@link ChatViewModel} the React layer reads.
 *
 * The session is injected via a factory so the whole controller unit-tests
 * against a fake session + hand-fed frames — i.e. real integration coverage
 * over the chat-core contract without a DOM or a socket.
 */

import { groupReactions } from '@neutron/chat-core'
import type {
  ChatMessage,
  ChatMessageOption,
  ChatMessageUploadAffordance,
  ConnStatus,
  PromptKind,
  ReactionAction,
  ReactionChip,
  SendStatus,
} from '@neutron/chat-core'

export type RenderRole = 'user' | 'agent'

/**
 * Track B Phase 4 — the per-message delivery ladder for an outbound (user)
 * message: 🕓 pending → ✓ sent → ✓✓ delivered → ✓✓ read (blue). Mirrors the
 * mobile `DeliveryState`; redefined here so the browser bundle doesn't pull in
 * the RN `app/` package.
 */
export type DeliveryState = 'pending' | 'sent' | 'delivered' | 'read'

export interface RenderMessage {
  /** Stable identity: client_msg_id for user sends, message_id for agent /
   *  streaming bubbles. Drives assistant-ui's message keying. */
  id: string
  /** Track B Phase 4 — the server message id (null until acked / for a
   *  streaming bubble). Reactions are keyed by this, NOT the render `id`
   *  (which is the client_msg_id for user sends). */
  messageId: string | null
  role: RenderRole
  text: string
  status: SendStatus
  /** True for an in-flight streamed agent bubble (no persisted row yet). */
  streaming: boolean
  attachments: readonly string[] | null
  createdAt: number
  /** Delivery ladder for user messages (null for agent / streaming bubbles). */
  delivery: DeliveryState | null
  /** Track B Phase 4 — per-emoji reaction chips for this message (empty when
   *  none). `reactedBySelf` marks chips this client added. */
  reactions: ReactionChip[]
  /** Track B Phase 4 (edit/delete) — true when this message has been edited
   *  (shows an "edited" marker). Always false for a deleted message. */
  edited: boolean
  /** Track B Phase 4 (edit/delete) — true when this message is tombstoned;
   *  the UI renders a "message deleted" placeholder instead of the body. */
  deleted: boolean
  /** P1b (onboarding / quick-reply buttons) — selectable options below an agent
   *  message's body (empty/null when none). */
  options: readonly ChatMessageOption[] | null
  /** P1b — outstanding-prompt id a chosen option is posted back against. */
  promptId: string | null
  /** P1b — whether a free-text reply is allowed alongside the buttons. */
  allowFreeform: boolean | null
  /** P1b — render mode for {@link options} (`buttons` default vs gallery). */
  kind: PromptKind | null
  /** P1b — upload affordance for an onboarding import phase (null when none). */
  uploadAffordance: ChatMessageUploadAffordance | null
  /** P1b — the option `value` this client has tapped (optimistic): the row
   *  collapses/greys once set. Local-only UI state, never persisted. */
  chosenValue: string | null
}

export interface ChatViewModel {
  messages: RenderMessage[]
  /** Typing/streaming indicator — true while awaiting or streaming a reply. */
  isRunning: boolean
  status: ConnStatus
  /** Count of sends still queued/unacked (offline tail). */
  pending: number
  projectId: string | null
  /** Track B Phase 4 — delivery state of the most recent user message, for a
   *  Telegram-style status line under the thread. Null when none sent. */
  latestUserDelivery: DeliveryState | null
}

/** The slice of `WebChatSession` the controller depends on (injectable). */
export interface ControllerSession {
  start(): void
  stop(): void
  setActive(active: boolean): void
  status(): ConnStatus
  send(
    body: string,
    opts?: { client_msg_id?: string; project_id?: string; attachments?: readonly string[] },
  ): Promise<void>
  messages(): Promise<ChatMessage[]>
  pendingCount(): Promise<number>
  /** Track B Phase 4 — report read messages (optional so legacy fakes still
   *  satisfy the interface). */
  markRead?(messageIds: readonly string[]): void
  /** Track B Phase 4 — add/remove an emoji reaction (optional so legacy fakes
   *  still satisfy the interface). */
  react?(messageId: string, emoji: string, action: ReactionAction): boolean
  /** Track B Phase 4 (edit/delete) — edit / delete a message the client
   *  authored (optional so legacy fakes still satisfy the interface). */
  editMessage?(messageId: string, body: string): boolean
  deleteMessage?(messageId: string): boolean
  /** P1b (onboarding / quick-reply buttons) — post a tapped option back to the
   *  server (optional so legacy fakes still satisfy the interface). */
  sendButtonChoice?(promptId: string, choiceValue: string, freeformText?: string): boolean
  /** This client's device id, for read-tick self-exclusion (optional). */
  readonly device_id?: string
}

/** Sinks the controller hands to the session factory so it can observe it. */
export interface ControllerSinks {
  onChange: () => void
  onStatus: (status: ConnStatus) => void
  onFrame: (frame: unknown) => void
}

export interface NeutronChatControllerOptions {
  createSession: (sinks: ControllerSinks) => ControllerSession
  projectId?: string | null
}

interface StreamEntry {
  text: string
  createdAt: number
}

export class NeutronChatController {
  private readonly session: ControllerSession
  private msgs: ChatMessage[] = []
  /** message_id → accumulated streaming text (not yet persisted). */
  private readonly streaming = new Map<string, StreamEntry>()
  private connStatus: ConnStatus = 'idle'
  private awaitingReply = false
  private pending = 0
  private projectId: string | null
  private readonly listeners = new Set<(vm: ChatViewModel) => void>()
  private vm: ChatViewModel
  private seq = 0
  /** P1b — render id → the option `value` the user tapped (optimistic collapse). */
  private readonly chosen = new Map<string, string>()
  /** This client's device id (for read-tick self-exclusion). */
  private readonly deviceId: string

  constructor(opts: NeutronChatControllerOptions) {
    this.projectId = opts.projectId ?? null
    this.session = opts.createSession({
      onChange: () => {
        void this.handleChange()
      },
      onStatus: (status) => this.handleStatus(status),
      onFrame: (frame) => this.handleFrame(frame),
    })
    this.deviceId = this.session.device_id ?? ''
    this.vm = this.computeVm()
  }

  start(): void {
    this.session.start()
    // Cold-open hydration: a durable Store (OPFS) may already hold the
    // transcript + queued offline sends from a previous session. Read it
    // immediately so a returning user sees their chat (and pending badge)
    // instantly on mount — NOT only after the next inbound frame / send. The
    // live `session_ready` resume still fills any gap once the socket opens.
    void this.handleChange()
  }

  stop(): void {
    this.session.stop()
  }

  setActive(active: boolean): void {
    this.session.setActive(active)
  }

  getViewModel(): ChatViewModel {
    return this.vm
  }

  /** Active project tag carried on subsequent sends. */
  setProject(projectId: string | null): void {
    if (projectId === this.projectId) return
    this.projectId = projectId
    this.publish()
  }

  subscribe(fn: (vm: ChatViewModel) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /**
   * Optimistically send a user message. Sets the typing indicator immediately
   * (so the UI feels instant), tags it with the active project, and lets the
   * session own the durable enqueue + flush. The optimistic bubble renders via
   * the session's `onChange`.
   */
  async send(body: string, attachments?: readonly string[]): Promise<void> {
    this.awaitingReply = true
    this.publish()
    const opts: { project_id?: string; attachments?: readonly string[] } = {}
    if (this.projectId !== null && this.projectId.length > 0) opts.project_id = this.projectId
    if (attachments !== undefined && attachments.length > 0) opts.attachments = attachments
    await this.session.send(body, opts)
  }

  private handleStatus(status: ConnStatus): void {
    this.connStatus = status
    this.publish()
  }

  private handleFrame(frame: unknown): void {
    if (typeof frame !== 'object' || frame === null) return
    const f = frame as Record<string, unknown>
    const type = f['type']
    if (type === 'agent_message_partial') {
      const messageId = f['message_id']
      const delta = f['body_delta']
      if (typeof messageId !== 'string' || messageId.length === 0) return
      if (typeof delta !== 'string') return
      // Any agent activity clears the "awaiting" bracket — the reply has begun.
      this.awaitingReply = false
      const existing = this.streaming.get(messageId)
      if (existing === undefined) {
        this.streaming.set(messageId, { text: delta, createdAt: this.nextSeq() })
      } else {
        existing.text += delta
      }
      this.publish()
      return
    }
    if (type === 'agent_message') {
      // The final message persists via the Store (a following onChange); clear
      // the awaiting bracket now so the indicator doesn't linger if no stream
      // ever arrived. The streaming buffer is pruned once the persisted row
      // shows up (see handleChange).
      this.awaitingReply = false
      this.publish()
      return
    }
    if (type === 'error') {
      this.awaitingReply = false
      this.publish()
    }
  }

  private async handleChange(): Promise<void> {
    const [msgs, pending] = await Promise.all([this.session.messages(), this.session.pendingCount()])
    this.msgs = msgs
    this.pending = pending
    // Drop any streaming buffer whose final message has now persisted, so the
    // durable row (with its seq + metadata) supersedes the live bubble.
    if (this.streaming.size > 0) {
      const persistedIds = new Set<string>()
      for (const m of msgs) if (m.message_id !== null) persistedIds.add(m.message_id)
      for (const id of [...this.streaming.keys()]) {
        if (persistedIds.has(id)) this.streaming.delete(id)
      }
    }
    this.markVisibleAgentRead(msgs)
    this.publish()
  }

  /**
   * Track B Phase 4 — report agent messages as read. The web chat is a single
   * scrolling thread the user is looking at, so a persisted agent message is
   * "read"; the session de-dups so this only sends one receipt per message.
   * Reporting ONLY agent messages (never the user's own sends) means a receipt
   * can't light the sender's own read tick.
   */
  private markVisibleAgentRead(msgs: ChatMessage[]): void {
    if (this.session.markRead === undefined) return
    const ids: string[] = []
    for (const m of msgs) {
      if (m.role === 'agent' && m.message_id !== null) ids.push(m.message_id)
    }
    if (ids.length > 0) this.session.markRead(ids)
  }

  /** Report messages the user has viewed (Track B Phase 4). Exposed for a UI
   *  that wants finer-grained viewport reporting than the auto-read above. */
  markRead(messageIds: readonly string[]): void {
    this.session.markRead?.(messageIds)
  }

  /**
   * Track B Phase 4 — toggle an emoji reaction on a message. `add` / `remove`
   * is sent to the server, which fans the authoritative `reaction_update` back
   * (applied via the session's `onChange`). A no-op when the session predates
   * reactions (legacy fake) or the message id is empty.
   */
  react(messageId: string, emoji: string, action: ReactionAction): void {
    if (messageId.length === 0 || emoji.length === 0) return
    this.session.react?.(messageId, emoji, action)
  }

  /**
   * Track B Phase 4 (edit/delete) — edit a message's body. The server
   * authorizes it against the message's author and fans the authoritative
   * `edit_update` back (applied via `onChange`). A no-op when the session
   * predates edits (legacy fake), the id is empty, or the body is blank.
   */
  editMessage(messageId: string, body: string): void {
    if (messageId.length === 0 || body.trim().length === 0) return
    this.session.editMessage?.(messageId, body.trim())
  }

  /**
   * Track B Phase 4 (edit/delete) — delete (tombstone) a message. The server
   * authorizes + fans an `edit_update` with `deleted:true` back. A no-op when
   * the session predates edits or the id is empty.
   */
  deleteMessage(messageId: string): void {
    if (messageId.length === 0) return
    this.session.deleteMessage?.(messageId)
  }

  /**
   * P1b (onboarding / quick-reply buttons) — handle a tapped option. Posts the
   * choice back to the server via {@link ControllerSession.sendButtonChoice}
   * (when a prompt id is present — the wire frame needs it to route), then
   * records the chosen `value` locally keyed by the render id so the option row
   * collapses/greys optimistically on the next render. Mirrors the Expo app's
   * `record_choice` reducer action. A no-op for an empty value.
   */
  onChoose(messageId: string, promptId: string | null, value: string): void {
    if (messageId.length === 0 || value.length === 0) return
    if (promptId !== null && promptId.length > 0) {
      this.session.sendButtonChoice?.(promptId, value)
    }
    this.chosen.set(messageId, value)
    this.publish()
  }

  private publish(): void {
    this.vm = this.computeVm()
    for (const fn of this.listeners) fn(this.vm)
  }

  private computeVm(): ChatViewModel {
    const rendered: RenderMessage[] = this.msgs.map((m) => {
      const id = m.client_msg_id.length > 0 ? m.client_msg_id : (m.message_id ?? `seq:${m.seq ?? 0}`)
      return {
        id,
        messageId: m.message_id,
        role: m.role,
        text: m.body,
        status: m.status,
        streaming: false,
        attachments: m.attachments,
        createdAt: m.created_at,
        delivery: deliveryFor(m, this.deviceId),
        reactions: groupReactions(m.reactions, this.deviceId),
        edited: m.deleted !== true && m.edited_at !== null && m.edited_at !== undefined,
        deleted: m.deleted === true,
        // P1b (onboarding / quick-reply buttons) — surface the agent-message
        // option metadata + this client's optimistic choice onto the VM.
        options: m.options ?? null,
        promptId: m.prompt_id ?? null,
        allowFreeform: m.allow_freeform ?? null,
        kind: m.kind ?? null,
        uploadAffordance: m.upload_affordance ?? null,
        chosenValue: this.chosen.get(id) ?? null,
      }
    })
    // Append live streaming bubbles whose final message hasn't persisted yet.
    const persistedIds = new Set<string>()
    for (const m of this.msgs) if (m.message_id !== null) persistedIds.add(m.message_id)
    const liveStreams: RenderMessage[] = []
    for (const [messageId, entry] of this.streaming) {
      if (persistedIds.has(messageId)) continue
      liveStreams.push({
        id: `stream:${messageId}`,
        messageId,
        role: 'agent',
        text: entry.text,
        status: 'sent',
        streaming: true,
        attachments: null,
        createdAt: entry.createdAt,
        delivery: null,
        reactions: [],
        edited: false,
        deleted: false,
        options: null,
        promptId: null,
        allowFreeform: null,
        kind: null,
        uploadAffordance: null,
        chosenValue: null,
      })
    }
    liveStreams.sort((a, b) => a.createdAt - b.createdAt)
    const messages = [...rendered, ...liveStreams]
    // Latest user message's delivery — for a Telegram-style status line.
    let latestUserDelivery: DeliveryState | null = null
    for (let i = rendered.length - 1; i >= 0; i--) {
      const r = rendered[i]
      if (r !== undefined && r.role === 'user') {
        latestUserDelivery = r.delivery
        break
      }
    }
    return {
      messages,
      isRunning: this.awaitingReply || liveStreams.length > 0,
      status: this.connStatus,
      pending: this.pending,
      projectId: this.projectId,
      latestUserDelivery,
    }
  }

  /** Monotonic local ordering key for streaming bubbles (no wall clock). */
  private nextSeq(): number {
    this.seq += 1
    return this.seq
  }
}

/**
 * Track B Phase 4 — derive an outbound message's delivery ladder from its send
 * status + read aggregate. Mirrors the mobile `deliveryState`: queued→pending,
 * sent→sent, acked→delivered, and acked→read once any device OTHER than this
 * one (incl. the synthetic `agent` reader) appears in `read_by`.
 */
export function deliveryFor(m: ChatMessage, selfDeviceId: string): DeliveryState | null {
  if (m.role !== 'user') return null
  if (m.status === 'queued') return 'pending'
  if (m.status === 'sent') return 'sent'
  const readBy = m.read_by
  if (readBy !== null && readBy !== undefined) {
    for (const id of readBy) {
      if (id.length > 0 && id !== selfDeviceId) return 'read'
    }
  }
  return 'delivered'
}
