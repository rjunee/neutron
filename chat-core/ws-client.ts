/**
 * @neutronai/chat-core — reconnecting WebSocket client.
 *
 * Transport half of the sync stack: an AppState-aware socket with
 * exponential backoff + jitter (research doc §4/§6 — the RN-recommended
 * "server-sequence + AppState-aware reconnect" pattern). It owns ONLY the
 * connection lifecycle; message ordering/persistence is the sync engine's
 * job and the offline buffer is the send-queue's. On every (re)open it fires
 * `onOpen`, which the integration uses to (a) send a `resume` request and
 * (b) flush the send-queue — the two actions that turn a reconnect into a
 * gap-free, no-lost-send reconnect.
 *
 * The socket factory + timers are injectable so the whole reconnect/backoff
 * machine is unit-testable with a fake socket and no real network or wall
 * clock.
 */

export type ConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

/**
 * Default app-level heartbeat cadence (ms). The client pings ONLY after this
 * much INBOUND silence, so on a busy socket it never fires. 25s sits under the
 * common 30–60s proxy / load-balancer idle-close window (so a genuinely idle
 * socket is kept warm) and far above any per-turn cadence — a heartbeat can
 * neither be confused with nor fight the one-reply-per-turn agent substrate,
 * because a `ping` is a transport control frame the server answers with `pong`
 * WITHOUT running an agent turn (see gateway/http/app-ws-surface.ts).
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000
/**
 * Default missed-pong deadline (ms). After a ping is sent, ANY inbound frame (a
 * `pong`, or ordinary traffic) proves the socket live and cancels the deadline;
 * if NOTHING arrives within this window the socket is half-open (a wifi↔cellular
 * handoff or a device sleep the OS never surfaced as `onclose`) and is
 * force-closed so `scheduleReconnect` actually fires. 10s tolerates a slow but
 * live RTT without stranding a dead socket.
 */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000

/** The app-level heartbeat frame. A transport control frame — the server
 *  short-circuits it to a `pong` and never runs an agent turn for it. */
const PING_FRAME = { v: 1, type: 'ping' } as const

/** Minimal socket surface the client drives. The browser `WebSocket` and
 *  Bun's `WebSocket` both satisfy it; tests pass a fake. */
export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: ((ev?: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev?: unknown) => void) | null
  onerror: ((ev?: unknown) => void) | null
}

export interface ChatWsClientOptions {
  url: string
  createSocket: (url: string) => SocketLike
  /** Fired on every successful (re)open. Use to send `resume` + flush queue. */
  onOpen?: () => void
  /**
   * Fired whenever the socket goes away UNEXPECTEDLY (a real `onclose`, or a
   * heartbeat-driven force-close of a half-open socket) — NOT on an explicit
   * `close()`. A surface uses it to tear down any per-open state armed in
   * `onOpen` (e.g. the resume fallback) so it can't fire on a dead socket.
   */
  onClose?: () => void
  /** Fired for each inbound frame, parsed from JSON (raw string on parse fail). */
  onMessage?: (data: unknown) => void
  /** Fired on every connection-status transition. */
  onStatus?: (status: ConnStatus) => void
  /** Base backoff in ms (default 500). */
  minBackoffMs?: number
  /** Backoff ceiling in ms (default 15_000). */
  maxBackoffMs?: number
  /** Jitter in [0,1) added as a fraction of the computed delay (default
   *  Math.random); injectable for deterministic tests. */
  jitter?: () => number
  /**
   * Heartbeat interval in ms — the client pings after this much inbound silence
   * (default {@link DEFAULT_HEARTBEAT_INTERVAL_MS}). Set to 0 to DISABLE the
   * heartbeat entirely (tests that only exercise reconnect/backoff).
   */
  heartbeatIntervalMs?: number
  /** Missed-pong deadline in ms (default {@link DEFAULT_HEARTBEAT_TIMEOUT_MS}). */
  heartbeatTimeoutMs?: number
  /** Injectable timers (tests). Default: global setTimeout/clearTimeout. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
}

export class ChatWsClient {
  private readonly opts: Required<
    Omit<ChatWsClientOptions, 'onOpen' | 'onClose' | 'onMessage' | 'onStatus'>
  >
  private readonly onOpen: (() => void) | undefined
  private readonly onClose: (() => void) | undefined
  private readonly onMessage: ((data: unknown) => void) | undefined
  private readonly onStatus: ((status: ConnStatus) => void) | undefined

  private socket: SocketLike | null = null
  private status: ConnStatus = 'idle'
  private attempt = 0
  private active = true
  private closedByUser = false
  private reconnectHandle: unknown = null
  /** GAP-1 — heartbeat: the pending idle-ping timer (fires a ping after silence). */
  private heartbeatHandle: unknown = null
  /** GAP-1 — heartbeat: the pending missed-pong deadline (fires a force-close). */
  private pongDeadlineHandle: unknown = null

  constructor(options: ChatWsClientOptions) {
    this.opts = {
      url: options.url,
      createSocket: options.createSocket,
      minBackoffMs: options.minBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 15_000,
      jitter: options.jitter ?? Math.random,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      setTimeoutFn:
        options.setTimeoutFn ??
        ((fn, ms) => {
          const handle = setTimeout(fn, ms)
          // A background heartbeat/reconnect timer must never keep the host
          // process alive (Node/Bun `unref`), so it can't block a clean exit.
          ;(handle as { unref?: () => void }).unref?.()
          return handle
        }),
      clearTimeoutFn: options.clearTimeoutFn ?? ((h) => clearTimeout(h as never)),
    }
    this.onOpen = options.onOpen
    this.onClose = options.onClose
    this.onMessage = options.onMessage
    this.onStatus = options.onStatus
  }

  getStatus(): ConnStatus {
    return this.status
  }

  /** Current reconnect attempt count (0 once open). Exposed for tests. */
  getAttempt(): number {
    return this.attempt
  }

  /** Open the connection (idempotent while already connecting/open). */
  connect(): void {
    this.closedByUser = false
    this.active = true
    if (this.status === 'connecting' || this.status === 'open') return
    // A caller (a manual "retry" button, a remount calling `connect()` again)
    // can reach here while `status === 'reconnecting'` — a backoff timer is
    // still armed in `reconnectHandle`. Cancel it BEFORE opening a fresh
    // socket (mirrors `notifyReachable`): otherwise the timer fires later and
    // calls `openSocket()` again, orphaning the socket we're about to open.
    this.cancelReconnect()
    this.openSocket()
  }

  /**
   * AppState transition. `setActive(false)` (app backgrounded) cancels any
   * pending reconnect and stops retrying — mobile OSes sever background
   * sockets anyway, so we don't burn battery flapping. `setActive(true)`
   * (foregrounded) reconnects immediately and resets backoff so the catch-up
   * is instant.
   */
  setActive(active: boolean): void {
    if (active === this.active) return
    this.active = active
    if (!active) {
      this.cancelReconnect()
      // Stop pinging while backgrounded — mobile OSes freeze/sever the socket
      // anyway, so a heartbeat there just burns battery / mis-fires on resume.
      this.clearHeartbeat()
      return
    }
    if (this.closedByUser) return
    if (this.status === 'open') {
      // FIX 8 — foregrounding an ALREADY-OPEN socket (the common path: background
      // the tab/app on a live socket, then return). `setActive(false)` cleared
      // the heartbeat but left the socket `open`, so we must re-arm it here or
      // half-open detection is lost for the rest of the socket's life. The idle
      // timer restarts from now; if the socket silently went half-open while
      // backgrounded, the next ping's missed pong force-closes it → reconnect.
      this.startHeartbeat()
      return
    }
    if (this.status !== 'connecting') {
      this.attempt = 0
      this.openSocket()
    }
  }

  /**
   * GAP-2 — network-reachability signal. A surface wires this to its platform's
   * "connectivity regained" event (browser `online`; NetInfo `isConnected` on
   * native, via the W6 bridge) so a reconnect fires the INSTANT the network is
   * back instead of waiting out the (up-to-`maxBackoffMs`) backoff. Resets the
   * backoff to base and reconnects NOW when we're not already open/connecting;
   * a no-op after an explicit `close()` or while backgrounded (`setActive`
   * owns the foreground/background lifecycle). Safe to call spuriously — an
   * already-open socket is left untouched (a genuinely half-open one is caught
   * by the heartbeat).
   */
  notifyReachable(): void {
    if (this.closedByUser || !this.active) return
    this.attempt = 0
    this.cancelReconnect()
    if (this.status === 'open' || this.status === 'connecting') return
    this.openSocket()
  }

  /** Send a frame. Returns false when the socket isn't open (caller should
   *  rely on the send-queue to buffer). */
  send(env: unknown): boolean {
    if (this.socket === null || this.status !== 'open') return false
    try {
      this.socket.send(JSON.stringify(env))
      return true
    } catch {
      return false
    }
  }

  /** Permanently close; no reconnect until `connect()` is called again. */
  close(): void {
    this.closedByUser = true
    this.cancelReconnect()
    this.clearHeartbeat()
    this.setStatus('closed')
    if (this.socket !== null) {
      try {
        this.socket.close()
      } catch {
        /* already closed */
      }
      this.socket = null
    }
  }

  private openSocket(): void {
    this.clearHeartbeat()
    // Defense-in-depth: never replace `this.socket` without properly tearing
    // down whatever it currently points to. Under normal operation this is
    // already null here (the callers that reach `openSocket()` all null it
    // first), but if that ever stops holding — a missed cancel, a future call
    // path — the superseded socket's own onopen/onclose are identity-stale-
    // guarded and would never fire, leaking it as a zombie live connection.
    // Tear it down exactly like a real unexpected close: close the socket and
    // fire `onClose` (if it was open, this is the surface's only signal to
    // tear down per-open state — e.g. the resume-fallback armed in `onOpen`;
    // if it was still mid-handshake this mirrors `onclose` firing before
    // `onopen` ever did, which is equally harmless to signal).
    if (this.socket !== null) {
      const stale = this.socket
      this.socket = null
      try {
        stale.close()
      } catch {
        /* already closed */
      }
      if (this.onClose !== undefined) this.onClose()
    }
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting')
    let socket: SocketLike
    try {
      socket = this.opts.createSocket(this.opts.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.onopen = () => {
      // Ignore a late callback from a socket we've already replaced/force-closed.
      if (this.socket !== socket) return
      // FIX 7 — the client was deactivated (backgrounded) or closed AFTER this
      // socket's connect was already in flight. A deactivated client must stay
      // quiescent: do NOT transition to `open`, start the heartbeat, or fire
      // `onOpen` (which arms the resume-fallback + drains the queue). Close the
      // just-opened socket and null our ref so its later `onclose` can't
      // double-schedule; leave a resumable status (`idle`) so a subsequent
      // `setActive(true)` reconnects cleanly rather than stranding the client.
      if (!this.active || this.closedByUser) {
        this.socket = null
        try {
          socket.close()
        } catch {
          /* already closed */
        }
        if (!this.closedByUser) this.setStatus('idle')
        return
      }
      this.attempt = 0
      this.setStatus('open')
      this.startHeartbeat()
      if (this.onOpen !== undefined) this.onOpen()
    }
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return
      // GAP-1 — ANY inbound frame proves the socket is alive: reset the idle
      // heartbeat countdown (and clear any pending pong deadline) BEFORE
      // surfacing the frame, so a busy socket never pings.
      this.noteActivity()
      if (this.onMessage === undefined) return
      const raw = ev.data
      if (typeof raw === 'string') {
        try {
          this.onMessage(JSON.parse(raw))
        } catch {
          this.onMessage(raw)
        }
      } else {
        this.onMessage(raw)
      }
    }
    socket.onerror = () => {
      // `onclose` follows an error in the WS spec; let it drive reconnect so
      // we don't double-schedule.
    }
    socket.onclose = () => {
      // A stale socket's late close (we already moved on via force-close /
      // reconnect) must not re-schedule — that would double the backoff clock.
      if (this.socket !== socket) return
      this.socket = null
      this.clearHeartbeat()
      // Notify the surface the socket is gone (tear down per-open state) BEFORE
      // deciding whether to reconnect.
      if (this.onClose !== undefined) this.onClose()
      if (this.closedByUser || !this.active) {
        if (!this.closedByUser) this.setStatus('idle')
        return
      }
      this.scheduleReconnect()
    }
  }

  // ---------------------------------------------------------------------------
  // GAP-1 — heartbeat / half-open detection.
  //
  // Implemented on the injectable single-shot timer (no `setInterval`) so it
  // shares the reconnect machine's fake-clock testability. The heartbeat is
  // purely IDLE-driven: every inbound frame reschedules it, so a ping is sent
  // only after `heartbeatIntervalMs` of true silence; a missed pong (no inbound
  // within `heartbeatTimeoutMs`) force-closes the half-open socket so the normal
  // reconnect/backoff path runs.
  // ---------------------------------------------------------------------------

  /** (Re)arm the idle-ping timer. No-op unless the socket is open and the
   *  heartbeat is enabled (`heartbeatIntervalMs > 0`). */
  private startHeartbeat(): void {
    this.clearHeartbeat()
    if (this.status !== 'open') return
    if (this.opts.heartbeatIntervalMs <= 0) return
    this.heartbeatHandle = this.opts.setTimeoutFn(() => {
      this.heartbeatHandle = null
      this.sendPing()
    }, this.opts.heartbeatIntervalMs)
  }

  /** Idle window elapsed → ping and start the missed-pong deadline. A send that
   *  throws (socket already dying) is itself proof the socket is dead. */
  private sendPing(): void {
    if (this.socket === null || this.status !== 'open') return
    try {
      this.socket.send(JSON.stringify(PING_FRAME))
    } catch {
      this.forceCloseDead()
      return
    }
    this.pongDeadlineHandle = this.opts.setTimeoutFn(() => {
      this.pongDeadlineHandle = null
      // No inbound (not even a pong) within the deadline → half-open. Kill it so
      // scheduleReconnect fires; without this the socket looks "connected"
      // forever and the client silently misses every message.
      this.forceCloseDead()
    }, this.opts.heartbeatTimeoutMs)
  }

  /** Inbound traffic = liveness. Clear the pending pong deadline and restart the
   *  idle countdown so the next ping is a fresh `heartbeatIntervalMs` away. */
  private noteActivity(): void {
    this.clearHeartbeat()
    this.startHeartbeat()
  }

  /** Proactively drop a socket the heartbeat proved dead and drive the reconnect
   *  path (mirrors `onclose`, but for a half-open socket whose `onclose` never
   *  fires). Nulls `this.socket` first so the dead socket's eventual `onclose`
   *  is ignored (the stale-guard above) and we don't double-schedule. */
  private forceCloseDead(): void {
    const dead = this.socket
    this.clearHeartbeat()
    this.socket = null
    if (dead !== null) {
      try {
        dead.close()
      } catch {
        /* already closed */
      }
    }
    // Same teardown notification as `onclose` (the dead socket's own onclose is
    // now stale-guarded, so this is the ONLY onClose for a force-close).
    if (this.onClose !== undefined) this.onClose()
    if (this.closedByUser || !this.active) {
      if (!this.closedByUser) this.setStatus('idle')
      return
    }
    this.scheduleReconnect()
  }

  /** Tear down both heartbeat timers (no leaks, no double-scheduling). */
  private clearHeartbeat(): void {
    if (this.heartbeatHandle !== null) {
      this.opts.clearTimeoutFn(this.heartbeatHandle)
      this.heartbeatHandle = null
    }
    if (this.pongDeadlineHandle !== null) {
      this.opts.clearTimeoutFn(this.pongDeadlineHandle)
      this.pongDeadlineHandle = null
    }
  }

  private scheduleReconnect(): void {
    this.cancelReconnect()
    this.setStatus('reconnecting')
    const delay = this.backoffDelay(this.attempt)
    this.attempt += 1
    // Identity stale-guard (mirrors the socket-identity guards in
    // `openSocket()`): capture THIS timer's own handle and only act if it's
    // still the one `this.reconnectHandle` points to. Without this, a stale
    // callback that somehow still fires after being "cancelled" (e.g. a
    // native-bridge timer race on RN, or any future call path) would
    // unconditionally null `this.reconnectHandle` and call `openSocket()` —
    // clobbering a NEWER reconnect timer's bookkeeping (making it
    // uncancellable) or reopening a socket after a fresher one is already
    // live, reintroducing the exact zombie-socket class of bug this file
    // exists to prevent.
    let handle: unknown
    handle = this.opts.setTimeoutFn(() => {
      if (this.reconnectHandle !== handle) return
      this.reconnectHandle = null
      if (this.closedByUser || !this.active) return
      this.openSocket()
    }, delay)
    this.reconnectHandle = handle
  }

  /** Exponential backoff with additive jitter, capped at maxBackoffMs. */
  backoffDelay(attempt: number): number {
    const base = Math.min(this.opts.maxBackoffMs, this.opts.minBackoffMs * 2 ** attempt)
    const jitter = base * 0.25 * this.opts.jitter()
    return Math.min(this.opts.maxBackoffMs, Math.round(base + jitter))
  }

  private cancelReconnect(): void {
    if (this.reconnectHandle !== null) {
      this.opts.clearTimeoutFn(this.reconnectHandle)
      this.reconnectHandle = null
    }
  }

  private setStatus(status: ConnStatus): void {
    if (this.status === status) return
    this.status = status
    if (this.onStatus !== undefined) this.onStatus(status)
  }
}
