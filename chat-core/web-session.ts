/**
 * @neutronai/chat-core — `WebChatSession`: the high-level composition a web
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
  normalizeEditUpdate,
  normalizeInbound,
  normalizeReactionUpdate,
  normalizeReceiptUpdate,
  parseSessionReadyMaxSeq,
  type ChatMessage,
  type OutboundButtonChoice,
  type OutboundEdit,
  type OutboundReaction,
  type OutboundReceipt,
  type ReactionAction,
} from './types.ts'
import { ChatWsClient, type ConnStatus, type SocketLike } from './ws-client.ts'

/**
 * GAP-4 — default ack-timeout (ms). A `sent` message whose server echo hasn't
 * reconciled it within this window flips to `failed` so the UI can swap the
 * stuck 🕓 clock for a retry affordance. Deliberately GENEROUS relative to the
 * actual ack latency: the ack is the server's `user_message` ECHO (a persist +
 * seq-stamp + fan-out — sub-second), which is INDEPENDENT of the agent turn
 * (fire-and-forget, up to ~240s). So 15s can never be tripped by a slow-but-live
 * turn, only by a genuinely lost socket — and the flip never itself resends (the
 * resend is the reconnect's idempotent `flushUnacked`), so it can neither
 * double-send a live turn nor fight the one-reply-per-turn substrate.
 */
export const DEFAULT_ACK_TIMEOUT_MS = 15_000
/**
 * GAP-5 — resume fallback (ms). On every (re)open the server normally announces
 * `session_ready` immediately, which drives resume + queue-drain. This fallback
 * fires resume+drain anyway if `session_ready` hasn't arrived within the window,
 * so a reconnect ALWAYS catches up + drains even against a server that never
 * announces. Kept short but > a normal announce RTT so a healthy connect never
 * double-resumes.
 */
export const DEFAULT_RESUME_FALLBACK_MS = 2_000

/** Default single-shot timer that never keeps the host process alive (Node/Bun
 *  `unref`), so a pending ack/resume timer can't block a test run or a clean
 *  shutdown. Injectable per-session for deterministic tests. */
function defaultSetTimeout(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms)
  ;(handle as { unref?: () => void }).unref?.()
  return handle
}

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
  /** GAP-4 — ack-timeout window (ms). Default {@link DEFAULT_ACK_TIMEOUT_MS};
   *  0 disables the failed-state flip. */
  ackTimeoutMs?: number
  /** GAP-5 — resume-fallback window (ms). Default {@link DEFAULT_RESUME_FALLBACK_MS};
   *  0 disables the fallback (session_ready remains the sole resume trigger). */
  resumeFallbackMs?: number
  /** Injectable single-shot timer (tests). Default: unref'd `setTimeout`. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
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
  /** GAP-4 — per-message (client_msg_id → handle) ack-deadline timers. A row that
   *  never gets its echo flips `sent` → `failed` when its timer fires. */
  private readonly ackTimers = new Map<string, unknown>()
  private readonly ackTimeoutMs: number
  /** GAP-5 — the pending resume fallback for the current open (null when a
   *  session_ready already drove resume, or between opens). */
  private resumeFallbackHandle: unknown = null
  /** GAP-5 — whether resume+drain has already run for the CURRENT open. Reset to
   *  false on every (re)open; set true whenever `resumeAndFlush` runs (fallback OR
   *  session_ready). Guarantees exactly one resume per open — a late session_ready
   *  arriving AFTER the fallback fired does NOT resume/resend a second time,
   *  UNLESS its stale-store reconcile actually reset the store (which needs a
   *  fresh resume-from-0). */
  private resumedThisOpen = false
  private readonly resumeFallbackMs: number
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown
  private readonly clearTimeoutFn: (handle: unknown) => void

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
    this.ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS
    this.resumeFallbackMs = opts.resumeFallbackMs ?? DEFAULT_RESUME_FALLBACK_MS
    this.setTimeoutFn = opts.setTimeoutFn ?? defaultSetTimeout
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as never))

    const wsOpts: ConstructorParameters<typeof ChatWsClient>[0] = {
      url: opts.url,
      createSocket:
        opts.createSocket ??
        ((url: string) => new WebSocket(url) as unknown as SocketLike),
      // GAP-5 — on EVERY (re)open, guarantee resume + queue-drain runs EXACTLY
      // once. Reset the per-open guard, then arm a fallback that fires resume+drain
      // if the server's session_ready (the fast path, in handleInbound) never lands.
      onOpen: () => {
        this.resumedThisOpen = false
        this.armResumeFallback()
      },
      // GAP-5 / FIX 2 — the socket is gone: cancel any pending resume fallback so
      // it can't fire resume+drain on a dead socket (a dropped send whose flush
      // callback throws would otherwise become an unhandled rejection).
      onClose: () => {
        this.clearResumeFallback()
      },
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

  /** Close the connection (no reconnect until `start()` again) and tear down all
   *  session timers (ack deadlines + resume fallback) so nothing leaks. */
  stop(): void {
    this.ws.close()
    this.clearAllTimers()
  }

  /** AppState bridge — call on focus/blur / visibilitychange. */
  setActive(active: boolean): void {
    this.ws.setActive(active)
  }

  /**
   * GAP-2 — network-reachability signal. Delegates to the transport: resets the
   * reconnect backoff and reconnects NOW so a regained network doesn't wait out
   * the dead-air backoff. THE SEAM: a surface wires this to its platform's
   * connectivity event and calls it — chat-core intentionally does NOT subscribe
   * to any platform API here:
   *   - web / mobile-web: `addEventListener('online', () => session.notifyReachable())`
   *   - native (Expo): NetInfo `addEventListener(s => s.isConnected && session.notifyReachable())`
   *     bridged through the W6 native transport shim.
   * Doubles as the manual "retry connection" action for a UI affordance.
   */
  notifyReachable(): void {
    this.ws.notifyReachable()
  }

  /**
   * GAP-5 — flush-before-suspend hook. A surface calls this on backgrounding
   * (web `visibilitychange` → hidden / `pagehide`; native `AppState` → background)
   * to push typed-but-unsent (`queued`) messages onto the wire NOW, before the OS
   * suspends the tab/app and freezes timers. Best-effort: a closed socket simply
   * leaves them queued for the next reconnect. Drains QUEUED only (not a full
   * unacked resend) so backgrounding never re-sends an already in-flight message.
   */
  async flushBeforeSuspend(): Promise<void> {
    await this.flush()
  }

  /**
   * GAP-4 — manual retry affordance. Re-drives every not-yet-`acked` send
   * (`queued` / `sent` / `failed`) over the CURRENT open socket, idempotently on
   * `client_msg_id` (the server de-dupes, and the `was_new` guard means a
   * re-delivery never re-fires the agent). A no-op while the socket is down —
   * the reconnect's own `resumeAndFlush` re-drives them then, or the UI can wire
   * the retry button to {@link notifyReachable} to force that reconnect.
   */
  async retry(): Promise<void> {
    const flushed = await this.queue.flushUnacked((envelope) => {
      const ok = this.ws.send(envelope)
      if (!ok) throw new Error('socket not open')
    }, this.topic_id)
    this.armAckTimersFor(flushed)
    if (flushed.length > 0) this.emitChange()
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
      // GAP-5 — session_ready is the FAST path for resume; cancel the on-open
      // fallback so a normal connect resumes exactly once (no double-resume).
      this.clearResumeFallback()
      // Stale-store reset detection (M1) — ALWAYS run (even if the fallback
      // already resumed): check whether the server's high-water seq regressed
      // below our local cursor (server wiped / reinstalled under us). If so the
      // local transcript is from a dead server; drop it so a fresh resume
      // re-syncs the transcript from seq 0.
      const didReset = await this.reconcileServerReset(data)
      // FIX 1 — resume EXACTLY once per open: if the on-open fallback already
      // resumed (from the stale MAX cursor), don't resume/resend again — UNLESS
      // the reconcile just wiped the store, which mandates a fresh resume-from-0.
      if (!this.resumedThisOpen || didReset) {
        await this.resumeAndFlush()
      }
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
    // Track B Phase 4 (edit/delete) — an edit_update carries the message's new
    // body + tombstone flag + monotonic rev. Apply it (rev-LWW) so the bubble
    // re-renders; no-op if the message isn't local yet or the update is stale.
    const edit = normalizeEditUpdate(data)
    if (edit !== null) {
      const { applied } = await this.engine.applyEditUpdate(this.topic_id, edit)
      if (applied) this.emitChange()
      return
    }
    const msg = normalizeInbound(data)
    if (msg === null) return
    await this.engine.applyInbound(this.topic_id, msg)
    // GAP-4 — this echo (a user_message carrying our client_msg_id) reconciled
    // the optimistic row to `acked`; cancel its pending ack deadline so it can't
    // spuriously flip to `failed` after the fact.
    if (msg.client_msg_id !== null && msg.client_msg_id.length > 0) {
      this.clearAckTimer(msg.client_msg_id)
    }
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

  /**
   * Edit a message's body (Track B Phase 4). Sends an `edit` frame over the
   * socket; the server authorizes it against the message's author (a human
   * device may edit `user` messages) and fans an `edit_update` (new body +
   * monotonic rev) back to every device, which {@link handleInbound} applies.
   * The authoritative state is the server's fanned aggregate. Best-effort over
   * the open socket; a frame sent while offline returns `false` and the UI can
   * re-issue. An empty body is rejected (use {@link deleteMessage} to remove).
   */
  editMessage(message_id: string, body: string): boolean {
    if (message_id.length === 0 || body.length === 0) return false
    const env: OutboundEdit = { v: 1, type: 'edit', message_id, action: 'edit', body }
    return this.ws.send(env)
  }

  /**
   * Delete (tombstone) a message (Track B Phase 4). Sends an `edit` frame with
   * `action:'delete'`; the server authorizes it against the message's author and
   * fans an `edit_update` with `deleted:true` to every device, which clears the
   * body and renders a "message deleted" placeholder. Best-effort over the open
   * socket.
   */
  deleteMessage(message_id: string): boolean {
    if (message_id.length === 0) return false
    const env: OutboundEdit = { v: 1, type: 'edit', message_id, action: 'delete' }
    return this.ws.send(env)
  }

  /**
   * P1b (onboarding / quick-reply buttons) — post the user's option choice back
   * to the server. Sends a `button_choice` frame carrying the option's `value`
   * (the routing key, NOT its label) + the `prompt_id` so the server's
   * outstanding-prompt store resolves the canonical choice; an optional
   * `freeform_text` rides along when the prompt allowed a free reply. Mirrors how
   * a user message is sent, but best-effort over the open socket (a tap is not on
   * the lossless message critical path): a choice tapped while offline returns
   * `false` and the UI can re-issue. Returns whether the frame reached the
   * socket.
   */
  sendButtonChoice(prompt_id: string, choice_value: string, freeform_text?: string): boolean {
    if (prompt_id.length === 0 || choice_value.length === 0) return false
    const env: OutboundButtonChoice = { v: 1, type: 'button_choice', prompt_id, choice_value }
    if (freeform_text !== undefined && freeform_text.length > 0) env.freeform_text = freeform_text
    return this.ws.send(env)
  }

  /**
   * Stale-store reset detection (M1). On `session_ready`, if the server's
   * reported high-water seq has regressed below our local cursor, the server was
   * wiped / reinstalled under us; clear the stale local transcript so the resume
   * that follows re-syncs from the fresh server. Emits a change on a real reset
   * so the UI drops the stale messages immediately, before the replay lands.
   * A no-op on every normal connect (server at/ahead of us, or no reported seq).
   */
  private async reconcileServerReset(frame: unknown): Promise<boolean> {
    const serverMaxSeq = parseSessionReadyMaxSeq(frame)
    const { reset } = await this.engine.reconcileServerReset(this.topic_id, serverMaxSeq)
    if (reset) this.emitChange()
    return reset
  }

  /** Send the resume request from our local cursor, then re-drive every
   *  not-yet-acked send. Uses `flushUnacked` (not `flush`) so a message that
   *  was handed to a socket which then dropped before the server echoed it is
   *  retried on reconnect rather than stranded `sent` forever (Codex P1). The
   *  retry is idempotent server-side (`client_msg_id`) and the surface's
   *  `was_new` guard stops it re-firing the agent. */
  private async resumeAndFlush(): Promise<void> {
    // FIX 1 — mark this open as resumed so a later session_ready (or a redundant
    // fallback) doesn't resume/resend a second time on the same connection.
    this.resumedThisOpen = true
    const resume = await this.engine.resumeRequest(this.topic_id)
    this.ws.send(resume)
    const flushed = await this.queue.flushUnacked((envelope) => {
      const ok = this.ws.send(envelope)
      if (!ok) throw new Error('socket not open')
    }, this.topic_id)
    this.armAckTimersFor(flushed)
    if (flushed.length > 0) this.emitChange()
  }

  private async flush(): Promise<void> {
    const flushed = await this.queue.flush((envelope) => {
      const ok = this.ws.send(envelope)
      if (!ok) throw new Error('socket not open')
    }, this.topic_id)
    this.armAckTimersFor(flushed)
    if (flushed.length > 0) this.emitChange()
  }

  /**
   * GAP-5 — arm the on-open resume fallback. Called from the transport's
   * `onOpen`; the timer fires resume + queue-drain only if a `session_ready`
   * (which cancels it) hasn't already done so, so every open resumes exactly once.
   */
  private armResumeFallback(): void {
    this.clearResumeFallback()
    if (this.resumeFallbackMs <= 0) return
    this.resumeFallbackHandle = this.setTimeoutFn(() => {
      this.resumeFallbackHandle = null
      // FIX 2 — belt-and-suspenders: never resume on a socket that isn't open
      // (onClose already clears this timer; this guards a stray fire), and
      // `.catch` a failed resume so it just waits for the next reconnect instead
      // of surfacing as an unhandled rejection.
      if (this.ws.getStatus() !== 'open') return
      void this.resumeAndFlush().catch(() => {
        /* resume/drain failed (socket dropped mid-flush) — the next reconnect's
           resumeAndFlush re-drives it; nothing to surface here. */
      })
    }, this.resumeFallbackMs)
  }

  private clearResumeFallback(): void {
    if (this.resumeFallbackHandle !== null) {
      this.clearTimeoutFn(this.resumeFallbackHandle)
      this.resumeFallbackHandle = null
    }
  }

  /** GAP-4 — arm an ack deadline for every freshly-`sent` row from a flush. The
   *  fire-time check re-reads the store, so arming a row that is already `failed`
   *  (a resend) is harmless. Idempotent: an existing timer is left in place. */
  private armAckTimersFor(flushed: readonly ChatMessage[]): void {
    for (const m of flushed) {
      if (m.status === 'sent') this.armAckTimer(m.client_msg_id)
    }
  }

  private armAckTimer(client_msg_id: string): void {
    if (client_msg_id.length === 0 || this.ackTimeoutMs <= 0) return
    if (this.ackTimers.has(client_msg_id)) return
    const handle = this.setTimeoutFn(() => {
      void this.onAckTimeout(client_msg_id)
    }, this.ackTimeoutMs)
    this.ackTimers.set(client_msg_id, handle)
  }

  /** Deadline elapsed with no echo — flip `sent` → `failed` (only if the row is
   *  STILL `sent`: a row that already reconciled to `acked`, or was re-driven,
   *  is left alone) so the UI shows a retry affordance instead of a stuck clock. */
  private async onAckTimeout(client_msg_id: string): Promise<void> {
    this.ackTimers.delete(client_msg_id)
    const row = await this.store.getByClientMsgId(this.topic_id, client_msg_id)
    if (row === null || row.status !== 'sent') return
    await this.store.upsert({ ...row, status: 'failed' })
    this.emitChange()
  }

  private clearAckTimer(client_msg_id: string): void {
    const handle = this.ackTimers.get(client_msg_id)
    if (handle === undefined) return
    this.clearTimeoutFn(handle)
    this.ackTimers.delete(client_msg_id)
  }

  private clearAllTimers(): void {
    this.clearResumeFallback()
    for (const handle of this.ackTimers.values()) this.clearTimeoutFn(handle)
    this.ackTimers.clear()
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
