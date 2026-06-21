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

import type { ChatMessage, ConnStatus, SendStatus } from '@neutron/chat-core'

export type RenderRole = 'user' | 'agent'

export interface RenderMessage {
  /** Stable identity: client_msg_id for user sends, message_id for agent /
   *  streaming bubbles. Drives assistant-ui's message keying. */
  id: string
  role: RenderRole
  text: string
  status: SendStatus
  /** True for an in-flight streamed agent bubble (no persisted row yet). */
  streaming: boolean
  attachments: readonly string[] | null
  createdAt: number
}

export interface ChatViewModel {
  messages: RenderMessage[]
  /** Typing/streaming indicator — true while awaiting or streaming a reply. */
  isRunning: boolean
  status: ConnStatus
  /** Count of sends still queued/unacked (offline tail). */
  pending: number
  projectId: string | null
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

  constructor(opts: NeutronChatControllerOptions) {
    this.projectId = opts.projectId ?? null
    this.session = opts.createSession({
      onChange: () => {
        void this.handleChange()
      },
      onStatus: (status) => this.handleStatus(status),
      onFrame: (frame) => this.handleFrame(frame),
    })
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
    this.publish()
  }

  private publish(): void {
    this.vm = this.computeVm()
    for (const fn of this.listeners) fn(this.vm)
  }

  private computeVm(): ChatViewModel {
    const rendered: RenderMessage[] = this.msgs.map((m) => ({
      id: m.client_msg_id.length > 0 ? m.client_msg_id : (m.message_id ?? `seq:${m.seq ?? 0}`),
      role: m.role,
      text: m.body,
      status: m.status,
      streaming: false,
      attachments: m.attachments,
      createdAt: m.created_at,
    }))
    // Append live streaming bubbles whose final message hasn't persisted yet.
    const persistedIds = new Set<string>()
    for (const m of this.msgs) if (m.message_id !== null) persistedIds.add(m.message_id)
    const liveStreams: RenderMessage[] = []
    for (const [messageId, entry] of this.streaming) {
      if (persistedIds.has(messageId)) continue
      liveStreams.push({
        id: `stream:${messageId}`,
        role: 'agent',
        text: entry.text,
        status: 'sent',
        streaming: true,
        attachments: null,
        createdAt: entry.createdAt,
      })
    }
    liveStreams.sort((a, b) => a.createdAt - b.createdAt)
    const messages = [...rendered, ...liveStreams]
    return {
      messages,
      isRunning: this.awaitingReply || liveStreams.length > 0,
      status: this.connStatus,
      pending: this.pending,
      projectId: this.projectId,
    }
  }

  /** Monotonic local ordering key for streaming bubbles (no wall clock). */
  private nextSeq(): number {
    this.seq += 1
    return this.seq
  }
}
