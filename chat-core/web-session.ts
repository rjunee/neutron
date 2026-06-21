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
import { normalizeInbound, type ChatMessage } from './types.ts'
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
  generateId?: () => string
  now?: () => number
}

export class WebChatSession {
  readonly topic_id: string
  private readonly store: Store
  private readonly queue: SendQueue
  private readonly engine: SyncEngine
  private readonly ws: ChatWsClient
  private readonly onChange: (() => void) | undefined
  private readonly onFrame: ((frame: unknown) => void) | undefined

  constructor(opts: WebChatSessionOptions) {
    this.topic_id = opts.topic_id
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
    const msg = normalizeInbound(data)
    if (msg === null) return
    await this.engine.applyInbound(this.topic_id, msg)
    this.emitChange()
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
