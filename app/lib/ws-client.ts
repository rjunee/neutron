/**
 * @neutronai/app — WebSocket client for the chat surface (P5.1).
 *
 * Per SPEC.md § Phases→Steps / P5.1. Connects to
 * the instance gateway's `/ws/app/chat` endpoint, authenticates via
 * the JWT bearer in the query string, and surfaces an event API that
 * the chat screen subscribes to.
 *
 * Reconnect policy: capped exponential backoff with jitter so a
 * gateway restart doesn't thunder back from every client at the same
 * millisecond. Backoff resets on a successful `session_ready`.
 *
 * Wire envelope: matches `channels/adapters/app-ws/envelope.ts`. The
 * client treats unknown envelope `type`s as no-ops so a future
 * gateway can add envelope kinds without breaking older app builds.
 */

import type {
  AppWsOutbound,
  AppWsOutboundAgentMessage,
  AppWsOutboundAgentMessagePartial,
  AppWsOutboundUserMessageEcho,
} from './ws-envelope';

export type AppWsClientState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'auth_failed';

export interface AppWsClientEvents {
  state: (state: AppWsClientState, detail?: { code?: string; message?: string }) => void;
  agent_message: (msg: AppWsOutboundAgentMessage) => void;
  /** P5.1 — streaming chunk for an in-flight agent message. */
  agent_message_partial: (msg: AppWsOutboundAgentMessagePartial) => void;
  user_message: (msg: AppWsOutboundUserMessageEcho) => void;
  session_ready: (input: {
    user_id: string;
    project_slug: string;
    topic_id: string;
    project_id?: string;
  }) => void;
  error: (input: { code: string; message: string }) => void;
}

export interface AppWsClientOptions {
  /** Base WS URL e.g. `wss://my-instance.example.test`. */
  base_url: string;
  /** Bearer token (HS256 JWT in dev, EdDSA JWT in prod). */
  token: string;
  /**
   * P5.2 — project this socket is scoped to. The value is appended to
   * the upgrade query string as `project_id=<id>` and included on every
   * outbound `user_message` envelope. The gateway echoes it back on the
   * canonical stream so the client renders messages in the right
   * project's transcript. Optional for back-compat with the global
   * (no-project) chat surface.
   */
  project_id?: string;
  /**
   * Argus BLOCKING #2 — client platform reported on the upgrade query
   * string. The gateway stashes this so outbound `agent_message`
   * envelopes carry doc-link URLs the client can actually dispatch
   * ('web' → https://<web-app-host>/projects/<id>/docs?path=...,
   * 'native' → neutron://docs/...). When unset the gateway defaults
   * to native.
   */
  platform?: 'web' | 'native';
  /** Override for tests. Defaults to the global `WebSocket`. */
  websocket_ctor?: typeof WebSocket;
  /** Min backoff in ms (default 500). */
  min_backoff_ms?: number;
  /** Max backoff in ms (default 15000). */
  max_backoff_ms?: number;
}

type Listener<K extends keyof AppWsClientEvents> = AppWsClientEvents[K];

export class AppWsClient {
  private socket: WebSocket | null = null;
  private state: AppWsClientState = 'disconnected';
  // Loose-typed storage — the public `on` / `emit` enforce the
  // per-event signature; internally we just hold callbacks.
  private listeners: Map<keyof AppWsClientEvents, Array<(...args: unknown[]) => void>> = new Map();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly websocketCtor: typeof WebSocket;

  constructor(private readonly opts: AppWsClientOptions) {
    this.minBackoffMs = opts.min_backoff_ms ?? 500;
    this.maxBackoffMs = opts.max_backoff_ms ?? 15_000;
    this.websocketCtor = opts.websocket_ctor ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket!;
    if (typeof this.websocketCtor !== 'function') {
      throw new Error('AppWsClient: no WebSocket constructor available in this runtime');
    }
  }

  on<K extends keyof AppWsClientEvents>(event: K, listener: Listener<K>): () => void {
    let list = this.listeners.get(event);
    if (list === undefined) {
      list = [];
      this.listeners.set(event, list);
    }
    const wrapped = listener as unknown as (...args: unknown[]) => void;
    list.push(wrapped);
    return () => {
      const idx = list!.indexOf(wrapped);
      if (idx >= 0) list!.splice(idx, 1);
    };
  }

  private emit<K extends keyof AppWsClientEvents>(
    event: K,
    ...args: Parameters<Listener<K>>
  ): void {
    const list = this.listeners.get(event);
    if (list === undefined) return;
    for (const listener of list) {
      try {
        listener(...(args as unknown[]));
      } catch (err) {
        console.warn('[ws-client] listener threw:', err);
      }
    }
  }

  getState(): AppWsClientState {
    return this.state;
  }

  connect(): void {
    if (this.state === 'connecting' || this.state === 'connected') return;
    this.intentionallyClosed = false;
    this.openSocket();
  }

  close(): void {
    this.intentionallyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket !== null) {
      try {
        this.socket.close(1000, 'client closed');
      } catch {
        // swallow — already closing/closed
      }
      this.socket = null;
    }
    this.setState('disconnected');
  }

  /**
   * Send a user message envelope over the WS. The gateway echoes
   * back as `user_message` on the same socket so the UI updates
   * from the canonical stream.
   *
   * Returns `true` when the message was queued onto the socket;
   * `false` when the socket isn't open (caller should retry via the
   * POST `/api/app/chat/send` HTTP path).
   *
   * P5.2 — `project_id` on the envelope is sourced from the optional
   * `input.project_id` first (per-call override; used when the screen
   * switches projects without reconnecting the socket) and then from
   * the constructor option `opts.project_id` as a default.
   */
  sendUserMessage(input: {
    body: string;
    client_msg_id?: string;
    project_id?: string;
    /** P5.1 — image attachment URLs uploaded before the send. */
    attachments?: ReadonlyArray<string>;
  }): boolean {
    if (this.socket === null || this.socket.readyState !== this.websocketCtor.OPEN) {
      return false;
    }
    const project_id = input.project_id ?? this.opts.project_id;
    const env: {
      v: 1;
      type: 'user_message';
      body: string;
      client_msg_id?: string;
      project_id?: string;
      attachments?: ReadonlyArray<string>;
    } = {
      v: 1,
      type: 'user_message',
      body: input.body,
      ...(input.client_msg_id !== undefined ? { client_msg_id: input.client_msg_id } : {}),
      ...(project_id !== undefined ? { project_id } : {}),
      ...(input.attachments !== undefined && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    };
    try {
      this.socket.send(JSON.stringify(env));
      return true;
    } catch (err) {
      console.warn('[ws-client] send threw:', err);
      return false;
    }
  }

  private setState(next: AppWsClientState, detail?: { code?: string; message?: string }): void {
    if (this.state === next) return;
    this.state = next;
    this.emit('state', next, detail);
  }

  private openSocket(): void {
    const base = `${this.opts.base_url.replace(/\/+$/, '')}/ws/app/chat`;
    const params = new URLSearchParams();
    params.set('token', this.opts.token);
    if (this.opts.project_id !== undefined && this.opts.project_id.length > 0) {
      params.set('project_id', this.opts.project_id);
    }
    if (this.opts.platform !== undefined) {
      params.set('platform', this.opts.platform);
    }
    const url = `${base}?${params.toString()}`;
    this.setState(this.reconnectAttempts === 0 ? 'connecting' : 'reconnecting');
    let socket: WebSocket;
    try {
      socket = new this.websocketCtor(url);
    } catch (err) {
      console.warn('[ws-client] constructor threw:', err);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = (): void => {
      // We don't flip to 'connected' until the gateway emits
      // `session_ready` so a 401-during-upgrade race (which can
      // arrive AFTER `open`) doesn't show up as a connected state.
      // Most browsers/Bun open then immediately close — that's
      // handled in `onclose` below.
    };
    socket.onmessage = (ev: MessageEvent): void => {
      let parsed: AppWsOutbound;
      try {
        parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        console.warn('[ws-client] dropped malformed json frame');
        return;
      }
      this.dispatchInbound(parsed);
    };
    socket.onerror = (): void => {
      // Most WS implementations emit `error` immediately before `close`.
      // Keep this quiet; the close handler is the source of truth.
    };
    socket.onclose = (ev: CloseEvent): void => {
      this.socket = null;
      // Auth failures from the upgrade come back as 4xxx close codes
      // or as a 401 HTTP response (which translates to a 1006 abnormal
      // closure in most clients). Without the body we can't tell
      // 401 from a connectivity drop — we treat repeated 1006s with
      // a token that never produced a session_ready as auth-failed
      // after the first attempt.
      if (this.intentionallyClosed) {
        this.setState('disconnected');
        return;
      }
      if (this.reconnectAttempts === 0 && ev.code === 1006) {
        // First-attempt 1006: could be either network-down or auth fail.
        // Surface a single auth_failed signal so the UI can hint at the
        // token state; we still try reconnect once in case it's flaky.
        this.setState('auth_failed', { code: 'upgrade_failed', message: 'WS upgrade rejected' });
      }
      this.scheduleReconnect();
    };
  }

  private dispatchInbound(env: AppWsOutbound): void {
    if (!env || typeof env !== 'object' || env.v !== 1) return;
    switch (env.type) {
      case 'session_ready': {
        this.reconnectAttempts = 0;
        this.setState('connected');
        this.emit('session_ready', {
          user_id: env.user_id,
          project_slug: env.project_slug,
          topic_id: env.topic_id,
          ...(env.project_id !== undefined ? { project_id: env.project_id } : {}),
        });
        return;
      }
      case 'user_message': {
        this.emit('user_message', env);
        return;
      }
      case 'agent_message': {
        this.emit('agent_message', env);
        return;
      }
      case 'agent_message_partial': {
        this.emit('agent_message_partial', env);
        return;
      }
      case 'error': {
        this.emit('error', { code: env.code, message: env.message });
        return;
      }
      default:
        // Unknown type — forward-compat, drop quietly.
        return;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    // Argus r1 MINOR — once we've flipped to `auth_failed` the existing
    // token is rotten. Reconnecting on the same query string just
    // produces another 1006 → another `auth_failed` → and the banner
    // flashes briefly between each transition before sliding back to
    // 'reconnecting'. Worse, after the first attempt the
    // `reconnectAttempts === 0` gate in onclose suppresses subsequent
    // `auth_failed` signals, leaving a persistent token-rot stuck on
    // the "reconnecting" spinner forever. Gate the reconnect timer
    // here so the only way out of `auth_failed` is an explicit
    // `connect()` from the caller (typically after a token refresh).
    if (this.state === 'auth_failed') return;
    if (this.reconnectTimer !== null) return;
    const attempt = this.reconnectAttempts;
    this.reconnectAttempts = attempt + 1;
    const base = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** Math.min(attempt, 8));
    const jitter = Math.floor(Math.random() * (base / 2));
    const delay = base + jitter;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionallyClosed) return;
      this.openSocket();
    }, delay);
  }
}
