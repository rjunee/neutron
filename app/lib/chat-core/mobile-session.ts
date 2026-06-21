/**
 * @neutronai/app — `MobileChatSession`: the RN analog of chat-core's
 * `WebChatSession` (research doc §7 — "share logic, not views": web and
 * mobile each instantiate a thin platform session over the SAME chat-core
 * engine). It composes the four engine primitives — nothing here re-
 * implements sync:
 *
 *   ChatWsClient (AppState-aware reconnect) + SendQueue (offline/idempotent)
 *        + SyncEngine (seq cursor + resume) + Store (op-sqlite on device)
 *
 * The Telegram-grade behaviours fall straight out of the composition:
 *   - optimistic send: `send()` writes to the local store + renders now
 *     (status `queued`) even with the socket down;
 *   - offline queue: queued sends auto-flush on (re)connect;
 *   - gap-free reconnect: every `session_ready` resumes from the local
 *     cursor (`{type:'resume', after_seq}`) and applies the replay;
 *   - instant cold-open: the op-sqlite Store already holds the transcript;
 *   - push catch-up: a data push calls {@link MobileChatSession.catchUp},
 *     which wakes the backgrounded socket → `session_ready` → resume.
 *
 * Two mobile-specific seams beyond `WebChatSession`:
 *   - {@link MobileChatSessionOptions.onFrame}: every raw inbound frame is
 *     handed to the UI so it can render streaming partials + the typing
 *     indicator (chat-core only persists finalized messages).
 *   - {@link MobileChatSession.catchUp}: the background-wake entry point.
 *
 * RN-free on purpose (no `react-native` import) so the whole send-queue +
 * resume integration is unit-testable under bun with a fake socket. AppState
 * is bridged by the React hook via {@link MobileChatSession.setActive}.
 */

import {
  ChatWsClient,
  InMemoryStore,
  normalizeInbound,
  SendQueue,
  SyncEngine,
  type ChatMessage,
  type ConnStatus,
  type SocketLike,
  type Store,
} from '@neutron/chat-core';

export interface MobileChatSessionOptions {
  /** WS URL, e.g. `wss://host/ws/app/chat?token=…&platform=native`. */
  url: string;
  /** The `app:<user_id>` topic this session renders. */
  topic_id: string;
  /** Durable local store (op-sqlite) — or any Store. Defaults to in-memory. */
  store?: Store;
  /** Socket factory; defaults to the RN global WebSocket. Injected in tests. */
  createSocket?: (url: string) => SocketLike;
  /** Called after any local change so the UI re-reads the transcript. */
  onChange?: () => void;
  /** Called on every connection-status transition. */
  onStatus?: (status: ConnStatus) => void;
  /** Called for every raw inbound frame (streaming partials, typing, …). */
  onFrame?: (data: unknown) => void;
  generateId?: () => string;
  now?: () => number;
  /** Injectable reconnect timer (tests). Defaults to global setTimeout. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export class MobileChatSession {
  readonly topic_id: string;
  private readonly store: Store;
  private readonly queue: SendQueue;
  private readonly engine: SyncEngine;
  private readonly ws: ChatWsClient;
  private readonly onChange: (() => void) | undefined;
  private readonly onFrame: ((data: unknown) => void) | undefined;

  constructor(opts: MobileChatSessionOptions) {
    this.topic_id = opts.topic_id;
    this.store = opts.store ?? new InMemoryStore();
    const queueOpts: { generateId?: () => string; now?: () => number } = {};
    if (opts.generateId !== undefined) queueOpts.generateId = opts.generateId;
    if (opts.now !== undefined) queueOpts.now = opts.now;
    this.queue = new SendQueue(this.store, queueOpts);
    this.engine = new SyncEngine(this.store);
    this.onChange = opts.onChange;
    this.onFrame = opts.onFrame;

    const wsOpts: ConstructorParameters<typeof ChatWsClient>[0] = {
      url: opts.url,
      createSocket:
        opts.createSocket ??
        ((url: string) =>
          new (globalThis as { WebSocket: new (url: string) => unknown }).WebSocket(
            url,
          ) as unknown as SocketLike),
      onMessage: (data) => {
        void this.handleInbound(data);
      },
    };
    if (opts.onStatus !== undefined) wsOpts.onStatus = opts.onStatus;
    if (opts.setTimeoutFn !== undefined) wsOpts.setTimeoutFn = opts.setTimeoutFn;
    if (opts.clearTimeoutFn !== undefined) wsOpts.clearTimeoutFn = opts.clearTimeoutFn;
    this.ws = new ChatWsClient(wsOpts);
  }

  /** Open the connection. */
  start(): void {
    this.ws.connect();
  }

  /** Close the connection (no reconnect until `start()` again). */
  stop(): void {
    this.ws.close();
  }

  /** AppState bridge — call on foreground (`true`) / background (`false`). */
  setActive(active: boolean): void {
    this.ws.setActive(active);
  }

  /** Connection status snapshot. */
  status(): ConnStatus {
    return this.ws.getStatus();
  }

  /**
   * Background-wake catch-up (research doc §6): a data push fires this. If the
   * socket is live we gap-fill immediately; otherwise we wake it and the
   * `session_ready` handler resumes once it (re)opens. Idempotent + safe to
   * call on every push.
   */
  async catchUp(): Promise<void> {
    if (this.status() === 'open') {
      await this.resumeAndFlush();
    } else {
      // setActive(true) resets backoff + reconnects immediately; the resume
      // request rides the next session_ready.
      this.ws.setActive(true);
      this.ws.connect();
    }
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
    const enqueueInput: Parameters<SendQueue['enqueue']>[0] = { topic_id: this.topic_id, body };
    if (opts.client_msg_id !== undefined) enqueueInput.client_msg_id = opts.client_msg_id;
    if (opts.project_id !== undefined) enqueueInput.project_id = opts.project_id;
    if (opts.attachments !== undefined) enqueueInput.attachments = opts.attachments;
    await this.queue.enqueue(enqueueInput);
    this.emitChange();
    await this.flush();
  }

  /** Current ordered transcript (for rendering / cold-open hydration). */
  async messages(): Promise<ChatMessage[]> {
    return this.engine.messages(this.topic_id);
  }

  /** Number of sends still awaiting delivery. */
  async pendingCount(): Promise<number> {
    return this.queue.pendingCount(this.topic_id);
  }

  private async handleInbound(data: unknown): Promise<void> {
    // Hand the raw frame to the UI first so streaming partials + typing
    // brackets render even though chat-core only persists final messages.
    if (this.onFrame !== undefined) this.onFrame(data);

    if (typeof data !== 'object' || data === null) return;
    const env = data as Record<string, unknown>;
    if (env['type'] === 'session_ready') {
      await this.resumeAndFlush();
      return;
    }
    const msg = normalizeInbound(data);
    if (msg === null) return;
    await this.engine.applyInbound(this.topic_id, msg);
    this.emitChange();
  }

  /** Resume from the local cursor, then re-drive every not-yet-acked send.
   *  Uses `flushUnacked` so a message handed to a socket that then dropped
   *  before the server echoed it is retried (idempotent server-side via
   *  `client_msg_id`) rather than stranded `sent` forever. */
  private async resumeAndFlush(): Promise<void> {
    const resume = await this.engine.resumeRequest(this.topic_id);
    this.ws.send(resume);
    const flushed = await this.queue.flushUnacked((envelope) => {
      const ok = this.ws.send(envelope);
      if (!ok) throw new Error('socket not open');
    }, this.topic_id);
    if (flushed.length > 0) this.emitChange();
  }

  private async flush(): Promise<void> {
    const flushed = await this.queue.flush((envelope) => {
      const ok = this.ws.send(envelope);
      if (!ok) throw new Error('socket not open');
    }, this.topic_id);
    if (flushed.length > 0) this.emitChange();
  }

  private emitChange(): void {
    if (this.onChange !== undefined) this.onChange();
  }
}
