/**
 * @neutron/chat-core — `WebChatSession`: the high-level composition a web
 * client instantiates to get Telegram-grade behaviour with no UI-framework
 * change. It wires the four primitives together:
 *
 *   ChatWsClient (reconnect)  +  SendQueue (offline/idempotent)
 *        +  SyncEngine (seq cursor + resume)  +  Store (durable local)
 *
 * The defining behaviours fall out of the composition:
 *   - optimistic send: `send()` enqueues to the local store and renders
 *     immediately (status `queued`), even with the socket down;
 *   - offline queue: queued sends flush automatically on (re)connect;
 *   - gap-free reconnect: on every `session_ready` the session resumes from
 *     its local cursor (`{type:'resume', after_seq}`) and applies the replay;
 *   - instant cold-open: the local Store already holds the transcript, so a
 *     reload renders before the network responds.
 *
 * The web client supplies a Store (use {@link createWebStore} for OPFS +
 * graceful in-memory fallback) and a topic id (derived from its JWT, as
 * `landing/chat.ts` already does via `decodeStartTokenUserId`). The socket
 * factory defaults to the browser `WebSocket`; tests inject a fake.
 */

import { SendQueue } from './send-queue.ts'
import { InMemoryStore, type Store } from './store.ts'
import { SyncEngine } from './sync-engine.ts'
import {
  normalizeInbound,
  normalizeReactionUpdate,
  normalizeReceiptUpdate,
  type ChatMessage,
  type OutboundReaction,
  type OutboundReceipt,
  type ReactionAction,
} from './types.ts'
import { ChatWsClient, type ConnStatus, type SocketLike } from './ws-client.ts'

export interface WebChatSessionOptions {
  /** WS URL, e.g. `wss://host/ws/app/chat?token=…&platform=web`. */
  url: string
  /** The `app:<user_id>` topic this session renders. */
  topic_id: string
  /** Durable local store (OPFS) — or any Store. Defaults to in-memory. */
  store?: Store
  /** Socket factory; defaults to the browser WebSocket. Injected in tests. */
  createSocket?: (url: string) => SocketLike
  /** Called after any local change so the UI re-renders. */
  onChange?: () => void
  /** Called on every connection-status transition. */
  onStatus?: (status: ConnStatus) => void
  /**
   * Called for EVERY parsed inbound frame, before the session decides whether
   * it's a renderable message. The sync layer only persists final
   * `user_message` echoes + `agent_message`s (everything else normalizes to
   * `null`), but a UI needs the ephemeral control frames too — chiefly
   * `agent_message_partial` (token streaming) and the typing/affordance hints.
   * This is a pure observer: it never affects persistence or ordering, so a
   * client that ignores it (the vanilla Phase-1 wiring) is unchanged. The
   * React/assistant-ui surface uses it to drive the live stream + "typing…"
   * indicator while the durable transcript still flows through the Store.
   */
  onFrame?: (frame: unknown) => void
  /**
   * This client's stable device id (Track B Phase 4). Threaded into the render
   * layer so a message's read tick excludes the sender's own device. The id is
   * ALSO passed on the WS upgrade URL (`&device_id=…`) so the server attributes
   * receipts to it — the session never self-reports it in a `receipt` frame,
   * which is what stops a client forging another device's ack.
   */
  device_id?: string
  generateId?: () => string
  now?: () => number
}

export class WebChatSession {
  readonly topic_id: string
  /** This client's device id (for read-tick self-exclusion). */
  readonly device_id: string
  private readonly store: Store
  private readonly queue: SendQueue
  private readonly engine: SyncEngine
  private readonly ws: ChatWsClient
  private readonly onChange: (() => void) | undefined
  private readonly onFrame: ((frame: unknown) => void) | undefined
  /** message_ids we've already sent a `read` receipt for — so re-rendering a
   *  visible message doesn't re-emit a receipt on every change. */
  private readonly readSent = new Set<string>()

  constructor(opts: WebChatSessionOptions) {
    this.topic_id = opts.topic_id
    this.device_id = opts.device_id ?? generateDeviceId(opts.generateId)
    this.store = opts.store ?? new InMemoryStore()
    const queueOpts: { generateId?: () => string; now?: () => number } = {}
    if (opts.generateId !== undefined) queueOpts.generateId = opts.generateId
    if (opts.now !== undefined) queueOpts.now = opts.now
    this.queue = new SendQueue(this.store, queueOpts)
    this.engine = new SyncEngine(this.store)
    this.onChange = opts.onChange
    this.onFrame = opts.onFrame

    const wsOpts: ConstructorParameters<typeof ChatWsClient>[0] = {
      url: opts.url,
      createSocket:
        opts.createSocket ??
        ((url: string) => new WebSocket(url) as unknown as SocketLike),
      onMessage: (data) => {
        void this.handleInbound(data)
      },
    }
    if (opts.onStatus !== undefined) wsOpts.onStatus = opts.onStatus
    this.ws = new ChatWsClient(wsOpts)
  }

  /** Open the connection. */
  start(): void {
    this.ws.connect()
  }

  /** Close the connection (no reconnect until `start()` again). */
  stop(): void {
    this.ws.close()
  }

  /** AppState bridge — call on focus/blur / visibilitychange. */
  setActive(active: boolean): void {
    this.ws.setActive(active)
  }

  /** Connection status snapshot. */
  status(): ConnStatus {
    return this.ws.getStatus()
  }

  /**
   * Send a user message. Optimistically persisted + rendered immediately;
   * delivered now if the socket is open, else queued and auto-flushed on the
   * next connect. Idempotent on `client_msg_id`.
   */
  async send(
    body: string,
    opts: { client_msg_id?: string; project_id?: string; attachments?: readonly string[] } = {},
  ): Promise<void> {
    const enqueueInput: Parameters<SendQueue['enqueue']>[0] = { topic_id: this.topic_id, body }
    if (opts.client_msg_id !== undefined) enqueueInput.client_msg_id = opts.client_msg_id
    if (opts.project_id !== undefined) enqueueInput.project_id = opts.project_id
    if (opts.attachments !== undefined) enqueueInput.attachments = opts.attachments
    await this.queue.enqueue(enqueueInput)
    this.emitChange()
    await this.flush()
  }

  /** Current ordered transcript (for rendering / cold-open hydration). */
  async messages(): Promise<ChatMessage[]> {
    return this.engine.messages(this.topic_id)
  }

  /** Number of sends still awaiting delivery. */
  async pendingCount(): Promise<number> {
    return this.queue.pendingCount(this.topic_id)
  }

  private async handleInbound(data: unknown): Promise<void> {
    if (typeof data !== 'object' || data === null) return
    // Surface the raw frame to any UI observer FIRST (streaming partials,
    // typing/affordance hints) — independent of whether it's a persisted
    // message. Failures in the observer must never break the sync path.
    if (this.onFrame !== undefined) {
      try {
        this.onFrame(data)
      } catch {
        /* observer error is the UI's problem, not the sync engine's */
      }
    }
    const env = data as Record<string, unknown>
    // On (re)connect the server announces the topic + high-water seq. That's
    // our trigger to fill the gap and flush anything queued while offline.
    if (env['type'] === 'session_ready') {
      await this.resumeAndFlush()
      return
    }
    // Track B Phase 4 — a receipt_update carries the latest delivered/read
    // aggregate for an already-applied message. Merge it (set-union) onto the
    // stored row so the bubble's tick advances. No-op if the message isn't
    // local yet (a receipt never precedes its message on the wire).
    const receipt = normalizeReceiptUpdate(data)
    if (receipt !== null) {
      const { applied } = await this.engine.applyReceiptUpdate(this.topic_id, receipt)
      if (applied) this.emitChange()
      return
    }
    // Track B Phase 4 (reactions) — a reaction_update carries the full current
    // reaction set + monotonic rev for an already-applied message. Apply it
    // (rev-LWW) so the message's chips update; no-op if the message isn't local
    // yet or the update is stale.
    const reaction = normalizeReactionUpdate(data)
    if (reaction !== null) {
      const { applied } = await this.engine.applyReactionUpdate(this.topic_id, reaction)
      if (applied) this.emitChange()
      return
    }
    const msg = normalizeInbound(data)
    if (msg === null) return
    await this.engine.applyInbound(this.topic_id, msg)
    this.emitChange()
  }

  /**
   * Report that the local user has read (viewed) one or more messages
   * (Track B Phase 4). The UI calls this with the message_ids that scrolled
   * into view; we send one `receipt` frame per not-yet-reported id over the
   * socket. The server attributes each to THIS socket's device id and fans a
   * `receipt_update` back to every device, so the sender's bubble advances to
   * "read". Best-effort: a receipt sent while the socket is down is simply
   * dropped (it is not on the lossless message critical path) — the next view
   * after reconnect re-reports it because the id only enters {@link readSent}
   * once a frame is actually accepted.
   */
  markRead(messageIds: readonly string[]): void {
    for (const message_id of messageIds) {
      if (message_id.length === 0 || this.readSent.has(message_id)) continue
      const env: OutboundReceipt = { v: 1, type: 'receipt', message_id, state: 'read' }
      if (this.ws.send(env)) this.readSent.add(message_id)
    }
  }

  /**
   * Add or remove an emoji reaction on a message (Track B Phase 4). Sends a
   * `reaction` frame over the socket; the server attributes it to THIS socket's
   * device id and fans a `reaction_update` (full aggregate + rev) back to every
   * device, which {@link handleInbound} applies. Best-effort over the open
   * socket (reactions are not on the lossless message critical path); a frame
   * sent while offline is dropped and the UI can re-issue on the next tap. The
   * optimistic local echo is left to the UI layer — the authoritative state is
   * the server's fanned aggregate.
   */
  react(message_id: string, emoji: string, action: ReactionAction): boolean {
    if (message_id.length === 0 || emoji.length === 0) return false
    const env: OutboundReaction = { v: 1, type: 'reaction', message_id, emoji, action }
    return this.ws.send(env)
  }

  /** Send the resume request from our local cursor, then re-drive every
   *  not-yet-acked send. Uses `flushUnacked` (not `flush`) so a message that
   *  was handed to a socket which then dropped before the server echoed it is
   *  retried on reconnect rather than stranded `sent` forever (Codex P1). The
   *  retry is idempotent server-side (`client_msg_id`) and the surface's
   *  `was_new` guard stops it re-firing the agent. */
  private async resumeAndFlush(): Promise<void> {
    const resume = await this.engine.resumeRequest(this.topic_id)
    this.ws.send(resume)
    const flushed = await this.queue.flushUnacked((envelope) => {
      const ok = this.ws.send(envelope)
      if (!ok) throw new Error('socket not open')
    }, this.topic_id)
    if (flushed.length > 0) this.emitChange()
  }

  private async flush(): Promise<void> {
    const flushed = await this.queue.flush((envelope) => {
      const ok = this.ws.send(envelope)
      if (!ok) throw new Error('socket not open')
    }, this.topic_id)
    if (flushed.length > 0) this.emitChange()
  }

  private emitChange(): void {
    if (this.onChange !== undefined) this.onChange()
  }
}

/** Mint a device id when the caller didn't supply a stable one. Prefer an
 *  injected generator (tests), then `crypto.randomUUID`, then a cheap fallback
 *  so the session never throws in an environment without WebCrypto. */
function generateDeviceId(generateId?: () => string): string {
  if (generateId !== undefined) return generateId()
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID !== undefined) return `dev-${c.randomUUID()}`
  return `dev-${Math.floor(Math.random() * 1e9).toString(36)}`
}
