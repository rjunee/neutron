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

import { prefixedRandomId } from './ids.ts'
import { SendQueue } from './send-queue.ts'
import { InMemoryStore, type Store } from './store.ts'
import { MAX_HISTORY_BACKFILL_ROUNDS, SyncEngine } from './sync-engine.ts'
import {
  isTransientSystemNotice,
  normalizeEditUpdate,
  normalizeInbound,
  normalizePromptResolved,
  normalizeReactionUpdate,
  normalizeReceiptUpdate,
  parseHistoryGap,
  parseSessionReadyMaxSeq,
  type ChatMessage,
  type OutboundButtonChoice,
  type OutboundEdit,
  type OutboundReaction,
  type OutboundReceipt,
  type ReactionAction,
} from './types.ts'
import { ChatWsClient, type ConnStatus, type SocketLike } from './ws-client.ts'
// TYPE-ONLY, and that is a hard constraint on this file rather than a style
// choice — see {@link DEFAULT_PRESENCE_REFRESH_MS}. A type import is erased, so
// it adds no edge to the browser bundle's module graph.
import type { AppWsInboundPresence } from '@neutronai/wire-types'

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

/**
 * Web presence (2026-08-15) — how often a FOREGROUNDED web session re-declares
 * itself, in ms. Must equal `WEB_PRESENCE_REFRESH_MS`
 * (`@neutronai/wire-types/web-presence.ts`), from which the server derives the
 * window it believes a `foreground` claim for.
 *
 * SO WHY IS IT A SECOND LITERAL RATHER THAN AN IMPORT? Because `chat-core` must
 * not take a RUNTIME dependency on `@neutronai/wire-types`, and that is a
 * measured constraint, not a preference. It had only ever imported that package
 * as a TYPE (erased at build time); making the import a VALUE one put the leaf
 * into the browser bundle's graph through `chat-core`'s own
 * `node_modules/@neutronai/wire-types` link, and `Bun.build` then intermittently
 * failed the whole `/chat-react.js` bundle with `No matching export in
 * "wire-types/web-presence.ts"` for exports that are plainly there — but ONLY
 * inside a loaded 100-file `bun test` process, never in isolation. Measured
 * both ways on one machine and one commit: with the value import the bundle
 * fails; with it removed, and with the SAME leaf imported as a value from
 * `landing/chat-react/config.ts` instead, it succeeds. The web chat client
 * 404s when that build fails, so this is not a test-only concern.
 *
 * THE DUPLICATION IS THEREFORE DELIBERATE AND MECHANICALLY GUARDED: the two
 * numbers must agree or the client stops refreshing before the server expires
 * it, so `chat-core/__tests__/web-presence-reporting.test.ts` asserts equality.
 * A test can import both freely — a test is not bundled for the browser. Do not
 * "fix" this by importing the constant here.
 */
export const DEFAULT_PRESENCE_REFRESH_MS = 20_000

/**
 * Build the presence control frame.
 *
 * Typed as {@link AppWsInboundPresence} — a TYPE-ONLY import, so the wire shape
 * is enforced by the compiler with no runtime edge to `@neutronai/wire-types`.
 * Drift the literal and the build reds; import the package's runtime builder and
 * the browser bundle breaks (see {@link DEFAULT_PRESENCE_REFRESH_MS}).
 */
function presenceFrame(state: 'foreground' | 'background'): AppWsInboundPresence {
  return { v: 1, type: 'presence', state }
}

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
  /**
   * Web presence (2026-08-15) — how often a FOREGROUNDED session re-declares
   * itself to the server (ms). Default {@link DEFAULT_PRESENCE_REFRESH_MS}; 0
   * disables the repeat, which makes the server forget this client one
   * `WEB_PRESENCE_TTL_MS` later and start notifying the owner's phone again.
   *
   * THAT DEGRADATION IS THE DESIGN, and it is why the repeat is a timer rather
   * than a one-shot on the visibility edge. The server does not trust a
   * `foreground` claim indefinitely — a browser killed without a close frame must
   * not be able to silence the owner's phone forever — so a live client has to
   * keep saying so. Stop saying it, for any reason, and the notifications come
   * back. Every failure of this mechanism ends in a redundant buzz, never in
   * silence.
   */
  presenceRefreshMs?: number
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
   *  session_ready). Guarantees exactly one FORWARD resume per open — a late
   *  session_ready arriving AFTER the fallback fired does NOT resume/resend a
   *  second time, UNLESS its stale-store reconcile actually reset the store (which
   *  needs a fresh resume-from-0). It does NOT bound `resume` frames in general:
   *  the BACKWARDS history walk sends more of them within the same open, capped
   *  separately by {@link MAX_HISTORY_BACKFILL_ROUNDS}. Do not read this guard as
   *  "one resume per socket" — that reading, applied to the mobile session which
   *  has no guard at all, is what justified a lossy replay window. */
  private resumedThisOpen = false
  /** Backwards-walk state, reset by every forward resume: how many pages of older
   *  history this catch-up has asked for, and the lowest `before_seq` it asked
   *  from. The count is the ceiling ({@link MAX_HISTORY_BACKFILL_ROUNDS}); the
   *  floor is the liveness guard — a `history_gap` that does not STRICTLY descend
   *  is ignored, so a server that repeated itself could not spin this client. */
  private backfillRounds = 0
  private backfillFloor: number | null = null
  /** Set per forward resume, BEFORE any response frame: this device's transcript was
   *  contiguous down to seq 1 at that moment. Paired with {@link resumeCursor} to
   *  decide whether a `history_gap` names a range this device is missing. */
  private historyWholeAtResume = false
  /** The `after_seq` this open's forward resume was sent with — the top of the run
   *  {@link historyWholeAtResume} describes. */
  private resumeCursor = 0
  private readonly resumeFallbackMs: number
  /** Web presence — the owner's last reported visibility for THIS session.
   *  Starts `true` because a session is constructed by a surface that is being
   *  rendered; the surface corrects it on the first `visibilitychange`, and
   *  `landing/chat-react/useNeutronChat.ts` also states it once on mount so a tab
   *  opened in the background never reports a foreground it doesn't have. */
  private active = true
  /** Web presence — the pending re-declare timer (null while backgrounded, while
   *  the socket is down, or when the refresh is disabled). */
  private presenceHandle: unknown = null
  private readonly presenceRefreshMs: number
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
    this.presenceRefreshMs = opts.presenceRefreshMs ?? DEFAULT_PRESENCE_REFRESH_MS
    this.setTimeoutFn = opts.setTimeoutFn ?? defaultSetTimeout
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as never))

    const wsOpts: ConstructorParameters<typeof ChatWsClient>[0] = {
      url: opts.url,
      createSocket:
        opts.createSocket ??
        ((url: string) => new WebSocket(url) as unknown as SocketLike),
      // GAP-5 — on EVERY (re)open, guarantee the FORWARD resume + queue-drain runs
      // EXACTLY once. Reset the per-open guard, then arm a fallback that fires
      // resume+drain if the server's session_ready (the fast path, in
      // handleInbound) never lands. (The backwards history walk is bounded by its
      // own round budget, not by this guard.)
      onOpen: () => {
        this.resumedThisOpen = false
        this.armResumeFallback()
        // Web presence — a fresh connection carries NO server-side presence
        // state (it is keyed per connection, and this one is new), so the
        // declaration has to be re-made on every open, not only on a visibility
        // EDGE. Without this a reconnect after a network flap would leave a
        // foregrounded tab looking absent for the rest of its life.
        this.reportPresence()
      },
      // GAP-5 / FIX 2 — the socket is gone: cancel any pending resume fallback so
      // it can't fire resume+drain on a dead socket (a dropped send whose flush
      // callback throws would otherwise become an unhandled rejection).
      onClose: () => {
        this.clearResumeFallback()
        // Web presence — nothing to re-declare to; the next `onOpen` restates it.
        // (The server has already forgotten this connection on its own `close`.)
        this.clearPresenceRefresh()
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

  /**
   * AppState bridge — call on focus/blur / visibilitychange.
   *
   * Web presence (2026-08-15) — this is ALSO where the owner's attention is
   * reported to the server, so it can decline to buzz his phone about a message
   * he is reading right here. Unconditional: `ChatWsClient.setActive`
   * short-circuits when the value hasn't changed, but the surface also calls this
   * on a project switch and after a remount, and a repeated declaration is
   * exactly the refresh the server's TTL wants.
   */
  setActive(active: boolean): void {
    this.active = active
    this.ws.setActive(active)
    this.reportPresence()
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
   * GAP-4 — per-message manual retry affordance. Re-drives ONLY the send with
   * this `client_msg_id` (the failed bubble the user tapped) over the CURRENT
   * open socket — NOT its siblings. Idempotent (the server de-dupes on
   * `client_msg_id`, and the `was_new` guard means the re-delivery never re-fires
   * the agent), and it re-arms that message's ack deadline (the `has()` guard in
   * {@link armAckTimer} means a manual retry racing the reconnect-flush can't
   * arm a duplicate timer). A no-op while the socket is down — the reconnect's
   * own `resumeAndFlush` re-drives it then, or the UI can wire the button to
   * {@link notifyReachable} to force that reconnect.
   */
  async retry(client_msg_id: string): Promise<void> {
    const flushed = await this.queue.flushOne((envelope) => {
      const ok = this.ws.send(envelope)
      if (!ok) throw new Error('socket not open')
    }, this.topic_id, client_msg_id)
    if (flushed !== null) {
      this.armAckTimersFor([flushed])
      this.emitChange()
    }
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
    // The server admitting its replay was TRUNCATED: rows below `older_than` were
    // not sent. Ask for the page below — this is the only path by which a transcript
    // longer than one replay page ever completes.
    //
    // ANSWERED WITH ARITHMETIC, NOT WITH A STORE READ. `older_than` means the SERVER's
    // page came back full, which is not the same claim as "rows remain below it" for
    // THIS device: one holding 1..500 of 1000 resumed at 500, was sent 501..1000 with
    // `older_than: 501`, and used to ask for the page below 501 — 500 rows it already
    // held.
    //
    // The test is `older_than <= resumeCursor + 1`: the page STARTS where this
    // device's run ended, so it joins on and leaves no hole. It cannot be answered by
    // reading the store here — `chat-core/ws-client.ts` dispatches frames without
    // awaiting the previous one, so a read sees an arbitrary prefix of the page this
    // frame is about, and it fails in the direction that DECLINES a walk the device
    // needs. Both operands are captured in `resumeAndFlush`, before any response can
    // arrive.
    //
    // AND THE CURSOR TERM IS NOT DECORATION: a device that was whole can acquire a
    // hole from the very page it is reacting to. Holding 1..100 of a topic grown to
    // 2000, it is sent the newest page 1501..2000 and is now holey — `older_than`
    // (1501) is far above its cursor (100), so the walk runs on THIS open. A bare
    // "was I whole?" guard would have deferred it to the next one.
    const historyGap = parseHistoryGap(data)
    if (historyGap !== null) {
      if (!(this.historyWholeAtResume && historyGap <= this.resumeCursor + 1)) {
        this.requestHistoryBackfill(historyGap)
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
    // ISSUES #419 — a prompt_resolved says an option row has been ANSWERED. Apply
    // it so the row collapses on THIS device too (a second device, or the tapping
    // device once the server confirms), and — critically — so the answer lands in
    // the DURABLE local store, where a later remount will still find it.
    const resolved = normalizePromptResolved(data)
    if (resolved !== null) {
      const { applied } = await this.engine.applyPromptResolved(this.topic_id, resolved)
      if (applied) this.emitChange()
      return
    }
    // FIX #333, WEB HALF — a TRANSIENT system notice (a supervisor alert, the
    // cold-start "⏳ Waking up…" ack) is LIVE-ONLY. It has already reached the UI
    // through `onFrame` above, which renders it as a quiet centered pill.
    // Persisting it here would put it in the durable transcript forever.
    //
    // The mobile session has guarded this since #333
    // (`app/lib/chat-core/mobile-session.ts:361`); web never did, and
    // `normalizeInbound` is documented as deliberately presentation-blind
    // ("a caller that persists must consult this BEFORE normalizeInbound",
    // `chat-core/types.ts:488-491`) — so every such frame was being written to
    // the OPFS store. The server assigns these no `seq` (`AppWsAdapter.send`
    // skips the `chat_log` append for `system_notice`), and
    // `compareForDisplay` sorts unsequenced rows AFTER every sequenced one, so
    // each persisted copy became a permanent bubble pinned below the live
    // transcript — printing its own true date under today's messages, which is
    // what made the timeline read as mis-ordered. It is also a row the resume
    // replay can never reconcile.
    if (isTransientSystemNotice(data)) return
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
  /**
   * Report read messages. Best-effort: an id is recorded ONLY when the socket
   * accepted the frame, so a send that failed (commonly: the socket is still
   * connecting right after a project switch) is retried on the next call.
   *
   * RETURNS THE IDS ACTUALLY SENT. That retry only works if callers keeping their
   * own ledger fill it from this RETURN rather than from the argument they passed
   * — filling it from the argument marks a failed send as done and removes the id
   * from every later call, so the receipt is never sent again and the unread badge
   * stalls until a reload. Already-sent ids are included in the return: they are
   * confirmed sent, which is what a caller's ledger is asking about.
   */
  markRead(messageIds: readonly string[]): readonly string[] {
    const accepted: string[] = []
    for (const message_id of messageIds) {
      if (message_id.length === 0) continue
      if (this.readSent.has(message_id)) {
        accepted.push(message_id)
        continue
      }
      const env: OutboundReceipt = { v: 1, type: 'receipt', message_id, state: 'read' }
      if (this.ws.send(env)) {
        this.readSent.add(message_id)
        accepted.push(message_id)
      }
    }
    return accepted
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
    this.resumeCursor = resume.after_seq
    this.ws.send(resume)
    const flushed = await this.queue.flushUnacked((envelope) => {
      const ok = this.ws.send(envelope)
      if (!ok) throw new Error('socket not open')
    }, this.topic_id)
    this.armAckTimersFor(flushed)
    if (flushed.length > 0) this.emitChange()
    // LAST, behind the queue drain: history is never more urgent than the owner's
    // undelivered sends. A fresh budget per forward resume, then one backwards
    // request if this device's transcript is NOT CONTIGUOUS down to seq 1 — the
    // server can only report a gap for a page it just sent, so without this local
    // test a walk that ran out of budget on one open could never be picked up on
    // the next.
    //
    // Contiguity, not "my oldest applied seq" — which is what this said, and it
    // described the shipped behaviour before `Store.contiguousFloorSeq` replaced
    // `earliestSeenSeq`. A device holding seq 1 with a hole ABOVE it has an oldest
    // seq of 1, so an oldest-row test reports "nothing missing" and the hole is never
    // asked for again (`chat-core/sync-engine.ts` `backfillFrom`).
    this.backfillRounds = 0
    this.backfillFloor = null
    const backfillFrom = await this.engine.backfillFrom(this.topic_id)
    // Cached for the open, because the `history_gap` handler cannot safely re-derive
    // either operand (`chat-core/ws-client.ts` dispatches frames without awaiting the
    // previous one, so a store read there sees an arbitrary prefix of the page it is
    // reacting to). `backfillFrom` is null both for an EMPTY store and for a
    // transcript that is already whole, and only the second is a reason to refuse.
    this.historyWholeAtResume =
      backfillFrom === null && (await this.store.lastSeenSeq(this.topic_id)) > 0
    if (backfillFrom !== null) this.requestHistoryBackfill(backfillFrom)
  }

  /**
   * Ask for the page of history below `before_seq` — one round of the backwards
   * walk. Refuses to run past {@link MAX_HISTORY_BACKFILL_ROUNDS} rounds, and
   * refuses any bound that does not strictly descend, so the walk always
   * terminates. A send that fails (socket gone) is not retried here: the next
   * forward resume restarts the walk from the store.
   *
   * Whether a `history_gap` is worth answering at all is decided by its handler, not
   * here — that decision needs the frame's `older_than`.
   */
  private requestHistoryBackfill(before_seq: number): void {
    if (before_seq <= 1) return
    if (this.backfillRounds >= MAX_HISTORY_BACKFILL_ROUNDS) return
    if (this.backfillFloor !== null && before_seq >= this.backfillFloor) return
    this.backfillFloor = before_seq
    this.backfillRounds += 1
    this.ws.send(this.engine.backfillRequest(before_seq))
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

  /**
   * Web presence — state the current visibility to the server and (re)arm the
   * repeat while foregrounded.
   *
   * A no-op on a socket that isn't open: `ChatWsClient.send` returns false and
   * the next `onOpen` restates it. Backgrounding sends its frame and stops the
   * repeat — the server would expire us anyway, but saying so makes the phone
   * start notifying immediately rather than a TTL later, which is the whole
   * point of the frame the owner's tab sends as it goes away.
   */
  private reportPresence(): void {
    this.clearPresenceRefresh()
    this.ws.send(presenceFrame(this.active ? 'foreground' : 'background'))
    if (this.active) this.armPresenceRefresh()
  }

  /**
   * Web presence — re-declare `foreground` every {@link presenceRefreshMs}.
   *
   * A CHAINED SINGLE-SHOT, not an interval, so it shares the injectable-timer
   * testability of the resume fallback above. It does NOT re-arm across a closed
   * socket: a dead connection's presence is the server's to forget, and the
   * reconnect's `onOpen` is what restates it.
   *
   * DELIBERATELY NOT THE TRANSPORT HEARTBEAT. That ping is idle-driven — any
   * inbound frame reschedules it — so it falls silent on a socket carrying a
   * streaming reply, i.e. exactly while the owner sits watching the answer he is
   * about to be pointlessly notified about.
   */
  private armPresenceRefresh(): void {
    if (this.presenceRefreshMs <= 0) return
    this.presenceHandle = this.setTimeoutFn(() => {
      this.presenceHandle = null
      if (!this.active) return
      if (this.ws.getStatus() !== 'open') return
      this.ws.send(presenceFrame('foreground'))
      this.armPresenceRefresh()
    }, this.presenceRefreshMs)
  }

  private clearPresenceRefresh(): void {
    if (this.presenceHandle !== null) {
      this.clearTimeoutFn(this.presenceHandle)
      this.presenceHandle = null
    }
  }

  private clearAllTimers(): void {
    this.clearResumeFallback()
    this.clearPresenceRefresh()
    for (const handle of this.ackTimers.values()) this.clearTimeoutFn(handle)
    this.ackTimers.clear()
  }

  private emitChange(): void {
    if (this.onChange !== undefined) this.onChange()
  }
}

/** Mint a device id when the caller didn't supply a stable one. Prefers an
 *  injected generator (tests), else the ONE shared `prefixedRandomId` — which is
 *  WebCrypto-optional by construction (see `ids.ts`). */
function generateDeviceId(generateId?: () => string): string {
  if (generateId !== undefined) return generateId()
  return prefixedRandomId('dev')
}
