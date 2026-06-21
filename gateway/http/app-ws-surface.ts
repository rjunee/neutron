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
 * The path `/ws/app/chat` is deliberately distinct from the landing
 * server's existing `/ws/chat` (which is owned by the onboarding chat
 * bridge). Mounting on a separate path means the landing surface's
 * tests, the M2 onboarding flow, and this new surface stay
 * independently composable; no behaviour change to either path when
 * the other is unwired.
 */

import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'
import { AppWsAdapter } from '../../channels/adapters/app-ws/adapter.ts'
import {
  decodeAppWsInbound,
  decodeAppWsResume,
  appWsTopicId,
  MAX_USER_MESSAGE_LEN,
  payloadIsEmpty,
  sanitizeAttachments,
  sanitizePlatform,
  sanitizeProjectId,
  type AppWsOutbound,
} from '../../channels/adapters/app-ws/envelope.ts'
import type { AppWsAuthResolver } from '../../channels/adapters/app-ws/auth.ts'
import type {
  AppWsClientPlatform,
  AppWsSessionRegistry,
} from '../../channels/adapters/app-ws/session-registry.ts'

export interface AppWsSocketData {
  /** Discriminator for the multiplexed websocket handler in compose.ts. */
  surface: 'app_ws'
  user_id: string
  project_slug: string
  channel_topic_id: string
  /**
   * P5.2 — project_id captured at upgrade time from the query string.
   * Stashed here so subsequent outbound envelopes can echo it back
   * without the client having to re-send on every message. Mutable
   * because the inbound `user_message` envelope may carry a different
   * project_id (e.g. the client switched tabs without reconnecting);
   * we update on every inbound and use the most recent value when
   * emitting the echo.
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

/**
 * Pre-dispatch chat-command filter. Returns a non-null response when
 * the inbound is a recognised command (e.g. `/note <body>`); the
 * surface posts the response back via the session registry and SKIPS
 * `adapter.dispatchInbound` so the LLM path doesn't fire. Returning
 * `null` lets the inbound fall through to the normal LLM dispatch.
 *
 * Per docs/plans/notes-core-tier1-brief.md § 3.2.
 */
export interface ChatCommandFilter {
  match(input: {
    user_id: string
    project_slug: string
    channel_topic_id: string
    project_id?: string
    body: string
  }): Promise<ChatCommandFilterResult | null>
}

export interface ChatCommandFilterResult {
  /** A short reply line for the chat surface to render. */
  text: string
  /** Optional structured payload (search hits, drawer list, etc.). */
  data?: unknown
  /** Optional deep-link the channel may surface as a tap target. */
  deep_link?: string
  /** Populated only when the command was malformed or denied. */
  error?: { code: string; message: string }
}

export interface CreateAppWsSurfaceOptions {
  adapter: AppWsAdapter
  registry: AppWsSessionRegistry
  auth: AppWsAuthResolver
  /** The gateway's own instance slug — used for `session_ready` payloads. */
  project_slug: string
  /**
   * Optional pre-dispatch chat-command filter. When supplied, the
   * surface checks every inbound (HTTP + WS) against the filter
   * BEFORE calling `adapter.dispatchInbound`. A matching command
   * short-circuits the LLM path and emits a tool-result envelope
   * back via the session registry.
   */
  chat_command_filter?: ChatCommandFilter
}

export function createAppWsSurface(opts: CreateAppWsSurfaceOptions): AppWsSurface {
  const { adapter, registry, auth } = opts
  const chat_command_filter = opts.chat_command_filter
  const project_slug = opts.project_slug

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
        const token = url.searchParams.get('token') ?? ''
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
        const data: AppWsSocketData = {
          surface: 'app_ws',
          user_id: resolved.user_id,
          project_slug: resolved.project_slug,
          channel_topic_id: appWsTopicId(resolved.user_id),
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
        const registerOpts: { platform?: AppWsClientPlatform } = {}
        if (data.platform !== undefined) registerOpts.platform = data.platform
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
        // query; 0 / unset when no durable log is wired.
        if (adapter.hasChatLog) {
          try {
            const last_seen_seq = await adapter.currentMaxSeq(data.channel_topic_id)
            if (last_seen_seq > 0) ready.last_seen_seq = last_seen_seq
          } catch {
            /* non-fatal: omit last_seen_seq, client resumes from its cursor */
          }
        }
        send(ready)
        console.info(
          `[app-ws] instance=${data.project_slug} user=${data.user_id} topic=${data.channel_topic_id} project=${data.project_id ?? '-'} platform=${data.platform ?? '-'} event=open`,
        )
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
          } catch (err) {
            const reason = err instanceof Error ? err.message : 'resume error'
            ws.send(JSON.stringify({ v: 1, type: 'error', code: 'resume_failed', message: reason }))
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
          const { was_new } = await adapter.ingestUserMessage({
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
          // Pre-dispatch chat-command filter — when matched, the
          // filter has already executed its side effect (e.g. captured
          // a note); we post a tool-result envelope back and SKIP
          // `dispatchInbound` so the LLM path doesn't run. Per
          // docs/plans/notes-core-tier1-brief.md § 3.2.
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
    // Pre-dispatch chat-command filter — when matched, short-circuit
    // the LLM dispatch and stash a tool-result envelope to ship in the
    // response body. Per docs/plans/notes-core-tier1-brief.md § 3.2.
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
      await ctx.adapter.dispatchInbound({
        user_id: resolved.user_id,
        channel_topic_id,
        body: text,
        ...(project_id !== null ? { project_id } : {}),
        ...(cleaned_attachments !== null ? { attachments: cleaned_attachments } : {}),
      })
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
