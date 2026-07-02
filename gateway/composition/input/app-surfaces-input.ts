export interface AppSurfacesCompositionInput {
  /**
   * P2 v2 § 6.1 (S4) — `POST /api/upload/<source>` handler. Production
   * wires `handleImportUpload` against the per-instance InterviewEngine,
   * `<owner_home>/imports/`, and the per-instance POSIX uid/gid. The
   * handler writes the bytes to disk + bridges
   * `engine.notifyImportUpload(...)` so the user advances out of
   * `import_upload_pending` automatically. Optional — when omitted the
   * route falls through to the default 404 chain.
   */
  import_upload_handler?: (req: Request) => Promise<Response>
  /**
   * Upload Resume Phase 2 — chunked resumable upload handler. Owns
   * `POST /api/upload/<source>/start`,
   * `PATCH /api/upload/<source>/<upload_id>`, and
   * `HEAD /api/upload/<source>/<upload_id>`. Returns `null` for
   * non-owned paths so the bare legacy `POST /api/upload/<source>`
   * shape continues to route through `import_upload_handler`. Optional —
   * when omitted the three chunked routes are unmounted.
   */
  chunked_upload_handler?: (req: Request) => Promise<Response | null>
  /**
   * 2026-05-25 (import-pipeline-resilience sprint, Part G.1) —
   * `POST /api/import/<job_id>/resume` handler. Production wires
   * `buildImportResumeHandler(...)` per
   * `gateway/upload/import-resume-handler.ts`. Optional — when
   * omitted the resume route is unmounted and the chat-bridge's
   * `resume_import` button surface no-ops gracefully (the chat-side
   * affordance still routes to the engine's analysis-presented
   * handler so the user can keep typing).
   */
  import_resume_handler?: (req: Request) => Promise<Response | null>
  /**
   * P5.1 — Expo-app WebSocket surface. When supplied, the composed
   * HTTP chain mounts `/ws/app/chat` + `/api/app/chat/send` and
   * multiplexes the websocket handler with the landing onboarding
   * surface (when both are present). Optional — when omitted both
   * routes are unmounted and the channel router is not extended with
   * the app-ws adapter.
   *
   * Surface factory: `gateway/http/app-ws-surface.ts:createAppWsSurface`.
   * Per SPEC.md § Phases→Steps and
   * docs/engineering-plan.md § B.P5.
   */
  app_ws_surface?: {
    handler: (
      req: Request,
      server: import('bun').Server<unknown>,
    ) => Promise<Response | null>
    websocket: import('bun').WebSocketHandler<unknown>
  }
  /**
   * P5.1 — Expo-app chat-attachment upload surface. When supplied, the
   * composed HTTP chain mounts `POST /api/app/upload` (multipart image
   * upload returning the canonical URL) and the matching auth-gated
   * GET. HTTP-only — no websocket. When omitted the upload route is
   * unmounted; the Expo client's upload-client.ts hits 404 and every
   * attach flips failed.
   *
   * Surface factory: `gateway/http/app-upload-surface.ts:createAppUploadSurface`.
   * Per SPEC.md § Phases→Steps / P5.1 (Argus r1
   * BLOCKING #1).
   */
  app_upload_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * P5.3 — Expo-app project-launcher surface. When supplied, the
   * composed HTTP chain mounts `/api/app/projects/<id>/launcher[*]`.
   * HTTP-only — no websocket multiplexing concerns. When omitted the
   * launcher routes are unmounted; the Expo client surfaces an empty
   * tile grid with a "launcher backend not wired" hint.
   *
   * Surface factory: `gateway/http/app-launcher-surface.ts:createAppLauncherSurface`.
   * Per SPEC.md § Phases→Steps / P5.3.
   */
  app_launcher_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * P5.4 — Expo-app project-scoped tasks surface. When supplied, the
   * composed HTTP chain mounts
   * `/api/app/projects/<id>/tasks[/<task_id>[/<verb>]]` (GET list +
   * POST create + PATCH update + POST complete/cancel + DELETE).
   * Backed by the P6.0 canonical `TaskStore`. When omitted the tasks
   * routes are unmounted; the Expo client surfaces an empty list +
   * error banner.
   *
   * Surface factory: `gateway/http/app-tasks-surface.ts:createAppTasksSurface`.
   * Per SPEC.md § Phases→Steps / P5.4 and
   * docs/engineering-plan.md § B.P5 + § B.P6.
   */
  app_tasks_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * P5.4 — Expo-app project-scoped reminders surface. When supplied,
   * the composed HTTP chain mounts
   * `/api/app/projects/<id>/reminders[/<reminder_id>[/<verb>]]`
   * (GET list + POST create + POST snooze + POST cancel). Backed by
   * the per-instance `ReminderStore`. Closes a wiring gap from PR #153
   * which landed the surface + tests but forgot the compose hook.
   *
   * Surface factory: `gateway/http/app-reminders-surface.ts:createAppRemindersSurface`.
   * Per SPEC.md § Phases→Steps / P5.4.
   */
  app_reminders_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * P5.2 + ISSUES #9 — Expo-app project-settings + project-list
   * surface. When supplied, the composed HTTP chain mounts:
   *   - `GET   /api/app/projects`                      (list, ISSUES #9)
   *   - `GET   /api/app/projects/<id>/settings`        (drawer)
   *   - `PATCH /api/app/projects/<id>/settings`        (drawer)
   *
   * PATCH whitelists `privacy_mode` only at P5.2; other fields → 400
   * `field_not_writable`. Backed by `SqliteProjectSettingsStore`
   * (`gateway/projects/sqlite-store.ts`) in production — the
   * per-instance `projects` + `project_members` tables (migration
   * 0038) are the canonical substrate. PATCH writes survive a
   * gateway restart (closes ISSUES #9). When omitted the routes are
   * unmounted; the Expo drawer surfaces an empty state.
   *
   * Surface factory: `gateway/http/app-projects-surface.ts:createAppProjectsSurface`.
   * Per docs/plans/P5.2-project-view-shell-sprint-brief.md § 4.5 + § 4.12.
   */
  app_projects_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * M2.5 — Open-mode connect auth surface. When supplied, the
   * composed HTTP chain mounts the 4 Open-client connect-auth endpoints
   * (start / callback / status / disconnect).
   *
   * These drive the "Connect to the shared identity service" settings
   * affordance on an Open self-hosted instance: the owner OAuths against the
   * centralized auth host, the gateway redeems a one-time code into a
   * FederatedTokenStore, and the unified project list then includes the
   * shared projects from every Managed workspace the user belongs to.
   *
   * Managed deployments leave this UNSET — they mint a per-instance
   * connect token in-process and never run the federated client path.
   * The boot shell only wires this when `deployment_mode === 'open'` (see
   * `gateway/index.ts`). When unset the routes are unmounted; the landing
   * panel's `/status` fetch 404s and the panel hides itself.
   *
   * Surface factory: the app-level connect auth surface in `gateway/http/`.
   * Per docs/plans/2026-06-01-m2.5-open-clients-managed-workspaces-plan.md.
   */
  app_connect_auth_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * P5.5 — Expo-app global Focus surface. When supplied, the composed
   * HTTP chain mounts `GET /api/app/focus`, the cross-project
   * today/most-important projection over the owner's tasks +
   * reminders. Read-only; no mutations, no websocket. When omitted
   * the route is unmounted; the Expo client surfaces an empty Focus
   * list with a "focus backend not wired" hint.
   *
   * Surface factory: `gateway/http/app-focus-surface.ts:createAppFocusSurface`.
   * Per SPEC.md § Phases→Steps / P5.5 and
   * docs/engineering-plan.md § B.P5.
   */
  app_focus_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * P6.1 — Expo-app current-focus-pick surface. When supplied, the
   * composed HTTP chain mounts `GET /api/app/focus/current` (today's
   * LLM nudge pick + joined Task row, or 404 when no pick today).
   *
   * Surface factory:
   *   `gateway/http/app-focus-current-surface.ts:createAppFocusCurrentSurface`.
   * Per docs/plans/2026-05-23-002-feat-p6-1-nudge-engine-staleness-current-focus-pick-plan.md.
   */
  app_focus_current_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * P5.7 — Expo-app admin surface. When supplied, the composed HTTP
   * chain mounts `/api/app/admin/*` (personality GET/PUT, gateway
   * restart POST, GBrain browse GET, connectors list GET). HTTP-
   * only — backed by `<owner_home>/persona/SOUL.md` for personality,
   * an injected `restartGateway` callback (defaults to SIGTERM) for
   * the Open-tier restart, and optional `MemoryStore` + `CoreInstallationsStore`
   * deps for the GBrain + connectors browse routes.
   *
   * Surface factory: `gateway/http/app-admin-surface.ts:createAppAdminSurface`.
   * Per SPEC.md § Phases→Steps / P5.7 and
   * docs/engineering-plan.md § B.P5 (Admin tab bullet).
   */
  app_admin_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * Admin-tab personality editor surface (2026-05-22). When supplied,
   * the composed HTTP chain mounts `/api/app/persona/*` (3-file list,
   * GET / PATCH per file, restart-from-scratch). HTTP-only — backed
   * by atomic writes to `<owner_home>/persona/{SOUL,USER,priority-map}.md`.
   *
   * Surface factory:
   *   `gateway/http/admin-personality-surface.ts:createAdminPersonalitySurface`.
   * Per docs/plans/2026-05-22-003-feat-admin-personality-editor-plan.md.
   */
  app_persona_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * P5.6 — Expo-app device push-token surface. When supplied, the
   * composed HTTP chain mounts `/api/app/devices/register` +
   * `/api/app/devices/unregister`. Backed by `DevicePushTokenStore`
   * (`gateway/push/store.ts`). The reminders module's tick loop
   * reads tokens from the same per-instance `device_push_tokens` table
   * via its `on_fired` hook when `push_dispatcher` is also wired.
   *
   * Surface factory: `gateway/http/app-devices-surface.ts:createAppDevicesSurface`.
   * Per SPEC.md § Phases→Steps / P5.6 +
   * docs/engineering-plan.md § B.P5.
   */
  app_devices_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * P7.0 + P7.1 — Expo-app project-scoped docs surface. When supplied,
   * the composed HTTP chain mounts
   * `/api/app/projects/<id>/docs/{tree,file,file/move,folder}` (GET
   * tree/file + PUT/DELETE file + POST file/move + POST/DELETE folder).
   * Backed by `DocStore` over
   * `<owner_home>/Projects/<project_id>/docs/`. When omitted the
   * routes are unmounted and fall through to the default chain.
   *
   * Surface factory: `gateway/http/app-docs-surface.ts:createAppDocsSurface`.
   * Per SPEC.md § Phases→Steps / P7.0 + P7.1.
   */
  app_docs_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * WAVE 3 — Expo/web-app tab-resolver surface. When supplied, the composed
   * HTTP chain mounts `GET /api/app/projects/<id>/tabs` (per-project tabs) +
   * `GET /api/app/tabs` (global tabs). The endpoints return engine-resolved
   * `TabDescriptor[]` that both clients (mobile RN + web React) consume
   * instead of hardcoding their tab set: BUILTIN descriptors (Chat/Documents/
   * Tasks per-project; Admin global) UNIONed with installed Cores'
   * `project_tab` surfaces (per-project from `core_installations`, global
   * from `core_global_installations`).
   *
   * Always on — no feature flag (SPEC Decisions Log, 2026-06-23). The surface
   * disclaims its routes (returns `null`) only for non-owned paths. When this
   * field is omitted entirely the routes are unmounted.
   *
   * Surface factory: `gateway/http/app-tabs-surface.ts:createAppTabsSurface`.
   * Per docs/plans/wave3-tabbed-interface-build-plan.md § 3.1-3.2 (PR-1+PR-2).
   */
  app_tabs_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * Work Board (Phase 1a) — the human read+WRITE board surface. Owns
   * `/api/app/projects/<id>/work-board[/<item_id>[/<verb>]]`. Dispatches the
   * SAME `WorkBoardStore` the agent tools + per-turn injection use. Surface
   * factory: `gateway/http/work-board-surface.ts:createWorkBoardSurface`.
   */
  app_work_board_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * Per-project credential CRUD (Settings tab, FOUNDATION). Owns
   * `/api/app/projects/<id>/credentials[/<service>]`. Dispatches the SAME
   * `ProjectCredentialStore` the resolver + per-turn awareness injection use.
   * Surface factory:
   * `gateway/http/project-credentials-surface.ts:createProjectCredentialsSurface`.
   */
  app_project_credentials_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * Part B — admin-panel Connect Codex surface. Owns
   * `/api/app/projects/<id>/codex-auth` (GET status / POST connect / DELETE
   * disconnect). Validates a pasted ChatGPT-subscription auth.json (metered
   * OPENAI_API_KEY rejected), stores it in the #149 credential store, and
   * materializes it to the per-project CODEX_HOME the trident codex reviewer
   * reads. Surface factory:
   * `gateway/http/codex-credential-surface.ts:createCodexCredentialSurface`.
   */
  app_codex_credential_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
  /**
   * P7.4 restore UI — optional project-backups + restore surface.
   * Owns `/api/app/projects/<id>/backups[...]` +
   * `/api/app/projects/<id>/restore`. Surface factory:
   * `gateway/http/app-backups-surface.ts:createAppBackupsSurface`.
   */
  app_backups_surface?: {
    handler: (req: Request) => Promise<Response | null>
  }
}
