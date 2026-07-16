/**
 * @neutronai/gateway/http — data-driven surface registry (RouteSlot).
 *
 * C4 (world-class-refactor plan §C4) — the single source of truth for the
 * per-instance gateway's HTTP surface routing. Before this unit, wiring one
 * surface required keeping FOUR hand-maintained lists in sync:
 *
 *   1. a `ComposeHttpHandlerInput` interface field (+ a clone
 *      `{ handler }` interface) in `gateway/http/compose.ts`,
 *   2. the `CompositionInput → composeInput` mapping in
 *      `gateway/composition.ts:buildComposedHttpFromComposition`,
 *   3. the `hasAnyChainedSurface` build-the-chain-at-all gate (same file),
 *   4. the precedence ladder in `composeHttpHandler`'s `dispatchRequest`.
 *
 * The lists had ALREADY diverged (see `CHAINED_SURFACE_COMPOSITION_KEYS`
 * below). Now each surface is ONE `RouteSlot` entry in the ordered
 * `ROUTE_SLOTS` array; the compose-input type, the mapping, the gate, and
 * the ladder are all GENERATED from it:
 *
 *   - `ComposeSurfaceInput` (→ `ComposeHttpHandlerInput`) is a mapped type
 *     over the slots' `key`s,
 *   - `buildComposeSurfaces()` generates mapping (2),
 *   - `hasAnyChainedSurface()` generates gate (3),
 *   - `composeHttpHandler` (in `./compose.ts`) walks `ROUTE_SLOTS` in array
 *     order to produce ladder (4).
 *
 * Adding a surface = 1 surface-factory file + 1 `slot({...})` entry here
 * (+ its `CompositionInput` field when the surface is composition-promoted —
 * that field is the graph contract Managed relies on and stays hand-declared
 * with its docs in `gateway/composition/input/*.ts`).
 *
 * ORDER IS LOAD-BEARING: `ROUTE_SLOTS` array order IS the routing precedence
 * (first match wins). The transition test
 * (`gateway/http/__tests__/route-slots-transition.test.ts`) pins the
 * generated ladder against a literal snapshot of the pre-C4 hand-rolled
 * ladder — reorder only with that test's consent.
 *
 * This module intentionally imports NO other `gateway/http` module (the
 * compose shell imports it, never the reverse) and only type-only leaves
 * from `gateway/composition/input/` — no import cycles.
 */

import type { Server, WebSocketHandler } from 'bun'

import { isSpaClientRoute } from '@neutronai/landing/spa-routes.ts'
// C5 — the landing route predicate + path set are OWNED by the landing package
// (`landing/routes.ts`, a tiny leaf mirroring `spa-routes.ts`) and CONSUMED
// here for the `landing` slot's match. The pre-C5 hand-maintained `LANDING_PATHS`
// literal that lived in this file is deleted; `LANDING_ROUTE_PATHS` is re-exported
// below so existing importers keep working. Behavior-identical (pinned by
// `landing/__tests__/routes-transition.test.ts`).
import { isLandingRoute, LANDING_ROUTE_PATHS } from '@neutronai/landing/routes.ts'
import type { HttpSurfacesCompositionInput } from '../composition/input/http-surfaces-input.ts'
import type { AppSurfacesCompositionInput } from '../composition/input/app-surfaces-input.ts'

/** Matches landing/server.ts SocketState (kept loose to avoid coupling). */
type LandingSocketState = unknown

/** The landing server's `{ fetch, websocket }` pair (`createLandingServer`). */
export interface LandingHandler {
  fetch: (req: Request, server: Server<LandingSocketState>) => Response | Promise<Response>
  websocket: WebSocketHandler<LandingSocketState>
}

/**
 * P5.1 — Expo app WebSocket surface (`/ws/app/chat` upgrade +
 * `POST /api/app/chat/send`). The websocket handler is multiplexed with the
 * landing server's handler by `ws.data.surface` (see `compose.ts`).
 */
export interface AppWsHandler {
  handler: (req: Request, server: Server<unknown>) => Promise<Response | null>
  websocket: WebSocketHandler<unknown>
}

/**
 * THE disclaiming route-surface shape: owns its path set, returns `null`
 * for every non-owned path so the chain keeps falling through. Replaces the
 * ~21 structurally-identical per-surface clone interfaces the pre-C4
 * `compose.ts` declared (AppLauncherHandler, AppTasksHandler, …,
 * CoresSurfaceHandler, DevMintSessionHandler).
 */
export interface SurfaceHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * P1.5 § 1.5.5 — POST /internal/cache-invalidate config. Auth-gated by a
 * shared HTTP secret (`X-Internal-Token`); comparison is constant-time.
 */
export interface InternalCacheInvalidateConfig {
  invalidateOwnerHandle: (owner_handle: string) => void
  /** Shared secret. Comparison is constant-time via XOR fold. */
  expectedToken: string
}

/** Per-request context handed to every slot's `match.when` + `dispatch`. */
export interface RouteDispatchContext {
  req: Request
  server: Server<LandingSocketState>
  url: URL
  pathname: string
  method: string
}

/**
 * Optional static precondition for a rung. All present fields must pass;
 * when the match fails the rung is SKIPPED (falls through), exactly like the
 * pre-C4 inline `if (pathname === … && method === …)` guards. Slots without
 * a `match` rely on their surface's own disclaim-with-`null` contract.
 */
export interface RouteMatch {
  /** Exact `url.pathname` equality. */
  path?: string
  /** `url.pathname.startsWith(prefix)`. */
  prefix?: string
  /** Exact HTTP method equality. */
  method?: string
  /** Arbitrary predicate (landing path-set / SPA catch-all). */
  when?: (ctx: RouteDispatchContext) => boolean
}

/**
 * One declared surface rung. `V` is the surface's compose-input value shape;
 * `K` its compose-input key (both flow into the generated
 * `ComposeSurfaceInput` type).
 */
export interface RouteSlot<K extends string = string, V = unknown> {
  /** Compose-input field this rung reads (generated into `ComposeSurfaceInput`). */
  key: K
  /**
   * Unique rung label (the transition test pins ladder order by these).
   * Distinct from `key` because one input can back two rungs
   * (`landing.pathset` + `landing.spa`).
   */
  rung: string
  /**
   * `CompositionInput` field whose presence promotes this surface into the
   * composed chain (`buildComposeSurfaces` + `hasAnyChainedSurface` are
   * generated from it). `null` → the surface has no composition seam
   * (`devMintSession` — compose-level only, per the pinned negative-space
   * test in `open-route-matrix.test.ts`) or is a secondary rung of an
   * already-promoted input (`landing.spa`).
   */
  composition: keyof RouteSlotComposition | null
  /**
   * Whether the composition field's presence counts toward the
   * build-the-chain-at-all gate (`hasAnyChainedSurface`). See
   * `CHAINED_SURFACE_COMPOSITION_KEYS` for the documented divergence.
   */
  gated: boolean
  /** This surface contributes a websocket handler (multiplexed in compose.ts). */
  ws?: true
  /** Static precondition; omitted → the surface handler itself disclaims. */
  match?: RouteMatch
  /**
   * Map the composition field value onto the compose-input value
   * (`undefined` → not promoted). Omitted on rungs promoted elsewhere:
   * `connectHandler` needs the Managed-only dynamic import that stays in
   * `gateway/composition.ts`; `landing.spa` shares `landing.pathset`'s
   * promotion; `devMintSession` has no composition seam.
   */
  promote?: (composition: RouteSlotComposition) => V | undefined
  /** Invoke the wired surface. `null` → fall through to the next rung. */
  dispatch: (value: V, ctx: RouteDispatchContext) => Response | null | Promise<Response | null>
}

/**
 * Structural subset of `CompositionInput` the registry reads. Composed from
 * the two type-only leaf interfaces plus structural re-declarations of the
 * three Cores surfaces / `connect_api` / `auth_gate` (their canonical
 * declarations live in `gateway/composition/input/{cores,connect,auth}-input.ts`,
 * which import runtime-adjacent modules this leaf must not pull in).
 * `tsc` checks assignability in BOTH directions at the
 * `gateway/composition.ts` call sites, so a drift here cannot compile.
 */
export interface RouteSlotComposition
  extends HttpSurfacesCompositionInput,
    AppSurfacesCompositionInput {
  /** P3 cores wire-up — `GET /api/cores[/<slug>]` admin surface. */
  cores_surface?: SurfaceHandler
  /** Cores OAuth — `/api/cores/oauth/google/*`. */
  cores_oauth_surface?: SurfaceHandler
  /** WAVE 2 Track A — `/api/cores/integrations` + `/api/cores/api-keys/*`. */
  cores_integrations_surface?: SurfaceHandler
  /**
   * Cross-instance API config — PRESENCE-ONLY here. Its promotion (the
   * Managed-only dynamic `import('@neutronai/connect/api/server.ts')`)
   * stays in `gateway/composition.ts`.
   */
  connect_api?: object
  /**
   * Per-instance HTTP auth gate — PRESENCE-ONLY here (promoted onto
   * `composeInput.authGate` in `gateway/composition.ts`; it wraps the
   * whole ladder rather than being a rung of it).
   */
  auth_gate?: object
}

// ─────────────────────────────────────────────────────────────────────────
// Landing path-set (owned by the landing package — see `landing/routes.ts`)
// ─────────────────────────────────────────────────────────────────────────

// C5 — `isLandingRoute` + `LANDING_ROUTE_PATHS` now live in
// `@neutronai/landing/routes.ts` (imported at the top of this file). They are
// re-exported here so existing importers (`gateway/http/compose.ts`, tests)
// keep resolving them through the gateway barrel unchanged.
export { isLandingRoute, LANDING_ROUTE_PATHS }

// ─────────────────────────────────────────────────────────────────────────
// Internal cache-invalidate handler (moved verbatim from compose.ts)
// ─────────────────────────────────────────────────────────────────────────

async function handleCacheInvalidate(
  req: Request,
  handler: InternalCacheInvalidateConfig,
): Promise<Response> {
  const supplied = req.headers.get('X-Internal-Token') ?? ''
  // Constant-time compare to defeat timing attacks on the shared secret.
  if (!constantTimeStringEquals(supplied, handler.expectedToken)) {
    return new Response('forbidden', { status: 403 })
  }
  let body: { owner_handle?: unknown } = {}
  try {
    body = (await req.json()) as { owner_handle?: unknown }
  } catch {
    return new Response('invalid json', { status: 400 })
  }
  const owner_handle = body.owner_handle
  if (typeof owner_handle !== 'string' || owner_handle.length === 0) {
    return new Response('missing owner_handle', { status: 400 })
  }
  handler.invalidateOwnerHandle(owner_handle)
  return new Response('{"ok":true}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function constantTimeStringEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

// ─────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────

/** Identity helper preserving each slot's literal `K` + inferred `V`. */
function slot<K extends string, V>(s: RouteSlot<K, V>): RouteSlot<K, V> {
  return s
}

/** Pluck-`handler` promotion for the standard disclaiming `{ handler }` surfaces. */
function pluckHandler(
  s: { handler: (req: Request) => Promise<Response | null> } | undefined,
): SurfaceHandler | undefined {
  return s === undefined ? undefined : { handler: s.handler }
}

/**
 * THE ordered surface registry. Array order IS the routing precedence
 * (first match wins) — a verbatim transcription of the pre-C4 hand-rolled
 * `dispatchRequest` ladder, pinned by the transition test.
 *
 * Rung-order rationale (carried over from the pre-C4 ladder comments):
 *   - dev-mint-session first: dev-only path, never collides with production
 *     routes (factory already gates on `NEUTRON_E2E_DEV_SECRET`).
 *   - operator/internal family (cache-invalidate, admin-respawn) ahead of
 *     everything user-facing; both bypass the auth gate by pathset.
 *   - chat-history/chat-topics ahead of landing so the surfaces own their
 *     paths unambiguously even though `/api/v1/chat/*` is ALSO in the
 *     landing path-set (slug-rename 404 fix).
 *   - chunked upload BEFORE import-resume BEFORE legacy single-shot upload:
 *     the chunked handler owns `/api/upload/<src>/{start,<id>}` and
 *     disclaims the bare `POST /api/upload/<src>` so the single-shot
 *     handler keeps it.
 *   - per-project children (launcher/tasks/reminders/tabs/work-board/
 *     credentials/codex-auth) BEFORE the generic appProjects surface;
 *     appFocusCurrent BEFORE appFocus (more-specific sibling first).
 *   - coresOAuth + coresIntegrations BEFORE cores (which 404s their shapes).
 *   - telegram webhook, then the landing path-set match, then the SPA
 *     `/projects[/…]` catch-all, then the cross-instance connect API,
 *     then the default healthz/404 fallback (in compose.ts).
 */
export const ROUTE_SLOTS = [
  // 0-pre. E2E onboarding walkthrough — synthetic session-mint. Owns
  //        `POST /api/dev/mint-session`. NO composition seam: unreachable via
  //        `composeProductionGraph` (pinned by open-route-matrix.test.ts);
  //        only a direct `composeHttpHandler` caller can wire it. The factory
  //        (`signup/dev/mint-session-route.ts`) self-gates on
  //        `NEUTRON_E2E_DEV_SECRET`.
  slot({
    key: 'devMintSession',
    rung: 'dev-mint-session',
    composition: null,
    gated: false,
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0. Internal cache invalidation — P1.5 § 1.5.5. Token-gated
  //    (X-Internal-Token, constant-time compare). The rename orchestrator
  //    POSTs `{ owner_handle }` after a slug rename commits.
  slot({
    key: 'internalCacheInvalidateHandler',
    rung: 'internal-cache-invalidate',
    composition: 'internal_cache_invalidate',
    gated: true,
    match: { path: '/internal/cache-invalidate', method: 'POST' },
    promote: (c) => c.internal_cache_invalidate,
    dispatch: (v: InternalCacheInvalidateConfig, ctx) => handleCacheInvalidate(ctx.req, v),
  }),
  // 0-op. Substrate-lift S2 — operator REPL force-respawn. Owns
  //       `POST /admin/respawn-session`, token-gated (X-Gateway-Token) inside
  //       the handler; operator family, bypasses the user-facing auth gate.
  slot({
    key: 'adminRespawn',
    rung: 'admin-respawn',
    composition: 'admin_respawn_handler',
    gated: true,
    promote: (c) =>
      c.admin_respawn_handler === undefined ? undefined : { handler: c.admin_respawn_handler },
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0a. Slug-check — P1.5 § 1.5.8 (Argus r2 BLOCKING #2). Bound ahead of
  //     landing routes so the API path is never shadowed by a landing 404.
  slot({
    key: 'slugCheckHandler',
    rung: 'slug-check',
    composition: 'slug_check_handler',
    gated: true,
    match: { path: '/api/v1/slug/check', method: 'GET' },
    promote: (c) => c.slug_check_handler,
    dispatch: (v: (req: Request) => Promise<Response>, ctx) => v(ctx.req),
  }),
  // 0a.bis Chat-history hydration — 2026-05-28. `GET /api/v1/chat/history`.
  //        Cookie auth happens inside the handler (the auth-gate's
  //        `pass-through-unauthed` on JSON Accept means the gate would NOT
  //        401 a tokenless history request; the handler self-verifies).
  slot({
    key: 'chatHistory',
    rung: 'chat-history',
    composition: 'chat_history_surface',
    gated: true, // C4 divergence fix — was mapped but missing from the pre-C4 gate
    promote: (c) => pluckHandler(c.chat_history_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0a.ter Sidebar topic rail — 2026-05-28. `GET /api/v1/chat/topics`.
  slot({
    key: 'chatTopics',
    rung: 'chat-topics',
    composition: 'chat_topics_surface',
    gated: true, // C4 divergence fix — was mapped but missing from the pre-C4 gate
    promote: (c) => pluckHandler(c.chat_topics_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0b. Avatar.png — Sprint 28. The Caddy proxy chain at <slug>.<base-domain>
  //     already routes /avatar.png here (Sprint 21); this rung closes the loop.
  slot({
    key: 'avatarHandler',
    rung: 'avatar',
    composition: 'avatar_handler',
    gated: true,
    match: { path: '/avatar.png', method: 'GET' },
    promote: (c) => c.avatar_handler,
    dispatch: (v: (req: Request) => Response | Promise<Response>, ctx) => v(ctx.req),
  }),
  // 0c. Profile-pic candidates — Sprint 28 Codex r2 P2. Per-candidate
  //     thumbnails for the image-gallery picker (ButtonOption.image_url).
  slot({
    key: 'candidateHandler',
    rung: 'profile-pic-candidate',
    composition: 'candidate_handler',
    gated: true,
    match: { prefix: '/profile-pic/candidate/', method: 'GET' },
    promote: (c) => c.candidate_handler,
    dispatch: (v: (req: Request) => Response | Promise<Response>, ctx) => v(ctx.req),
  }),
  // 0d-pre. Chunked resumable upload — Upload Resume Phase 2. Owns
  //         `POST /api/upload/<src>/start` + `PATCH|HEAD /api/upload/<src>/<id>`;
  //         disclaims the bare legacy `POST /api/upload/<src>` shape.
  slot({
    key: 'chunkedUploadHandler',
    rung: 'chunked-upload',
    composition: 'chunked_upload_handler',
    gated: true,
    promote: (c) => c.chunked_upload_handler,
    dispatch: (v: (req: Request) => Promise<Response | null>, ctx) => v(ctx.req),
  }),
  // 0d-mid. Import resume — 2026-05-25 Part G.1. `POST /api/import/<job>/resume`;
  //         `/api/import/` prefix kept distinct from `/api/upload/`.
  slot({
    key: 'importResumeHandler',
    rung: 'import-resume',
    composition: 'import_resume_handler',
    gated: true, // C4 divergence fix — was mapped but missing from the pre-C4 gate
    promote: (c) => c.import_resume_handler,
    dispatch: (v: (req: Request) => Promise<Response | null>, ctx) => v(ctx.req),
  }),
  // 0d. Import upload — P2 v2 § 6.1 (S4). `POST /api/upload/<source>` for the
  //     ChatGPT/Claude export ZIP; ahead of landing so the multi-GB body
  //     never hits the landing SPA chain.
  slot({
    key: 'importUploadHandler',
    rung: 'import-upload',
    composition: 'import_upload_handler',
    gated: true,
    match: { prefix: '/api/upload/', method: 'POST' },
    promote: (c) => c.import_upload_handler,
    dispatch: (v: (req: Request) => Promise<Response>, ctx) => v(ctx.req),
  }),
  // 0e. Expo-app WebSocket surface — P5.1. The single unified chat socket:
  //     `/ws/app/chat` + `POST /api/app/chat/send`. Contributes the app_ws
  //     websocket handler (multiplexed with landing's in compose.ts).
  slot({
    key: 'appWs',
    rung: 'app-ws',
    composition: 'app_ws_surface',
    gated: true,
    ws: true,
    promote: (c) =>
      c.app_ws_surface === undefined
        ? undefined
        : { handler: c.app_ws_surface.handler, websocket: c.app_ws_surface.websocket },
    dispatch: (v: AppWsHandler, ctx) => v.handler(ctx.req, ctx.server),
  }),
  // 0e2. Expo-app chat-attachment upload — P5.1 (Argus r1 BLOCKING #1). Owns
  //      `POST /api/app/upload` + the auth-gated GET; co-located with app-ws.
  slot({
    key: 'appUpload',
    rung: 'app-upload',
    composition: 'app_upload_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_upload_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0f. Project launcher — P5.3. `/api/app/projects/<id>/launcher[*]`.
  slot({
    key: 'appLauncher',
    rung: 'app-launcher',
    composition: 'app_launcher_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_launcher_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0g. Project tasks — P5.4. `/api/app/projects/<id>/tasks[/<id>[/<verb>]]`.
  slot({
    key: 'appTasks',
    rung: 'app-tasks',
    composition: 'app_tasks_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_tasks_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0h. Project reminders — P5.4. `/api/app/projects/<id>/reminders[…]`.
  slot({
    key: 'appReminders',
    rung: 'app-reminders',
    composition: 'app_reminders_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_reminders_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0h1. Tab resolver — WAVE 3. `GET /api/app/projects/<id>/tabs` +
  //      `GET /api/app/tabs`. BEFORE appProjects (per-project child).
  slot({
    key: 'appTabs',
    rung: 'app-tabs',
    composition: 'app_tabs_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_tabs_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0h1b. Work Board (Phase 1a) — `/api/app/projects/<id>/work-board[…]`.
  slot({
    key: 'appWorkBoard',
    rung: 'app-work-board',
    composition: 'app_work_board_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_work_board_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0h1c. Per-project credential CRUD (Settings tab) —
  //       `/api/app/projects/<id>/credentials[/<service>]`.
  slot({
    key: 'appProjectCredentials',
    rung: 'app-project-credentials',
    composition: 'app_project_credentials_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_project_credentials_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0h1d. Connect Codex — global `/api/app/codex-auth` + per-project
  //       `/api/app/projects/<id>/codex-auth`.
  slot({
    key: 'appCodexCredential',
    rung: 'app-codex-credential',
    composition: 'app_codex_credential_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_codex_credential_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0h2. Project settings + list — P5.2 + ISSUES #9. AFTER every per-project
  //      child so it never claims paths a sibling already routed.
  slot({
    key: 'appProjects',
    rung: 'app-projects',
    composition: 'app_projects_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_projects_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0h3. Open-mode cross-instance auth — M2.5.
  //      `/api/app/connect/auth/{start,callback,status,disconnect}`.
  slot({
    key: 'appConnectAuth',
    rung: 'app-connect-auth',
    composition: 'app_connect_auth_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_connect_auth_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0i-pre. Current focus pick — P6.1. `GET /api/app/focus/current`;
  //         more-specific sibling BEFORE appFocus.
  slot({
    key: 'appFocusCurrent',
    rung: 'app-focus-current',
    composition: 'app_focus_current_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_focus_current_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0i. Global Focus — P5.5. `GET /api/app/focus`.
  slot({
    key: 'appFocus',
    rung: 'app-focus',
    composition: 'app_focus_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_focus_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0i2. Read-only diagnostics — O5. `GET /api/app/admin/diagnostics`.
  //      BEFORE appAdmin so it claims this exact path even if the (currently
  //      unmounted) admin surface is ever wired — its `unknown_admin_route`
  //      404 would otherwise swallow `/diagnostics`.
  slot({
    key: 'appDiagnostics',
    rung: 'app-diagnostics',
    composition: 'app_diagnostics_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_diagnostics_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0j. App admin — P5.7. `/api/app/admin/*`.
  slot({
    key: 'appAdmin',
    rung: 'app-admin',
    composition: 'app_admin_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_admin_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0j2. Admin-tab personality editor — 2026-05-22. `/api/app/persona/*`;
  //      disjoint from /api/app/admin/*, placed next to it for co-location.
  slot({
    key: 'appPersona',
    rung: 'app-persona',
    composition: 'app_persona_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_persona_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0k. Device push tokens — P5.6. `/api/app/devices/{register,unregister}`.
  slot({
    key: 'appDevices',
    rung: 'app-devices',
    composition: 'app_devices_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_devices_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0l. Project docs — P7.0 + P7.1.
  //     `/api/app/projects/<id>/docs/{tree,file,file/move,folder}`.
  slot({
    key: 'appDocs',
    rung: 'app-docs',
    composition: 'app_docs_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_docs_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0l1. Project backups + restore — P7.4. `/api/app/projects/<id>/backups[…]`
  //      + `/restore`. AFTER appDocs (disjoint patterns; order matches the
  //      order the P7 routes were introduced).
  slot({
    key: 'appBackups',
    rung: 'app-backups',
    composition: 'app_backups_surface',
    gated: true,
    promote: (c) => pluckHandler(c.app_backups_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0m1. Cores OAuth — `/api/cores/oauth/google/*`. BEFORE cores.
  slot({
    key: 'coresOAuth',
    rung: 'cores-oauth',
    composition: 'cores_oauth_surface',
    gated: true,
    promote: (c) => pluckHandler(c.cores_oauth_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0m0b. Cores Integrations — WAVE 2 Track A. `/api/cores/integrations` +
  //       `/api/cores/api-keys/*`. BEFORE cores; independent of coresOAuth.
  slot({
    key: 'coresIntegrations',
    rung: 'cores-integrations',
    composition: 'cores_integrations_surface',
    gated: true,
    promote: (c) => pluckHandler(c.cores_integrations_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 0m. Bundled-Cores admin — P3. `GET /api/cores[/<slug>]`.
  slot({
    key: 'cores',
    rung: 'cores',
    composition: 'cores_surface',
    gated: true,
    promote: (c) => pluckHandler(c.cores_surface),
    dispatch: (v: SurfaceHandler, ctx) => v.handler(ctx.req),
  }),
  // 1. Telegram webhook — exact match on POST /webhook/telegram only.
  //    The handler itself further validates the secret_token + body.
  slot({
    key: 'telegramWebhookHandler',
    rung: 'telegram-webhook',
    composition: 'telegram_webhook',
    gated: true,
    match: { path: '/webhook/telegram', method: 'POST' },
    promote: (c) => c.telegram_webhook?.handler,
    dispatch: (v: (req: Request) => Promise<Response>, ctx) => v(ctx.req),
  }),
  // 2. Landing routes — explicit path-set match so cross-instance API paths
  //    can't be shadowed by a landing 404. Contributes the landing websocket.
  slot({
    key: 'landing',
    rung: 'landing.pathset',
    composition: 'landing_server',
    gated: true,
    ws: true,
    match: {
      when: (ctx) => isLandingRoute(ctx.pathname, ctx.method, ctx.url.searchParams.has('invite')),
    },
    promote: (c) => c.landing_server,
    dispatch: (v: LandingHandler, ctx) => v.fetch(ctx.req, ctx.server),
  }),
  // 2.5. SPA client-route catch-all — a hard load / share of a project-scoped
  //      deep link (e.g. `/projects/<id>/docs?path=…`) is a browser navigation
  //      into the chat-react shell, not an API call. Delegate to landing so
  //      the SPA boots + client-routes. `isSpaClientRoute` matches only
  //      `GET /projects[/…]`, disjoint from every API/asset/operator surface
  //      above (which already ran + returned their own real 404s), so this can
  //      never mask an API 404. Secondary rung of the `landing` input —
  //      promotion/gating live on `landing.pathset`.
  slot({
    key: 'landing',
    rung: 'landing.spa',
    composition: null,
    gated: false,
    match: { when: (ctx) => isSpaClientRoute(ctx.pathname, ctx.method) },
    dispatch: (v: LandingHandler, ctx) => v.fetch(ctx.req, ctx.server),
  }),
  // 3. Cross-instance API — returns null when the request is not
  //    `/connect/v1/*` so the chain falls through to the default. Promotion
  //    (the Managed-only dynamic import) stays in `gateway/composition.ts`.
  slot({
    key: 'connectHandler',
    rung: 'connect',
    composition: 'connect_api',
    gated: true,
    dispatch: (v: (req: Request) => Promise<Response | null>, ctx) => v(ctx.req),
  }),
] as const

type Slots = (typeof ROUTE_SLOTS)[number]
type SlotValue<S> = S extends RouteSlot<string, infer V> ? V : never

/**
 * GENERATED — the surface fields of `ComposeHttpHandlerInput`, mapped from
 * `ROUTE_SLOTS` (one optional field per slot `key`). The full input adds
 * `defaultHandler` + `authGate` in `./compose.ts`.
 */
export type ComposeSurfaceInput = {
  [S in Slots as S['key']]?: SlotValue<S>
}

/**
 * GENERATED — the `CompositionInput` fields whose presence builds the
 * composed HTTP chain at all (`hasAnyChainedSurface`). Derived from the
 * slots' `gated` flags.
 *
 * C4 DIVERGENCE FIX (the one intended behavior change of §C4): the pre-C4
 * hand-maintained gate had drifted from the mapping — `chat_history_surface`,
 * `chat_topics_surface`, `import_resume_handler`, and `auth_gate` were
 * MAPPED into the chain but omitted from the gate, so a composition that
 * supplied only one of them silently yielded `graph.fetch === undefined`
 * (its wired route was never served; latent-prod-bug analysis in the pre-C4
 * `open-route-matrix.test.ts` Part 3, which pinned the drift AS-IS). Every
 * mapped surface now counts: the three surfaces via `gated: true` on their
 * slots, and `auth_gate` via the explicit entry below (it is promoted as a
 * non-rung wrapper in `gateway/composition.ts`, so it has no slot to flag).
 * Harmless for every real composition (all supply landing + more), but the
 * gate can no longer silently drop a wired surface.
 */
export const CHAINED_SURFACE_COMPOSITION_KEYS: readonly (keyof RouteSlotComposition)[] = [
  ...new Set(
    ROUTE_SLOTS.filter((s) => s.gated && s.composition !== null).map(
      (s) => s.composition as keyof RouteSlotComposition,
    ),
  ),
  'auth_gate',
]

/**
 * GENERATED gate — build the chain only if the caller supplied at least one
 * chain-gating surface; otherwise the boot shell stays on its dev
 * `/healthz`-only handler (legacy `bun run gateway/index.ts`).
 */
export function hasAnyChainedSurface(composition: RouteSlotComposition): boolean {
  return CHAINED_SURFACE_COMPOSITION_KEYS.some((key) => composition[key] !== undefined)
}

/**
 * GENERATED mapping — promote every present `CompositionInput` surface onto
 * its compose-input field (ISSUE #32: this is the ONLY path that promotes a
 * surface into the production HTTP chain; `composeProductionGraph` owns it).
 * `connectHandler` (dynamic import) + `authGate` (non-rung) are appended by
 * `gateway/composition.ts:buildComposedHttpFromComposition`.
 */
export function buildComposeSurfaces(composition: RouteSlotComposition): ComposeSurfaceInput {
  const out: Record<string, unknown> = {}
  for (const s of ROUTE_SLOTS) {
    if (s.promote === undefined) continue
    const value = s.promote(composition)
    if (value !== undefined) out[s.key] = value
  }
  return out as ComposeSurfaceInput
}

/** Evaluate a rung's static match precondition against the request context. */
export function slotMatches(match: RouteMatch, ctx: RouteDispatchContext): boolean {
  if (match.method !== undefined && ctx.method !== match.method) return false
  if (match.path !== undefined && ctx.pathname !== match.path) return false
  if (match.prefix !== undefined && !ctx.pathname.startsWith(match.prefix)) return false
  if (match.when !== undefined && !match.when(ctx)) return false
  return true
}
