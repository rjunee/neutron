/**
 * @neutron/chat-core — reconnecting WebSocket client.
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
  /** Injectable timers (tests). Default: global setTimeout/clearTimeout. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown
  clearTimeoutFn?: (handle: unknown) => void
}

export class ChatWsClient {
  private readonly opts: Required<
    Omit<ChatWsClientOptions, 'onOpen' | 'onMessage' | 'onStatus'>
  >
  private readonly onOpen: (() => void) | undefined
  private readonly onMessage: ((data: unknown) => void) | undefined
  private readonly onStatus: ((status: ConnStatus) => void) | undefined

  private socket: SocketLike | null = null
  private status: ConnStatus = 'idle'
  private attempt = 0
  private active = true
  private closedByUser = false
  private reconnectHandle: unknown = null

  constructor(options: ChatWsClientOptions) {
    this.opts = {
      url: options.url,
      createSocket: options.createSocket,
      minBackoffMs: options.minBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 15_000,
      jitter: options.jitter ?? Math.random,
      setTimeoutFn:
        options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms) as unknown),
      clearTimeoutFn: options.clearTimeoutFn ?? ((h) => clearTimeout(h as never)),
    }
    this.onOpen = options.onOpen
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
      return
    }
    if (this.closedByUser) return
    if (this.status !== 'open' && this.status !== 'connecting') {
      this.attempt = 0
      this.openSocket()
    }
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
      this.attempt = 0
      this.setStatus('open')
      if (this.onOpen !== undefined) this.onOpen()
    }
    socket.onmessage = (ev) => {
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
      this.socket = null
      if (this.closedByUser || !this.active) {
        if (!this.closedByUser) this.setStatus('idle')
        return
      }
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    this.cancelReconnect()
    this.setStatus('reconnecting')
    const delay = this.backoffDelay(this.attempt)
    this.attempt += 1
    this.reconnectHandle = this.opts.setTimeoutFn(() => {
      this.reconnectHandle = null
      if (this.closedByUser || !this.active) return
      this.openSocket()
    }, delay)
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
