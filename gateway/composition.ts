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
import { LoopRegistry, type DormantLoop } from '@neutronai/loop'
import { GatewayModuleGraph } from './module-graph.ts'
import {
  buildManagedAuthGate,
  composeHttpHandler,
  type ComposedHttpHandler,
  type ComposeHttpHandlerInput,
} from './http/compose.ts'
import { buildComposeSurfaces, hasAnyChainedSurface } from './http/route-slots.ts'
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
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('composition')
export type { CompositionInput } from './composition/input/composition-input.ts'
export type { CompositionHttpHandler } from './composition/types.ts'
export type { MemoryHealthSummary, MemoryHealthProvider } from './composition/types.ts'

/**
 * §F2 / decision D-7 — loops that are fully BUILT but deliberately NOT started
 * in any composition today. Enumerated here so the boot inventory line names
 * them (explicit dormancy, never a silent dead loop) and the loop-inventory
 * production-composer test PINS the set — a future silently-added dead loop, or
 * a silent deletion of one of these, breaks that test.
 *
 * D-7 (2026-07-02 Decisions Log): "Document as dormant now; add BOTH to SPEC.md
 * as post-window feature PRs." Wiring each requires real feature infrastructure
 * (ProjectBackupScheduler ← a per-instance `ProjectBackupStore` + git backup
 * plumbing from the P7.4 sprint; comments `AgentWatcher` ← the realmode LLM-call
 * composer + comment store + shared anchor-walker project lock) that belongs in
 * a feature PR, not this refactor unit — so F2 makes their dormancy EXPLICIT
 * rather than wiring or deleting them.
 */
export const DORMANT_LOOPS: readonly DormantLoop[] = [
  {
    name: 'project-backup-scheduler',
    reason:
      'built (gateway/git/project-backup-scheduler.ts) but never constructed in any composition; needs a wired ProjectBackupStore + project enumerator (P7.4 backup sprint).',
    deferredTo: 'D-7 → SPEC roadmap post-window feature PR',
  },
  {
    name: 'agent-watcher',
    reason:
      'built (gateway/comments/agent-watcher.ts) but never constructed in any composition; needs the realmode LLM-call composer + comment store + shared anchor-walker project lock.',
    deferredTo: 'D-7 → SPEC roadmap post-window feature PR',
  },
]

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
  /**
   * §F2 — the loop inventory. Every long-lived tick loop this composition
   * STARTED (reminders, trident, cron, watchdog) has registered its live
   * descriptor here by the time `composeProductionGraph` returns. A
   * production-composer test pins `loopRegistry.names()` (the ISSUE-#32 pattern
   * applied to loops); the dormant set is {@link DORMANT_LOOPS}.
   */
  loopRegistry: LoopRegistry
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

  // C4 — the `CompositionInput → composeInput` surface mapping AND the
  // build-the-chain-at-all gate are GENERATED from the ordered RouteSlot
  // registry (`gateway/http/route-slots.ts`), the same source the ladder in
  // `composeHttpHandler` walks. One registration entry per surface.
  //
  // Build the chain only if the caller supplied at least one chain-gating
  // surface; otherwise return null so the boot shell stays on its dev
  // `/healthz`-only handler (legacy `bun run gateway/index.ts`).
  if (!hasAnyChainedSurface(composition)) return null

  const composeInput: ComposeHttpHandlerInput = {
    defaultHandler,
    ...buildComposeSurfaces(composition),
  }
  // The two non-rung promotions stay explicit here:
  //   - `connectHandler` carries the Managed-only dynamic import above;
  if (connectHandler !== undefined) {
    composeInput.connectHandler = connectHandler
  }
  //   - C5b — the ONE auth-gate seam, both modes. `composition.auth_gate`
  //     carries EITHER a Managed `AuthGateOptions` decision object (the default
  //     shape — wrapped here into the unified `HttpGate` via
  //     `buildManagedAuthGate`) OR an Open pre-built `HttpGate`
  //     (`{ kind: 'gate', gate }`, supplied by the Open composer for the
  //     single-owner `openFetch` serving gate). Both land on the single
  //     `composeInput.gate` seam the ladder dispatches through. The gate wraps
  //     the whole ladder rather than being a rung of it.
  if (composition.auth_gate !== undefined) {
    const ag = composition.auth_gate
    composeInput.gate = 'kind' in ag ? ag.gate : buildManagedAuthGate(ag)
  }
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

  // §F2 — the boot loop inventory. REUSE the registry the caller threaded
  // through `CompositionInput.loop_registry` (the Open composer registers the
  // `ChunkedUploadSweeper` it starts BEFORE this graph composes) so the ONE boot
  // line inventories the COMPLETE running set — loops started here AND by the
  // composer. Absent (Managed / direct composer-test callers) → a fresh registry
  // holding just this graph's loops. `buildCoreModules` threads it into the
  // reminders / trident / watchdog module inits (each registers its live
  // descriptor after `start()`); cron registers below after its own `start()`.
  const loopRegistry = input.loop_registry ?? new LoopRegistry()

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
  } = buildCoreModules(input, loopRegistry)

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
  // §F2 — WHOLE-COMPOSITION failure atomicity. `graph.compose()` STARTS the
  // module loops (reminders / trident / watchdog during their inits), and cron
  // + the post-compose wiring run after. Per-loop register-before-start makes
  // each loop individually atomic, but ACROSS loops a LATER failure (e.g. a
  // reused `loop_registry` that collides on `cron`, which starts after the three
  // module loops) would leave the earlier loops running — and `boot()`'s
  // init-failure cleanup can't stop them because `graph` isn't assigned until
  // this function RETURNS. So OWN the lifecycle here: wrap compose() + cron
  // start + all post-compose wiring in one try/catch and, on ANY throw,
  // `graph.shutdown()` (stops every started module loop in reverse-init order)
  // BEFORE rethrowing. No leaked timer regardless of which loop collides.
  let composedHttp: ComposedHttpHandler | null
  try {
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
  // §F2 — cron is the last loop the GRAPH starts (its jobs are registered by the
  // modules that own them during compose(), and `start()` binds their timers).
  // REGISTER BEFORE START (failure-atomic; see build-core-modules) so a reused
  // registry collision throws before the scheduler arms its timers. The ONE boot
  // line is emitted by the boot shell (`gateway/index.ts`) AFTER the
  // gateway-liveness loop — the LAST loop of all — has also started, so the
  // single inventory line names the truly-complete set (composer loops + graph
  // loops + gateway liveness). A direct composeProductionGraph caller that never
  // reaches the boot shell (tests) reads the set off `graph.loopRegistry`.
  loopRegistry.register(cron.scheduler.describe())
  cron.scheduler.start()

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
  // above, so a failure here would leak the started graph — now covered by the
  // single whole-composition try/catch (§F2) that wraps compose() through here.
  composedHttp = await buildComposedHttpFromComposition(input)
  } catch (err) {
    // §F2 — ANY failure after `graph.register(...)` (a module-init loop-register
    // collision during compose(), the cron register/start, Cores/connect wiring,
    // or the HTTP composition) tears down every started module loop before
    // rethrowing, so no timer leaks regardless of which loop or step failed.
    try {
      await graph.shutdown()
    } catch (shutdownErr) {
      moduleLog.error('graph_shutdown_after_composition_failure_threw', {
        error: shutdownErr instanceof Error ? (shutdownErr.stack ?? shutdownErr.message) : String(shutdownErr),
      })
    }
    throw err
  }

  const composedGraph = graph as ComposedProductionGraph
  if (composedHttp !== null) {
    composedGraph.fetch = composedHttp.fetch
    composedGraph.websocket = composedHttp.websocket
  }
  composedGraph.composition = input
  composedGraph.loopRegistry = loopRegistry
  return composedGraph
}
