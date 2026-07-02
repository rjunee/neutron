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
 * Precedence (first match wins):
 *   1. Telegram webhook    `/webhook/telegram` POST
 *   2. Landing routes      (path-prefix match, see LANDING_PATHS below)
 *   3. Cross-instance API  (returns `null` to fall through)
 *   4. Default healthz     `/healthz` GET, else 404
 *
 * The WebSocket upgrade rides on the same `Bun.serve` instance via the
 * `websocket` option. Only the landing server contributes a WS handler;
 * other routes are HTTP-only.
 */

import type { Server, ServerWebSocket, WebSocketHandler } from 'bun'

import {
  evaluateAuthGate,
  type AuthGateOptions,
} from '../../landing/auth-gate.ts'
import { isSpaClientRoute } from '../../landing/spa-routes.ts'

/** Matches landing/server.ts SocketState (kept loose to avoid coupling). */
type LandingSocketState = unknown

export interface LandingHandler {
  fetch: (req: Request, server: Server<LandingSocketState>) => Response | Promise<Response>
  websocket: WebSocketHandler<LandingSocketState>
}

/**
 * P5.1 — Expo app WebSocket surface. Mounted at `/ws/app/chat` (HTTP
 * upgrade) + `/api/app/chat/send` (HTTP POST). The websocket handler is
 * multiplexed with the landing server's onboarding chat handler by
 * inspecting `ws.data.surface` so a single `Bun.serve` instance can
 * serve both surfaces independently.
 */
export interface AppWsHandler {
  handler: (req: Request, server: Server<unknown>) => Promise<Response | null>
  websocket: WebSocketHandler<unknown>
}

/**
 * P5.3 — Expo app project-launcher surface. Mounts the four launcher
 * routes (`GET /api/app/projects/<id>/launcher` + the three POST
 * mutations). HTTP-only — no websocket, so the handler is a single
 * function that returns `null` for non-owned paths and falls through to
 * the downstream chain.
 */
export interface AppLauncherHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * P5.1 — Expo chat-attachment upload surface. Owns
 * `POST /api/app/upload` (multipart image upload, returns canonical
 * URL) + `GET /api/app/upload/<user_id>/<hash>.<ext>` (auth-gated
 * read). HTTP-only — disclaims non-owned paths via `null` so unrelated
 * `/api/app/...` routes fall through.
 *
 * Closes Argus r1 BLOCKING #1 — `app/lib/upload-client.ts` POSTed to
 * this exact path but the route did not exist on the gateway, so every
 * production attach silently 404'd.
 */
export interface AppUploadHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * P5.4 — Expo app project-scoped tasks surface. Owns
 * `/api/app/projects/<id>/tasks[/<task_id>[/<verb>]]`. HTTP-only —
 * same shape as the launcher surface. Returns `null` for non-owned
 * paths so unrelated `/api/app/...` routes fall through.
 */
export interface AppTasksHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * P5.4 — Expo app project-scoped reminders surface. Owns
 * `/api/app/projects/<id>/reminders[/<reminder_id>[/<verb>]]`. HTTP-
 * only, same shape as the tasks surface. Returns `null` for non-owned
 * paths so unrelated `/api/app/...` routes fall through.
 */
export interface AppRemindersHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * P5.2 — Expo app project-settings surface. Owns
 * `GET` + `PATCH` `/api/app/projects/<id>/settings`. HTTP-only — same
 * `disclaim-with-null` contract as launcher/tasks/reminders. Backs
 * the project view shell's settings drawer (read description /
 * persona / privacy_mode / billing_mode / members; PATCH whitelists
 * `privacy_mode` only at P5.2).
 */
export interface AppProjectsHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * M2.5 — Open-mode cross-instance auth surface. Owns
 * `/api/app/connect/auth/{start,callback,status,disconnect}`. Drives
 * the Open self-host "Connect to the shared identity service" affordance. HTTP-only —
 * same `disclaim-with-null` contract as the other app surfaces, so unrelated
 * `/api/app/...` paths fall through.
 *
 * Surface factory:
 *   `gateway/http/app-connect-auth.ts:createAppConnectAuthSurface`.
 */
export interface AppConnectAuthHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * P5.5 — Expo app global Focus surface. Mounts the cross-project
 * `GET /api/app/focus` aggregator. HTTP-only, read-only. The handler
 * returns `null` for non-owned paths so the compose chain keeps
 * falling through (no shadowing of unrelated `/api/app/...` routes).
 */
export interface AppFocusHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * P6.1 — Expo app current-focus-pick surface. Mounts
 * `GET /api/app/focus/current` (today's LLM "do this next" pick or
 * 404 when no pick). HTTP-only, read-only. Returns `null` for
 * non-owned paths so the compose chain keeps falling through.
 */
export interface AppFocusCurrentHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * P5.7 — Expo app admin surface. Owns `/api/app/admin/*`
 * (personality, gateway restart, GBrain browse, connectors).
 * HTTP-only — disclaims non-owned paths via `null` so unrelated
 * `/api/app/...` routes fall through to the downstream chain.
 */
export interface AppAdminHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * Admin-tab personality editor surface (2026-05-22). Owns
 * `/api/app/persona/*` (list / get / patch / restart-from-scratch).
 * HTTP-only — disclaims non-owned paths via `null` so unrelated
 * `/api/app/...` routes fall through.
 *
 * Per docs/plans/2026-05-22-003-feat-admin-personality-editor-plan.md.
 */
export interface AppPersonaHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * P5.6 — Expo app device push-token surface. Owns
 * `/api/app/devices/register` + `/api/app/devices/unregister`.
 * HTTP-only — same shape as launcher/tasks/reminders. Returns `null`
 * for non-owned paths so unrelated `/api/app/...` routes fall
 * through.
 */
export interface AppDevicesHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * P7.0 + P7.1 — Expo app project-scoped docs surface (in-app Obsidian
 * replacement). Owns `/api/app/projects/<id>/docs/{tree,file,file/move,folder}`.
 * HTTP-only — same shape as the other app surfaces. Returns `null` for
 * non-owned paths so unrelated `/api/app/...` routes fall through.
 */
export interface AppDocsHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * WAVE 3 — Expo/web-app tab-resolver surface. Owns
 * `GET /api/app/projects/<id>/tabs` + `GET /api/app/tabs`. Returns the
 * engine-resolved tab descriptors both clients consume (builtins ∪ installed
 * Cores' `project_tab` surfaces). Always on — no feature flag (SPEC Decisions
 * Log, 2026-06-23). Disclaims (returns `null`) only for non-owned paths.
 *
 * Surface factory: `gateway/http/app-tabs-surface.ts:createAppTabsSurface`.
 */
export interface AppTabsHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * Work Board (Phase 1a) — Expo-app project Work Board surface. Owns
 * `/api/app/projects/<id>/work-board[/<item_id>[/<verb>]]` (GET +
 * POST/PATCH/DELETE). Disclaims non-owned paths via `null` so the chain stays
 * composable. Surface factory: `gateway/http/work-board-surface.ts`.
 */
export interface AppWorkBoardHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * Per-project credential CRUD surface (Settings tab, FOUNDATION). Owns
 * `/api/app/projects/<id>/credentials[/<service>]` (GET/POST/DELETE).
 * Disclaims non-owned paths via `null`. Surface factory:
 * `gateway/http/project-credentials-surface.ts`.
 */
export interface AppProjectCredentialsHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * P7.4 restore UI — Expo-app project-backups + restore surface.
 * Owns `/api/app/projects/<id>/backups[...]` + `/api/app/projects/<id>/restore`.
 * Same disclaiming-null contract as the docs surface.
 *
 * Surface factory:
 *   `gateway/http/app-backups-surface.ts:createAppBackupsSurface`.
 */
export interface AppBackupsHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * P3 cores wire-up — bundled-Cores admin surface. Owns
 * `GET /api/cores` + `GET /api/cores/<slug>`. HTTP-only, read-only.
 * Returns `null` for non-owned paths so unrelated `/api/...` routes
 * fall through to the downstream chain.
 *
 * Per docs/plans/P3-cores-wireup-sprint-brief.md § 3.
 */
export interface CoresSurfaceHandler {
  handler: (req: Request) => Promise<Response | null>
}

/**
 * E2E onboarding walkthrough — synthetic session-mint surface. Owns
 * `POST /api/dev/mint-session`. The harness POSTs `{ project_slug,
 * user_id, signup_via? }` and the handler returns a start-token JWT +
 * a `redirect_url` pointing at `/start?token=<jwt>` so the harness
 * can drive the chat surface without a real Google OAuth round-trip.
 *
 * Per docs/plans/2026-05-22-e2e-onboarding-walkthrough.md § Part A.
 *
 * Production safety: the factory at
 * `signup/dev/mint-session-route.ts:createDevMintSessionHandler`
 * returns `null` when `NEUTRON_E2E_DEV_SECRET` is missing / too short,
 * so this field stays unset on prod boots — the route is unbound and
 * the path falls through to the default 404.
 */
export interface DevMintSessionHandler {
  handler: (req: Request) => Promise<Response | null>
}

export interface ComposeHttpHandlerInput {
  /**
   * The landing server's `{ fetch, websocket }` pair, when this gateway
   * has the chat surface wired. Production instances supply this; the
   * P1-only legacy boot path leaves it omitted.
   */
  landing?: LandingHandler
  /**
   * `POST /webhook/telegram` handler returned by
   * `channels/adapters/telegram/webhook-server.ts:buildWebhookHandler`.
   * Optional — instances that haven't configured a Telegram bot leave this
   * unset (the route 404s with the default fallback chain).
   */
  telegramWebhookHandler?: (req: Request) => Promise<Response>
  /**
   * Cross-instance API handler returning `null` when the request is not
   * for `/connect/v1/*`. Built by
   * `connect/api/server.ts:createConnectApiHandler`
   * when `composition.connect_api` is supplied. Optional — instances
   * that don't expose a cross-instance API leave this unset.
   */
  connectHandler?: (req: Request) => Promise<Response | null>
  /**
   * P1.5 § 1.5.5 — POST /internal/cache-invalidate. Auth-gated by a
   * shared HTTP secret (`X-Internal-Token` header) since renames are
   * orchestrated by a sibling process, not an external client. The
   * orchestrator POSTs `{ internal_handle }` after a rename commits;
   * the handler flushes the JWT shim's slug-history cache for that
   * instance. Optional — instances without a configured shim still ship.
   */
  internalCacheInvalidateHandler?: {
    invalidateInternalHandle: (internal_handle: string) => void
    /** Shared secret. Comparison is constant-time via `timingSafeEqual`. */
    expectedToken: string
  }
  /**
   * P1.5 § 1.5.8 — GET /api/v1/slug/check. Slug-picker preflight: the
   * client hits this before driving renameUrlSlug so taken / reserved /
   * malformed candidates surface in the picker UI instead of rolling
   * into the rename orchestrator and failing there. Argus r2 [BLOCKING
   * #2]: prior shape shipped the handler in onboarding/api/slug-check.ts
   * (with 9 unit tests) but nobody routed it — production fell through
   * to the default 404. Optional; when unset the route is unbound and
   * falls through to the default chain.
   */
  slugCheckHandler?: (req: Request) => Promise<Response>
  /**
   * Chat-history hydration (2026-05-28) — `GET /api/v1/chat/history`.
   * Powers the chat surface's WS-open hydration of historical
   * `button_prompts` rows + the scroll-up "Load earlier" lazy-load.
   * Cookie-auth via the same `cookieToUserClaim` closure the WS
   * upgrade uses; topic_id is server-derived from the authenticated
   * user_id so a crafted query param can't leak another user's
   * history. Returns `null` for non-owned paths so the chain falls
   * through. Optional — when unset the route is unmounted and the
   * chat surface degrades gracefully (live WS-only, no history).
   *
   * Surface factory: `gateway/http/chat-history-surface.ts:createChatHistorySurface`.
   * Per `docs/plans/2026-05-28-001-feat-chat-history-hydration-plan.md`.
   */
  chatHistory?: { handler: (req: Request) => Promise<Response | null> }
  /**
   * Sidebar topic-rail (2026-05-28 sprint) — `GET /api/v1/chat/topics`.
   * Powers the left-rail topic list on the chat surface (General + one
   * row per per-project topic the user has at least one
   * `button_prompts` row in). Cookie-auth via the same
   * `cookieToUserClaim` closure the WS upgrade + chat-history use; the
   * surface derives the user-id prefix server-side, so a crafted query
   * param can't enumerate another user's topics. Returns `null` for
   * non-owned paths so the chain falls through. Optional — when unset
   * the route is unmounted and the chat client falls back to the
   * built-in "General-only" sidebar row.
   *
   * Surface factory: `gateway/http/chat-topics-surface.ts:createChatTopicsSurface`.
   */
  chatTopics?: { handler: (req: Request) => Promise<Response | null> }
  /**
   * Sprint 28 — `GET /avatar.png` route. Per-instance gateway serves the
   * canonical avatar PNG from `<owner_home>/persona/profile-pic.png`
   * with a 5-minute Cache-Control hint. Optional — when unset, the
   * route is unbound and falls through to the default chain (404). The
   * Caddy proxy chain at `<slug>.<base-domain>` already routes
   * `/avatar.png` to this gateway (Sprint 21 partial); this hook closes
   * the other side of that route.
   */
  avatarHandler?: (req: Request) => Response | Promise<Response>
  /**
   * Sprint 28 Codex r2 P2 — `GET /profile-pic/candidate/<id>.png` route.
   * Serves per-candidate thumbnails from
   * `<owner_home>/persona/profile-pic-candidates/<id>.png` so the
   * image-gallery picker rendered on web/app can fetch the bytes the
   * user is choosing between. Optional — falls through to default 404
   * when unset.
   */
  candidateHandler?: (req: Request) => Response | Promise<Response>
  /**
   * P2 v2 § 6.1 (S4) — `POST /api/upload/<source>` handler. Accepts
   * ChatGPT / Claude export ZIPs uploaded from the chat surface (web
   * or Telegram document-relay), writes them to
   * `<owner_home>/imports/<source>.zip`, then bridges into the
   * InterviewEngine so the `import_upload_pending` phase advances to
   * `import_running` without a follow-up button tap. Optional — when
   * unset the upload route 404s through the default chain.
   */
  importUploadHandler?: (req: Request) => Promise<Response>
  /**
   * Upload Resume Phase 2 — chunked resumable upload handler. Owns
   * `POST /api/upload/<source>/start`,
   * `PATCH /api/upload/<source>/<upload_id>`, and
   * `HEAD /api/upload/<source>/<upload_id>`. Mounted BEFORE
   * `importUploadHandler` so the bare legacy `POST /api/upload/<source>`
   * shape continues to route through the single-shot handler. Returns
   * `null` for paths that don't match any of the three chunked shapes
   * so the chain falls through. Optional — when unset the three routes
   * are unmounted and clients fall back to the legacy single-shot POST.
   *
   * Per gateway/upload/chunked-upload-handler.ts.
   */
  chunkedUploadHandler?: (req: Request) => Promise<Response | null>
  /**
   * 2026-05-25 (import-pipeline-resilience sprint, Part G.1) —
   * `POST /api/import/<job_id>/resume` handler. Owns just the resume
   * route; returns `null` for non-owned paths so the chain falls
   * through. Builds atop the same `ImportJobRunnerHook` +
   * `ImportPayloadResolver` the engine carries, so the resume action
   * uses the same auth/payload pipeline as the auto-resume cron tick.
   *
   * Per `gateway/upload/import-resume-handler.ts:buildImportResumeHandler`.
   */
  importResumeHandler?: (req: Request) => Promise<Response | null>
  /**
   * P5.1 — optional Expo-app WebSocket surface. When supplied, the
   * composed handler routes `/ws/app/chat` + `/api/app/chat/send` to
   * it, and the returned `websocket` handler is multiplexed with
   * landing's onboarding chat handler via the `ws.data.surface`
   * discriminator. When unset the routes are unmounted (404 through
   * the default chain).
   */
  appWs?: AppWsHandler
  /**
   * P5.3 — optional Expo-app project-launcher surface. When supplied,
   * the composed handler routes `/api/app/projects/<id>/launcher[*]` to
   * it (GET list + POST mutations). HTTP-only, no websocket. When
   * unset the routes are unmounted and fall through to the default
   * chain.
   *
   * Surface factory: `gateway/http/app-launcher-surface.ts:createAppLauncherSurface`.
   * Per SPEC.md § Phases→Steps / P5.3.
   */
  appLauncher?: AppLauncherHandler
  /**
   * P5.1 — optional Expo-app chat-attachment upload surface. When
   * supplied, the composed handler routes `POST /api/app/upload` (the
   * Expo client's image upload endpoint) and the corresponding GET to
   * it. HTTP-only. When unset the routes are unmounted and the client's
   * upload-client.ts hits a 404 → the optimistic bubble flips failed.
   *
   * Surface factory: `gateway/http/app-upload-surface.ts:createAppUploadSurface`.
   * Per SPEC.md § Phases→Steps / P5.1 (Argus r1
   * BLOCKING #1 fix).
   */
  appUpload?: AppUploadHandler
  /**
   * P5.4 — optional Expo-app project-scoped tasks surface. When
   * supplied, the composed handler routes
   * `/api/app/projects/<id>/tasks[/<task_id>[/<verb>]]` to it. HTTP-
   * only, backed by the P6.0 canonical TaskStore. When unset the
   * routes are unmounted and fall through to the default chain.
   *
   * Surface factory: `gateway/http/app-tasks-surface.ts:createAppTasksSurface`.
   * Per SPEC.md § Phases→Steps / P5.4 and
   * docs/engineering-plan.md § B.P5 + § B.P6.
   */
  appTasks?: AppTasksHandler
  /**
   * P5.4 — optional Expo-app project-scoped reminders surface. When
   * supplied, the composed handler routes
   * `/api/app/projects/<id>/reminders[/<reminder_id>[/<verb>]]` to it.
   * HTTP-only, backed by the per-project `ReminderStore` engine. When
   * unset the routes are unmounted and fall through to the default
   * chain.
   *
   * Surface factory: `gateway/http/app-reminders-surface.ts:createAppRemindersSurface`.
   * Per SPEC.md § Phases→Steps / P5.4.
   */
  appReminders?: AppRemindersHandler
  /**
   * P5.2 — optional Expo-app project-settings surface. When supplied,
   * the composed HTTP chain mounts
   * `GET` + `PATCH` `/api/app/projects/<id>/settings` ahead of the
   * docs surface (siblings under `/api/app/projects/<id>/`, distinct
   * trailing segments). HTTP-only. When unset the route is unmounted
   * and falls through to the default chain; the Expo client surfaces
   * an empty drawer + error banner.
   *
   * Surface factory: `gateway/http/app-projects-surface.ts:createAppProjectsSurface`.
   * Per docs/plans/P5.2-project-view-shell-sprint-brief.md § 4.5 + § 4.12.
   */
  appProjects?: AppProjectsHandler
  /**
   * M2.5 — optional Open-mode cross-instance auth surface. When supplied,
   * the composed handler routes
   * `/api/app/connect/auth/{start,callback,status,disconnect}` to it.
   * Mounted BEFORE `appProjects` so the cross-instance auth paths are
   * unambiguously owned (both disclaim non-owned paths via `null`, so
   * ordering is belt-and-braces). Wired by the boot shell only when
   * `deployment_mode === 'open'`; Managed boots leave it unset and the
   * routes 404 (Managed uses the in-process minted-token path instead).
   *
   * Surface factory:
   *   `gateway/http/app-connect-auth.ts:createAppConnectAuthSurface`.
   */
  appConnectAuth?: AppConnectAuthHandler
  /**
   * P5.5 — optional Expo-app global Focus surface. When supplied, the
   * composed handler routes `GET /api/app/focus` to it. HTTP-only,
   * read-only. When unset the route is unmounted and falls through
   * to the default chain.
   *
   * Surface factory: `gateway/http/app-focus-surface.ts:createAppFocusSurface`.
   * Per SPEC.md § Phases→Steps / P5.5 and
   * docs/engineering-plan.md § B.P5.
   */
  appFocus?: AppFocusHandler
  /**
   * P6.1 — optional Expo-app current-focus-pick surface. When
   * supplied, the composed handler routes `GET /api/app/focus/current`
   * to it. HTTP-only, read-only. Mounted BEFORE `appFocus` so the
   * /current path is matched as a sibling, not as a child of /focus.
   * (Both surfaces return null for non-matching paths, but ordering
   * is more explicit when the more-specific path runs first.)
   *
   * Surface factory:
   *   `gateway/http/app-focus-current-surface.ts:createAppFocusCurrentSurface`.
   * Per docs/plans/2026-05-23-002-feat-p6-1-nudge-engine-staleness-current-focus-pick-plan.md.
   */
  appFocusCurrent?: AppFocusCurrentHandler
  /**
   * P5.7 — optional Expo-app admin surface. When supplied, the
   * composed handler routes `/api/app/admin/*` to it (personality
   * GET/PUT, gateway restart POST, GBrain browse GET, connectors
   * list GET). HTTP-only. When unset the routes are unmounted and
   * fall through to the default chain.
   *
   * Surface factory: `gateway/http/app-admin-surface.ts:createAppAdminSurface`.
   * Per SPEC.md § Phases→Steps / P5.7 and
   * docs/engineering-plan.md § B.P5.
   */
  appAdmin?: AppAdminHandler
  /**
   * Admin-tab personality editor surface (2026-05-22). When supplied,
   * the composed HTTP chain mounts `/api/app/persona/*` (3-file list,
   * GET / PATCH per-file, restart-from-scratch). HTTP-only; mounted
   * AFTER `appAdmin` so the two `/api/app/{admin,persona}/*` siblings
   * sit together in the precedence chain.
   *
   * Surface factory:
   *   `gateway/http/admin-personality-surface.ts:createAdminPersonalitySurface`.
   * Per docs/plans/2026-05-22-003-feat-admin-personality-editor-plan.md.
   */
  appPersona?: AppPersonaHandler
  /**
   * P5.6 — optional Expo-app device push-token surface. When
   * supplied, the composed handler routes
   * `/api/app/devices/register` + `/api/app/devices/unregister` to it.
   * HTTP-only. When unset the routes are unmounted and fall through.
   *
   * Surface factory: `gateway/http/app-devices-surface.ts:createAppDevicesSurface`.
   * Per SPEC.md § Phases→Steps / P5.6 and
   * docs/engineering-plan.md § B.P5.
   */
  appDevices?: AppDevicesHandler
  /**
   * P7.0 + P7.1 — optional Expo-app project-scoped docs surface. When
   * supplied, the composed HTTP chain mounts
   * `/api/app/projects/<id>/docs/{tree,file,file/move,folder}` (GET
   * tree/file + PUT file + POST file/move + DELETE file + POST folder
   * + DELETE folder). Backed by `DocStore` over
   * `<owner_home>/Projects/<project_id>/docs/`. When omitted the
   * routes are unmounted; the Expo client falls back to a placeholder
   * tree.
   *
   * Surface factory: `gateway/http/app-docs-surface.ts:createAppDocsSurface`.
   * Per SPEC.md § Phases→Steps / P7.0 + P7.1 and
   * docs/engineering-plan.md § B.P7.
   */
  appDocs?: AppDocsHandler
  /**
   * WAVE 3 — optional Expo/web-app tab-resolver surface. When supplied, the
   * composed HTTP chain mounts `GET /api/app/projects/<id>/tabs` +
   * `GET /api/app/tabs` (engine-resolved tab descriptors both clients consume:
   * builtins ∪ installed Cores' `project_tab` surfaces). Always on — no
   * feature flag (SPEC Decisions Log, 2026-06-23); disclaims its routes
   * (returns `null`) only for non-owned paths. Mounted ahead of `appProjects`
   * so the per-project `/tabs` path is unambiguously owned, mirroring the
   * launcher/tasks/reminders precedence.
   *
   * Surface factory: `gateway/http/app-tabs-surface.ts:createAppTabsSurface`.
   * Per docs/plans/wave3-tabbed-interface-build-plan.md § 3.1-3.2 (PR-1+PR-2).
   */
  appTabs?: AppTabsHandler
  /**
   * Work Board (Phase 1a) — Expo-app project Work Board surface. When
   * supplied, the composed handler routes `/api/app/projects/<id>/work-board`
   * (GET + POST/PATCH/DELETE) ahead of `appProjects`, mirroring the
   * launcher/tasks/tabs precedence.
   */
  appWorkBoard?: AppWorkBoardHandler
  /**
   * Per-project credential CRUD surface (Settings tab). When supplied, the
   * composed handler routes `/api/app/projects/<id>/credentials[/<service>]`
   * (GET/POST/DELETE) ahead of `appProjects`, mirroring the work-board
   * precedence so the per-project child path is unambiguously owned.
   */
  appProjectCredentials?: AppProjectCredentialsHandler
  /**
   * P7.4 restore UI — Expo-app project-backups + restore surface. When
   * supplied, the composed HTTP chain mounts:
   *
   *   - GET  `/api/app/projects/<id>/backups`
   *   - GET  `/api/app/projects/<id>/backups/<sha>`
   *   - GET  `/api/app/projects/<id>/backups/<sha>/file?path=...`
   *   - GET  `/api/app/projects/<id>/backups/<sha>/diff?path=...`
   *   - POST `/api/app/projects/<id>/restore`
   *
   * Mounted ahead of `appDocs` so the `/backups[...]` + `/restore`
   * paths are unambiguously owned. Returns `null` for non-owned paths
   * (e.g. `/docs/...`) so the chain still reaches the docs surface.
   */
  appBackups?: AppBackupsHandler
  /**
   * P3 cores wire-up — optional bundled-Cores admin surface. When
   * supplied, the composed handler routes `GET /api/cores` +
   * `GET /api/cores/<slug>` to it ahead of the landing routes so
   * `/api/cores...` paths are unambiguously owned. HTTP-only,
   * read-only. When unset the routes are unmounted and fall through
   * to the default chain.
   *
   * Surface factory: `gateway/http/cores-surface.ts:createCoresSurface`.
   * Per docs/plans/P3-cores-wireup-sprint-brief.md § 3.
   */
  cores?: CoresSurfaceHandler
  /**
   * Cores OAuth secret-resolution sprint — optional surface owning
   * `/api/cores/oauth/google/{start,ingest,disconnect/<label>,status}`.
   * Mounted BEFORE `cores` so the OAuth paths are unambiguous (cores
   * itself disclaims `/api/cores/oauth/` so the chain works either
   * way, but precedence makes it explicit).
   *
   * Per docs/plans/cores-oauth-secret-resolution-sprint-brief.md § 4.1.
   */
  coresOAuth?: CoresSurfaceHandler
  /**
   * WAVE 2 Track A — unified Integrations admin surface. Owns
   * `GET /api/cores/integrations` + `/api/cores/api-keys/*`. Mounted BEFORE
   * `cores` (which 404s those shapes) and independent of `coresOAuth`, so
   * standalone API-key management works with no Google OAuth client.
   *
   * Surface factory: `gateway/http/cores-integrations-surface.ts`.
   */
  coresIntegrations?: CoresSurfaceHandler
  /**
   * E2E onboarding walkthrough — optional synthetic session-mint
   * surface. Owns `POST /api/dev/mint-session`. Mounted FIRST in the
   * precedence chain so it bypasses every other surface; the route is
   * already gated by `NEUTRON_E2E_DEV_SECRET` inside the factory so
   * precedence here is just for clarity (the path is uniquely owned).
   * When the boot path leaves this unset, the route is unbound and
   * `/api/dev/mint-session` falls through to the default 404.
   *
   * Per docs/plans/2026-05-22-e2e-onboarding-walkthrough.md § Part A.
   */
  devMintSession?: DevMintSessionHandler
  /**
   * 2026-05-27 returning-user resume sprint — optional per-instance
   * HTTP auth gate. When supplied, the composed handler runs the gate
   * on every request that hits the user-facing path set
   * (`USER_FACING_GATED_PATHS` below) BEFORE dispatching to the
   * landing / app / cores surface. The gate consumes a `?start=<token>`
   * (cryptographic verify, no jti claim) + sets a session cookie, OR
   * accepts an existing session cookie, OR 302s a browser request to
   * the identity service's signin with `return_url` preserved.
   *
   * When `authGate` is omitted the gate is skipped entirely — the
   * pre-2026-05-27 unauthenticated behaviour for `/chat` / `/api/app/*`
   * is preserved (used by tests + dev / smoke deploys without an
   * identity service co-located).
   *
   * Per docs/plans/2026-05-27-returning-user-resume-auth.md (this sprint).
   */
  authGate?: AuthGateOptions
  /**
   * Substrate-lift S2/S3 — optional operator REPL-respawn surface. When supplied,
   * the composed handler routes `POST /admin/respawn-session` to it (token-gated
   * via `X-Gateway-Token`). Mounted in the operator/internal route family ahead
   * of the landing chain so the path is unambiguous + bypasses the user-facing
   * auth gate. Wired by the boot shell whenever an operator token is configured
   * (the persistent REPL is the sole substrate post-S3-rip-replace; the removed
   * `NEUTRON_PERSISTENT_REPL` flag no longer gates it — Codex r2); otherwise unset
   * → the route 404s.
   *
   * Surface factory: `gateway/http/admin-respawn-surface.ts:createAdminRespawnSurface`.
   */
  adminRespawn?: { handler: (req: Request) => Promise<Response | null> }
  /**
   * Always-present fallback. Production wires
   * `defaultHealthzHandler({ project_slug, bootedAt })` from gateway/index.
   */
  defaultHandler: (req: Request) => Response | Promise<Response>
}

export interface ComposedHttpHandler {
  fetch: (req: Request, server: Server<LandingSocketState>) => Response | Promise<Response>
  websocket: WebSocketHandler<LandingSocketState>
}

/**
 * Path prefixes the landing server owns. Listed here (not delegated by
 * trial-and-error) so the precedence chain stays explicit + the
 * cross-instance API isn't accidentally shadowed by a landing 404.
 *
 * Matches the routes implemented in `landing/server.ts:222-315`:
 *   - `GET  /chat`                       static HTML
 *   - `GET  /chat.js`                    bundled client
 *   - `GET  /api/v1/sign-up`             OAuth redirect trampoline
 *   - `GET  /invite[?invite=…]`          static HTML (when invite_html present)
 *   - `GET  /invite.js`                  bundled client
 *   - `POST /onboarding/invite-accept`   accept handler
 *   - `GET  /?invite=…`                  same as /invite (root-with-query)
 *   - `GET  /recover`                    S17 — silent reconnect after
 *                                        post-slug-rename WS disconnect
 *   - `GET  /start`                      2026-05-22 — `?token=` (or
 *                                        legacy `?start=`) lands on the
 *                                        per-instance gateway for
 *                                        returning owners who have
 *                                        picked a real URL slug
 *                                        (`identity/main.ts:594-615` via
 *                                        `buildPerOwnerDeepLink`); the
 *                                        handler 302s to
 *                                        `/chat?start=<token>` per
 *                                        `landing/server.ts:674-689`,
 *                                        propagating `?debug=` +
 *                                        `?import=`. Without this
 *                                        allowlist entry the per-instance
 *                                        gateway's HTTP precedence chain
 *                                        fell through to the default
 *                                        404 and the redirect handler
 *                                        was never reached.
 */
const LANDING_PATHS: ReadonlySet<string> = new Set([
  '/chat',
  '/chat-react.js',
  '/api/v1/sign-up',
  '/invite',
  '/invite.js',
  '/onboarding/invite-accept',
  '/recover',
  '/start',
  // 2026-05-28 chat-history hydration sprint — without this entry the
  // per-instance gateway's HTTP precedence chain would fall through to
  // the default 404 on `/api/v1/chat/history` for a slug-renamed
  // instance (mirrors the ISSUES #59 root cause for `/start`).
  '/api/v1/chat/history',
  // 2026-05-28 sidebar topic-rail sprint — sibling of /chat/history.
  // Same precedence-chain reasoning: a slug-renamed instance otherwise
  // falls through to default 404 on the per-instance gateway.
  '/api/v1/chat/topics',
  // ISSUES #208 — mobile install page + PWA/brand assets. The wow
  // handoff's MOBILE_APP_URL points at `/mobile`; without these entries
  // the per-instance gateway falls through to the default 404 (same bug
  // class as `/start`, ISSUES #59). The asset routes let chat.html link
  // a manifest + icons so Add-to-Home-Screen installs carry the brand
  // icon instead of a screenshot. All four are static, owner-data-free
  // surfaces served by `landing/server.ts`; none are auth-gated (the
  // gate only covers `/`, `/chat`, `/api/app/*`).
  '/mobile',
  '/site.webmanifest',
  '/favicon.svg',
  '/apple-touch-icon.png',
])

function isLandingRoute(pathname: string, method: string, hasInviteQuery: boolean): boolean {
  if (LANDING_PATHS.has(pathname)) return true
  // AUTH-CORRECTION (2026-06-28) — the Claude-Max OAuth install-token handoff
  // routes (`/oauth/max/install-token/{initiate,<signup_id>.sh,complete,state}`)
  // are served by landing's `installTokenHandler`. They carry a variable
  // `<signup_id>.sh` segment so a path-Set match won't do — prefix-match the
  // whole surface. None are auth-gated (the gate only covers `/`, `/chat`,
  // `/api/app/*`), which is correct: the handoff is the PRE-auth step.
  if (pathname.startsWith('/oauth/max/install-token')) return true
  // Root path with `?invite=` is the invite landing short-circuit.
  if (pathname === '/' && method === 'GET' && hasInviteQuery) return true
  return false
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
  const {
    landing,
    telegramWebhookHandler,
    connectHandler,
    internalCacheInvalidateHandler,
    slugCheckHandler,
    chatHistory,
    chatTopics,
    avatarHandler,
    candidateHandler,
    importUploadHandler,
    chunkedUploadHandler,
    importResumeHandler,
    appWs,
    appUpload,
    appLauncher,
    appTasks,
    appReminders,
    appProjects,
    appConnectAuth,
    appFocus,
    appFocusCurrent,
    appAdmin,
    appPersona,
    appDevices,
    appDocs,
    appTabs,
    appWorkBoard,
    appProjectCredentials,
    appBackups,
    cores,
    coresOAuth,
    coresIntegrations,
    devMintSession,
    authGate,
    adminRespawn,
    defaultHandler,
  } = input
  return {
    fetch: async (req, server) => {
      const url = new URL(req.url)
      const pathname = url.pathname
      const method = req.method

      // 2026-05-27 returning-user resume sprint — evaluate the
      // per-instance HTTP auth gate FIRST for browser-facing routes
      // (/, /chat, /api/app/*). The gate either (a) 302s a tokenless
      // browser request to identity signin with `return_url` preserved,
      // OR (b) consumes a fresh `?start=<token>` + emits a Set-Cookie
      // we tack onto whatever the downstream chain returns, OR (c)
      // passes through unchanged when the request is already
      // authenticated (existing session cookie OR programmatic API
      // call with bearer-auth that the downstream chain owns).
      //
      // 2026-05-27 persistent-session-cookie sprint — sliding refresh:
      // cookie-valid `allow` decisions ALSO carry a `set_cookie` so the
      // 30-day session-cookie TTL rolls forward on every authenticated
      // request. The stitch site below handles both `authenticated`
      // (just-consumed-a-token) and `allow` (existing-cookie) uniformly.
      let gateSetCookie: string | null = null
      if (authGate !== undefined && isGatedUserFacingRoute(pathname, method)) {
        const decision = await evaluateAuthGate(req, authGate)
        if (decision.kind === 'redirect-to-signin') {
          return new Response(null, {
            status: 302,
            headers: { location: decision.location },
          })
        }
        // Argus r1 BLOCKER #1 + #2 (2026-05-27): the gate produced a 302
        // to a per-instance route. Either:
        //   - cookie-valid GET / → 302 /chat with refreshed cookie
        //     (closes #2 cookie path; sliding-refresh applies)
        //   - cookie-valid GET /chat tokenless → 302 /chat?start=<fresh>
        //     with refreshed cookie (closes #1 hot-loop)
        //   - just-signed-in GET /?start=<valid> → 302 /chat?start=<token>
        //     with set-cookie (closes #2 first-signin path)
        // The decision carries the optional Set-Cookie so we can stitch
        // it onto the 302 in one shot.
        if (decision.kind === 'redirect') {
          const headers = new Headers({ location: decision.location })
          if (decision.set_cookie !== undefined) {
            headers.append('set-cookie', decision.set_cookie)
          }
          return new Response(null, { status: 302, headers })
        }
        if (decision.kind === 'authenticated') {
          gateSetCookie = decision.set_cookie
        }
        // 'allow' carries an optional `set_cookie` when the request came
        // in with a valid session cookie — sliding-refresh emits a fresh
        // Set-Cookie on every authenticated hit so the 30-day TTL keeps
        // rolling forward and active users never time out.
        if (decision.kind === 'allow' && decision.set_cookie !== undefined) {
          gateSetCookie = decision.set_cookie
        }
        // 'pass-through-unauthed' (programmatic API request — bearer-auth
        // chain decides) falls through unchanged.
      }

      const res = await dispatchRequest()
      if (gateSetCookie !== null) {
        // Tack the gate's Set-Cookie onto the downstream response. We
        // build a fresh Headers from the existing response then append
        // so any Set-Cookie the downstream emitted survives (Headers
        // supports multiple `set-cookie` entries via .append).
        const headers = new Headers(res.headers)
        headers.append('set-cookie', gateSetCookie)
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers,
        })
      }
      return res

      async function dispatchRequest(): Promise<Response> {
      // 0-pre. E2E onboarding walkthrough — synthetic session-mint. Owns
      //        `POST /api/dev/mint-session`. Mounted ahead of every
      //        other surface so the dev-only path never collides with a
      //        production route. The factory inside
      //        `signup/dev/mint-session-route.ts` already gates on
      //        `NEUTRON_E2E_DEV_SECRET` — when the env is unset the
      //        boot path leaves `devMintSession` undefined, so the
      //        precedence here is just for clarity.
      if (devMintSession !== undefined) {
        const devRes = await devMintSession.handler(req)
        if (devRes !== null) return devRes
      }
      // 0. Internal cache invalidation — P1.5 § 1.5.5. Token-gated.
      if (
        pathname === '/internal/cache-invalidate' &&
        method === 'POST' &&
        internalCacheInvalidateHandler !== undefined
      ) {
        return await handleCacheInvalidate(req, internalCacheInvalidateHandler)
      }
      // 0-op. Substrate-lift S2 — operator REPL force-respawn. Owns
      //       `POST /admin/respawn-session`. Token-gated (X-Gateway-Token)
      //       inside the handler; mounted here in the operator family so the
      //       path bypasses the user-facing auth gate + is unambiguous ahead
      //       of the landing chain. Returns `null` for non-owned paths so the
      //       chain falls through. Closes Argus r1 BLOCKING #2.
      if (adminRespawn !== undefined) {
        const respawnRes = await adminRespawn.handler(req)
        if (respawnRes !== null) return respawnRes
      }
      // 0a. Slug-check — P1.5 § 1.5.8. Argus r2 [BLOCKING #2]: bound
      //     ahead of landing routes so the API path is unambiguous and
      //     never shadowed by a landing fall-through 404.
      if (
        pathname === '/api/v1/slug/check' &&
        method === 'GET' &&
        slugCheckHandler !== undefined
      ) {
        return await slugCheckHandler(req)
      }
      // 0a.bis Chat-history hydration — 2026-05-28. Bound ahead of
      //        landing routes so the surface owns its path
      //        unambiguously even when /chat is later mounted as a
      //        fall-through. The surface handler returns null for any
      //        path it doesn't own, so it falls through to the next
      //        handler in the chain on a sibling-owned route. Cookie
      //        auth happens inside the handler (the per-instance
      //        auth-gate's `pass-through-unauthed` behavior on JSON
      //        Accept means the gate would NOT 401 a tokenless
      //        history request; the handler self-verifies via the
      //        injected `resolveUserClaim`).
      if (chatHistory !== undefined) {
        const histRes = await chatHistory.handler(req)
        if (histRes !== null) return histRes
      }
      // 0a.ter Sidebar topic rail — 2026-05-28. Owns
      //        `GET /api/v1/chat/topics`. Mounted next to chat-history
      //        so both chat-surface sibling endpoints sit together in
      //        the precedence chain. Returns `null` for non-owned
      //        paths.
      if (chatTopics !== undefined) {
        const topicsRes = await chatTopics.handler(req)
        if (topicsRes !== null) return topicsRes
      }
      // 0b. Avatar.png — Sprint 28. Bound ahead of landing routes so the
      //     route is unambiguous + caches the bytes properly even when
      //     the landing chain disclaims the path. The Caddy proxy chain
      //     at <slug>.<base-domain> already routes /avatar.png to
      //     this gateway (Sprint 21); the handler here closes the loop.
      if (
        pathname === '/avatar.png' &&
        method === 'GET' &&
        avatarHandler !== undefined
      ) {
        return await avatarHandler(req)
      }
      // 0c. Profile-pic candidates — Sprint 28 Codex r2 P2. Per-candidate
      //     thumbnails the image-gallery picker references via
      //     ButtonOption.image_url. Path-prefix match so different
      //     candidate ids dispatch through the same handler.
      if (
        pathname.startsWith('/profile-pic/candidate/') &&
        method === 'GET' &&
        candidateHandler !== undefined
      ) {
        return await candidateHandler(req)
      }
      // 0d-pre. Chunked resumable upload — Upload Resume Phase 2. Owns
      //         `POST /api/upload/<source>/start`,
      //         `PATCH /api/upload/<source>/<upload_id>`, and
      //         `HEAD /api/upload/<source>/<upload_id>`. Mounted ahead of
      //         the legacy single-shot handler so the chunked path
      //         shapes are unambiguously owned; returns `null` for
      //         non-owned shapes so the bare legacy
      //         `POST /api/upload/<source>` still routes through the
      //         single-shot handler below.
      if (chunkedUploadHandler !== undefined) {
        const chunkedRes = await chunkedUploadHandler(req)
        if (chunkedRes !== null) return chunkedRes
      }
      // 0d-mid. Import resume — sprint 2026-05-25 Part G.1. Owns
      //         `POST /api/import/<job_id>/resume`. Returns `null` for
      //         non-owned paths so non-resume requests fall through to
      //         the legacy upload chain. Mounted ahead of import upload
      //         to keep the route prefix `/api/import/` distinct from
      //         `/api/upload/` and avoid any future collision.
      if (importResumeHandler !== undefined) {
        const resumeRes = await importResumeHandler(req)
        if (resumeRes !== null) return resumeRes
      }
      // 0d. Import upload — P2 v2 § 6.1 (S4). `POST /api/upload/<source>`
      //     for the ChatGPT / Claude history-export ZIP. Mounted ahead
      //     of the landing routes so the path is unambiguous + the
      //     multi-GB body never accidentally hits the landing
      //     `createLandingServer` SPA chain.
      if (
        pathname.startsWith('/api/upload/') &&
        method === 'POST' &&
        importUploadHandler !== undefined
      ) {
        return await importUploadHandler(req)
      }
      // 0e. Expo-app WebSocket surface — P5.1. The single unified chat
      //     socket: `/ws/app/chat` carries both onboarding and chat (the
      //     legacy landing `/ws/chat` socket was removed). The surface
      //     handler returns `null` when the path is not its concern so
      //     unrelated `/api/...` paths still reach the downstream chain.
      if (appWs !== undefined) {
        const appRes = await appWs.handler(req, server)
        if (appRes !== null) return appRes
      }
      // 0e2. Expo-app chat-attachment upload surface — P5.1. Owns
      //      `POST /api/app/upload` + `GET /api/app/upload/<...>`.
      //      Mounted right after the WS surface so the chat surface +
      //      its upload sibling stay co-located in routing. Returns
      //      `null` for non-owned paths so unrelated `/api/app/...`
      //      paths fall through. Closes Argus r1 BLOCKING #1.
      if (appUpload !== undefined) {
        const uploadRes = await appUpload.handler(req)
        if (uploadRes !== null) return uploadRes
      }
      // 0f. Expo-app project launcher surface — P5.3. Owns
      //     `/api/app/projects/<id>/launcher[*]`. Mounted ahead of
      //     landing routes so the per-project launcher path is
      //     unambiguously owned (the landing chain doesn't claim it
      //     today, but the precedence keeps it that way as the landing
      //     SPA grows). Returns `null` for non-owned paths so unrelated
      //     `/api/...` paths fall through to the downstream chain.
      if (appLauncher !== undefined) {
        const launcherRes = await appLauncher.handler(req)
        if (launcherRes !== null) return launcherRes
      }
      // 0g. Expo-app project-scoped tasks surface — P5.4. Owns
      //     `/api/app/projects/<id>/tasks[/<task_id>[/<verb>]]`.
      //     Mounted alongside the launcher surface; both disclaim
      //     non-owned paths via `null` so the chain stays composable.
      if (appTasks !== undefined) {
        const tasksRes = await appTasks.handler(req)
        if (tasksRes !== null) return tasksRes
      }
      // 0h. Expo-app project-scoped reminders surface — P5.4. Owns
      //     `/api/app/projects/<id>/reminders[/<reminder_id>[/<verb>]]`.
      //     Same disclaiming-null contract as launcher/tasks.
      if (appReminders !== undefined) {
        const remRes = await appReminders.handler(req)
        if (remRes !== null) return remRes
      }
      // 0h1. Expo/web-app tab-resolver surface — WAVE 3. Owns
      //      `GET /api/app/projects/<id>/tabs` + `GET /api/app/tabs`.
      //      Mounted BEFORE appProjects so the per-project `/tabs` path is
      //      unambiguously owned (appProjects disclaims it via null today,
      //      but this precedence keeps it that way), mirroring the
      //      launcher/tasks/reminders ordering. Always on — no flag; the
      //      surface disclaims (null) only for non-owned paths.
      if (appTabs !== undefined) {
        const tabsRes = await appTabs.handler(req)
        if (tabsRes !== null) return tabsRes
      }
      // 0h1b. Work Board (Phase 1a) — Expo-app project Work Board surface.
      //       Owns `/api/app/projects/<id>/work-board[/<item_id>[/<verb>]]`
      //       (GET + POST/PATCH/DELETE). Mounted BEFORE appProjects so the
      //       per-project `/work-board` path is unambiguously owned, mirroring
      //       the tasks/tabs precedence. Disclaims (null) non-owned paths.
      if (appWorkBoard !== undefined) {
        const wbRes = await appWorkBoard.handler(req)
        if (wbRes !== null) return wbRes
      }
      // 0h1c. Per-project credential CRUD (Settings tab) — owns
      //       `/api/app/projects/<id>/credentials[/<service>]` (GET/POST/DELETE).
      //       Mounted BEFORE appProjects so the per-project `/credentials` path
      //       is unambiguously owned, mirroring the work-board precedence.
      if (appProjectCredentials !== undefined) {
        const credRes = await appProjectCredentials.handler(req)
        if (credRes !== null) return credRes
      }
      // 0h2. Expo-app project-settings + project-list surface — P5.2
      //      + ISSUES #9. Owns:
      //        - GET   /api/app/projects                       (list)
      //        - GET   /api/app/projects/<id>/settings         (drawer)
      //        - PATCH /api/app/projects/<id>/settings         (drawer)
      //      Mounted AFTER launcher / tasks / reminders so the surface
      //      never claims paths like /api/app/projects/<id>/launcher
      //      that a per-project sibling has already routed. The list
      //      endpoint reads from the same per-project `projects` table
      //      the settings drawer mutates.
      if (appProjects !== undefined) {
        const projRes = await appProjects.handler(req)
        if (projRes !== null) return projRes
      }
      // 0h3. Open-mode cross-instance auth surface — M2.5. Owns
      //      `/api/app/connect/auth/{start,callback,status,disconnect}`.
      //      Wired only when deployment_mode === 'open'. Returns `null` for
      //      non-owned paths so the chain stays composable. The /status XHR
      //      carries `Accept: application/json` so the auth-gate (when
      //      mounted) passes it through; /callback is a browser nav the
      //      already-authenticated user reaches with a live session cookie.
      if (appConnectAuth !== undefined) {
        const ctRes = await appConnectAuth.handler(req)
        if (ctRes !== null) return ctRes
      }
      // 0i-pre. Expo-app current-focus-pick surface — P6.1. Owns
      //         `GET /api/app/focus/current`. Mounted BEFORE the
      //         broader Focus surface so the more-specific sibling
      //         path matches first. Returns null for non-owned paths.
      if (appFocusCurrent !== undefined) {
        const fcRes = await appFocusCurrent.handler(req)
        if (fcRes !== null) return fcRes
      }
      // 0i. Expo-app global Focus surface — P5.5. Owns
      //     `GET /api/app/focus`. Mounted ahead of landing routes for
      //     the same precedence-stability reason as the per-project
      //     launcher above. Returns `null` for non-owned paths.
      if (appFocus !== undefined) {
        const focusRes = await appFocus.handler(req)
        if (focusRes !== null) return focusRes
      }
      // 0j. Expo-app admin surface — P5.7. Owns `/api/app/admin/*`
      //     (personality, gateway restart, GBrain browse,
      //     connectors). HTTP-only; disclaims non-owned paths via
      //     `null` so the chain stays composable.
      if (appAdmin !== undefined) {
        const adminRes = await appAdmin.handler(req)
        if (adminRes !== null) return adminRes
      }
      // 0j2. Admin-tab personality editor — 2026-05-22. Owns
      //      `/api/app/persona/*` (3-file list, GET/PATCH per file,
      //      restart-from-scratch). Disjoint from /api/app/admin/* so
      //      no shadowing risk; placed next to admin for grep
      //      co-location.
      if (appPersona !== undefined) {
        const personaRes = await appPersona.handler(req)
        if (personaRes !== null) return personaRes
      }
      // 0k. Expo-app device push-token surface — P5.6. Owns
      //     `/api/app/devices/register` + `/api/app/devices/unregister`.
      //     The reminder-fired hook reads tokens from this store and
      //     POSTs them to the Expo Push API; the gateway never calls
      //     anything in this surface itself, only the Expo client does.
      if (appDevices !== undefined) {
        const devicesRes = await appDevices.handler(req)
        if (devicesRes !== null) return devicesRes
      }
      // 0l. Expo-app project docs surface — P7.0 + P7.1. Owns
      //     `/api/app/projects/<id>/docs/{tree,file,file/move,folder}`.
      //     Same disclaiming-null contract as the sibling app surfaces.
      if (appDocs !== undefined) {
        const docsRes = await appDocs.handler(req)
        if (docsRes !== null) return docsRes
      }
      // 0l1. Expo-app project backups + restore surface — P7.4 restore
      //      UI. Owns `/api/app/projects/<id>/backups[...]` +
      //      `/api/app/projects/<id>/restore`. Mounted AFTER appDocs
      //      so the docs surface continues to own `/docs/*` (its
      //      regex is disjoint). Order is irrelevant in practice — the
      //      two surfaces' path patterns don't overlap — but keeping
      //      backups after docs lines up the precedence chain with
      //      the order P7 routes were introduced.
      if (appBackups !== undefined) {
        const backupsRes = await appBackups.handler(req)
        if (backupsRes !== null) return backupsRes
      }
      // 0m1. Cores OAuth surface — Cores OAuth secret-resolution sprint.
      //      Owns `/api/cores/oauth/google/*`. Mounted BEFORE the
      //      bundled-cores admin surface so the OAuth paths are
      //      unambiguous. Returns `null` for non-owned paths.
      if (coresOAuth !== undefined) {
        const coresOAuthRes = await coresOAuth.handler(req)
        if (coresOAuthRes !== null) return coresOAuthRes
      }
      // 0m0b. Cores Integrations surface — WAVE 2 Track A. Owns
      //       `/api/cores/integrations` + `/api/cores/api-keys/*`. Mounted
      //       BEFORE the bundled-Cores admin surface (which would 404 these
      //       shapes) and independent of the OAuth surface above, so
      //       standalone API-key management works with no Google OAuth
      //       client. Returns `null` for non-owned paths.
      if (coresIntegrations !== undefined) {
        const coresIntegrationsRes = await coresIntegrations.handler(req)
        if (coresIntegrationsRes !== null) return coresIntegrationsRes
      }
      // 0m. Bundled-Cores admin surface — P3. Owns `/api/cores[/<slug>]`.
      //     Mounted ahead of landing/cross-instance chains so the path is
      //     unambiguously owned. Returns `null` for non-owned paths
      //     so unrelated `/api/...` paths fall through.
      if (cores !== undefined) {
        const coresRes = await cores.handler(req)
        if (coresRes !== null) return coresRes
      }
      // 1. Telegram webhook — exact match on POST /webhook/telegram only.
      //    The handler itself further validates the secret_token + body.
      if (pathname === '/webhook/telegram' && method === 'POST' && telegramWebhookHandler !== undefined) {
        return await telegramWebhookHandler(req)
      }
      // 2. Landing routes — explicit path-set match so cross-instance API
      //    paths can't be shadowed by a landing 404.
      if (landing !== undefined && isLandingRoute(pathname, method, url.searchParams.has('invite'))) {
        return await landing.fetch(req, server)
      }
      // 2.5. SPA client-route catch-all — a hard load / share of a
      //      project-scoped deep link (e.g. the P-A doc-reference URL
      //      `/projects/<id>/docs?path=…`) is a browser navigation into the
      //      chat-react shell, not an API call. Delegate it to landing so the
      //      SPA boots + client-routes to the deep link instead of falling
      //      through to the default 404. `isSpaClientRoute` matches only
      //      `GET /projects[/…]`, a prefix disjoint from every API/asset/
      //      operator surface above (all of which already ran + returned their
      //      own real 404s), so this can never mask an API 404.
      if (landing !== undefined && isSpaClientRoute(pathname, method)) {
        return await landing.fetch(req, server)
      }
      // 3. Cross-instance API — returns null to indicate the request is not
      //    its concern; we fall through. Returns a Response when it owns
      //    the route (success OR error — both are final).
      if (connectHandler !== undefined) {
        const r = await connectHandler(req)
        if (r !== null) return r
      }
      // 4. Default fallback (healthz + 404).
      return await defaultHandler(req)
      } // end dispatchRequest
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

async function handleCacheInvalidate(
  req: Request,
  handler: NonNullable<ComposeHttpHandlerInput['internalCacheInvalidateHandler']>,
): Promise<Response> {
  const supplied = req.headers.get('X-Internal-Token') ?? ''
  // Constant-time compare to defeat timing attacks on the shared secret.
  if (!constantTimeStringEquals(supplied, handler.expectedToken)) {
    return new Response('forbidden', { status: 403 })
  }
  let body: { internal_handle?: unknown } = {}
  try {
    body = (await req.json()) as { internal_handle?: unknown }
  } catch {
    return new Response('invalid json', { status: 400 })
  }
  const internal_handle = body.internal_handle
  if (typeof internal_handle !== 'string' || internal_handle.length === 0) {
    return new Response('missing internal_handle', { status: 400 })
  }
  handler.invalidateInternalHandle(internal_handle)
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

/** Re-exported test-helper view of the path table so other modules
 *  (or tests) can assert routing without re-implementing the predicate. */
export const LANDING_ROUTE_PATHS = LANDING_PATHS

// Ensure the structural import gives ServerWebSocket type (unused at
// runtime; pulled in for the websocket-handler typing).
type _ServerWsImportProbe = ServerWebSocket<LandingSocketState>
