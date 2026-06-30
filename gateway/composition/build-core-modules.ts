/**
 * Core module-graph builders for the production composition.
 *
 * Extracted from `composeProductionGraph` (R5 / audit P2-5) — this file
 * owns the construction of every `GatewayModule` object the production
 * graph registers. `buildCoreModules(input)` returns the module objects;
 * the caller (`composeProductionGraph`) keeps ownership of the
 * registration ORDER and the post-`graph.compose()` wiring, both of which
 * are load-bearing. Behaviour is byte-identical to the inline definitions.
 */

import { ChannelRouter } from '../../channels/router.ts'
import { CronHandlerRegistry } from '../../cron/handlers.ts'
import { CronJobRegistry } from '../../cron/jobs.ts'
import { CronScheduler } from '../../cron/scheduler.ts'
import { CronStateStore } from '../../cron/state.ts'
import { McpServer } from '../../mcp/server.ts'
import {
  setReplToolBridge,
  clearReplToolBridgeIf,
} from '../../runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import { registerNeutronToolsSurface } from '../../mcp/surfaces/neutron-tools.ts'
import { registerDocSearchToolSurface } from '../../doc-search/tool.ts'
import { registerGBrainSearchToolSurface } from '../../gbrain-memory/agent-tool.ts'
import { registerWorkBoardToolSurface } from '../../work-board/agent-tool.ts'
import { registerCreateProjectToolSurface } from '../realmode-composer/create-project-tool.ts'
import { registerMessageSearchToolSurface } from '../../message-search/tool.ts'
import { registerDispatchToolSurface } from '../../agent-dispatch/tool.ts'
import { registerSkillForgeToolSurface } from '../../skill-forge/tool.ts'
import { installBundledCores } from '../cores/install-bundled.ts'
import type { CoresModuleState } from '../cores/composer-state.ts'
import {
  OnboardingTelemetry,
  buildProductionOnboardingTelemetry,
  buildSeanEllisHandler,
  composeOnboardingTelemetrySinks,
  registerSeanEllisCron,
  type ComposedTelemetrySinks,
} from '../../onboarding/telemetry/index.ts'
import {
  buildOnboardingResumeHandler,
  registerOnboardingResumeCron,
} from '../../onboarding/interview/resume-cron.ts'
import {
  buildImportRunningHandler,
  registerImportRunningCron,
} from '../../onboarding/interview/import-running-cron.ts'
import {
  buildOvernightEngineHandler,
  registerOvernightHandler,
} from '../../onboarding/overnight/register.ts'
import type { PlatformAdapter } from '../../runtime/platform-adapter.ts'
import { ReminderStore } from '../../reminders/store.ts'
import { ReminderTickLoop } from '../../reminders/tick.ts'
import { TridentRunStore } from '../../trident/store.ts'
import { TridentTickLoop, type TridentTerminalHook } from '../../trident/tick.ts'
import { stubAdvanceDeps } from '../../trident/state-machine.ts'
import { buildTridentOrchestrator } from '../../trident/orchestrator.ts'
import { buildWorkflowFirer } from '../../trident/inner-loop.ts'
import { buildTridentDelivery } from '../../trident/delivery.ts'
import { withTerminalObserver } from '../../trident/terminal-observer.ts'
import { spawnCapture } from '../../trident/git-mode.ts'
import { TaskStore } from '../../tasks/store.ts'
import {
  buildFocusScoreRecomputeHandler,
  registerFocusScoreRecomputeCron,
} from '../../tasks/focus-score-cron.ts'
import {
  buildTaskPrioritizeHandler,
  registerTaskPrioritizeCron,
} from '../../tasks/prioritize-llm.ts'
import {
  buildNudgeEngineHandler,
  registerNudgeEngineCron,
} from '../tasks/p6/nudge-engine.ts'
import { ProactiveStateStore } from '../proactive/state-store.ts'
import {
  buildIdleNudgeSweepHandler,
  buildMorningBriefHandler,
  registerIdleNudgeSweepCron,
  registerMorningBriefCron,
} from '../proactive/cron.ts'
import type {
  IdleNudgeSweepDeps,
  ProactiveTopicCandidate,
} from '../proactive/idle-nudge-sweep.ts'
import type {
  BriefFocusItem,
  MorningBriefDeps,
  ProactiveContextSources,
} from '../proactive/morning-brief.ts'
import { attachReminderLinkSubscriber } from '../../tasks/reminder-link.ts'
import {
  buildProjectionWriter,
  type ProjectionWriter,
} from '../../tasks/projection/index.ts'
import {
  attachOvernightWorkCompletedHook,
  type OvernightWorkCompletedEvent,
} from '../../tasks/overnight-task-hook.ts'
import type { Task } from '../../tasks/store.ts'
import { ApprovalManager } from '../../tools/approval.ts'
import { ProcessRegistry } from '../../tools/process-registry.ts'
import { ToolRegistry } from '../../tools/registry.ts'
import { AlertStore } from '../../watchdog/alert-store.ts'
import {
  CrashedAgentDetector,
  HeartbeatDetector,
  StuckAgentDetector,
} from '../../watchdog/detectors.ts'
import { WatchdogSupervisor } from '../../watchdog/supervisor.ts'
import { type GatewayModule } from '../module-graph.ts'
import type { CompositionInput } from './input/composition-input.ts'

/**
 * Module objects produced by `buildCoreModules`. The caller registers
 * these in a fixed order (load-bearing) and then calls `graph.compose()`.
 */
export interface CoreModules {
  toolsModule: GatewayModule<ToolRegistry>
  processRegistryModule: GatewayModule<ProcessRegistry>
  approvalModule: GatewayModule<ApprovalManager>
  channelsModule: GatewayModule<ChannelRouter>
  mcpModule: GatewayModule<McpServer>
  replToolBridgeModule: GatewayModule<{ wired: boolean }>
  remindersModule: GatewayModule<{ store: ReminderStore; loop: ReminderTickLoop }>
  tridentModule: GatewayModule<{ store: TridentRunStore; loop: TridentTickLoop }>
  cronModule: GatewayModule<{
    jobs: CronJobRegistry
    handlers: CronHandlerRegistry
    state: CronStateStore
    scheduler: CronScheduler
  }>
  watchdogModule: GatewayModule<{ store: AlertStore; supervisor: WatchdogSupervisor }>
  onboardingTelemetryModule: GatewayModule<{
    telemetry: OnboardingTelemetry
    composed: ComposedTelemetrySinks
  }>
  platformModule: GatewayModule<PlatformAdapter>
  tasksModule: GatewayModule<{
    store: TaskStore
    projection: ProjectionWriter | null
    overnightHook: (event: OvernightWorkCompletedEvent) => Promise<Task>
  }>
  coresModule: GatewayModule<CoresModuleState> | null
}

export function buildCoreModules(input: CompositionInput): CoreModules {
  const toolsModule: GatewayModule<ToolRegistry> = {
    name: 'tools',
    init: () => {
      const reg = new ToolRegistry()
      registerNeutronToolsSurface(reg)
      // Doc-search (QMD-equivalent) — register the `doc_search` +
      // `doc_read` agent tools when the composer wired a runtime, so the
      // live agent can search the owner's project docs mid-conversation.
      if (input.doc_search !== undefined) {
        registerDocSearchToolSurface(reg, input.doc_search.runtime)
      }
      // Message-search (chat-history twin) — register the `message_search`
      // agent tool when the composer wired a runtime, so the live agent can
      // full-text-search the conversation mid-turn.
      if (input.message_search !== undefined) {
        registerMessageSearchToolSurface(reg, input.message_search.runtime)
      }
      // Memory recall (P0-2) — register the `gbrain_search` agent tool when the
      // composer wired the owner's GBrainMemoryStore, so the live agent can
      // READ BACK the entity pages + scribe facts the WRITE path persists every
      // turn. The agent-native twin of Vajra's `mcp__qmd__query` recall; rides
      // the #87 tools-bridge as `mcp__neutron__gbrain_search`.
      if (input.gbrain_search !== undefined) {
        registerGBrainSearchToolSurface(reg, input.gbrain_search.store)
      }
      // Agent-dispatch family (parity gap #3) — register `dispatch_agent` when
      // the composer wired the service, so the live agent can dispatch a
      // named/ad-hoc background specialist that shares the SubagentRegistry +
      // watchdog with the Trident loop and reports its result back to chat.
      if (input.agent_dispatch !== undefined) {
        registerDispatchToolSurface(reg, input.agent_dispatch.service)
      }
      // Skill-forge (parity gap #5) — register `skill_forge_list` +
      // `skill_forge_decide` when the composer wired the backend, so the live
      // agent can list / approve / decline Skill Forge proposals (agent-native
      // parity with the `/skills` chat command, which shares the SAME backend).
      if (input.skill_forge !== undefined) {
        registerSkillForgeToolSurface(reg, input.skill_forge.backend)
      }
      // Work Board (Phase 1a) — register the `work_board_*` tools when the
      // composer wired the shared store, so the orchestrator can read+write its
      // own external-memory board mid-turn. Same store instance the HTTP
      // surface + per-turn injection use (one code path, one live-push). Rides
      // the #87 tools-bridge as `mcp__neutron__work_board_*`.
      if (input.work_board !== undefined) {
        registerWorkBoardToolSurface(reg, input.work_board.store)
      }
      // Create-project (project-rail Create Project parity) — register the
      // `create_project` agent tool when the composer wired the service, so the
      // live agent can create a project mid-turn. Same owner-scoped create path
      // the HTTP surface uses (one code path). Rides the #87 tools-bridge as
      // `mcp__neutron__create_project`.
      if (input.create_project !== undefined) {
        registerCreateProjectToolSurface(reg, input.create_project.service)
      }
      return reg
    },
  }

  const processRegistryModule: GatewayModule<ProcessRegistry> = {
    name: 'process-registry',
    init: () => new ProcessRegistry(),
  }

  const approvalModule: GatewayModule<ApprovalManager> = {
    name: 'approval',
    deps: ['tools'],
    init: () => new ApprovalManager(input.db, input.approval_notifier),
  }

  const channelsModule: GatewayModule<ChannelRouter> = {
    name: 'channels',
    // Sprint 19 — reuse the caller-supplied ChannelRouter when present so
    // the production composer's pre-built router (held by the Telegram
    // webhook handler) is the same instance the graph exposes.
    init: () =>
      input.channel_router ??
      new ChannelRouter(input.db, input.project_slug, input.topic_handler),
  }

  const mcpModule: GatewayModule<McpServer> = {
    name: 'mcp',
    deps: ['tools'],
    init: (ctx) => {
      const tools = ctx.graph.get<ToolRegistry>('tools')
      return new McpServer({ project_slug: input.project_slug, registry: tools })
    },
  }

  // P0-1 — native-MCP tool bridge wiring. The persistent REPL substrate is built
  // in the composer BEFORE this graph composes, so it reaches the in-process
  // registry through a late-bound module singleton. Here — once `mcp` exists and
  // every Core / doc-search / etc. has registered into the shared registry — we
  // point that singleton at the graph's `McpServer` (which structurally satisfies
  // `ReplToolBridge`: it has `listToolSchemas` + `dispatch`). Shutdown clears it
  // so a torn-down instance can't dispatch tool calls against a dead registry.
  let wiredBridgeServer: McpServer | undefined
  const replToolBridgeModule: GatewayModule<{ wired: boolean }> = {
    name: 'repl-tool-bridge',
    deps: ['mcp'],
    init: (ctx) => {
      wiredBridgeServer = ctx.graph.get<McpServer>('mcp')
      setReplToolBridge(wiredBridgeServer)
      return { wired: true }
    },
    shutdown: () => {
      // Identity-guarded so a second graph in the same process (tests) can't
      // null out the live graph's bridge on an older graph's teardown.
      if (wiredBridgeServer !== undefined) clearReplToolBridgeIf(wiredBridgeServer)
    },
  }

  const remindersModule: GatewayModule<{ store: ReminderStore; loop: ReminderTickLoop }> = {
    name: 'reminders',
    init: () => {
      const store = new ReminderStore(input.db)
      // P5.6 — when a push dispatcher is wired, attach it as the
      // tick loop's `on_fired` hook so every fired reminder also
      // emits a native push to every registered Expo device for the
      // instance. The hook is failure-safe inside the tick loop, so a
      // push outage cannot stop reminders from being marked fired.
      const loopOpts: ConstructorParameters<typeof ReminderTickLoop>[0] = {
        store,
        dispatcher: input.reminder_dispatcher,
      }
      if (input.push_dispatcher !== undefined) {
        loopOpts.on_fired = input.push_dispatcher
      }
      const loop = new ReminderTickLoop(loopOpts)
      loop.start()
      return { store, loop }
    },
    shutdown: (instance) => {
      instance.loop.stop()
    },
  }

  // Trident — the autonomous Forge→Argus→merge state machine (foundational
  // runtime, ported from Vajra's /trident skill). The tick loop sweeps
  // every non-terminal `code_trident_runs` row each interval and advances
  // it via the state machine, exactly as the reminders loop sweeps due
  // reminders.
  //
  // Trident v2 (Work Board Phase 2a exec-model): the INNER Forge→Argus→fix loop
  // is one native CC Dynamic Workflow (`trident/inner-workflow.mjs`). When the
  // composer threads `input.trident.fire_inner_workflow` (the warm-substrate FIRE
  // seam), the module builds the real `step` here — `buildWorkflowFirer` (fires
  // the workflow + settles the launching turn) + `buildTridentOrchestrator`
  // (harvests the typed result from `code_trident_runs.inner_result` by runId,
  // server-gates the verdict, merges on APPROVE). `/code <task>` (and governed
  // Ralph runs) create `code_trident_runs` rows that THIS loop drives end-to-end.
  //
  // When no dispatch is threaded (Open dev / default), the module falls
  // back to `stubAdvanceDeps` (classify always "running") so the loop is
  // live + restart-safe but advances nothing — unchanged Open behaviour.
  // Started here, stopped on shutdown.
  const tridentWiring = input.trident
  const tridentModule: GatewayModule<{ store: TridentRunStore; loop: TridentTickLoop }> = {
    name: 'trident',
    // Depend on `channels` so the SAME `ChannelRouter` instance the gateway
    // routes inbound events through is the one Trident delivers terminal
    // results back through (gap-audit P0-1). The dep also fixes init order:
    // the router is constructed before this module reads it.
    deps: ['channels'],
    init: (ctx) => {
      const store = new TridentRunStore(input.db)
      // Async result delivery (gap-audit P0-1) — post each run's terminal
      // result (done / failed) back to its originating chat topic via the
      // run's persisted chat_id/thread_id. Generic: ANY background-agent
      // run that lands terminal with a chat_id delivers through this seam,
      // not just `/code`. Runs with no originating chat no-op inside the
      // hook. Failure-safe: the tick loop wraps `onTerminal` in its own
      // try/catch so a posting outage never un-terminates a finished build.
      const router = ctx.graph.get<ChannelRouter>('channels')
      const delivery = buildTridentDelivery({ sink: router })
      // Skill-forge trigger (parity gap #5) — when the composer wired an
      // `on_run_terminal` observer, run it on every terminal run, ISOLATED
      // from delivery (`withTerminalObserver`): a delivery outage must not skip
      // the auto-skillify audit, since the run is already terminal and the loop
      // won't re-fire the hook. Observer errors are logged, never propagated;
      // a delivery error is still re-thrown so the loop's try/catch logs it.
      const runTerminalObserver = tridentWiring?.on_run_terminal
      const on_terminal: TridentTerminalHook =
        runTerminalObserver === undefined
          ? delivery
          : withTerminalObserver(delivery, runTerminalObserver)
      let loop: TridentTickLoop
      if (tridentWiring !== undefined) {
        // Trident v2 (Work Board Phase 2a exec-model) — the inner Forge→Argus→fix
        // loop is one native CC Dynamic Workflow. The FIRER (`fire_inner_workflow`)
        // invokes the `Workflow` tool on a WARM substrate and SETTLES the
        // launching turn immediately (billing-exempt — no `claude -p`); the
        // workflow runs detached and persists its TYPED result to
        // `code_trident_runs.inner_result`. The orchestrator step fires it per
        // run, then HARVESTS that typed result from the DB by runId (deterministic
        // TS), server-gates the verdict, and merges on APPROVE.
        const fire_workflow = buildWorkflowFirer({ fire: tridentWiring.fire_inner_workflow })
        const orchestratorOpts: Parameters<typeof buildTridentOrchestrator>[0] = {
          fire_workflow,
          db_path: input.db.path,
          run_host: tridentWiring.run_host ?? spawnCapture,
        }
        if (tridentWiring.on_orphaned_session !== undefined) {
          orchestratorOpts.on_orphaned_session = tridentWiring.on_orphaned_session
        }
        const { step } = buildTridentOrchestrator(orchestratorOpts)
        loop = new TridentTickLoop({ store, step, on_terminal })
      } else {
        loop = new TridentTickLoop({ store, deps: stubAdvanceDeps(), on_terminal })
      }
      loop.start()
      return { store, loop }
    },
    shutdown: (instance) => {
      instance.loop.stop()
    },
  }

  const cronModule: GatewayModule<{
    jobs: CronJobRegistry
    handlers: CronHandlerRegistry
    state: CronStateStore
    scheduler: CronScheduler
  }> = {
    name: 'cron',
    init: () => {
      // T2 r3 (2026-05-13) — Argus BLOCKING #1: reuse the caller-supplied
      // CronJobRegistry when present so the realmode-composer's
      // wow-dispatcher and THIS scheduler read from one shared instance.
      // See CompositionInput.cron_jobs docblock for the full incident.
      const jobs = input.cron_jobs ?? new CronJobRegistry()
      const handlers = new CronHandlerRegistry()
      const state = new CronStateStore(input.db)
      const scheduler = new CronScheduler({
        jobs,
        handlers,
        db: input.db,
        project_slug: input.project_slug,
      })
      // P1 S4 doesn't auto-start jobs — handlers are wired by the modules
      // that own each job (vault-backup, focus_score_recompute, …) BEFORE scheduler.start.
      // The boot shell triggers start() after all modules register handlers.
      return { jobs, handlers, state, scheduler }
    },
    shutdown: (instance) => {
      instance.scheduler.stop()
    },
  }

  const watchdogModule: GatewayModule<{
    store: AlertStore
    supervisor: WatchdogSupervisor
  }> = {
    name: 'watchdog',
    deps: ['process-registry', 'cron'],
    init: (ctx) => {
      const store = new AlertStore(input.db)
      const supervisor = new WatchdogSupervisor({ store, notifier: input.watchdog_notifier })
      const processRegistry = ctx.graph.get<ProcessRegistry>('process-registry')
      const cron = ctx.graph.get<{ jobs: CronJobRegistry; state: CronStateStore }>('cron')
      supervisor.registerDetector(
        new HeartbeatDetector({
          project_slug: input.project_slug,
          tracker: input.heartbeat_tracker,
        }),
      )
      supervisor.registerDetector(
        new StuckAgentDetector({
          project_slug: input.project_slug,
          process_registry: processRegistry,
        }),
      )
      const crashedOpts: ConstructorParameters<typeof CrashedAgentDetector>[0] = {
        project_slug: input.project_slug,
        process_registry: processRegistry,
      }
      if (input.pid_probe !== undefined) crashedOpts.pid_probe = input.pid_probe
      supervisor.registerDetector(new CrashedAgentDetector(crashedOpts))
      // overrun_cron, db_lock_contention, substrate_cooldown_saturation
      // detectors are registered by the modules that own those state
      // sources (substrate dispatcher, persistence layer) — wired in
      // sprints S5/S6 when those modules expose hooks. P1 S4 ships the
      // first three; the remaining three classes ARE testable in isolation
      // (see tests/integration/watchdog-six-modes.test.ts) but the live
      // production wire-up is incremental.
      supervisor.start()
      return { store, supervisor }
    },
    shutdown: (instance) => {
      instance.supervisor.stop()
    },
  }

  // Onboarding telemetry — composes OnboardingTelemetry + the typed
  // sinks (signup / interview / archetype / import / persona /
  // profile_pic / completion + a wow eventLogger factory). Production
  // wires the Sean Ellis cron via the optional
  // `input.onboarding_telemetry.sean_ellis` config; when omitted the
  // module still exposes `composed` sinks so other modules can consume
  // them. Per docs/plans/P2-onboarding.md § 5 + § 9.5 + Codex r3 P1
  // follow-up (2026-05-03).
  const onboardingTelemetryModule: GatewayModule<{
    telemetry: OnboardingTelemetry
    composed: ComposedTelemetrySinks
  }> = {
    name: 'onboarding-telemetry',
    deps: ['cron'],
    init: (ctx) => {
      // P2-v2 S22 — when the realmode composer pre-built the telemetry
      // (so it could wire the `importOnSonnetFallback` callback into
      // `buildLandingStack`), reuse that instance. Otherwise build a
      // fresh one via the SAME helper the composer uses — `buildProductionOnboardingTelemetry`
      // owns the `resolveAttemptId` transaction logic (mint-on-miss for
      // `onboarding_state.attempt_id` so pre-engine signup events share
      // the attempt bucket with later interview events; routes the
      // SELECT/INSERT/SELECT through `input.db.transaction(...)` so the
      // resolver doesn't race the engine's own upserts via `raw()`).
      const preBuiltTelemetry = input.onboarding_telemetry?.instance
      const telemetry =
        preBuiltTelemetry ??
        buildProductionOnboardingTelemetry({
          db: input.db,
          ...(input.onboarding_telemetry?.eventLogger !== undefined
            ? { eventLogger: input.onboarding_telemetry.eventLogger }
            : {}),
        })
      const composed = composeOnboardingTelemetrySinks(telemetry)

      const seanCfg = input.onboarding_telemetry?.sean_ellis
      if (seanCfg !== undefined) {
        const cron = ctx.graph.get<{
          jobs: CronJobRegistry
          handlers: CronHandlerRegistry
        }>('cron')
        const handlerDeps: Parameters<typeof buildSeanEllisHandler>[0] = {
          db: input.db,
          telemetry,
          channel: seanCfg.channel,
          resolveContext: seanCfg.resolveContext,
        }
        const handler = buildSeanEllisHandler(handlerDeps)
        const registerInput: Parameters<typeof registerSeanEllisCron>[0] = {
          project_slug: input.project_slug,
          jobs: cron.jobs,
          handlers: cron.handlers,
          handler,
        }
        if (seanCfg.interval_ms !== undefined) registerInput.interval_ms = seanCfg.interval_ms
        registerSeanEllisCron(registerInput)
      }

      // Trident 6 (2026-05-13) — resume-on-reconnect cron. Independent
      // of the Sean Ellis cron; gated on `onboarding_resume_cron` being
      // supplied so legacy callers and tests that don't construct the
      // engine here stay unaffected.
      const resumeCfg = input.onboarding_resume_cron
      if (resumeCfg !== undefined) {
        const cron = ctx.graph.get<{
          jobs: CronJobRegistry
          handlers: CronHandlerRegistry
        }>('cron')
        const handlerDeps: Parameters<typeof buildOnboardingResumeHandler>[0] = {
          engine: resumeCfg.engine,
          db: input.db,
        }
        if (resumeCfg.resume_gap_ms !== undefined) {
          handlerDeps.resume_gap_ms = resumeCfg.resume_gap_ms
        }
        if (resumeCfg.canDeliver !== undefined) {
          handlerDeps.canDeliver = resumeCfg.canDeliver
        }
        const handler = buildOnboardingResumeHandler(handlerDeps)
        const registerInput: Parameters<typeof registerOnboardingResumeCron>[0] = {
          project_slug: input.project_slug,
          jobs: cron.jobs,
          handlers: cron.handlers,
          handler,
        }
        if (resumeCfg.interval_ms !== undefined) {
          registerInput.interval_ms = resumeCfg.interval_ms
        }
        registerOnboardingResumeCron(registerInput)
      }

      // S12 (2026-05-16) — import-running cron-tick. Independent of the
      // resume cron; gated on `onboarding_import_running_cron` being
      // supplied so legacy callers and tests that don't construct the
      // engine here stay unaffected. The cron drives
      // `engine.pollImportRunningTick(...)` every 15s so the runner's
      // terminal status (completed / failed / cancelled / hard-timeout)
      // gets detected without requiring a user inbound.
      const importRunningCfg = input.onboarding_import_running_cron
      if (importRunningCfg !== undefined) {
        const cron = ctx.graph.get<{
          jobs: CronJobRegistry
          handlers: CronHandlerRegistry
        }>('cron')
        const handler = buildImportRunningHandler({
          engine: importRunningCfg.engine,
          db: input.db,
        })
        const registerInput: Parameters<typeof registerImportRunningCron>[0] = {
          project_slug: input.project_slug,
          jobs: cron.jobs,
          handlers: cron.handlers,
          handler,
        }
        if (importRunningCfg.interval_ms !== undefined) {
          registerInput.interval_ms = importRunningCfg.interval_ms
        }
        registerImportRunningCron(registerInput)
      }

      // 2026-06-19 (overnight-engine) — register the REAL Autonomous
      // Overnight-Work engine handler `overnight_handler` UNCONDITIONALLY.
      // (2026-06-22: the preview-only morning check-in stub
      // `wow_overnight_handler` it superseded was removed.) The JOB
      // (`overnight-<slug>`) is registered dynamically by wow-moment action
      // 07 at dispatch time — the handler just has to exist by the time the
      // scheduler ticks it. Each ~30-min tick: scan (in 23:00–07:00 window)
      // → advance in-flight Trident runs → reporter (≥06:50). Each queued
      // item runs AS a Trident run (`code_trident_runs`); the morning brief
      // reports the REAL result. The optional `onboarding_overnight_cron.deliver`
      // seam supplies the delivery surface; absent → the reporter records 'skipped'.
      {
        const cron = ctx.graph.get<{
          jobs: CronJobRegistry
          handlers: CronHandlerRegistry
        }>('cron')
        const overnightCfg = input.onboarding_overnight_cron
        const handler = buildOvernightEngineHandler({
          db: input.db,
          ...(overnightCfg?.deliver !== undefined ? { deliver: overnightCfg.deliver } : {}),
        })
        registerOvernightHandler({ handlers: cron.handlers, handler })
      }
      return { telemetry, composed }
    },
  }

  // Sprint B (2026-05-17) — PlatformAdapter module. Exposes the
  // injected platform adapter via the module graph so downstream
  // modules (interview engine, slug-picker hook, install-token routes
  // in Sprint C) can resolve it via `graph.get<PlatformAdapter>('platform')`
  // without taking a direct import on Managed-classified primitives.
  // Sprint B (2026-05-20) — REQUIRED. The pre-Sprint-B optional shape
  // was dropped so a caller cannot silently bypass the seam; tests
  // wire a synthetic `buildLocalPlatformAdapter({ selfOwner: stub })`
  // in three lines.
  const platformAdapter = input.platform
  const platformModule: GatewayModule<PlatformAdapter> = {
    name: 'platform',
    init: () => platformAdapter,
  }

  // P3 cores wire-up — the `cores` module builds the bundled-Cores
  // registry, drives each Core's idempotent install lifecycle, and
  // registers each Core's `buildTools(deps)` output against the
  // production `ToolRegistry`. The module depends on `tools` so the
  // registry is populated by the time `mcp`'s dispatcher resolves
  // tool names. Only constructed when `input.cores` is supplied;
  // legacy callers compose unchanged.
  let coresModule: GatewayModule<CoresModuleState> | null = null
  if (input.cores !== undefined) {
    const coresCfg = input.cores
    coresModule = {
      name: 'cores',
      deps: ['tools'],
      init: async (ctx) => {
        const tools = ctx.graph.get<ToolRegistry>('tools')
        // Sprint B (2026-05-20) — resolve rootDirs: explicit override >
        // platform adapter (REQUIRED). The previous `process.cwd()`
        // fallback was dropped along with the optional `platform?:`
        // field; callers always have a wired adapter now.
        const rootDirs: readonly string[] =
          coresCfg.rootDirs !== undefined && coresCfg.rootDirs.length > 0
            ? coresCfg.rootDirs
            : input.platform.getBundledCoreRoots()
        const installArgs: Parameters<typeof installBundledCores>[0] = {
          project_slug: input.project_slug,
          projectDb: input.db,
          dataDir: coresCfg.dataDir,
          tools,
          secretsStore: coresCfg.secretsStore,
          rootDirs,
        }
        if (coresCfg.backends !== undefined) installArgs.backends = coresCfg.backends
        if (coresCfg.prompter !== undefined) installArgs.prompter = coresCfg.prompter
        if (coresCfg.log !== undefined) installArgs.log = coresCfg.log
        if (coresCfg.hardFailFailureRatio !== undefined) {
          installArgs.hardFailFailureRatio = coresCfg.hardFailFailureRatio
        }
        const result = await installBundledCores(installArgs)
        console.log(
          `[cores] project=${input.project_slug} discovered=${result.discovered} installed=${result.installed.size} failed=${result.failures.length}`,
        )
        return {
          registry: result.registry,
          installed: result.installed,
          failures: result.failures,
          launcherIcons: result.launcherIcons,
        }
      },
    }
  }

  // P6 — canonical TaskStore module. Composes after `cron` + `reminders`
  // so the wired subscribers (focus-score cron, reminder-link,
  // projection writer, overnight-task hook) can resolve their deps.
  // The store + writer instances are exposed via `graph.get('tasks')`
  // so HTTP surfaces (P5.4 / P5.5) and the wow-moment Action 4 can
  // grab the same instance.
  const tasksModule: GatewayModule<{
    store: TaskStore
    projection: ProjectionWriter | null
    overnightHook: (event: OvernightWorkCompletedEvent) => Promise<Task>
  }> = {
    name: 'tasks',
    deps: ['cron', 'reminders', 'channels'],
    init: (ctx) => {
      const tasksCfg = input.tasks ?? {}
      // Use the composer-supplied canonical store when present so HTTP
      // surfaces + the Tasks-Core adapter share the same instance and
      // subscribers fire on every write. Fall back to a fresh store
      // for tests / bespoke composers that don't need cross-surface
      // mutation visibility.
      //
      // GUARDRAIL: if the caller enabled ANY subscriber-dependent
      // feature (projection writer, reminder-link, focus-score cron)
      // without supplying `tasksCfg.store`, the fallback store is a
      // dead-end — HTTP surfaces + the Tasks-Core adapter would each
      // build their own `new TaskStore(db)` and bypass the wiring
      // entirely. That's the exact incident behind Argus r2 BLOCKING
      // #2 (PR #221) where projection silently never fired in prod.
      // Warn loudly so a future composer regression surfaces at boot
      // instead of as a quiet user-visible drift.
      const featuresEnabled =
        tasksCfg.enable_focus_score_cron === true ||
        tasksCfg.enable_reminder_link === true ||
        tasksCfg.projection !== undefined
      if (featuresEnabled && tasksCfg.store === undefined) {
        console.warn(
          `[tasks-composer] project=${input.project_slug} WARNING: ` +
            `subscriber feature(s) enabled (focus_score_cron=` +
            `${tasksCfg.enable_focus_score_cron === true} ` +
            `reminder_link=${tasksCfg.enable_reminder_link === true} ` +
            `projection=${tasksCfg.projection !== undefined}) but ` +
            `tasksCfg.store is undefined. The fallback store will not ` +
            `be shared with HTTP surfaces / Tasks-Core, so writes ` +
            `through those surfaces will NOT fire subscribers. ` +
            `Thread a canonical TaskStore via composition.tasks.store ` +
            `+ buildCoresBackendFactories({ canonicalTaskStore }) — ` +
            `see Argus r2 BLOCKING #2 (PR #221, 2026-05-20).`,
        )
      }
      const store = tasksCfg.store ?? new TaskStore(input.db)
      const remindersDeps = ctx.graph.get<{ store: ReminderStore }>('reminders')
      const cronDeps = ctx.graph.get<{
        jobs: CronJobRegistry
        handlers: CronHandlerRegistry
      }>('cron')

      if (tasksCfg.enable_reminder_link === true) {
        attachReminderLinkSubscriber({
          store,
          ctx: {
            projectDb: input.db,
            remindersStore: remindersDeps.store,
          },
        })
      }

      if (tasksCfg.enable_focus_score_cron === true) {
        const handlerDeps: Parameters<typeof buildFocusScoreRecomputeHandler>[0] =
          { db: input.db }
        const handler = buildFocusScoreRecomputeHandler(handlerDeps)
        const registerInput: Parameters<typeof registerFocusScoreRecomputeCron>[0] = {
          project_slug: input.project_slug,
          jobs: cronDeps.jobs,
          handlers: cronDeps.handlers,
          handler,
        }
        if (tasksCfg.focus_score_interval_ms !== undefined) {
          registerInput.interval_ms = tasksCfg.focus_score_interval_ms
        }
        registerFocusScoreRecomputeCron(registerInput)
      }

      // WAVE 3 PR-7 — LLM-primary prioritization cron. Each tick ranks
      // the open backlog via the LLM (deterministic focus-score order is
      // the fallback when no credential is wired / the call errors) and
      // stamps `llm_rank` / `llm_reason` / `prioritized_by`; the
      // `focus_score` order then renders LLM-rank-first across every
      // surface. Safe to register with a null llm — the handler runs the
      // deterministic fallback until a credential becomes available.
      if (tasksCfg.enable_task_prioritize_cron === true) {
        const prioritizer = tasksCfg.task_prioritizer ?? { llm: null }
        const prioritizeHandlerDeps: Parameters<typeof buildTaskPrioritizeHandler>[0] =
          { db: input.db, llm: prioritizer.llm }
        if (prioritizer.model !== undefined) {
          prioritizeHandlerDeps.model = prioritizer.model
        }
        if (prioritizer.timeout_ms !== undefined) {
          prioritizeHandlerDeps.timeout_ms = prioritizer.timeout_ms
        }
        if (prioritizer.limit !== undefined) {
          prioritizeHandlerDeps.limit = prioritizer.limit
        }
        const prioritizeHandler = buildTaskPrioritizeHandler(prioritizeHandlerDeps)
        const prioritizeRegisterInput: Parameters<typeof registerTaskPrioritizeCron>[0] = {
          project_slug: input.project_slug,
          jobs: cronDeps.jobs,
          handlers: cronDeps.handlers,
          handler: prioritizeHandler,
        }
        if (tasksCfg.task_prioritize_interval_ms !== undefined) {
          prioritizeRegisterInput.interval_ms = tasksCfg.task_prioritize_interval_ms
        }
        registerTaskPrioritizeCron(prioritizeRegisterInput)
      }

      // P6.1 — daily nudge engine cron. Runs the staleness pass + LLM
      // "do this next" pick once per day per instance. The handler is a
      // safe no-op when `nudge_engine.llm` is null (no Anthropic
      // credential) — we still register the cron so a credential
      // becoming available later resumes the engine without a boot.
      if (tasksCfg.enable_nudge_engine_cron === true) {
        const ne = tasksCfg.nudge_engine ?? { llm: null }
        const nudgeHandlerDeps: Parameters<typeof buildNudgeEngineHandler>[0] = {
          db: input.db,
          llm: ne.llm,
        }
        if (ne.personaLoader !== undefined) {
          nudgeHandlerDeps.personaLoader = ne.personaLoader
        }
        if (ne.timezone !== undefined) nudgeHandlerDeps.timezone = ne.timezone
        if (ne.timeout_ms !== undefined) {
          nudgeHandlerDeps.timeout_ms = ne.timeout_ms
        }
        if (ne.model !== undefined) nudgeHandlerDeps.model = ne.model
        const nudgeHandler = buildNudgeEngineHandler(nudgeHandlerDeps)
        const nudgeRegisterInput: Parameters<typeof registerNudgeEngineCron>[0] = {
          project_slug: input.project_slug,
          jobs: cronDeps.jobs,
          handlers: cronDeps.handlers,
          handler: nudgeHandler,
        }
        if (tasksCfg.nudge_engine_interval_ms !== undefined) {
          nudgeRegisterInput.interval_ms = tasksCfg.nudge_engine_interval_ms
        }
        registerNudgeEngineCron(nudgeRegisterInput)
      }

      // P0-5 — proactive messaging (gap-audit WAVE 2 Track A). The daily
      // morning brief + the idle-topic nudge sweep, both posting through the
      // production `ChannelRouter` and reusing the shared cron registry + the
      // P6 nudge ranker. Each half is independently gated on the
      // production-specific seam it needs (a topic to post the brief to; an
      // enumeration of idle topics for the sweep). Absent → neither cron
      // registers (unchanged Open default).
      const proactiveCfg = tasksCfg.proactive
      if (proactiveCfg !== undefined) {
        const channelRouter = ctx.graph.get<ChannelRouter>('channels')
        // Override sink (Open's durable web sink) wins; else the core router
        // (Telegram instances). The router's live-only app_socket adapter would
        // drop a timer-fired web post with no open socket — hence the override.
        const proactiveSink = proactiveCfg.sink ?? channelRouter
        const proactiveStore = new ProactiveStateStore(input.db)

        // Morning brief — gated on a resolvable General topic.
        const generalTopic = proactiveCfg.resolveGeneralTopic?.() ?? null
        if (generalTopic !== null && generalTopic.length > 0) {
          // Default the focus-queue source to the canonical TaskStore (top
          // open tasks by focus score) so the brief is useful out of the box;
          // any caller-supplied source wins per-key.
          const defaultSources: ProactiveContextSources = {
            focusQueue: async (): Promise<BriefFocusItem[]> =>
              store
                .list({
                  project_slug: input.project_slug,
                  status: 'open',
                  order: 'focus_score',
                  limit: 5,
                })
                .map((t) => ({
                  title: t.title,
                  due: t.due_date !== null ? `due ${t.due_date.slice(0, 10)}` : null,
                })),
          }
          const sources: ProactiveContextSources = {
            ...defaultSources,
            ...(proactiveCfg.sources ?? {}),
          }
          const briefDeps: MorningBriefDeps = {
            store: proactiveStore,
            sources,
            sink: proactiveSink,
            general_topic_id: generalTopic,
            now: () => Date.now(),
          }
          if (proactiveCfg.timezone !== undefined) briefDeps.tz = proactiveCfg.timezone
          if (proactiveCfg.brief_hour !== undefined) briefDeps.brief_hour = proactiveCfg.brief_hour
          if (proactiveCfg.composeBrief !== undefined) {
            briefDeps.composeWithLlm = proactiveCfg.composeBrief
          }
          const briefHandler = buildMorningBriefHandler(briefDeps)
          const briefRegister: Parameters<typeof registerMorningBriefCron>[0] = {
            project_slug: input.project_slug,
            jobs: cronDeps.jobs,
            handlers: cronDeps.handlers,
            handler: briefHandler,
          }
          if (proactiveCfg.brief_interval_ms !== undefined) {
            briefRegister.interval_ms = proactiveCfg.brief_interval_ms
          }
          registerMorningBriefCron(briefRegister)
        }

        // Idle-topic nudge sweep — gated on an idle-topic enumeration.
        if (proactiveCfg.listIdleTopics !== undefined) {
          const listIdleTopics = proactiveCfg.listIdleTopics
          const sweepDeps: IdleNudgeSweepDeps = {
            db: input.db,
            store: proactiveStore,
            sink: proactiveSink,
            listTopics: (): Promise<ProactiveTopicCandidate[]> | ProactiveTopicCandidate[] =>
              listIdleTopics(),
            now: () => Date.now(),
          }
          if (proactiveCfg.timezone !== undefined) sweepDeps.tz = proactiveCfg.timezone
          if (proactiveCfg.idle_threshold_ms !== undefined) {
            sweepDeps.idle_threshold_ms = proactiveCfg.idle_threshold_ms
          }
          if (proactiveCfg.rateNudge !== undefined) {
            sweepDeps.rateNudge = proactiveCfg.rateNudge
          }
          const sweepHandler = buildIdleNudgeSweepHandler(sweepDeps)
          const sweepRegister: Parameters<typeof registerIdleNudgeSweepCron>[0] = {
            project_slug: input.project_slug,
            jobs: cronDeps.jobs,
            handlers: cronDeps.handlers,
            handler: sweepHandler,
          }
          if (proactiveCfg.sweep_interval_ms !== undefined) {
            sweepRegister.interval_ms = proactiveCfg.sweep_interval_ms
          }
          registerIdleNudgeSweepCron(sweepRegister)
        }
      }

      let projection: ProjectionWriter | null = null
      if (tasksCfg.projection !== undefined) {
        const projectionOpts: Parameters<typeof buildProjectionWriter>[0] = {
          store,
          resolveProjectDir: tasksCfg.projection.resolveProjectDir,
        }
        if (tasksCfg.projection.debounce_ms !== undefined) {
          projectionOpts.debounce_ms = tasksCfg.projection.debounce_ms
        }
        projection = buildProjectionWriter(projectionOpts)
      }

      const overnightHook = attachOvernightWorkCompletedHook({ store })

      return { store, projection, overnightHook }
    },
    shutdown: async (instance) => {
      if (instance.projection !== null) {
        await instance.projection.stop()
      }
    },
  }

  return {
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
  }
}
