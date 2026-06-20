import type { Server, WebSocketHandler } from 'bun'
import type { CompositionHttpHandler } from '../types.ts'

export interface HttpSurfacesCompositionInput {
  /**
   * Optional HTTP handler. When set, the boot shell wires it to the
   * `Bun.serve` listener so the graph's HTTP-adjacent surfaces (channels
   * webhook, MCP server, identity callback, connect API) are reachable
   * on the per-instance port. P1 S4 graph composition does not yet supply
   * one; S6 connect API + P2 onboarding are the consumers.
   *
   * Sprint 18: when `landing_server` and/or `telegram_webhook` are
   * supplied AND `http_handler` is omitted, `composeProductionGraph`
   * composes a precedence-chain handler via `composeHttpHandler` from
   * `./http/compose.ts` and exposes it as `graph.fetch`. Caller-
   * supplied `http_handler` always wins — tests and custom paths stay
   * authoritative.
   */
  http_handler?: (req: Request) => Response | Promise<Response>
  /**
   * Optional fallback handler used by the composed precedence chain
   * when no upstream surface owns a route. Production wires
   * `defaultHealthzHandler({project_slug, bootedAt})` from
   * `gateway/index.ts` here so the chain ends in a real `/healthz`
   * stub instead of a bare 404. Optional — when omitted, the chain
   * 404s on any unowned route (the legacy test-fixture default).
   *
   * Per ISSUE #32 — moving the composed-chain assembly into
   * `composeProductionGraph` means the boot's `bootedAt` + slug
   * context flows through this seam instead of being inlined.
   */
  default_handler?: CompositionHttpHandler
  /**
   * Sprint 18 — landing server (chat HTTP + WebSocket upgrade) wired by
   * `gateway/index.ts:boot` into the per-instance `Bun.serve` listener.
   * The factory `createLandingServer` from `@neutronai/landing` returns
   * the `{ fetch, websocket }` pair this field expects; production
   * builds it with a `ChatBridge` constructed via
   * `gateway/http/chat-bridge.ts:buildWebChatBridge`.
   */
  landing_server?: {
    fetch: (req: Request, server: Server<unknown>) => Response | Promise<Response>
    websocket: WebSocketHandler<unknown>
  }
  /**
   * Sprint 18 — Telegram webhook handler. Built via
   * `channels/adapters/telegram/webhook-server.ts:buildWebhookHandler`
   * by the caller (production: with secret_token from secrets store +
   * receiver wired to the channel router). When omitted, the
   * `/webhook/telegram` route 404s through the default fallback.
   */
  telegram_webhook?: {
    handler: (req: Request) => Promise<Response>
  }
  /**
   * P1.5 § 1.5.5 — POST /internal/cache-invalidate handler. Production
   * wires the JWT slug-history LRU's `invalidateInternalHandle` callback
   * here so the rename orchestrator can push-invalidate after a rename
   * commits. Optional; when omitted the route falls through to the
   * default 404 chain (the LRU's pull-style 5min TTL fallback covers
   * the gap with acceptable staleness, per P1.5 detailed design § 1.5.5).
   */
  internal_cache_invalidate?: {
    invalidateInternalHandle: (internal_handle: string) => void
    expectedToken: string
  }
  /**
   * P1.5 § 1.5.8 — GET /api/v1/slug/check handler. Production composer
   * wires `handleSlugCheck` against the registry + slug-history + the
   * merged reserved-slug set. Argus r2 [BLOCKING #2]: this used to be
   * shipped without a route binding, so the slug-picker UX could not
   * preflight before rename — users hit failure inside renameUrlSlug
   * instead of the picker. The route binding lives in
   * `gateway/http/compose.ts`; this field is the wire-point.
   */
  slug_check_handler?: (req: Request) => Promise<Response>
  /**
   * Substrate-lift S2/S3 — operator REPL force-respawn handler
   * (`POST /admin/respawn-session`). Production wires
   * `createAdminRespawnSurface(...)` from `gateway/http/admin-respawn-surface.ts`
   * whenever an operator token is configured (the persistent REPL is the sole
   * substrate post-S3-rip-replace; the removed `NEUTRON_PERSISTENT_REPL` flag no
   * longer gates it — Codex r2); otherwise unset → the route 404s. Returns `null`
   * for non-owned paths.
   */
  admin_respawn_handler?: (req: Request) => Promise<Response | null>
  /**
   * Chat-history hydration (2026-05-28) — `GET /api/v1/chat/history`
   * surface. Production wires `createChatHistorySurface(...)` from
   * `gateway/http/chat-history-surface.ts` with the per-instance
   * `ButtonStore` + the same `cookieToUserClaim` closure the WS
   * upgrade uses (built in `gateway/index.ts:2923`). Optional — when
   * unset the route is unmounted and the chat surface degrades
   * gracefully (no historical-turn render on connect).
   *
   * Per `docs/plans/2026-05-28-001-feat-chat-history-hydration-plan.md`.
   */
  chat_history_surface?: { handler: (req: Request) => Promise<Response | null> }
  /**
   * 2026-05-28 sidebar + per-project chat topology sprint — sibling of
   * `chat_history_surface`. Production wires `createChatTopicsSurface(...)`
   * from `gateway/http/chat-topics-surface.ts` with the per-instance
   * `ButtonStore` + the same `cookieToUserClaim` closure the WS upgrade
   * uses + a `ProjectSettingsStore`-backed name resolver. Optional —
   * when unset the chat client falls back to its built-in "General-only"
   * sidebar row.
   */
  chat_topics_surface?: { handler: (req: Request) => Promise<Response | null> }
  /**
   * Sprint 28 — `GET /avatar.png` handler. Production wires
   * `onboarding/profile-pic/storage.ts:buildAvatarRouteHandler` against
   * the per-instance `<owner_home>`. Optional — when omitted the route
   * falls through to the default 404 chain (the user just hasn't picked
   * an avatar yet, or this surface is dev/test).
   */
  avatar_handler?: (req: Request) => Response | Promise<Response>
  /**
   * Sprint 28 Codex r2 P2 — `GET /profile-pic/candidate/<id>.png`
   * handler. Production wires `buildCandidateRouteHandler` so the
   * web/app image-gallery picker can fetch each candidate thumbnail.
   */
  candidate_handler?: (req: Request) => Response | Promise<Response>
}
