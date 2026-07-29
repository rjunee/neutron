/**
 * @neutronai/gateway/http — HTTP route composition.
 *
 * Sprint 18 — per-instance gateway HTTP route composition.
 *
 * Composes the production routes (`/chat`, `/webhook/telegram`, the
 * unified `/ws/app/chat` Expo-app socket, plus the existing cross-instance
 * API) into a single `{ fetch, websocket }` pair the boot shell hands to
 * `Bun.serve`. The landing routes (`/chat` GET, `/chat.js` GET,
 * `/api/v1/sign-up` GET, `/invite*`, `/onboarding/invite-accept` POST) are
 * delegated to `createLandingServer` from `@neutronai/landing`, which
 * encapsulates the per-route HTTP logic. (Chat itself moved off the
 * landing server's old `/ws/chat` onboarding socket onto `/ws/app/chat`.)
 *
 * C4 (world-class-refactor plan §C4) — the precedence ladder is GENERATED
 * from the ordered `ROUTE_SLOTS` registry in `./route-slots.ts` (first match
 * wins, array order IS precedence). Each surface is one `RouteSlot`
 * declaration there; this module keeps only the compose shell:
 *
 *   - the per-request auth-gate pre-step (runs BEFORE the ladder for
 *     browser-facing routes) + the Set-Cookie stitch onto the downstream
 *     response,
 *   - the generated ladder walk ending in the default healthz/404 fallback,
 *   - the landing ⇄ app-ws websocket multiplex.
 *
 * The WebSocket upgrade rides on the same `Bun.serve` instance via the
 * `websocket` option. Only the landing server + the app-ws surface
 * contribute WS handlers (the slots flagged `ws: true`); other routes are
 * HTTP-only.
 */

import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'

import {
  evaluateAuthGate,
  type AuthGateOptions,
} from '@neutronai/landing/auth-gate.ts'
import { isSpaClientRoute } from '@neutronai/landing/spa-routes.ts'
import type { HttpGate } from './http-gate.ts'
import {
  ROUTE_SLOTS,
  slotMatches,
  type AppWsHandler,
  type ComposeSurfaceInput,
  type LandingHandler,
  type RouteDispatchContext,
} from './route-slots.ts'

// C4 — the surface handler shapes, the landing path-set, and the registry
// itself are re-exported so existing importers of this module keep working
// (and so tests can assert routing against the single source of truth).
export {
  buildComposeSurfaces,
  CHAINED_SURFACE_COMPOSITION_KEYS,
  hasAnyChainedSurface,
  isLandingRoute,
  LANDING_ROUTE_PATHS,
  ROUTE_SLOTS,
} from './route-slots.ts'
export type { HttpGate } from './http-gate.ts'
export type {
  AppWsHandler,
  InternalCacheInvalidateConfig,
  LandingHandler,
  RouteDispatchContext,
  RouteMatch,
  RouteSlot,
  RouteSlotComposition,
  SurfaceHandler,
} from './route-slots.ts'

/** Matches landing/server.ts SocketState (kept loose to avoid coupling). */
type LandingSocketState = unknown

/**
 * Input to `composeHttpHandler`. The per-surface fields are GENERATED from
 * the `ROUTE_SLOTS` registry (`ComposeSurfaceInput` — one optional field per
 * slot `key`; see each slot's docblock in `./route-slots.ts` for the surface
 * semantics that used to live on per-field JSDoc here). The two non-rung
 * fields are declared inline below.
 */
export type ComposeHttpHandlerInput = ComposeSurfaceInput & {
  /**
   * 2026-05-27 returning-user resume sprint — optional per-instance HTTP
   * auth gate. When supplied, the composed handler runs the gate on every
   * request that hits the user-facing path set (`isGatedUserFacingRoute`
   * below) BEFORE dispatching to the landing / app / cores surface. The
   * gate consumes a `?start=<token>` (cryptographic verify, no jti claim)
   * + sets a session cookie, OR accepts an existing session cookie, OR
   * 302s a browser request to the identity service's signin with
   * `return_url` preserved.
   *
   * When `authGate` is omitted the gate is skipped entirely — the
   * pre-2026-05-27 unauthenticated behaviour for `/chat` / `/api/app/*`
   * is preserved (used by tests + dev / smoke deploys without an
   * identity service co-located).
   *
   * Per docs/plans/2026-05-27-returning-user-resume-auth.md.
   */
  /**
   * C5b — the ONE auth-gate seam, both modes. When supplied, the composed
   * handler runs the gate on every request that hits the user-facing path set
   * (`isGatedUserFacingRoute`) BEFORE dispatching the route ladder. Managed
   * owner-gated mode supplies `buildManagedAuthGate(<AuthGateOptions>)` (the
   * OAuth decision gate + Set-Cookie stitch); Open anonymous mode supplies
   * `buildOpenOwnerGate(...).gate` (the single-owner serving gate). Both flow
   * through the single `gate.apply(...)` dispatch below.
   *
   * When omitted the gate is skipped entirely — the pre-2026-05-27
   * unauthenticated behaviour for `/chat` / `/api/app/*` is preserved (used by
   * tests + dev / smoke deploys without an identity service co-located).
   */
  gate?: HttpGate
  /**
   * Always-present fallback. Production wires
   * `defaultHealthzHandler({ project_slug, bootedAt })` from gateway/index.
   */
  defaultHandler: (req: Request) => Response | Promise<Response>
}

/**
 * C5b — the MANAGED-mode adapter: wrap an `AuthGateOptions` decision object into
 * the unified `HttpGate` seam. Behaviorally IDENTICAL to the pre-C5b inline
 * auth-gate block that lived in `composeHttpHandler` — it evaluates the gate,
 * short-circuits redirects, and stitches the gate's `Set-Cookie` onto the
 * downstream response (APPEND, never replace, for BOTH the `authenticated` and
 * cookie-valid `allow` decisions — sliding refresh). Pinned by
 * `auth-gate-dispatch.test.ts` + `auth-gate-seam-both-modes.test.ts`.
 */
export function buildManagedAuthGate(options: AuthGateOptions): HttpGate {
  return {
    async apply(req, _server, next): Promise<Response> {
      const decision = await evaluateAuthGate(req, options)
      if (decision.kind === 'redirect-to-signin') {
        return new Response(null, {
          status: 302,
          headers: { location: decision.location },
        })
      }
      // Argus r1 BLOCKER #1 + #2 — a 302 to a per-instance route, carrying an
      // optional Set-Cookie to stitch onto the 302 in one shot.
      if (decision.kind === 'redirect') {
        const headers = new Headers({ location: decision.location })
        if (decision.set_cookie !== undefined) {
          headers.append('set-cookie', decision.set_cookie)
        }
        return new Response(null, { status: 302, headers })
      }
      // `authenticated` (just consumed a `?start=`) and cookie-valid `allow`
      // (sliding refresh) both carry a Set-Cookie we APPEND onto whatever the
      // downstream chain returns — never replacing a cookie the surface set.
      let gateSetCookie: string | null = null
      if (decision.kind === 'authenticated') {
        gateSetCookie = decision.set_cookie
      }
      if (decision.kind === 'allow' && decision.set_cookie !== undefined) {
        gateSetCookie = decision.set_cookie
      }
      // 'pass-through-unauthed' (programmatic API request — bearer-auth chain
      // decides) falls through unchanged.
      const res = await next()
      if (gateSetCookie !== null) {
        const headers = new Headers(res.headers)
        headers.append('set-cookie', gateSetCookie)
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers,
        })
      }
      return res
    },
  }
}

export interface ComposedHttpHandler {
  fetch: (req: Request, server: Server<LandingSocketState>) => Response | Promise<Response>
  websocket: WebSocketHandler<LandingSocketState>
}

/**
 * 2026-05-27 returning-user resume sprint — per-instance routes that the
 * HTTP auth gate (`landing/auth-gate.ts`) protects when `authGate` is
 * supplied. The gate fires BEFORE the landing / app / cores surfaces so
 * a browser hitting any of these paths without a valid session cookie
 * gets 302'd to identity signin.
 *
 * Gated paths:
 *   - `GET /chat`               — chat HTML (browser-only)
 *   - `GET /`                   — root: redirect to `/chat` after auth
 *   - `GET|POST /api/app/*`     — Expo-app surfaces (browser requests
 *                                 carry `Accept: text/html` and trip
 *                                 the gate; mobile-app calls send
 *                                 `Accept: application/json` and the
 *                                 gate falls through to the bearer-auth
 *                                 chain — see `isBrowserNavigation` in
 *                                 `landing/auth-gate.ts`)
 *
 * Routes that intentionally BYPASS the gate (handled BEFORE this check):
 *   - `/healthz`                 — liveness probe
 *   - `/.well-known/*`           — JWKS, future static well-known
 *   - `/webhook/telegram`        — secret-token-gated server-to-server
 *   - `/internal/*`              — token-gated operator routes
 *   - `/api/v1/slug/check`       — public preflight
 *   - `/avatar.png`              — public avatar
 *   - `/profile-pic/candidate/*` — public per-candidate thumbnails
 *   - `/api/upload/*`            — chunked/legacy uploads (session
 *                                  cookie wouldn't survive POST anyway)
 *   - `/api/import/*`            — resume endpoints (server-to-server)
 *   - `/api/dev/*`               — dev-mode mint-session shim
 *   - `/api/cores/oauth/*`       — Core OAuth handoff
 *   - `/recover`                 — token re-mint after WS disconnect
 *   - `/start`                   — the `/start?token=` 302 trampoline
 *                                  already cookies + bounces to /chat
 *   - `/chat.js`                 — public JS bundle, same bytes per instance
 *   - `/invite*`                 — owner-side invite landing
 *   - `/onboarding/invite-accept`— invite-accept handler with own JWT
 */
function isGatedUserFacingRoute(pathname: string, method: string): boolean {
  if (pathname === '/' && method === 'GET') return true
  if (pathname === '/chat' && method === 'GET') return true
  // SPA client-route deep links (`GET /projects[/…]`, e.g. a shared
  // `/projects/<id>/docs?path=…` doc URL) serve the same chat-react shell as
  // `/chat`, so they get the SAME auth gate: a tokenless browser hard-load is
  // 302'd to signin rather than rendering a shell that then 302s on its first
  // `/api/app/*` fetch. Only active when `authGate` is wired (Managed); the
  // Open self-host + tests leave it unset, so this is a no-op there.
  if (isSpaClientRoute(pathname, method)) return true
  if (pathname.startsWith('/api/app/')) return true
  return false
}

/** No-op WebSocket handler used when no landing server is wired. Bun.serve
 *  requires a websocket handler when any code path calls `server.upgrade`;
 *  with no landing server, no upgrade calls happen and this stays cold. */
const NOOP_WEBSOCKET: WebSocketHandler<LandingSocketState> = {
  message(): void {},
  open(): void {},
  close(): void {},
}

/**
 * Build the composed `{ fetch, websocket }` pair. Pure factory — does not
 * touch `Bun.serve` itself; caller wires it in `gateway/index.ts:boot`.
 */
export function composeHttpHandler(input: ComposeHttpHandlerInput): ComposedHttpHandler {
  const { landing, appWs, gate, defaultHandler } = input
  return {
    fetch: async (req, server) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      const method = req.method
      const ctx: RouteDispatchContext = { req, server, url, pathname, method }

      // C5b — the ONE auth-gate seam, both modes. For browser-facing routes
      // (`/`, `/chat`, SPA deep links, `/api/app/*`) delegate to the supplied
      // gate, handing it `next = dispatchRequest` so it can either terminate
      // the request (redirect, or — Open mode — serve the injected shell) OR
      // fall through to the ladder and stitch its Set-Cookie on. Non-gated
      // routes (and the no-gate Open-without-seam / dev cases) dispatch the
      // ladder directly, exactly as before.
      if (gate !== undefined && isGatedUserFacingRoute(pathname, method)) {
        return await gate.apply(req, server, dispatchRequest)
      }
      return await dispatchRequest()

      /**
       * C4 — the GENERATED precedence ladder. Walk `ROUTE_SLOTS` in array
       * order (first match wins): skip rungs whose surface isn't wired or
       * whose static `match` fails; dispatch the rest; a non-`null`
       * Response is final, `null` falls through. Ends in the default
       * healthz/404 fallback. Behavior-identical to the pre-C4 hand-rolled
       * ladder — pinned by `__tests__/route-slots-transition.test.ts`.
       */
      async function dispatchRequest(): Promise<Response> {
        for (const s of ROUTE_SLOTS) {
          const value = input[s.key]
          if (value === undefined) continue
          if (s.match !== undefined && !slotMatches(s.match, ctx)) continue
          // `value`'s static type is the union over all slots' value shapes;
          // TS cannot correlate it with THIS slot's `dispatch` parameter
          // (correlated-union limitation), but `defineSlot` guaranteed the
          // pairing per entry at declaration time — one contained cast.
          const dispatch = s.dispatch as (
            v: unknown,
            c: RouteDispatchContext,
          ) => Response | null | Promise<Response | null>
          const res = await dispatch(value, ctx)
          if (res !== null) return res
        }
        return await defaultHandler(req)
      }
    },
    websocket: multiplexWebsocket({
      ...(landing !== undefined ? { landing } : {}),
      ...(appWs !== undefined ? { appWs } : {}),
    }),
  }
}

/**
 * Multiplex the landing websocket close-stub + Expo app
 * (`/ws/app/chat`) websocket handlers behind the single websocket
 * option that `Bun.serve` accepts. The discriminator is
 * `ws.data.surface === 'app_ws'` set by the app-ws surface during
 * upgrade. Landing's SocketState shape does NOT set that field, so
 * any non-app-ws upgrade falls through to the landing handler (which,
 * since `/ws/chat` was removed, is now just a defensive close-stub).
 *
 * These are exactly the two `ws: true` slots in `ROUTE_SLOTS` — the
 * multiplex is bespoke to that pair (surface-discriminated dispatch), so it
 * stays hand-rolled here rather than pretending to be registry-generic.
 *
 * When neither is wired the returned handler is a no-op cold stub
 * (matches the prior `NOOP_WEBSOCKET` behaviour for the legacy P1
 * boot path).
 */
function multiplexWebsocket(input: {
  landing?: LandingHandler
  appWs?: AppWsHandler
}): WebSocketHandler<LandingSocketState> {
  const { landing, appWs } = input
  if (landing === undefined && appWs === undefined) return NOOP_WEBSOCKET
  if (landing === undefined && appWs !== undefined) {
    return appWs.websocket as WebSocketHandler<LandingSocketState>
  }
  if (landing !== undefined && appWs === undefined) return landing.websocket
  const land = landing as LandingHandler
  const app = appWs as AppWsHandler
  const isAppWs = (ws: ServerWebSocket<LandingSocketState>): boolean => {
    const data = ws.data as { surface?: unknown } | undefined
    return data !== undefined && data?.surface === 'app_ws'
  }
  return {
    async open(ws): Promise<void> {
      if (isAppWs(ws)) {
        return app.websocket.open?.(ws as unknown as ServerWebSocket<unknown>)
      }
      return land.websocket.open?.(ws)
    },
    async message(ws, message): Promise<void> {
      if (isAppWs(ws)) {
        return app.websocket.message?.(ws as unknown as ServerWebSocket<unknown>, message)
      }
      return land.websocket.message?.(ws, message)
    },
    async close(ws, code, reason): Promise<void> {
      if (isAppWs(ws)) {
        return app.websocket.close?.(ws as unknown as ServerWebSocket<unknown>, code, reason)
      }
      return land.websocket.close?.(ws, code, reason)
    },
    async drain(ws): Promise<void> {
      if (isAppWs(ws)) {
        return app.websocket.drain?.(ws as unknown as ServerWebSocket<unknown>)
      }
      return land.websocket.drain?.(ws)
    },
  }
}
