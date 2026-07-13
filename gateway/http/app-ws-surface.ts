/**
 * @neutronai/gateway/http — Expo-app WebSocket surface (P5.1).
 *
 * Per SPEC.md § Phases→Steps and
 * docs/engineering-plan.md § B.P5 ("Chat surface — WebSocket
 * bidirectional stream from gateway").
 *
 * The surface exposes two routes:
 *
 *   - `GET /ws/app/chat?token=<JWT>` — WebSocket upgrade. Token is
 *     resolved by `createAppWsAuthResolver`; on success the socket is
 *     bound to the synthetic `app:<user_id>` topic and registered in
 *     the adapter's session registry. The agent's emit pipeline (any
 *     future `ChannelRouter.send` for an `app_socket` topic) routes
 *     here via the adapter.
 *
 *   - `POST /api/app/chat/send` — outbound user-message HTTP path. The
 *     brief calls this out as the canonical send path so the UI
 *     stream updates from echoes on the WS (no optimistic-only
 *     local state). The handler echoes back via `emitUserMessageEcho`
 *     and forwards the inbound through `AppWsAdapter.dispatchInbound`
 *     so the gateway's existing `ChannelRouter.receive` pipeline runs.
 *
 * `/ws/app/chat` is now the SINGLE chat WebSocket endpoint (2026-06-26
 * consolidation): onboarding runs as the initial MODE of this surface
 * (see open/composer.ts on_session_open / on_button_choice), and the
 * legacy landing onboarding socket has been removed. Steady-state and
 * onboarding share this one path, one engine, one renderer.
 */

import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'
import { AppWsAdapter } from '@neutronai/channels/adapters/app-ws/adapter.ts'
import { AppChatEditNotAuthorizedError } from '@neutronai/persistence/index.ts'
import {
  decodeAppWsInbound,
  decodeAppWsButtonChoice,
  decodeAppWsEdit,
  decodeAppWsReaction,
  decodeAppWsReceipt,
  decodeAppWsResume,
  appWsTopicId,
  appWsProjectTopicId,
  AGENT_DEVICE_ID,
  MAX_USER_MESSAGE_LEN,
  payloadIsEmpty,
  sanitizeAttachments,
  sanitizeDeviceId,
  sanitizePlatform,
  sanitizeProjectId,
  type AppWsOutbound,
} from '@neutronai/channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '@neutronai/channels/adapters/app-ws/auth.ts'
import type {
  AppWsClientPlatform,
  AppWsSessionRegistry,
} from '@neutronai/channels/adapters/app-ws/session-registry.ts'
// L2 (2026-07) — `ChatCommandFilter` + `ChatCommandFilterResult` moved to
// `../../contracts/chat-command-filter.ts` (a node-free leaf — see that
// file's header for the "stranded contract" rationale).
import type {
  ChatCommandFilter,
  ChatCommandFilterResult,
} from '@neutronai/contracts/chat-command-filter.ts'
import { constantTimeEqual } from '@neutronai/runtime/constant-time-equal.ts'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
export type { ChatCommandFilter, ChatCommandFilterResult }

/**
 * Origin guard for the `/ws/app/chat` upgrade (S0 (a) same-origin core, S2 (a)
 * configured-origin allow-list). A browser ALWAYS sends an `Origin` header on
 * the WebSocket handshake, and a WS upgrade is NOT subject to CORS — so without
 * this check ANY web page the owner merely visits could open
 * `ws://127.0.0.1:7800/ws/app/chat?token=…` against the loopback gateway.
 *
 * Comparison is by CANONICAL origin (`URL.origin` = scheme + host + port), NOT
 * host-only: configuring `https://app.example` must NOT authorize
 * `http://app.example` (network-injectable) or `ftp://app.example` or a
 * different port. Returns `true` when the request may proceed:
 *   - `Origin` ABSENT (native Expo / CLI clients send none) → allowed; those
 *     authenticate by bearer alone.
 *   - `Origin` PRESENT and its canonical origin is in `allowedWebOrigins` (the
 *     configured owner web origin(s) — `NEUTRON_WEB_APP_BASE` / landing origin,
 *     for a reverse-proxied deploy served from a different origin than the
 *     gateway's own) → allowed.
 *   - `Origin` PRESENT and its canonical origin equals the server's OWN
 *     canonical origin (`selfOrigin`, derived from the request scheme + `Host`)
 *     → allowed.
 *   - `Origin` PRESENT but cross-origin, a scheme/port downgrade, opaque
 *     (`"null"`), or `selfOrigin` unknown with no configured match → REJECTED.
 *
 * The policy keys on the `Origin` being present-and-cross-origin, NOT on its
 * absence — a same-origin/native client still connects.
 */
export function appWsOriginAllowed(
  origin: string | null,
  selfOrigin: string | null,
  allowedWebOrigins: readonly string[] = [],
): boolean {
  if (origin === null) return true
  let browserOrigin: string
  try {
    browserOrigin = new URL(origin).origin
  } catch {
    // Malformed origin.
    return false
  }
  // `URL.origin` is the string `"null"` for an opaque origin (sandboxed iframe
  // `Origin: null`) or any non-hierarchical scheme — reject those outright.
  if (browserOrigin.length === 0 || browserOrigin === 'null') return false
  // A configured owner web origin is allowed even when it differs from the
  // server's own origin (reverse-proxied deploy). CANONICAL match, so a scheme
  // downgrade / wrong port never inherits the configured origin's authority.
  // Fail-closed: an empty/unconfigured list widens nothing.
  if (allowedWebOrigins.includes(browserOrigin)) return true
  // Same-origin: the owner's served page (Origin === the server's own origin on
  // the actual bound scheme + host + port).
  if (selfOrigin !== null && browserOrigin === selfOrigin) return true
  return false
}

/**
 * S2 (a) — normalize each configured owner web origin (raw `NEUTRON_WEB_APP_BASE`
 * / landing-origin base URL strings) to its CANONICAL `URL.origin` (scheme +
 * host + port) so {@link appWsOriginAllowed} matches a browser `Origin` exactly
 * — never scheme- or port-blind. Empty / malformed / opaque entries are dropped
 * (they don't widen the allow-set — fail-closed), never a throw at boot.
 */
export function normalizeWebOrigins(bases: readonly string[]): string[] {
  const origins: string[] = []
  for (const base of bases) {
    if (typeof base !== 'string' || base.trim().length === 0) continue
    try {
      const o = new URL(base.trim()).origin
      if (o.length > 0 && o !== 'null') origins.push(o)
    } catch {
      /* malformed configured origin — ignore, don't widen the allow-set */
    }
  }
  return origins
}

/**
 * The server's OWN CANONICAL origin for a request (via `URL.origin`, so a
 * default port is stripped and the host is lower-cased — exactly like
 * {@link normalizeWebOrigins}), used for the same-origin check. Without this a
 * legit `Host: app.example.test:443` on HTTPS would build `https://…:443` and
 * never equal the browser's port-stripped `Origin`.
 *
 * Scheme resolution: prefer `X-Forwarded-Proto` (only a real reverse proxy can
 * set it — a browser cannot add headers to a WS handshake), take its FIRST
 * comma-separated token, and TRUST it only when it is `http`/`https`; otherwise
 * fall back to the actual request (socket) scheme, else `http`. `null` when the
 * `Host` header is absent (no reliable self-origin).
 */
export function requestSelfOrigin(req: Request): string | null {
  const host = req.headers.get('host')
  if (host === null || host.length === 0) return null
  let socketScheme = 'http'
  try {
    socketScheme = new URL(req.url).protocol.replace(/:$/, '').toLowerCase()
  } catch {
    /* keep the http default */
  }
  const fwd = req.headers.get('x-forwarded-proto')
  const fwdFirst = fwd !== null ? (fwd.split(',')[0] ?? '').trim().toLowerCase() : ''
  const scheme =
    fwdFirst === 'http' || fwdFirst === 'https'
      ? fwdFirst
      : socketScheme === 'http' || socketScheme === 'https'
        ? socketScheme
        : 'http'
  try {
    const o = new URL(`${scheme}://${host}`).origin
    return o !== 'null' && o.length > 0 ? o : null
  } catch {
    // Malformed Host — no reliable self-origin (still safe: configured origins
    // remain matchable, and a missing self-origin only tightens the check).
    return null
  }
}

export interface AppWsSocketData {
  /** Discriminator for the multiplexed websocket handler in compose.ts. */
  surface: 'app_ws'
  user_id: string
  project_slug: string
  /**
   * The topic this socket reads/writes/resumes against. For a WEB client that
   * connected with a `project_id`, this is the PER-PROJECT topic
   * `app:<user>:<project>` (so persistence + seq + resume + fan-out scope to the
   * project); otherwise the user-scoped `app:<user>`. Fixed for the socket's
   * lifetime — the web client reconnects to switch projects.
   */
  channel_topic_id: string
  /**
   * P5.2 — project_id captured at upgrade time from the query string.
   * Stashed here so subsequent outbound envelopes can echo it back
   * without the client having to re-send on every message, and so the
   * live-agent turn scopes to the right project. For WEB it also selects the
   * per-project `channel_topic_id` bind above. Mutable because a P5.1/mobile
   * inbound `user_message` may carry a different project_id (the mobile client
   * switches tabs WITHOUT reconnecting on its single `app:<user>` socket); we
   * update on every inbound and use the most recent value when emitting the echo.
   */
  project_id?: string
  /**
   * Argus BLOCKING #2 — client platform reported on the upgrade query
   * string ('web' | 'native'). Used by the adapter at send time to
   * pick a `DocLinkChannel` the client can actually dispatch
   * (`neutron://...` for native; `https://app.example.test/...`
   * for web). Absent for P5.1 clients that don't send the field —
   * those default to native at the adapter.
   */
  platform?: AppWsClientPlatform
  /**
   * Track B Phase 4 — client-minted device id from the upgrade query string.
   * Used to attribute read receipts to the right device and to record
   * `delivered` for this device at message fan-out time. Absent for legacy
   * clients that don't report one (those just aren't tracked for receipts).
   */
  device_id?: string
  /** Captured ONCE in `open` so identity-aware unregister works. */
  send?: (env: AppWsOutbound) => void
}

export interface AppWsSurface {
  /**
   * HTTP route dispatcher. Returns the `Response` for an owned route,
   * or `null` to indicate the request belongs to a sibling surface.
   * Caller (`compose.ts`) chains.
   */
  handler: (req: Request, server: Server<unknown>) => Promise<Response | null>
  /** Bun.serve websocket handler. Multiplexed by compose.ts. */
  websocket: WebSocketHandler<AppWsSocketData>
  /** Surface exposes the underlying adapter so wiring can register it on the router. */
  adapter: AppWsAdapter
}

export interface CreateAppWsSurfaceOptions {
  adapter: AppWsAdapter
  registry: AppWsSessionRegistry
  auth: AppWsAuthResolver
  /** The gateway's own instance slug — used for `session_ready` payloads. */
  project_slug: string
  /**
   * S0 security quick-patch (b) — the per-boot app-ws token. When set, a
   * BROWSER upgrade (`Origin` header present) to `/ws/app/chat` MUST present
   * exactly this token (constant-time compared) instead of the guessable
   * `dev:<owner>` bearer; the web client receives the token via the served page
   * bootstrap (`window.__neutron_app_ws_token`). Native clients (no `Origin`
   * header) are exempt and continue to authenticate through the resolver.
   * UNSET ⇒ no token gate — back-compat for gateway-level tests and non-Open
   * consumers that never mint one.
   */
  app_ws_token?: string
  /**
   * S2 (b) — require the per-boot `app_ws_token` even from an ORIGIN-LESS
   * (native) client. On a LOOPBACK bind this stays `false` so native dev clients
   * authenticate by bearer alone (today's ergonomics). On a WIDE bind it is set
   * `true` so an Origin-less client on the network can NOT ride the predictable
   * `dev:owner` bearer — it must present the real per-boot token like the web
   * client does. No effect when `app_ws_token` is unset (no token gate at all).
   */
  require_token_without_origin?: boolean
  /**
   * S2 (a) — configured owner web origin(s) (e.g. `NEUTRON_WEB_APP_BASE` /
   * landing origin) whose BROWSER upgrades are allowed IN ADDITION to a strict
   * same-origin (`Origin` host === `Host`). A reverse-proxied deploy serves the
   * web app from a different origin than the gateway's own Host, so a pure
   * same-origin check would reject the legitimate owner page. Raw base URL
   * strings; the surface extracts each `host` ONCE at construction via
   * {@link normalizeWebOriginHosts}. Absent / empty ⇒ same-origin-only (the S0
   * behavior — a loopback dogfood box with `NEUTRON_WEB_APP_BASE` unset).
   */
  allowed_web_origins?: readonly string[]
  /**
   * Optional pre-dispatch chat-command filter. When supplied, the
   * surface checks every inbound (HTTP + WS) against the filter
   * BEFORE calling `adapter.dispatchInbound`. A matching command
   * short-circuits the LLM path and emits a tool-result envelope
   * back via the session registry.
   */
  chat_command_filter?: ChatCommandFilter
  /**
   * Onboarding consolidation (2026-06-26) — fired once per WS `open`, right
   * after `session_ready`. The Open composer uses it to drive the unified
   * onboarding: if the owner has not finished onboarding it runs an
   * `appWsChatTurn` on the live CC session (topic `app:<user>`), which emits
   * the first onboarding prompt over THIS socket (the SAME surface steady-state
   * chat uses). A no-op for fully-onboarded owners. Must never throw — the
   * surface wraps it so a hook failure can't tear down the socket.
   */
  on_session_open?: (input: {
    user_id: string
    project_slug: string
    channel_topic_id: string
    project_id?: string
  }) => Promise<void>
  /**
   * Onboarding consolidation (2026-06-26) — fired when the client taps an
   * onboarding/quick-reply button (a `button_choice` frame). The composer
   * resolves it against the engine's persisted prompt (onboarding) or feeds the
   * choice to the live agent (steady-state). Decoded BEFORE the user_message
   * path so the message decoder keeps its narrow type.
   */
  on_button_choice?: (input: {
    user_id: string
    project_slug: string
    channel_topic_id: string
    project_id?: string
    prompt_id: string
    choice_value: string
    freeform_text?: string
  }) => Promise<void>
}

export function createAppWsSurface(opts: CreateAppWsSurfaceOptions): AppWsSurface {
  const { adapter, registry, auth } = opts
  const chat_command_filter = opts.chat_command_filter
  const project_slug = opts.project_slug
  const app_ws_token = opts.app_ws_token
  // S2 (b) — on a WIDE bind, an Origin-less client must ALSO present the token.
  const requireTokenWithoutOrigin = opts.require_token_without_origin ?? false
  // S2 (a) — resolve the configured owner web origin(s) to canonical origins
  // ONCE (empty on a loopback dogfood box), reused on every upgrade check below.
  const allowedWebOrigins = normalizeWebOrigins(opts.allowed_web_origins ?? [])
  const on_session_open = opts.on_session_open
  const on_button_choice = opts.on_button_choice

  return {
    adapter,
    handler: async (req, server) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      const method = req.method

      if (pathname === '/ws/app/chat') {
        if (method !== 'GET') {
          return new Response('method not allowed', { status: 405 })
        }
        // S0 (a) — same-origin guard. A cross-origin web page cannot open this
        // socket even though the loopback gateway trusts localhost; a native
        // client (no Origin) is unaffected. Rejected BEFORE any token work so a
        // malicious page never even reaches the resolver.
        const origin = req.headers.get('origin')
        if (!appWsOriginAllowed(origin, requestSelfOrigin(req), allowedWebOrigins)) {
          return new Response(
            JSON.stringify({
              ok: false,
              code: 'bad_origin',
              message: 'cross-origin websocket upgrade rejected',
            }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          )
        }
        const token = url.searchParams.get('token') ?? ''
        // S0 (b) / S2 (b) — per-boot token gate. When a per-boot token is
        // configured, an upgrade carrying an `Origin` (a browser) MUST present
        // exactly it — the guessable `dev:<owner>` constant is no longer accepted
        // from the web. On a LOOPBACK bind, Origin-less native clients skip this
        // and fall through to the resolver's bearer check (dev ergonomics). On a
        // WIDE bind (`requireTokenWithoutOrigin`), Origin-less clients on the
        // network must ALSO present the token — they cannot ride `dev:owner`.
        // Constant-time compare so a token guess can't be narrowed by timing.
        if (
          app_ws_token !== undefined &&
          (origin !== null || requireTokenWithoutOrigin) &&
          !constantTimeEqual(token, app_ws_token)
        ) {
          return new Response(
            JSON.stringify({
              ok: false,
              code: 'bad_app_ws_token',
              message: 'invalid app-ws token',
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          )
        }
        const resolved = await auth.resolve(token)
        if ('code' in resolved) {
          // Bad credential → 401 with a small JSON body so the client
          // can surface the failure reason.
          return new Response(
            JSON.stringify({ ok: false, code: resolved.code, message: resolved.message }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          )
        }
        // P5.2 — sanitize `project_id` from the upgrade query string.
        // We deliberately accept `null` (the field is optional and
        // back-compat with P5.1 clients that don't send it). The
        // value lives on the socket data so subsequent echoes carry
        // it; per sprint roadmap § 4 this is the "stash and round
        // trip" semantics — full per-project routing is a later
        // P5.x concern.
        const raw_project_id = url.searchParams.get('project_id')
        const project_id = raw_project_id !== null ? sanitizeProjectId(raw_project_id) : null
        // Argus BLOCKING #2 — sanitize `platform` from the upgrade
        // query string. 'web' or 'native'; any other value is
        // dropped and the adapter defaults to native (neutron://).
        const raw_platform = url.searchParams.get('platform')
        const platform = raw_platform !== null ? sanitizePlatform(raw_platform) : null
        // Track B Phase 4 — device id for receipt attribution. Mint a synthetic
        // per-connection id when the client doesn't report one (legacy client,
        // or a missing/malformed value) so every socket is always attributable;
        // a client-supplied id is stable across reconnects, a minted one isn't.
        const raw_device_id = url.searchParams.get('device_id')
        const device_id =
          (raw_device_id !== null ? sanitizeDeviceId(raw_device_id) : null) ??
          `conn-${crypto.randomUUID()}`
        // Per-project chat (web): bind the socket to a PER-PROJECT topic
        // `app:<user>:<project>` so persistence + seq + resume + fan-out all
        // scope to that project, and the agent loop picks the project up from
        // the `project_id` field. The web React client reconnects (one socket
        // per active project) on a project switch; General omits `project_id`
        // and stays on the user-scoped `app:<user>` topic. Gated on
        // `platform === 'web'` — mobile keeps its single `app:<user>` socket +
        // `project_id`-field switch model, so its transcript is unchanged.
        const channel_topic_id =
          platform === 'web' && project_id !== null
            ? appWsProjectTopicId(resolved.user_id, project_id)
            : appWsTopicId(resolved.user_id)
        const data: AppWsSocketData = {
          surface: 'app_ws',
          user_id: resolved.user_id,
          project_slug: resolved.project_slug,
          channel_topic_id,
          device_id,
        }
        if (project_id !== null) data.project_id = project_id
        if (platform !== null) data.platform = platform
        const upgraded = server.upgrade(req, { data })
        if (!upgraded) {
          return new Response('upgrade failed', { status: 426 })
        }
        return new Response(null, { status: 101 })
      }

      if (pathname === '/api/app/chat/send' && method === 'POST') {
        const sendCtx: Parameters<typeof handleSend>[1] = { adapter, auth, project_slug }
        if (chat_command_filter !== undefined) {
          sendCtx.chat_command_filter = chat_command_filter
        }
        return await handleSend(req, sendCtx)
      }

      return null
    },
    websocket: {
      async open(ws: ServerWebSocket<AppWsSocketData>): Promise<void> {
        const data = ws.data
        if (data === undefined || data.surface !== 'app_ws') return
        const send = (env: AppWsOutbound): void => {
          // T10 / Sprint-18 pattern (landing/server.ts): when
          // `ws.send` returns 0 the underlying socket is closed.
          // We THROW rather than swallow so the producer
          // (`InMemoryAppWsSessionRegistry.send` /
          // `AppWsAdapter.send`) catches and downgrades the result
          // to a dropped-marker. Without the throw, closed-socket
          // writes look like successful delivery to the channel
          // router — the close/reconnect race silently loses
          // every agent emit between `close` and the next
          // identity-aware `unregister`. Per Codex P2 review on
          // PR #142.
          //
          // Bun's typed surface returns `number` for backpressure
          // (-1 means "queued, will flush on drain") so we ONLY
          // throw on a strict `=== 0`.
          const wrote = ws.send(JSON.stringify(env))
          if (typeof wrote === 'number' && wrote === 0) {
            throw new Error('app-ws: ws.send returned 0 (socket closed)')
          }
        }
        data.send = send
        // Register BEFORE emitting the first envelope so the registry
        // routes session_ready into the live socket. (Earlier draft
        // emitted first via adapter.emitDirect — that goes through the
        // registry and silently dropped because the entry wasn't
        // registered yet. Caught by app-ws-surface.test.ts WS round-trip.)
        const registerOpts: { platform?: AppWsClientPlatform; device_id?: string } = {}
        if (data.platform !== undefined) registerOpts.platform = data.platform
        if (data.device_id !== undefined) registerOpts.device_id = data.device_id
        registry.register(data.channel_topic_id, send, registerOpts)
        const ready: AppWsOutbound = {
          v: 1,
          type: 'session_ready',
          user_id: data.user_id,
          project_slug: data.project_slug,
          topic_id: data.channel_topic_id,
          ts: Date.now(),
        }
        if (data.project_id !== undefined) ready.project_id = data.project_id
        // Chat-sync foundation — tell the client the current high-water seq
        // so it can decide whether a `resume` is even needed (its local
        // cursor already at last_seen_seq → skip the round-trip). Cheap MAX
        // query.
        //
        // Stale-store reset detection (M1) — when a durable log IS wired we
        // ALWAYS send last_seen_seq, INCLUDING 0 (a freshly reinstalled server
        // whose log is still empty at connect time). A present 0 is an
        // affirmative "this server has nothing for the topic" signal: a client
        // whose local cursor is ahead recognises the seq regression, clears its
        // stale transcript, and re-syncs. Omitting the field on 0 (the old
        // behaviour) was indistinguishable from "no durable log wired", where
        // clearing would destroy the only copy — so the field stays ABSENT only
        // when there is no durable log at all (or the MAX query failed).
        if (adapter.hasChatLog) {
          try {
            ready.last_seen_seq = await adapter.currentMaxSeq(data.channel_topic_id)
          } catch {
            /* non-fatal: omit last_seen_seq, client resumes from its cursor */
          }
        }
        send(ready)
        console.info(
          `[app-ws] instance=${data.project_slug} user=${data.user_id} topic=${data.channel_topic_id} project=${data.project_id ?? '-'} platform=${data.platform ?? '-'} event=open`,
        )
        // Onboarding consolidation (2026-06-26) — after session_ready, give the
        // composer a chance to fire the FIRST onboarding prompt over this socket
        // when the owner hasn't finished onboarding. Wrapped so a hook failure
        // can't tear down the socket (the engine re-emits on the next connect).
        if (on_session_open !== undefined) {
          try {
            await on_session_open({
              user_id: data.user_id,
              project_slug: data.project_slug,
              channel_topic_id: data.channel_topic_id,
              ...(data.project_id !== undefined ? { project_id: data.project_id } : {}),
            })
          } catch (err) {
            console.warn(
              `[app-ws] on_session_open failed user=${data.user_id} topic=${data.channel_topic_id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          }
        }
      },
      async message(ws, message): Promise<void> {
        const data = ws.data
        if (data === undefined || data.surface !== 'app_ws') return
        let parsed: unknown
        try {
          parsed = JSON.parse(typeof message === 'string' ? message : message.toString())
        } catch {
          ws.send(
            JSON.stringify({ v: 1, type: 'error', code: 'malformed_json', message: 'invalid json' }),
          )
          return
        }
        // W5 GAP-1 — app-level heartbeat. The chat-core client pings after
        // inbound silence to detect a half-open socket (wifi↔cellular handoff /
        // device sleep the OS never surfaced as a close). Answer with a `pong`
        // so a healthy-but-idle socket is proven live and NOT force-closed. A
        // transport control frame: it short-circuits BEFORE the message decoders,
        // so it never persists, never assigns a seq, and never runs an agent turn
        // — it cannot fight the one-reply-per-turn substrate. (Even without this
        // reply the client stays correct — any inbound counts as liveness — but
        // this keeps idle sockets from tripping the `malformed_envelope` path.)
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          (parsed as { type?: unknown }).type === 'ping'
        ) {
          ws.send(JSON.stringify({ v: 1, type: 'pong', ts: Date.now() }))
          return
        }
        // Chat-sync foundation — gap-fill request. Replay everything after
        // the client's cursor to THIS socket only (the requesting device),
        // so a reconnect / cold-open fills its gap without re-broadcasting
        // to other live devices. No-op (replayAfter returns []) when no
        // durable log is wired. Checked BEFORE the message decoder so the
        // user_message path keeps its narrow type.
        const resume = decodeAppWsResume(parsed)
        if (resume !== null) {
          try {
            const replay = await adapter.replayAfter(data.channel_topic_id, resume.after_seq)
            const send = data.send
            for (const env of replay) {
              if (send !== undefined) send(env)
              else ws.send(JSON.stringify(env))
            }
            // Track B Phase 4 — after the message replay, replay current
            // receipt state (one receipt_update per message with receipts) to
            // THIS socket so its ladder reflects delivered/read for the gap it
            // missed. No-op when the receipt log isn't wired. Sent AFTER the
            // messages so each update's target message is already applied.
            const receipts = await adapter.replayReceiptsAfter(
              data.channel_topic_id,
              resume.after_seq,
            )
            for (const env of receipts) {
              if (send !== undefined) send(env)
              else ws.send(JSON.stringify(env))
            }
            // Track B Phase 4 (reactions) — likewise replay current reaction
            // state (one reaction_update per message with reactions) AFTER the
            // messages so each update's target message is already applied.
            const reactions = await adapter.replayReactionsAfter(
              data.channel_topic_id,
              resume.after_seq,
            )
            for (const env of reactions) {
              if (send !== undefined) send(env)
              else ws.send(JSON.stringify(env))
            }
            // Track B Phase 4 (edit/delete) — likewise replay current edit state
            // (one edit_update per edited/deleted message) AFTER the messages so
            // each update's target message is already applied.
            const edits = await adapter.replayEditsAfter(
              data.channel_topic_id,
              resume.after_seq,
            )
            for (const env of edits) {
              if (send !== undefined) send(env)
              else ws.send(JSON.stringify(env))
            }
          } catch (err) {
            const reason = err instanceof Error ? err.message : 'resume error'
            ws.send(JSON.stringify({ v: 1, type: 'error', code: 'resume_failed', message: reason }))
          }
          return
        }
        // Track B Phase 4 — a `read` receipt from this device. Attributed to the
        // SOCKET's device id (never the frame), then fanned to every device as a
        // receipt_update so the sender's bubble advances. Checked before the
        // message decoder so the user_message path keeps its narrow type.
        const receipt = decodeAppWsReceipt(parsed)
        if (receipt !== null) {
          const device_id = data.device_id ?? `conn-${data.user_id}`
          try {
            await adapter.recordReceipt({
              channel_topic_id: data.channel_topic_id,
              message_id: receipt.message_id,
              device_id,
              state: 'read',
              ...(data.project_id !== undefined ? { project_id: data.project_id } : {}),
            })
          } catch (err) {
            const reason = err instanceof Error ? err.message : 'receipt error'
            ws.send(JSON.stringify({ v: 1, type: 'error', code: 'receipt_failed', message: reason }))
          }
          return
        }
        // Track B Phase 4 (reactions) — an add/remove reaction from this device.
        // Attributed to the SOCKET's device id (never the frame), then fanned to
        // every device as a reaction_update. Checked before the message decoder
        // so the user_message path keeps its narrow type.
        const reaction = decodeAppWsReaction(parsed)
        if (reaction !== null) {
          const device_id = data.device_id ?? `conn-${data.user_id}`
          try {
            await adapter.recordReaction({
              channel_topic_id: data.channel_topic_id,
              message_id: reaction.message_id,
              device_id,
              emoji: reaction.emoji,
              action: reaction.action,
              ...(data.project_id !== undefined ? { project_id: data.project_id } : {}),
            })
          } catch (err) {
            const reason = err instanceof Error ? err.message : 'reaction error'
            ws.send(JSON.stringify({ v: 1, type: 'error', code: 'reaction_failed', message: reason }))
          }
          return
        }
        // Track B Phase 4 (edit/delete) — an author edit/delete from this device.
        // The editor is the SOCKET's device id (never the frame); the adapter
        // authorizes it against the message's author and fans an edit_update to
        // every device. A cross-author mutation answers with `not_authorized`.
        // Checked before the message decoder so the user_message path stays narrow.
        const edit = decodeAppWsEdit(parsed)
        if (edit !== null) {
          const device_id = data.device_id ?? `conn-${data.user_id}`
          try {
            await adapter.recordEdit({
              channel_topic_id: data.channel_topic_id,
              message_id: edit.message_id,
              editor_device_id: device_id,
              action: edit.action,
              ...(edit.body !== undefined ? { body: edit.body } : {}),
              ...(data.project_id !== undefined ? { project_id: data.project_id } : {}),
            })
          } catch (err) {
            const code = err instanceof AppChatEditNotAuthorizedError ? 'not_authorized' : 'edit_failed'
            const reason = err instanceof Error ? err.message : 'edit error'
            ws.send(JSON.stringify({ v: 1, type: 'error', code, message: reason }))
          }
          return
        }
        // Onboarding consolidation (2026-06-26) — a button/quick-reply CHOICE.
        // Routed to the composer's `on_button_choice` (engine.advance for
        // onboarding, live-agent for steady-state). Decoded BEFORE the message
        // decoder so the user_message path keeps its narrow type. No
        // ingest/echo: a tap isn't a typed message — the client renders the
        // selection optimistically; the engine emits the next prompt.
        const choice = decodeAppWsButtonChoice(parsed)
        if (choice !== null) {
          if (on_button_choice === undefined) {
            ws.send(
              JSON.stringify({
                v: 1,
                type: 'error',
                code: 'button_choice_unsupported',
                message: 'this surface does not accept button_choice',
              }),
            )
            return
          }
          try {
            await on_button_choice({
              user_id: data.user_id,
              project_slug,
              channel_topic_id: data.channel_topic_id,
              ...(data.project_id !== undefined ? { project_id: data.project_id } : {}),
              prompt_id: choice.prompt_id,
              choice_value: choice.choice_value,
              ...(choice.freeform_text !== undefined ? { freeform_text: choice.freeform_text } : {}),
            })
          } catch (err) {
            const reason = err instanceof Error ? err.message : 'button_choice error'
            ws.send(
              JSON.stringify({ v: 1, type: 'error', code: 'button_choice_failed', message: reason }),
            )
          }
          return
        }
        const inbound = decodeAppWsInbound(parsed)
        if (inbound === null) {
          ws.send(
            JSON.stringify({
              v: 1,
              type: 'error',
              code: 'malformed_envelope',
              message: 'expected { v:1, type:"user_message", body, ... } or { v:1, type:"resume", after_seq }',
            }),
          )
          return
        }
        // P5.2 — inbound may carry a fresh `project_id` (the client
        // switched tabs without reconnecting). When it does, update
        // the stash so any subsequent gateway-initiated emits (push,
        // agent reply) carry the right value. When it doesn't, fall
        // back to the upgrade-time stash.
        const inbound_project_id = inbound.project_id ?? data.project_id
        if (inbound.project_id !== undefined) {
          data.project_id = inbound.project_id
        }
        try {
          // Chat-sync foundation — persist + stamp seq + fan out the echo
          // (de-dups on client_msg_id when a durable log is wired). Falls
          // back to the legacy in-memory echo when no log is configured.
          const { was_new, message_id } = await adapter.ingestUserMessage({
            channel_topic_id: data.channel_topic_id,
            user_id: data.user_id,
            body: inbound.body,
            ...(inbound.client_msg_id !== undefined ? { client_msg_id: inbound.client_msg_id } : {}),
            ...(inbound_project_id !== undefined ? { project_id: inbound_project_id } : {}),
            ...(inbound.attachments !== undefined ? { attachments: inbound.attachments } : {}),
          })
          // DOUBLE-DISPATCH GUARD (Argus + Codex P1, PR #6): when the durable
          // log de-duped a re-sent client_msg_id (`was_new === false`), the
          // echo above already re-rendered the message (the client de-dupes it
          // on client_msg_id), but the side-effecting work below — the
          // chat-command filter and the agent dispatch — MUST NOT run again, or
          // a re-send (offline-queue flush, double-tap, HTTP/WS race) fires the
          // agent / a command twice. Storage idempotency alone doesn't make the
          // surface idempotent; this gate does.
          if (!was_new) return
          // Track B Phase 4 — the server has received this user message and is
          // about to act on it; record an `agent` READ receipt so the sender's
          // bubble shows the read tick the instant the agent picks it up — no
          // second device required. Fans a receipt_update to every device.
          await adapter.recordReceipt({
            channel_topic_id: data.channel_topic_id,
            message_id,
            device_id: AGENT_DEVICE_ID,
            state: 'read',
            ...(inbound_project_id !== undefined ? { project_id: inbound_project_id } : {}),
          })
          // Pre-dispatch chat-command filter — when matched, the
          // filter has already executed its side effect (e.g. created
          // a reminder); we post a tool-result envelope back and SKIP
          // `dispatchInbound` so the LLM path doesn't run.
          if (chat_command_filter !== undefined) {
            const matchInput: Parameters<ChatCommandFilter['match']>[0] = {
              user_id: data.user_id,
              project_slug,
              channel_topic_id: data.channel_topic_id,
              body: inbound.body,
            }
            if (inbound_project_id !== undefined) matchInput.project_id = inbound_project_id
            const cmd_result = await chat_command_filter.match(matchInput)
            if (cmd_result !== null) {
              postCommandResult(ws, data.channel_topic_id, cmd_result, inbound.client_msg_id)
              return
            }
          }
          await adapter.dispatchInbound({
            user_id: data.user_id,
            channel_topic_id: data.channel_topic_id,
            body: inbound.body,
            ...(inbound_project_id !== undefined ? { project_id: inbound_project_id } : {}),
            ...(inbound.attachments !== undefined ? { attachments: inbound.attachments } : {}),
          })
        } catch (err) {
          const reason = err instanceof Error ? err.message : 'dispatch error'
          ws.send(JSON.stringify({ v: 1, type: 'error', code: 'dispatch_failed', message: reason }))
        }
      },
      async close(ws): Promise<void> {
        const data = ws.data
        if (data === undefined || data.surface !== 'app_ws') return
        const send = data.send
        if (send !== undefined) {
          registry.unregister(data.channel_topic_id, send)
        }
        console.info(
          `[app-ws] instance=${data.project_slug} user=${data.user_id} topic=${data.channel_topic_id} project=${data.project_id ?? '-'} platform=${data.platform ?? '-'} event=close`,
        )
      },
    },
  }
}

async function handleSend(
  req: Request,
  ctx: {
    adapter: AppWsAdapter
    auth: AppWsAuthResolver
    project_slug: string
    chat_command_filter?: ChatCommandFilter
  },
): Promise<Response> {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return new Response(
      JSON.stringify({ ok: false, code: 'missing_bearer', message: 'expected Authorization: Bearer <token>' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )
  }
  const token = auth.slice('bearer '.length).trim()
  const resolved = await ctx.auth.resolve(token)
  if ('code' in resolved) {
    return new Response(
      JSON.stringify({ ok: false, code: resolved.code, message: resolved.message }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )
  }
  let body: {
    body?: unknown
    client_msg_id?: unknown
    project_id?: unknown
    attachments?: unknown
  }
  try {
    body = (await req.json()) as {
      body?: unknown
      client_msg_id?: unknown
      project_id?: unknown
      attachments?: unknown
    }
  } catch {
    return new Response(
      JSON.stringify({ ok: false, code: 'malformed_json', message: 'invalid json' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }
  // P5.1 — `body` is allowed to be missing / empty when `attachments`
  // is non-empty. The composer enables Send on
  // `draft.trim().length > 0 || attachments.length > 0`
  // (InputComposer.tsx); rejecting attachments-only sends here was the
  // root of the Argus r1 BLOCKING #2 "image-attach never reaches the
  // server" regression. Treat a missing / non-string `body` as the
  // empty string and let `payloadIsEmpty` decide.
  const text = typeof body.body === 'string' ? body.body : ''
  if (text.length > MAX_USER_MESSAGE_LEN) {
    // Mirror the WS path's `decodeAppWsInbound` cap so HTTP and WS
    // accept identical envelopes. Per Codex P2 review on PR #142.
    return new Response(
      JSON.stringify({
        ok: false,
        code: 'body_too_long',
        message: `body exceeds ${MAX_USER_MESSAGE_LEN} chars`,
      }),
      { status: 413, headers: { 'content-type': 'application/json' } },
    )
  }
  // P5.1 — attachments parity with the WS path. `sanitizeAttachments`
  // applies the same array-length / per-URL caps and shape guards the
  // WS decoder uses; malformed shapes return `null` (treated as
  // "no attachments"). Both echo + dispatchInbound thread the cleaned
  // value through so the agent loop sees the URLs on
  // `IncomingEvent.adapter_metadata.attachments`. Closes Argus r1
  // BLOCKING #3 (HTTP fallback used to drop the field entirely).
  const cleaned_attachments = sanitizeAttachments(body.attachments)
  // P5.1 — share the empty-payload predicate with the WS decoder so
  // both transports reject the same shape. Either body or attachments
  // must be non-empty.
  if (payloadIsEmpty(text, cleaned_attachments)) {
    return new Response(
      JSON.stringify({
        ok: false,
        code: 'missing_body',
        message: 'expected at least one of { body: string, attachments: string[] }',
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }
  // P5.2 — extract optional `project_id` from the request body. The
  // HTTP path mirrors the WS inbound's project_id semantics: stash on
  // the canonical envelope so the client renders the message in the
  // right project's transcript. Malformed values (wrong type, too
  // long, illegal chars) are silently dropped — the rest of the send
  // succeeds without project scoping, matching the WS path's
  // "absent or malformed → undefined" treatment.
  const project_id = body.project_id !== undefined ? sanitizeProjectId(body.project_id) : null
  const channel_topic_id = appWsTopicId(resolved.user_id)
  const echoOpts: {
    channel_topic_id: string
    user_id: string
    body: string
    client_msg_id?: string
    project_id?: string
    attachments?: ReadonlyArray<string>
  } = {
    channel_topic_id,
    user_id: resolved.user_id,
    body: text,
  }
  if (typeof body.client_msg_id === 'string' && body.client_msg_id.length > 0) {
    echoOpts.client_msg_id = body.client_msg_id
  }
  if (project_id !== null) echoOpts.project_id = project_id
  if (cleaned_attachments !== null) echoOpts.attachments = cleaned_attachments
  // Chat-sync foundation — persist + stamp seq + fan out the echo (de-dups
  // on client_msg_id). Falls back to the legacy in-memory echo when no
  // durable log is wired. The returned seq rides on the HTTP response echo
  // so an HTTP-fallback client orders this send identically to the WS path.
  const { message_id, seq, was_new } = await ctx.adapter.ingestUserMessage(echoOpts)
  const ts = Date.now()
  // DOUBLE-DISPATCH GUARD (Argus + Codex P1, PR #6): a re-sent client_msg_id
  // (HTTP retry, or the HTTP fallback racing the WS echo of the same send)
  // de-dupes to the existing row (`was_new === false`). The echo above already
  // reconciled the client's bubble; the side-effecting chat-command filter +
  // agent dispatch below MUST be skipped so the agent / a command never fires
  // twice. We still return the canonical echo so the client renders correctly.
  let command_result: ChatCommandFilterResult | null = null
  if (was_new) {
    // Track B Phase 4 — record an `agent` READ receipt for the freshly-received
    // message so the sender's bubble advances the moment the server picks it up
    // (parity with the WS path). Fans a receipt_update to every live device.
    await ctx.adapter.recordReceipt({
      channel_topic_id,
      message_id,
      device_id: AGENT_DEVICE_ID,
      state: 'read',
      ...(project_id !== null ? { project_id } : {}),
    })
    // Pre-dispatch chat-command filter — when matched, short-circuit
    // the LLM dispatch and stash a tool-result envelope to ship in the
    // response body.
    if (ctx.chat_command_filter !== undefined) {
      const matchInput: Parameters<ChatCommandFilter['match']>[0] = {
        user_id: resolved.user_id,
        project_slug: ctx.project_slug,
        channel_topic_id,
        body: text,
      }
      if (project_id !== null) matchInput.project_id = project_id
      command_result = await ctx.chat_command_filter.match(matchInput)
    }
    if (command_result === null) {
      // Chat transport — FIRE-AND-FORGET the agent turn; do NOT block the HTTP
      // response on it. The user echo is already persisted (with seq) + fanned
      // above; the agent reply fans over the WS as it completes and is
      // replayable from the durable chat_log on reconnect. Awaiting the whole
      // turn (up to 240s) before responding made the optimistic bubble
      // un-confirmable — an RN/proxy read timeout flipped it to `failed` and the
      // retry re-sent the same client_msg_id. (That re-send is now de-duped
      // server-side by the durable log, but a phantom "failed → retrying" bubble
      // is still bad UX.) Return the echo NOW; the turn runs in the background.
      // Errors surface to the client as the agent's own FAILURE_BODY
      // `agent_message` over the WS, so we only log here.
      fireAndForget('app-ws-surface.dispatchInbound', ctx.adapter
        .dispatchInbound({
          user_id: resolved.user_id,
          channel_topic_id,
          body: text,
          ...(project_id !== null ? { project_id } : {}),
          ...(cleaned_attachments !== null ? { attachments: cleaned_attachments } : {}),
        })
        .catch((err: unknown) => {
          console.warn(
            `[app-ws] topic=${channel_topic_id} HTTP-fallback dispatch failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
          throw err // re-raise so fireAndForget counts it (the .catch only adds context)
        }))
    }
  }
  // Return the canonical user_message envelope in the response so the
  // Expo client can render it locally when the WS path is down (the
  // HTTP-fallback case: emit echoes via the registry, but if no live
  // socket is registered the envelope is dropped and the WS echo
  // never arrives). Per Codex P1 review on PR #142.
  const echo: AppWsOutbound = {
    v: 1,
    type: 'user_message',
    user_id: resolved.user_id,
    body: text,
    message_id,
    ts,
    ...(echoOpts.client_msg_id !== undefined ? { client_msg_id: echoOpts.client_msg_id } : {}),
    ...(project_id !== null ? { project_id } : {}),
    ...(cleaned_attachments !== null ? { attachments: cleaned_attachments } : {}),
    ...(seq !== null ? { seq } : {}),
  }
  const responseBody: Record<string, unknown> = { ok: true, message_id, echo }
  if (command_result !== null) {
    responseBody['chat_command_result'] = command_result
  }
  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Post a `chat_command_result` envelope to the WS for the touched
 *  channel topic. Used by the WS message handler when the chat-command
 *  filter matches an inbound. */
function postCommandResult(
  ws: ServerWebSocket<AppWsSocketData>,
  channel_topic_id: string,
  cmd_result: ChatCommandFilterResult,
  client_msg_id: string | undefined,
): void {
  const env: Record<string, unknown> = {
    v: 1,
    type: 'chat_command_result',
    channel_topic_id,
    text: cmd_result.text,
    ts: Date.now(),
  }
  if (cmd_result.data !== undefined) env['data'] = cmd_result.data
  if (cmd_result.deep_link !== undefined) env['deep_link'] = cmd_result.deep_link
  if (cmd_result.error !== undefined) env['error'] = cmd_result.error
  if (client_msg_id !== undefined) env['client_msg_id'] = client_msg_id
  try {
    ws.send(JSON.stringify(env))
  } catch {
    /* socket closed; envelope dropped — same semantics as other WS sends */
  }
}
