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
 *   - push catch-up: a foreground push (or any reconnect) calls
 *     {@link MobileChatSession.catchUp}, which wakes a paused socket →
 *     `session_ready` → resume. (Foreground-only — the RN hook does not run JS
 *     on a backgrounded data push; the gap is filled on next foreground.)
 *
 * Two mobile-specific seams beyond `WebChatSession`:
 *   - {@link MobileChatSessionOptions.onFrame}: every raw inbound frame is
 *     handed to the UI so it can render streaming partials + the typing
 *     indicator (chat-core only persists finalized messages).
 *   - {@link MobileChatSession.catchUp}: the catch-up entry point (foreground
 *     push / reconnect).
 *
 * RN-free on purpose (no `react-native` import) so the whole send-queue +
 * resume integration is unit-testable under bun with a fake socket. AppState
 * is bridged by the React hook via {@link MobileChatSession.setActive}.
 */

import {
  ChatWsClient,
  DEFAULT_ACK_TIMEOUT_MS,
  InMemoryStore,
  normalizeEditUpdate,
  normalizeInbound,
  normalizeReactionUpdate,
  normalizeReceiptUpdate,
  parseSessionReadyMaxSeq,
  SendQueue,
  SyncEngine,
  type ChatMessage,
  type ConnStatus,
  type InboundChatMessage,
  type OutboundButtonChoice,
  type OutboundEdit,
  type OutboundReaction,
  type OutboundReceipt,
  type ReactionAction,
  type SocketLike,
  type Store,
} from '@neutronai/chat-core';

export interface MobileChatSessionOptions {
  /** WS URL, e.g. `wss://host/ws/app/chat?token=…&platform=native`. */
  url: string;
  /** The `app:<user_id>` topic this session renders. */
  topic_id: string;
  /** The project_id this view is scoped to (empty/undefined = global). Used to
   *  tag synthetic `chat_command_result` messages so a slash-command answer
   *  shows in the project chat it was issued from. */
  project_id?: string;
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
  /** This device's stable id (Track B Phase 4 — read-receipt self-exclusion +
   *  server attribution via the WS upgrade URL). Defaults to a generated id. */
  device_id?: string;
  generateId?: () => string;
  now?: () => number;
  /** W5 GAP-4 — ack-timeout window (ms). Default {@link DEFAULT_ACK_TIMEOUT_MS};
   *  0 disables the sent→failed flip. Parity with WebChatSession. */
  ackTimeoutMs?: number;
  /** W5 GAP-1 — heartbeat cadence (ms) passed through to the transport; the
   *  client pings after this much inbound silence to detect a half-open socket.
   *  Defaults to the transport default. Set to 0 to DISABLE (tests whose injected
   *  timer fires immediately, so a real-cadence heartbeat would mis-fire). */
  heartbeatIntervalMs?: number;
  /** W5 GAP-1 — missed-pong deadline (ms), passed through to the transport. */
  heartbeatTimeoutMs?: number;
  /** Injectable reconnect timer (tests). Defaults to global setTimeout. Also
   *  drives the ack-timeout deadlines. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/** Default single-shot timer that never keeps the RN JS runtime / a test process
 *  alive (unref), so a pending ack timer can't block a clean shutdown. */
function defaultSetTimeout(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms);
  (handle as { unref?: () => void }).unref?.();
  return handle;
}

export class MobileChatSession {
  readonly topic_id: string;
  /** This device's id (for read-tick self-exclusion). */
  readonly device_id: string;
  /** The view's project scope (null = global), for tagging command results. */
  private readonly viewProjectId: string | null;
  private readonly store: Store;
  private readonly queue: SendQueue;
  private readonly engine: SyncEngine;
  private readonly ws: ChatWsClient;
  private readonly onChange: (() => void) | undefined;
  private readonly onFrame: ((data: unknown) => void) | undefined;
  /** message_ids we've already reported `read` for (de-dups re-renders). */
  private readonly readSent = new Set<string>();
  /** W5 GAP-4 — per-message (client_msg_id → handle) ack-deadline timers. A row
   *  that never gets its echo flips `sent` → `failed` when its timer fires. */
  private readonly ackTimers = new Map<string, unknown>();
  private readonly ackTimeoutMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(opts: MobileChatSessionOptions) {
    this.topic_id = opts.topic_id;
    this.device_id = opts.device_id ?? generateDeviceId(opts.generateId);
    this.viewProjectId = opts.project_id !== undefined && opts.project_id.length > 0 ? opts.project_id : null;
    this.store = opts.store ?? new InMemoryStore();
    const queueOpts: { generateId?: () => string; now?: () => number } = {};
    if (opts.generateId !== undefined) queueOpts.generateId = opts.generateId;
    if (opts.now !== undefined) queueOpts.now = opts.now;
    this.queue = new SendQueue(this.store, queueOpts);
    this.engine = new SyncEngine(this.store);
    this.onChange = opts.onChange;
    this.onFrame = opts.onFrame;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.setTimeoutFn = opts.setTimeoutFn ?? defaultSetTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as never));

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
    if (opts.heartbeatIntervalMs !== undefined) wsOpts.heartbeatIntervalMs = opts.heartbeatIntervalMs;
    if (opts.heartbeatTimeoutMs !== undefined) wsOpts.heartbeatTimeoutMs = opts.heartbeatTimeoutMs;
    if (opts.setTimeoutFn !== undefined) wsOpts.setTimeoutFn = opts.setTimeoutFn;
    if (opts.clearTimeoutFn !== undefined) wsOpts.clearTimeoutFn = opts.clearTimeoutFn;
    this.ws = new ChatWsClient(wsOpts);
  }

  /** Open the connection. */
  start(): void {
    this.ws.connect();
  }

  /** Close the connection (no reconnect until `start()` again) and tear down the
   *  ack-deadline timers so nothing leaks. */
  stop(): void {
    this.ws.close();
    this.clearAllTimers();
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
   * Catch-up gap-fill (research doc §6): a foreground push or a reconnect fires
   * this. If the socket is live we gap-fill immediately; otherwise we wake it
   * and the `session_ready` handler resumes once it (re)opens. Idempotent +
   * safe to call on every push. (Foreground-only: the RN hook can only invoke
   * this while the app is foregrounded — see `use-mobile-chat.ts`.)
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

  /**
   * Report that the local user has read (viewed) one or more messages
   * (Track B Phase 4). The UI calls this with the message_ids that became
   * visible (e.g. FlashList `onViewableItemsChanged`); we send one `receipt`
   * frame per not-yet-reported id. The server attributes each to THIS device
   * (via the upgrade-URL device id) and fans a `receipt_update` to every device
   * so the sender's bubble advances to "read". Best-effort over the open socket
   * — an id only enters {@link readSent} once a frame is actually accepted, so
   * a receipt dropped while offline is re-sent on the next view after reconnect.
   */
  markRead(messageIds: readonly string[]): void {
    for (const message_id of messageIds) {
      if (message_id.length === 0 || this.readSent.has(message_id)) continue;
      const env: OutboundReceipt = { v: 1, type: 'receipt', message_id, state: 'read' };
      if (this.ws.send(env)) this.readSent.add(message_id);
    }
  }

  /**
   * Add or remove an emoji reaction on a message (Track B Phase 4). Sends a
   * `reaction` frame; the server attributes it to THIS device (via the upgrade
   * URL device id) and fans a `reaction_update` to every device, which {@link
   * handleInbound} applies. Best-effort over the open socket; returns whether
   * the frame was handed to the socket.
   */
  react(message_id: string, emoji: string, action: ReactionAction): boolean {
    if (message_id.length === 0 || emoji.length === 0) return false;
    const env: OutboundReaction = { v: 1, type: 'reaction', message_id, emoji, action };
    return this.ws.send(env);
  }

  /**
   * Edit a message's body (Track B Phase 4). Sends an `edit` frame; the server
   * authorizes it against the message's author and fans an `edit_update` to
   * every device, which {@link handleInbound} applies. An empty body is rejected
   * (use {@link deleteMessage} to remove). Returns whether the frame was sent.
   */
  editMessage(message_id: string, body: string): boolean {
    if (message_id.length === 0 || body.length === 0) return false;
    const env: OutboundEdit = { v: 1, type: 'edit', message_id, action: 'edit', body };
    return this.ws.send(env);
  }

  /**
   * Delete (tombstone) a message (Track B Phase 4). Sends an `edit` frame with
   * `action:'delete'`; the server authorizes + fans an `edit_update` with
   * `deleted:true` to every device. Returns whether the frame was sent.
   */
  deleteMessage(message_id: string): boolean {
    if (message_id.length === 0) return false;
    const env: OutboundEdit = { v: 1, type: 'edit', message_id, action: 'delete' };
    return this.ws.send(env);
  }

  /**
   * P1b (onboarding / quick-reply buttons) — answer an agent prompt by tapping
   * an option. Sends a `button_choice` frame the server routes to the composer's
   * `on_button_choice` (engine.advance); the resulting `agent_message` arrives on
   * the socket like any other. `freeform` carries an optional typed reply when the
   * prompt allowed it. Best-effort over the open socket; returns whether sent.
   */
  chooseOption(prompt_id: string, choice_value: string, freeform?: string): boolean {
    if (prompt_id.length === 0 || choice_value.length === 0) return false;
    const env: OutboundButtonChoice = {
      v: 1,
      type: 'button_choice',
      prompt_id,
      choice_value,
    };
    if (freeform !== undefined && freeform.length > 0) env.freeform_text = freeform;
    return this.ws.send(env);
  }

  private async handleInbound(data: unknown): Promise<void> {
    // Hand the raw frame to the UI first so streaming partials + typing
    // brackets render even though chat-core only persists final messages.
    if (this.onFrame !== undefined) this.onFrame(data);

    if (typeof data !== 'object' || data === null) return;
    const env = data as Record<string, unknown>;
    if (env['type'] === 'session_ready') {
      // Stale-store reset detection (M1) — BEFORE resuming, check whether the
      // server's high-water seq regressed below our local cursor (server wiped /
      // reinstalled under us). If so the on-device transcript is from a dead
      // server; drop it so the resume below re-syncs the fresh one from seq 0.
      await this.reconcileServerReset(data);
      await this.resumeAndFlush();
      return;
    }
    // A matched slash command (/note, /remind, /cal, /skills, …) is answered with
    // a single `chat_command_result` and NO `agent_message` — without this the
    // command's confirmation/output is silently dropped. Render it as an agent
    // message (the bot's reply), tagged with the view's project so it shows in the
    // project chat it was issued from. No server `seq` → it sorts in the optimistic
    // tail by `created_at`, which is the bottom of the transcript (where it belongs).
    if (env['type'] === 'chat_command_result') {
      const inbound = commandResultToInbound(env, this.viewProjectId);
      if (inbound !== null) {
        await this.engine.applyInbound(this.topic_id, inbound);
        this.emitChange();
      }
      return;
    }
    // Track B Phase 4 — a receipt_update advances an already-applied message's
    // delivered/read aggregate. Merge (set-union) onto the stored row so the
    // tick advances; no-op when the message isn't local yet.
    const receipt = normalizeReceiptUpdate(data);
    if (receipt !== null) {
      const { applied } = await this.engine.applyReceiptUpdate(this.topic_id, receipt);
      if (applied) this.emitChange();
      return;
    }
    // Track B Phase 4 (reactions) — a reaction_update carries the full current
    // reaction set + rev for an already-applied message. Apply (rev-LWW) so the
    // chips update; no-op if the message isn't local yet or the update is stale.
    const reaction = normalizeReactionUpdate(data);
    if (reaction !== null) {
      const { applied } = await this.engine.applyReactionUpdate(this.topic_id, reaction);
      if (applied) this.emitChange();
      return;
    }
    // Track B Phase 4 (edit/delete) — an edit_update carries the message's new
    // body + tombstone flag + rev. Apply (rev-LWW) so the bubble re-renders;
    // no-op if the message isn't local yet or the update is stale.
    const edit = normalizeEditUpdate(data);
    if (edit !== null) {
      const { applied } = await this.engine.applyEditUpdate(this.topic_id, edit);
      if (applied) this.emitChange();
      return;
    }
    const msg = normalizeInbound(data);
    if (msg === null) return;
    await this.engine.applyInbound(this.topic_id, msg);
    // W5 GAP-4 — this echo (a user_message carrying our client_msg_id) reconciled
    // the optimistic row to `acked`; cancel its ack deadline so it can't later
    // spuriously flip to `failed`.
    if (msg.client_msg_id !== null && msg.client_msg_id.length > 0) {
      this.clearAckTimer(msg.client_msg_id);
    }
    this.emitChange();
  }

  /**
   * Stale-store reset detection (M1). On `session_ready`, if the server's
   * reported high-water seq has regressed below our local cursor, the server was
   * wiped / reinstalled under us; clear the stale on-device transcript so the
   * resume that follows re-syncs from the fresh server. Emits a change on a real
   * reset so the UI drops the stale messages immediately, before the replay
   * lands. A no-op on every normal connect (server at/ahead of us, or no seq).
   */
  private async reconcileServerReset(frame: unknown): Promise<void> {
    const serverMaxSeq = parseSessionReadyMaxSeq(frame);
    const { reset } = await this.engine.reconcileServerReset(this.topic_id, serverMaxSeq);
    if (reset) this.emitChange();
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
    this.armAckTimersFor(flushed);
    if (flushed.length > 0) this.emitChange();
  }

  private async flush(): Promise<void> {
    const flushed = await this.queue.flush((envelope) => {
      const ok = this.ws.send(envelope);
      if (!ok) throw new Error('socket not open');
    }, this.topic_id);
    this.armAckTimersFor(flushed);
    if (flushed.length > 0) this.emitChange();
  }

  /**
   * W5 GAP-4 — parity with WebChatSession. Arm an ack deadline for every freshly
   * `sent` row from a flush; when it fires without the echo having reconciled the
   * row, flip `sent` → `failed` so the render layer shows a retry affordance
   * instead of a permanently-stuck 🕓 clock. NEVER auto-resends (the resend is the
   * reconnect's idempotent `flushUnacked`), so it can't double-send a slow-but-
   * live turn or fight the one-reply-per-turn substrate.
   */
  private armAckTimersFor(flushed: readonly ChatMessage[]): void {
    for (const m of flushed) {
      if (m.status === 'sent') this.armAckTimer(m.client_msg_id);
    }
  }

  private armAckTimer(client_msg_id: string): void {
    if (client_msg_id.length === 0 || this.ackTimeoutMs <= 0) return;
    if (this.ackTimers.has(client_msg_id)) return;
    const handle = this.setTimeoutFn(() => {
      void this.onAckTimeout(client_msg_id);
    }, this.ackTimeoutMs);
    this.ackTimers.set(client_msg_id, handle);
  }

  private async onAckTimeout(client_msg_id: string): Promise<void> {
    this.ackTimers.delete(client_msg_id);
    const row = await this.store.getByClientMsgId(this.topic_id, client_msg_id);
    if (row === null || row.status !== 'sent') return; // already acked/failed, or gone
    await this.store.upsert({ ...row, status: 'failed' });
    this.emitChange();
  }

  private clearAckTimer(client_msg_id: string): void {
    const handle = this.ackTimers.get(client_msg_id);
    if (handle === undefined) return;
    this.clearTimeoutFn(handle);
    this.ackTimers.delete(client_msg_id);
  }

  private clearAllTimers(): void {
    for (const handle of this.ackTimers.values()) this.clearTimeoutFn(handle);
    this.ackTimers.clear();
  }

  private emitChange(): void {
    if (this.onChange !== undefined) this.onChange();
  }
}

/**
 * Build a synthetic inbound agent message from a `chat_command_result` frame.
 * The visible body is the result `text`, else the error message, else a generic
 * line (mirrors the legacy `commandResultBody`). Synthesizes a stable
 * `message_id` from the client_msg_id (or ts) so a re-delivery upserts rather
 * than duplicates. Returns null when the frame isn't a well-formed command result.
 */
function commandResultToInbound(
  env: Record<string, unknown>,
  viewProjectId: string | null,
): InboundChatMessage | null {
  const text = typeof env['text'] === 'string' ? (env['text'] as string) : '';
  const error = env['error'] as { message?: unknown } | undefined;
  const errMsg = typeof error?.message === 'string' ? (error.message as string) : '';
  const body = text.length > 0 ? text : errMsg.length > 0 ? errMsg : 'Command completed.';
  const ts = typeof env['ts'] === 'number' && Number.isFinite(env['ts']) ? (env['ts'] as number) : 0;
  const cmid =
    typeof env['client_msg_id'] === 'string' && (env['client_msg_id'] as string).length > 0
      ? (env['client_msg_id'] as string)
      : null;
  const message_id = `cmd:${cmid ?? ts}`;
  const out: InboundChatMessage = {
    role: 'agent',
    message_id,
    seq: null,
    body,
    client_msg_id: null,
    project_id: viewProjectId,
    attachments: null,
    created_at: ts,
  };
  if (typeof env['deep_link'] === 'string' && (env['deep_link'] as string).length > 0) {
    out.deep_link = env['deep_link'] as string;
  }
  return out;
}

/** Mint a device id when the caller didn't supply a stable one. Prefer an
 *  injected generator (tests), then `crypto.randomUUID`, then a cheap fallback
 *  so the session never throws on a runtime without WebCrypto. */
function generateDeviceId(generateId?: () => string): string {
  if (generateId !== undefined) return generateId();
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID !== undefined) return `dev-${c.randomUUID()}`;
  return `dev-${Math.floor(Math.random() * 1e9).toString(36)}`;
}
