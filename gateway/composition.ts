/**
 * @neutronai/gateway — production module composition.
 *
 * Wires up every concrete module that ships in P1 S4 into a
 * `GatewayModuleGraph`. The boot shell
 * (`gateway/index.ts`) calls `composeProductionGraph()` after the DB +
 * migrations are ready and after `READY=1` is sent.
 *
 * Each module is a tiny adapter shim that constructs the underlying
 * primitive (ToolRegistry, ChannelRouter, McpServer, etc.) and exposes it
 * via the graph's `get(name)` lookup. The shim shape keeps the production
 * graph file readable while the actual implementations live in their own
 * modules + are individually testable.
 */

// R5 (audit P2-5) — the bulk of the module-construction imports moved to
// `composition/build-core-modules.ts` along with the module-graph object
// builders. composition.ts retains only the imports its surviving
// post-`graph.compose()` wiring + the `buildComposedHttpFromComposition`
// helper still reference.
import { CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import { CronScheduler } from '@neutronai/cron/scheduler.ts'
import { CronStateStore } from '@neutronai/cron/state.ts'
import { GatewayModuleGraph } from './module-graph.ts'
import {
  composeHttpHandler,
  type ComposedHttpHandler,
  type ComposeHttpHandlerInput,
} from './http/compose.ts'
import { buildCoreModules } from './composition/build-core-modules.ts'
import { wireCoresSurfaces } from './composition/wire-cores-surfaces.ts'
import { wireConnectOverlay } from './composition/wire-connect-overlay.ts'
// `CompositionInput` + `CompositionHttpHandler` now live in dependency-free
// leaves (R5 / audit P2-5) so the extracted sub-builders + per-concern input
// interfaces can import them without importing this file back (which would
// re-introduce a composition.ts ↔ composition/* cycle). Re-exported here so
// every external importer of these types from `gateway/composition.ts` is
// unchanged.
import type { CompositionInput } from './composition/input/composition-input.ts'
import type { CompositionHttpHandler } from './composition/types.ts'
export type { CompositionInput } from './composition/input/composition-input.ts'
export type { CompositionHttpHandler } from './composition/types.ts'

/**
 * Return shape from `composeProductionGraph` after ISSUE #32. The
 * function still returns the full `GatewayModuleGraph` (existing
 * callers keep using `.shutdown()`, `.get()`, `.names()` unchanged)
 * but now also exposes the composed HTTP `{fetch, websocket}` pair the
 * production boot path used to assemble itself by re-invoking
 * `composeHttpHandler` on top of the same composition.
 *
 * Why this matters: prior to this sprint every
 * `*-production-composer.test.ts` had to re-construct the chain via
 * `composeHttpHandler({appXxx: { handler: surface.handler }})` and
 * serve THAT handler — bypassing the real
 * `composition.app_xxx_surface → composeInput.appXxx` mapping the boot
 * shell did. Deleting a `composeInput.appXxx = …` line in `boot()`
 * silently passed every reachability test.
 *
 * Now the mapping is OWNED by `composeProductionGraph` (via
 * `buildComposedHttpFromComposition` below) and is the only path that
 * produces the composed `fetch`. Tests that serve `graph.fetch`
 * exercise the real mapping; a deletion at the mapping site provably
 * breaks them. The closing condition for ISSUE #32.
 */
export type ComposedProductionGraph = GatewayModuleGraph & {
  /**
   * Composed Bun.serve-compatible fetch handler. Undefined when the
   * caller supplied neither a `http_handler` override nor any chained
   * surface field (legacy P1 dev path stays on the boot shell's
   * default healthz/404 handler).
   */
  fetch?: ComposedHttpHandler['fetch']
  /**
   * Composed Bun.serve-compatible websocket handler. Undefined under
   * the same conditions as `fetch`.
   */
  websocket?: ComposedHttpHandler['websocket']
  /**
   * The exact `CompositionInput` the caller passed in (possibly
   * mutated by the composer itself — `cores_surface`,
   * `cores_oauth_surface`, `connect_api.handlers.on_inbound_message`
   * overlays). Same object reference for backward compat.
   */
  composition: CompositionInput
}

/**
 * Map a fully-prepared `CompositionInput` onto the
 * `ComposeHttpHandlerInput` shape `composeHttpHandler` expects, then
 * compose. Returns `null` when no chained surface was supplied — the
 * legacy P1 dev path stays on the caller-supplied default handler in
 * that case (boot recognises `null` and skips wiring the chain).
 *
 * Centralising the mapping HERE (instead of inline in
 * `gateway/index.ts:boot`) is the structural fix for ISSUE #32 — a
 * single grep for `app_xxx_surface` now finds the only path that
 * promotes a surface into the production HTTP chain. Every
 * `*-production-composer.test.ts` exercises this mapping by serving
 * `graph.fetch` rather than re-rolling its own `composeHttpHandler`
 * call.
 */
async function buildComposedHttpFromComposition(
  composition: CompositionInput,
): Promise<ComposedHttpHandler | null> {
  // Cross-instance API construction is Managed-only. The dynamic import
  // means Open-tier boots (no `connect_api` field set) never load
  // the Managed-classified `connect/api/server.ts` edge.
  let connectHandler: ((req: Request) => Promise<Response | null>) | undefined
  if (composition.connect_api !== undefined) {
    const ct = composition.connect_api
    // Sprint B (2026-05-20) — `composition.connect_api` carries the
    // runtime/connect-handlers structural aliases. The Managed
    // `createConnectApiHandler` accepts its own (wider) shape; both
    // shapes are field-for-field equivalent so a narrow cast is the
    // cleanest seam.
    const cross = (
      await import('@neutronai/connect/api/server.ts')
    ).createConnectApiHandler({
      receiving_instance_slug: composition.project_slug,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      auth: ct.auth as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handlers: ct.handlers as any,
      // M2.6 Ph3 — public-edge rate limiter (connect-node only; undefined
      // elsewhere → trusted fan-out keeps its pre-Ph3 posture).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rate_limiter: ct.rate_limiter as any,
    })
    connectHandler = cross
  }

  const defaultHandler: CompositionHttpHandler =
    composition.default_handler ?? (() => new Response('Not Found', { status: 404 }))
  const composeInput: ComposeHttpHandlerInput = { defaultHandler }
  if (composition.landing_server !== undefined) {
    composeInput.landing = composition.landing_server
  }
  if (composition.telegram_webhook !== undefined) {
    composeInput.telegramWebhookHandler = composition.telegram_webhook.handler
  }
  if (connectHandler !== undefined) {
    composeInput.connectHandler = connectHandler
  }
  if (composition.internal_cache_invalidate !== undefined) {
    composeInput.internalCacheInvalidateHandler = composition.internal_cache_invalidate
  }
  if (composition.slug_check_handler !== undefined) {
    composeInput.slugCheckHandler = composition.slug_check_handler
  }
  if (composition.admin_respawn_handler !== undefined) {
    composeInput.adminRespawn = { handler: composition.admin_respawn_handler }
  }
  if (composition.chat_history_surface !== undefined) {
    composeInput.chatHistory = { handler: composition.chat_history_surface.handler }
  }
  if (composition.chat_topics_surface !== undefined) {
    composeInput.chatTopics = { handler: composition.chat_topics_surface.handler }
  }
  if (composition.avatar_handler !== undefined) {
    composeInput.avatarHandler = composition.avatar_handler
  }
  if (composition.candidate_handler !== undefined) {
    composeInput.candidateHandler = composition.candidate_handler
  }
  if (composition.import_upload_handler !== undefined) {
    composeInput.importUploadHandler = composition.import_upload_handler
  }
  if (composition.chunked_upload_handler !== undefined) {
    composeInput.chunkedUploadHandler = composition.chunked_upload_handler
  }
  if (composition.import_resume_handler !== undefined) {
    composeInput.importResumeHandler = composition.import_resume_handler
  }
  if (composition.app_ws_surface !== undefined) {
    composeInput.appWs = {
      handler: composition.app_ws_surface.handler,
      websocket: composition.app_ws_surface.websocket,
    }
  }
  if (composition.app_upload_surface !== undefined) {
    composeInput.appUpload = { handler: composition.app_upload_surface.handler }
  }
  if (composition.app_launcher_surface !== undefined) {
    composeInput.appLauncher = { handler: composition.app_launcher_surface.handler }
  }
  if (composition.app_tasks_surface !== undefined) {
    composeInput.appTasks = { handler: composition.app_tasks_surface.handler }
  }
  if (composition.app_reminders_surface !== undefined) {
    composeInput.appReminders = { handler: composition.app_reminders_surface.handler }
  }
  if (composition.app_projects_surface !== undefined) {
    composeInput.appProjects = { handler: composition.app_projects_surface.handler }
  }
  if (composition.app_connect_auth_surface !== undefined) {
    composeInput.appConnectAuth = {
      handler: composition.app_connect_auth_surface.handler,
    }
  }
  if (composition.app_focus_surface !== undefined) {
    composeInput.appFocus = { handler: composition.app_focus_surface.handler }
  }
  if (composition.app_focus_current_surface !== undefined) {
    composeInput.appFocusCurrent = {
      handler: composition.app_focus_current_surface.handler,
    }
  }
  if (composition.app_admin_surface !== undefined) {
    composeInput.appAdmin = { handler: composition.app_admin_surface.handler }
  }
  if (composition.app_persona_surface !== undefined) {
    composeInput.appPersona = { handler: composition.app_persona_surface.handler }
  }
  if (composition.app_devices_surface !== undefined) {
    composeInput.appDevices = { handler: composition.app_devices_surface.handler }
  }
  if (composition.app_docs_surface !== undefined) {
    composeInput.appDocs = { handler: composition.app_docs_surface.handler }
  }
  if (composition.app_tabs_surface !== undefined) {
    composeInput.appTabs = { handler: composition.app_tabs_surface.handler }
  }
  if (composition.app_work_board_surface !== undefined) {
    composeInput.appWorkBoard = { handler: composition.app_work_board_surface.handler }
  }
  if (composition.app_project_credentials_surface !== undefined) {
    composeInput.appProjectCredentials = {
      handler: composition.app_project_credentials_surface.handler,
    }
  }
  if (composition.app_codex_credential_surface !== undefined) {
    composeInput.appCodexCredential = {
      handler: composition.app_codex_credential_surface.handler,
    }
  }
  if (composition.app_backups_surface !== undefined) {
    composeInput.appBackups = {
      handler: composition.app_backups_surface.handler,
    }
  }
  if (composition.cores_surface !== undefined) {
    composeInput.cores = { handler: composition.cores_surface.handler }
  }
  if (composition.cores_oauth_surface !== undefined) {
    composeInput.coresOAuth = { handler: composition.cores_oauth_surface.handler }
  }
  if (composition.cores_integrations_surface !== undefined) {
    composeInput.coresIntegrations = {
      handler: composition.cores_integrations_surface.handler,
    }
  }
  if (composition.auth_gate !== undefined) {
    // 2026-05-27 returning-user resume sprint — every gated route in
    // the per-instance gateway runs through `landing/auth-gate.ts` before
    // dispatching to landing / app / cores surfaces.
    composeInput.authGate = composition.auth_gate
  }

  // Build the chain only if the caller supplied at least one
  // surface; otherwise return null so the boot shell stays on its
  // dev `/healthz`-only handler (legacy `bun run gateway/index.ts`).
  const hasAnyChainedSurface =
    composition.landing_server !== undefined ||
    composition.telegram_webhook !== undefined ||
    composition.connect_api !== undefined ||
    composition.internal_cache_invalidate !== undefined ||
    composition.slug_check_handler !== undefined ||
    composition.admin_respawn_handler !== undefined ||
    composition.avatar_handler !== undefined ||
    composition.candidate_handler !== undefined ||
    composition.import_upload_handler !== undefined ||
    composition.chunked_upload_handler !== undefined ||
    composition.app_ws_surface !== undefined ||
    composition.app_upload_surface !== undefined ||
    composition.app_launcher_surface !== undefined ||
    composition.app_tasks_surface !== undefined ||
    composition.app_reminders_surface !== undefined ||
    composition.app_projects_surface !== undefined ||
    composition.app_connect_auth_surface !== undefined ||
    composition.app_focus_surface !== undefined ||
    composition.app_focus_current_surface !== undefined ||
    composition.app_admin_surface !== undefined ||
    composition.app_persona_surface !== undefined ||
    composition.app_devices_surface !== undefined ||
    composition.app_docs_surface !== undefined ||
    composition.app_tabs_surface !== undefined ||
    composition.app_work_board_surface !== undefined ||
    composition.app_project_credentials_surface !== undefined ||
    composition.app_codex_credential_surface !== undefined ||
    composition.app_backups_surface !== undefined ||
    composition.cores_surface !== undefined ||
    composition.cores_oauth_surface !== undefined ||
    composition.cores_integrations_surface !== undefined
  if (!hasAnyChainedSurface) return null
  return composeHttpHandler(composeInput)
}

/**
 * Compose the P1 S4 production module graph. Returns the live graph
 * augmented with the composed HTTP `{fetch, websocket}` pair (see
 * `ComposedProductionGraph`). The caller is responsible for
 * `await graph.shutdown()` on SIGTERM.
 */
export async function composeProductionGraph(
  input: CompositionInput,
): Promise<ComposedProductionGraph> {
  const graph = new GatewayModuleGraph({ project_slug: input.project_slug })

  // R5 (audit P2-5) — module-graph object construction extracted to
  // `composition/build-core-modules.ts`. The registration ORDER below
  // and the post-`graph.compose()` wiring stay here (both load-bearing).
  const {
    toolsModule,
    processRegistryModule,
    approvalModule,
    channelsModule,
    mcpModule,
    replToolBridgeModule,
    remindersModule,
    tridentModule,
    cronModule,
    watchdogModule,
    onboardingTelemetryModule,
    platformModule,
    tasksModule,
    coresModule,
  } = buildCoreModules(input)

  graph.register(toolsModule)
  graph.register(processRegistryModule)
  graph.register(approvalModule)
  graph.register(channelsModule)
  graph.register(mcpModule)
  // P0-1 — registered AFTER `mcp` (deps:['mcp']); points the substrate's
  // late-bound tool-bridge singleton at the graph's McpServer.
  graph.register(replToolBridgeModule)
  graph.register(remindersModule)
  graph.register(tridentModule)
  graph.register(cronModule)
  graph.register(tasksModule)
  graph.register(watchdogModule)
  graph.register(onboardingTelemetryModule)
  graph.register(platformModule)
  if (coresModule !== null) {
    graph.register(coresModule)
  }
  await graph.compose()

  // S15 (2026-05-17) — kick the CronScheduler over the line. Every cron
  // module's docblock (resume-on-reconnect, Sean Ellis, import-running)
  // promised "the cron starts ticking on the next CronScheduler.start()"
  // — but no code ever made that call. The cronModule's init only
  // CONSTRUCTS the scheduler; cron jobs registered through
  // CompositionInput.cron_jobs (wow-dispatcher action 07) and via the
  // onboarding-telemetry module init (Sean Ellis, resume, import-running)
  // landed in the registry, but the scheduler's `setInterval` mesh was
  // never wired up. Result: `cron_state` stays empty for every instance,
  // and the import_running phase strands the user mid-onboarding because
  // pollImportRunningTick never gets called (v0.1.36 prod walkthrough).
  //
  // Calling start() AFTER `await graph.compose()` is safe: every module's
  // init runs during compose() and every handler/job registration happens
  // before this line. `start()` is idempotent — re-runs early-out on
  // `this.running.has(job.name)` — so a hot-reload composer (tests) does
  // not double-tick. The log line records the count + sorted job names so
  // a journald grep at boot tells operators exactly which crons went live
  // (and a `0 jobs` line flags a wiring regression at boot rather than
  // 15 min later when the first user stalls).
  const cron = graph.get<{
    jobs: CronJobRegistry
    handlers: CronHandlerRegistry
    state: CronStateStore
    scheduler: CronScheduler
  }>('cron')
  cron.scheduler.start()
  const job_names = cron.scheduler.runningJobNames()
  console.log(
    `[cron-scheduler] project=${input.project_slug} started — ${job_names.length} job(s) ticking: [${job_names.join(', ')}]`,
  )

  // R5 (audit P2-5) — Cores HTTP surface auto-build extracted to
  // `composition/wire-cores-surfaces.ts`. Runs in the SAME position as the
  // former inline block (after cron start, before the connect overlay).
  await wireCoresSurfaces(input, graph)

  // R5 (audit P2-5) — connect `on_inbound_message` overlay extracted to
  // `composition/wire-connect-overlay.ts`. Runs after the Cores auto-build
  // and before the HTTP composition (unchanged ordering).
  wireConnectOverlay(input, graph)

  // ISSUE #32 — build the composed HTTP `{fetch, websocket}` from the
  // (now fully-overlaid) composition and attach it to the graph.
  // Caller-supplied `http_handler` still wins at the boot precedence
  // ladder; we always build the chain when surfaces are present so
  // tests can serve `graph.fetch` without re-rolling their own
  // `composeHttpHandler` invocation.
  //
  // Codex r1 P2 (2026-05-22) — `buildComposedHttpFromComposition` runs
  // AFTER `graph.compose()` + the cron scheduler `start()` calls
  // above, so a failure here would leak the started graph (cron
  // ticker, reminders tick loop, watchdog supervisor) — `boot()`'s
  // init-failure catch can only see `graph` once this function
  // returns. Pre-refactor the connect API construction happened
  // inside `boot()` AFTER its `graph` variable was assigned, so its
  // catch could `await graph.shutdown()`. Now we own the lifecycle
  // until `return`: if the HTTP composition throws (the only realistic
  // path is `import('@neutronai/connect/api/server.ts')` failing
  // under a Managed boot when the submodule is unreadable), tear down
  // the graph BEFORE re-throwing so the caller's catch doesn't see a
  // half-running gateway it can't reach.
  let composedHttp: ComposedHttpHandler | null
  try {
    composedHttp = await buildComposedHttpFromComposition(input)
  } catch (err) {
    try {
      await graph.shutdown()
    } catch (shutdownErr) {
      console.error(
        '[composeProductionGraph] graph shutdown after HTTP composition failure threw:',
        shutdownErr,
      )
    }
    throw err
  }

  const composedGraph = graph as ComposedProductionGraph
  if (composedHttp !== null) {
    composedGraph.fetch = composedHttp.fetch
    composedGraph.websocket = composedHttp.websocket
  }
  composedGraph.composition = input
  return composedGraph
}
