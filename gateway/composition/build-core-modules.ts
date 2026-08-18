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

import { ChannelRouter } from '@neutronai/channels/router.ts'
import { CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import { CronScheduler } from '@neutronai/cron/scheduler.ts'
import { CronStateStore } from '@neutronai/cron/state.ts'
import { LoopRegistry } from '@neutronai/loop'
import { McpServer } from '@neutronai/mcp/server.ts'
import {
  setReplToolBridge,
  clearReplToolBridgeIf,
  setReplTodoSync,
  clearReplTodoSyncIf,
  type ReplTodoSync,
} from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import { workBoardScopeKey } from '@neutronai/work-board/store.ts'
import {
  normalizeTodos,
  reconcileTodosIntoBoard,
} from '@neutronai/work-board/todo-reconcile.ts'
import { registerNeutronToolsSurface } from '@neutronai/mcp/surfaces/neutron-tools.ts'
import { registerDocSearchToolSurface } from '@neutronai/doc-search/tool.ts'
import { registerMemorySearchToolSurface } from '@neutronai/gbrain-memory/agent-tool.ts'
import { registerWorkBoardToolSurface } from '@neutronai/work-board/agent-tool.ts'
import { registerTridentBuildToolSurface } from '@neutronai/trident/work-board-build-tool.ts'
import { registerCodexCredentialToolSurface } from '@neutronai/trident/codex-credential-tool.ts'
import { registerCreateProjectToolSurface } from '../wiring/create-project-tool.ts'
import { registerHostDeployToolSurface } from '../wiring/host-deploy-tool.ts'
import { registerMessageSearchToolSurface } from '@neutronai/message-search/tool.ts'
import { registerDispatchToolSurface } from '@neutronai/agent-dispatch/tool.ts'
import { registerSkillForgeToolSurface } from '@neutronai/skill-forge/tool.ts'
import { installBundledCores } from '../cores/install-bundled.ts'
import { runWithActiveProject } from '../cores/active-project-context.ts'
import type { CoresModuleState } from '../cores/composer-state.ts'
import {
  OnboardingTelemetry,
  buildProductionOnboardingTelemetry,
  buildSeanEllisHandler,
  composeOnboardingTelemetrySinks,
  registerSeanEllisCron,
  type ComposedTelemetrySinks,
} from '@neutronai/onboarding/telemetry/index.ts'
import {
  buildImportRunningHandler,
  registerImportRunningCron,
} from '@neutronai/onboarding/interview/import-running-cron.ts'
import {
  buildOvernightEngineHandler,
  registerOvernightHandler,
} from '@neutronai/onboarding/overnight/register.ts'
import type { PlatformAdapter } from '@neutronai/runtime/platform-adapter.ts'
import { ReminderStore } from '@neutronai/reminders/store.ts'
import { ReminderTickLoop } from '@neutronai/reminders/tick.ts'
import { TridentRunStore, type TridentRun } from '@neutronai/trident/store.ts'
import {
  TridentTickLoop,
  type TridentDeadLauncherLatch,
  type TridentLivenessProbe,
  type TridentTerminalHook,
  type TridentTransitionHook,
} from '@neutronai/trident/tick.ts'
import { stubAdvanceDeps } from '@neutronai/trident/state-machine.ts'
import { buildTridentOrchestrator } from '@neutronai/trident/orchestrator.ts'
import { buildWorkflowFirer } from '@neutronai/trident/inner-loop.ts'
import { buildTridentDelivery } from '@neutronai/trident/delivery.ts'
import { composeTerminalHook } from '@neutronai/trident/terminal-observer.ts'
import { buildBoardReconcileObserver } from '@neutronai/trident/board-reconcile.ts'
import { unwiredPublisherCredential } from '@neutronai/trident/git-mode.ts'
import { spawnCapture } from '@neutronai/trident/git-mode.ts'
import { countActiveBuildRuns } from '@neutronai/trident/active-runs.ts'
import { TaskStore } from '@neutronai/tasks/store.ts'
import {
  buildFocusScoreRecomputeHandler,
  registerFocusScoreRecomputeCron,
} from '@neutronai/tasks/focus-score-cron.ts'
import {
  buildTaskPrioritizeHandler,
  registerTaskPrioritizeCron,
} from '@neutronai/tasks/prioritize-llm.ts'
import {
  buildNudgeEngineHandler,
  registerNudgeEngineCron,
} from '../tasks/p6/nudge-engine.ts'
import { isValidIanaTimezone, readOwnerTimezone } from '../storage/owner-metadata.ts'
import { ProactiveStateStore } from '../proactive/state-store.ts'
import {
  buildIdleNudgeSweepHandler,
  registerIdleNudgeSweepCron,
} from '../proactive/cron.ts'
import {
  buildEmailPipelinePollHandler,
  registerEmailPipelineCron,
} from '../cores/email-pipeline-wiring.ts'
import type {
  IdleNudgeSweepDeps,
  ProactiveTopicCandidate,
} from '../proactive/idle-nudge-sweep.ts'
import { attachReminderLinkSubscriber } from '@neutronai/tasks/reminder-link.ts'
import {
  buildProjectionWriter,
  type ProjectionWriter,
} from '@neutronai/tasks/projection/index.ts'
import {
  attachOvernightWorkCompletedHook,
  type OvernightWorkCompletedEvent,
} from '@neutronai/tasks/overnight-task-hook.ts'
import type { Task } from '@neutronai/tasks/store.ts'
import { ApprovalManager } from '@neutronai/tools/approval.ts'
import { busyRetryExhaustionCount } from '@neutronai/persistence/index.ts'
import { ProcessRegistry, pushAmbientProcessRegistry } from '@neutronai/tools/process-registry.ts'
import { ToolRegistry } from '@neutronai/tools/registry.ts'
import { AlertStore } from '@neutronai/watchdog/alert-store.ts'
import {
  CrashedAgentDetector,
  DbLockContentionDetector,
  HeartbeatDetector,
  OverrunCronDetector,
  StuckAgentDetector,
  SubstrateCooldownDetector,
} from '@neutronai/watchdog/detectors.ts'
import { WatchdogSupervisor } from '@neutronai/watchdog/supervisor.ts'
import { type GatewayModule } from '../module-graph.ts'
import type { CompositionInput } from './input/composition-input.ts'
import { createLogger } from '@neutronai/logger'
import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'

const moduleLog = createLogger('core-modules')
// Distinct subsystem tag for the tasks-composer wiring warnings (a boot-time
// guardrail test pins the `[tasks-composer]` prefix in the log line).
const tasksComposerLog = createLogger('tasks-composer')

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
  tridentModule: GatewayModule<{ store: TridentRunStore; loop: TridentTickLoop; drain?: () => Promise<void> }>
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

/**
 * §F2 — the long-lived tick loops (reminders, trident, watchdog) register their
 * live {@link LoopDescriptor} into this registry the moment they start, so the
 * composer emits ONE boot inventory line and a production-composer test can PIN
 * the running-loop set. Optional so the two existing direct-drivers of
 * `buildCoreModules` (the trident-shutdown + watchdog-wiring unit tests) keep
 * their one-arg call; they get a throwaway registry that no one reads.
 */
export function buildCoreModules(
  input: CompositionInput,
  loopRegistry: LoopRegistry = new LoopRegistry(),
): CoreModules {
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
      // Memory recall (P0-2) — register the `memory_search` agent tool when the
      // composer wired the owner's MemoryStore, so the live agent can READ BACK
      // the entity pages + scribe facts the WRITE path persists every turn. The
      // agent-native twin of the legacy harness's `mcp__qmd__query` recall; rides the #87
      // tools-bridge as `mcp__neutron__memory_search`.
      if (input.memory_search !== undefined) {
        registerMemorySearchToolSurface(reg, input.memory_search.store)
      }
      // Agent-dispatch family (parity gap #3) — register `dispatch_agent` when
      // the composer wired the service, so the live agent can dispatch a
      // named/ad-hoc background specialist that shares the SubagentRegistry +
      // watchdog with the Trident loop and reports its result back to chat.
      if (input.agent_dispatch !== undefined) {
        registerDispatchToolSurface(reg, input.agent_dispatch.service, {
          ...(input.agent_dispatch.resolve_delivery_target !== undefined
            ? { resolve_delivery_target: input.agent_dispatch.resolve_delivery_target }
            : {}),
        })
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
        registerWorkBoardToolSurface(reg, input.work_board.store, {
          ...(input.work_board.spec_doc !== undefined ? { specDoc: input.work_board.spec_doc } : {}),
          // #429 task 4 — thread the deterministic chat ack (composer-built,
          // durable+live app-ws seam). Absent → no post (unchanged behaviour).
          ...(input.work_board.chat_ack !== undefined ? { chatAck: input.work_board.chat_ack } : {}),
          // T4 — thread the derived-inline-activity dep so `work_board_list`
          // serves evidence truth (same closure the HTTP surface gets). Absent →
          // raw stored-flag passthrough. Display-only; it gates nothing.
          ...(input.work_board.derive_inline_active !== undefined
            ? { deriveInlineActive: input.work_board.derive_inline_active }
            : {}),
          // The composer-built removal chokepoint — the SAME one the UI's X
          // runs. Present → `work_board_remove` registers; absent → it does not.
          ...(input.work_board.removal !== undefined ? { removal: input.work_board.removal } : {}),
        })
      }
      // Work Board Phase 2b — register the agent-native board-bound build
      // dispatch (`work_board_dispatch_build`) when the composer wired it (live
      // credential present). The orchestrator fires N of these for N parallel
      // trident builds, each bound to a Plan item; the durable loop harvests by
      // runId. Enforces the required-item + ask-before-acting chokepoint.
      if (input.trident_build_dispatch !== undefined) {
        registerTridentBuildToolSurface(reg, input.trident_build_dispatch)
      }
      // Codex connect/status (Part B) — register the `codex_connect` +
      // `codex_status` agent tools when the composer wired the service, so the
      // live agent has agent-native parity with the admin-panel Connect Codex
      // flow (same `CodexCredentialService`: subscription-only, metered key
      // rejected, materialized to the per-project CODEX_HOME).
      if (input.codex_credential !== undefined) {
        registerCodexCredentialToolSurface(reg, { service: input.codex_credential.service })
      }
      // Create-project (project-rail Create Project parity) — register the
      // `create_project` agent tool when the composer wired the service, so the
      // live agent can create a project mid-turn. Same owner-scoped create path
      // the HTTP surface uses (one code path). Rides the #87 tools-bridge as
      // `mcp__neutron__create_project`.
      if (input.create_project !== undefined) {
        registerCreateProjectToolSurface(reg, input.create_project.service)
      }
      // Owner-approved host deploy — register `host_deploy_request` +
      // `host_deploy_status` so the agent can ASK for a deploy of the host this
      // instance runs on. Registered unconditionally of any control-plane
      // configuration: with no endpoint the tools answer `enabled:false` WITH
      // the reason, because an option that silently disappears is how a missing
      // capability stays invisible for weeks. The service getter is late-bound
      // (see `install` below) — the graph's ApprovalManager does not exist yet.
      if (input.host_deploy !== undefined) {
        registerHostDeployToolSurface(reg, input.host_deploy.service)
      }
      return reg
    },
  }

  // F4 — the ambient-publish deregister for the process registry (below). Held
  // in the module-builder closure so `shutdown` can clear the ambient handle the
  // spawn sites reach (`tools/process-registry.ts` ambient accessor).
  let clearAmbientProcessRegistry: (() => void) | null = null
  const processRegistryModule: GatewayModule<ProcessRegistry> = {
    name: 'process-registry',
    init: () => {
      const registry = new ProcessRegistry()
      // F4 — publish THIS instance as the ambient live-process registry so the
      // deep PTY spawn chokepoint (`persistent/spawn.ts`, no DI seam to here)
      // writes child PIDs into the SAME registry the watchdog detectors read.
      // The stuck/crashed detectors consume `graph.get('process-registry')`
      // (below), which is this exact instance — one truth, not two.
      clearAmbientProcessRegistry = pushAmbientProcessRegistry(registry)
      return registry
    },
    shutdown: () => {
      clearAmbientProcessRegistry?.()
      clearAmbientProcessRegistry = null
    },
  }

  const approvalModule: GatewayModule<ApprovalManager> = {
    name: 'approval',
    deps: ['tools'],
    init: () => {
      const manager = new ApprovalManager(input.db, input.approval_notifier)
      // Host deploy — hand the service THIS manager instance (the one whose
      // `tool_approvals` rows the owner's in-chat tap resolves). Installed here
      // rather than passed as a value because the `tools` module, which
      // registers the agent tools, initializes first.
      input.host_deploy?.install({ approvals: manager })
      return manager
    },
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
      // X6 — bind the dispatching turn's active project into the ambient
      // active-project frame around every tool handler, so a Core tool's
      // credential accessor (which reads that frame at call time) scopes
      // per-project on the agent's native tool path.
      return new McpServer({
        project_slug: input.project_slug,
        registry: tools,
        bindActiveProject: runWithActiveProject,
      })
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
  // WAVE 3.5 task B — the TodoWrite→Work Board reconciler wired alongside the
  // bridge (both are late-bound singletons the persistent-REPL sink reads). Held
  // here so shutdown can identity-guard-clear it. Only wired when the shared
  // WorkBoardStore is present (LLM-less / board-less boots leave it undefined →
  // the sink's /todo-sync route no-ops).
  let wiredTodoSync: ReplTodoSync | undefined
  const replToolBridgeModule: GatewayModule<{ wired: boolean }> = {
    name: 'repl-tool-bridge',
    deps: ['mcp'],
    init: (ctx) => {
      wiredBridgeServer = ctx.graph.get<McpServer>('mcp')
      setReplToolBridge(wiredBridgeServer)
      const board = input.work_board?.store
      if (board !== undefined) {
        // The sink hands us the session's active project_id + the raw todo list;
        // resolve the per-project scope (owner slug bounds it, exactly like the
        // work_board_* tools) and reconcile through the SAME shared store so a
        // synced create/update fires its `onChange` live-push.
        wiredTodoSync = async ({ project_id, todos }) => {
          const scope = workBoardScopeKey(input.project_slug, project_id)
          await reconcileTodosIntoBoard(board, scope, normalizeTodos(todos))
        }
        setReplTodoSync(wiredTodoSync)
      }
      return { wired: true }
    },
    shutdown: () => {
      // Identity-guarded so a second graph in the same process (tests) can't
      // null out the live graph's bridge on an older graph's teardown.
      if (wiredBridgeServer !== undefined) clearReplToolBridgeIf(wiredBridgeServer)
      if (wiredTodoSync !== undefined) clearReplTodoSyncIf(wiredTodoSync)
    },
  }

  const remindersModule: GatewayModule<{ store: ReminderStore; loop: ReminderTickLoop }> = {
    name: 'reminders',
    // Executor-mode reminders (plan task 4) — the tick loop's ritual executor is
    // built from the graph's `ApprovalManager` (the approval checker source), so
    // the module depends on `approval` being composed first.
    deps: ['approval'],
    init: (ctx) => {
      const store = new ReminderStore(input.db)
      // (The P5.6 note that used to sit here described attaching the push
      // dispatcher as the tick's `on_fired` hook. That wiring is GONE — see the
      // "what is NOT here any more" note below, which is now the only account of
      // it. Leaving both left one file describing the wiring and contradicting
      // itself twenty-five lines later.)
      const loopOpts: ConstructorParameters<typeof ReminderTickLoop>[0] = {
        store,
        dispatcher: input.reminder_dispatcher,
        // ISSUES #40 — resolve a cron reminder's wall clock in the OWNER's zone.
        // Before this, the tick loop had no zone wired and defaulted to the HOST
        // zone, so on a UTC server every recurring reminder fired at its stored
        // hour in UTC: a `0 21 * * *` evening ritual arrived mid-afternoon for an
        // owner in the Americas, and nothing errored — the reminder shows up, at
        // the wrong hour, which reads as the owner's own mistake.
        //
        // Same source + same resolve-per-invocation contract as the nudge engine
        // above: the stored per-instance zone, read at each fire (keyed on the
        // ROW's owner_slug, not a composition-time slug) so a zone reported after
        // boot applies on the next tick without a restart. `isValidIanaTimezone`
        // guards the read because a zone that does not construct would make
        // `nextCronFire` throw, which the tick treats as an uncomputable cadence
        // and RETIRES the row — a bad zone must cost an hour, never the reminder.
        resolve_time_zone: (owner_slug: string): string | null => {
          const tz = readOwnerTimezone(input.db, owner_slug)
          return tz !== null && isValidIanaTimezone(tz) ? tz : null
        },
      }
      // NOTE what is NOT here any more: a reminder-fired PUSH hook. Until
      // 2026-08-09 the composition's `push_dispatcher` was attached to the tick's
      // `on_fired` and composed a notification from the reminder ROW — which for a
      // ritual is the dispatch token `ritual:<id>`, so the owner's lock screen read
      // `ritual:kaizen`. The tick cannot see the message the fire posted, so it was
      // never a place a truthful chat notification could be built. It is composed
      // by the ONE out-of-turn delivery seam instead (`gateway/http/deliver.ts` →
      // its `notify` sink), which knows the posted text and the durable row id AND
      // is shared by every producer, so a brief and a nudge notify the same way a
      // fired reminder does.
      // Rituals (ISSUES #504) — install the ritual fire PLANNER now that the
      // graph's ApprovalManager exists. NOTE what is NOT here: the tick loop gets
      // no ritual option, because a ritual is not a special kind of fire. The
      // planner installs into the ONE `reminder_dispatcher` the composer already
      // built, which composes a ritual and a nudge through the same substrate call
      // and posts both through the same delivery seam.
      //
      // Absent (LLM-less box) → a row with NO `ritual_id` composes as an ordinary
      // nudge; a RITUAL row is refused outright — it composes nothing, logs at error
      // level and posts one plain-language notice (`reminders/dispatcher.ts:508`).
      // This sentence used to read "every row composes as an ordinary nudge, which is
      // fail-closed", which was true of the approved PROMPT and false of the
      // NOTIFICATION: a ritual row's stored `message` IS the dispatch token
      // `ritual:<id>`, so nudging it is how `ritual:kaizen` reached the owner's lock
      // screen. Corrected in `dispatcher.ts` and `open/composer.ts` first; this was
      // the third copy of the same claim and it was missed.
      if (input.init_ritual_planner !== undefined) {
        input.init_ritual_planner({
          approvals: ctx.graph.get<ApprovalManager>('approval'),
        })
      }
      const loop = new ReminderTickLoop(loopOpts)
      // §F2 — REGISTER BEFORE START (failure-atomic): a duplicate-name throw
      // happens before any timer is armed, so a reused/colliding registry can
      // never leak a running loop with no reachable stop handle.
      loopRegistry.register(loop.describe())
      loop.start()
      return { store, loop }
    },
    shutdown: async (instance) => {
      // §F1 — quiescing stop: awaits the in-flight tick before teardown.
      await instance.loop.stop()
    },
  }

  // Trident — the autonomous Forge→Argus→merge state machine (foundational
  // runtime, ported from the legacy harness's /trident skill). The tick loop sweeps
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
  const tridentModule: GatewayModule<{ store: TridentRunStore; loop: TridentTickLoop; drain?: () => Promise<void> }> = {
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
      // Terminal completions post through the graph's `ChannelRouter` — the ONE
      // delivery seam. X5 registered a real adapter on it in every composition
      // (Open: `AppWsAdapter` for `app_socket`, via `composition.channel_router`;
      // Telegram instances: `TelegramAdapter`), so `router.send` dispatches to the
      // owning adapter (durable persist + live fan-out) instead of throwing. The
      // `delivery_sink` override remains an OPTIONAL escape hatch (custom sink /
      // tests); default + Open is the router.
      const delivery = buildTridentDelivery({ sink: tridentWiring?.delivery_sink ?? router })
      // Skill-forge trigger (parity gap #5) — when the composer wired an
      // `on_run_terminal` observer, run it on every terminal run, ISOLATED
      // from delivery (`withTerminalObserver`): a delivery outage must not skip
      // the auto-skillify audit, since the run is already terminal and the loop
      // won't re-fire the hook. Observer errors are logged, never propagated;
      // a delivery error is still re-thrown so the loop's try/catch logs it.
      const runTerminalObserver = tridentWiring?.on_run_terminal
      // Work Board Phase 2b — RECONCILE the bound board item on a terminal run:
      // clear its run binding (fork `⑂` goes dark) and set the lane from the
      // outcome (done → completed history; failed/stopped → back to upcoming).
      // Keyed off `linked_run_id` via `detachRun` (idempotent + a no-op for an
      // unbound run). Best-effort observer — a board write outage must never
      // skip delivery nor un-terminate the run (the loop already transitioned
      // it). Composed with any skill-forge observer into one observer fn.
      const boardReconcile = buildBoardReconcileObserver(input.work_board?.store) ?? undefined
      // #335 — register the same terminal-build wake observer in the tick-loop chain.
      const observers = [boardReconcile, runTerminalObserver, tridentWiring?.on_terminal_wake].filter(
        (o): o is (run: TridentRun) => Promise<void> => o !== undefined,
      )
      // §F6a — the SAME assembly the out-of-band `terminate()` chokepoint uses,
      // so a cancelled build runs the exact chain a loop-reaped one does.
      const on_terminal: TridentTerminalHook = composeTerminalHook(delivery, observers)
      // M1 UX REDESIGN — the LIVE-PROGRESS fan. When the composer wired an
      // `on_run_transition` observer, adapt it to the loop's `TridentTransitionHook`
      // so a checkpoint advance (building→reviewing→fixing→merging), a launch, or a
      // terminal transition fans the bound Work item + the project rail live. Spread
      // conditionally so the option is simply absent (loop unchanged) when unwired.
      const runTransitionObserver = tridentWiring?.on_run_transition
      const transitionOpt: { on_transition?: TridentTransitionHook } =
        runTransitionObserver === undefined
          ? {}
          : { on_transition: { onTransition: (run) => runTransitionObserver(run) } }
      // The wake-on-change watcher's cadence, when the composition set one. Spread
      // conditionally for the same reason as `on_transition`: absent means "the 2 s
      // default", not "0". This is what makes the cadence CONFIGURABLE in production
      // rather than only on the options type (Argus r3).
      const watchOpt: { watch_interval_ms?: number } =
        tridentWiring?.watch_interval_ms === undefined
          ? {}
          : { watch_interval_ms: tridentWiring.watch_interval_ms }
      // The external signal observes the warm launcher, not the detached build.
      // Route it through #267's durable crash latch so harvest-first continuation
      // remains authoritative across gateway restarts.
      const livenessOpt: {
        probe_launcher_alive?: TridentLivenessProbe
        latch_launcher_dead?: TridentDeadLauncherLatch
      } =
        tridentWiring?.probe_launcher_alive === undefined
          ? {}
          : {
              probe_launcher_alive: tridentWiring.probe_launcher_alive,
              latch_launcher_dead: (key, reason) => store.crashRunningByLauncher(key, reason),
            }
      let loop: TridentTickLoop
      // §F1 — the orchestrator's `drain()` (previously destructured away and
      // never called) settles every in-flight FIRE turn on shutdown. Captured
      // here and wired into `shutdown` so a clean teardown quiesces trident too.
      let drain: (() => Promise<void>) | undefined
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
        // #342 — the bounded Forge merge-conflict resolver: a LOCAL-mode merge
        // that hits a rebase conflict (a 2nd/3rd parallel same-project build) is
        // auto-resolved instead of hard-failing. Absent → conflicts escalate to chat.
        if (tridentWiring.resolve_conflict !== undefined) {
          orchestratorOpts.resolve_conflict = tridentWiring.resolve_conflict
        }
        // OPTIONAL cross-model review: resolve the Codex credential dir
        // (CODEX_HOME) for the inner workflow. PREFER the composer's per-run
        // resolver (`resolve_codex_home` → `CodexCredentialService.resolveActiveCodexHome`:
        // project override → global → unset, self-healing) so the review reads
        // the credential through the #149 store resolver, never a stale static
        // path. Fall back to the static `codex_home` / `NEUTRON_CODEX_HOME` env
        // for manual dev overrides. Absent → codex "not connected" → Claude-only
        // review (never a merge blocker).
        if (tridentWiring.resolve_codex_home !== undefined) {
          orchestratorOpts.resolve_codex_home = tridentWiring.resolve_codex_home
        }
        // The inner loop's GitHub READS: the store coordinates its per-command
        // `gh` runner resolves the instance token from. Without these the probes
        // fall back to bare `gh` — which on an unauthenticated box is exactly the
        // 2026-08-14 failure (every readiness probe unreadable, every review
        // deferred). Paths/handles only; the token is never wired through here.
        if (tridentWiring.gh_data_dir !== undefined) {
          orchestratorOpts.gh_data_dir = tridentWiring.gh_data_dir
        }
        if (tridentWiring.gh_owner_handle !== undefined) {
          orchestratorOpts.gh_owner_handle = tridentWiring.gh_owner_handle
        }
        // The KIMI K3 cross-model panelist. Absent → never runs (graceful).
        if (tridentWiring.resolve_kimi_configured !== undefined) {
          orchestratorOpts.resolve_kimi_configured = tridentWiring.resolve_kimi_configured
        }
        // The owner's per-phase model/effort choices. Without this line the whole
        // per-phase config chain is inert: it was built end to end and never given a
        // producer, so every run used the defaults regardless of what was set.
        if (tridentWiring.resolve_phase_models !== undefined) {
          orchestratorOpts.resolve_phase_models = tridentWiring.resolve_phase_models
        }
        // RB2 (b) — thread the owner's reflection corrections/diary resolver so the
        // inner workflow re-grounds the FORGE BUILDER (not the argus review gate) on
        // owner corrections on its first turn (reflection was chat-only before RB2).
        if (tridentWiring.resolve_reflection_context !== undefined) {
          orchestratorOpts.resolve_reflection_context = tridentWiring.resolve_reflection_context
        }
        // THE LIVE FAN-OUT the TEST EXECUTION budget divides the box by, when it
        // exceeds the planned fan-out (`DEFAULT_BUILD_FANOUT`, which is the constant
        // that carries the guarantee — see `computeTestJobs`). Counts the launching
        // run's OWN row too, so the divisor is the true number of builds sharing these
        // cores. Without this line the whole chain is inert (the `resolve_phase_models`
        // lesson — an unwired producer ships a feature whose every part works and which
        // as a whole does nothing).
        //
        // ONLY THE BUILD PHASES COUNT — see `countActiveBuildRuns`, which is where the
        // rule and its known over-count live, and which is unit-tested behaviourally.
        orchestratorOpts.resolve_active_runs = () => countActiveBuildRuns(store)
        orchestratorOpts.record_stage = (id, stage, meta) => {
          // The stamp is telemetry: a ledger failure must never hold up or fail
          // the fire it is describing, so swallow — but through the sanctioned
          // wrapper, which counts the rejection instead of dropping it silently.
          fireAndForget('trident_record_stage', store.recordStageEvent(id, stage, meta ?? null))
        }
        const codexHome = tridentWiring.codex_home ?? process.env['NEUTRON_CODEX_HOME']
        if (codexHome !== undefined && codexHome.length > 0) {
          orchestratorOpts.codex_home = codexHome
        }
        // RALPH RE-FIRE (#362) — the seam that atomically persists a re-fired Ralph
        // run's reset (null the harvested `inner_result` + release the sub-agent slot +
        // bump ralph_round) out-of-band in ONE store UPDATE. save/saveIfActive never
        // write `inner_result`; the single atomic write also avoids the crash window
        // that would otherwise strand the row as terminal-but-garbled. A multi-task
        // Ralph build re-fires a fresh inner iteration per remaining task.
        orchestratorOpts.persist_refire_reset = (id, patch) =>
          store.update(id, patch).then(() => {})
        // "A gateway restart must not kill an in-flight build" — the crash-recovery
        // claim. A gateway restart kills the warm `cc-trident-fire-*` REPL supervising
        // a DETACHED build; without this seam the tick reaps the run to `failed` (it
        // did exactly that to three healthy builds on 2026-08-14). Wired here, a
        // crashed launcher is instead relaunched as a continuation from its pushed
        // branch/PR/checkpoint, bounded by the durable `crash_recoveries` budget.
        orchestratorOpts.begin_crash_recovery = (id) => store.beginCrashRecovery(id)
        // "An infrastructure failure must retry itself" — atomically spend the
        // durable executor/transport retry budget and release the run slot.
        orchestratorOpts.begin_infra_retry = (id) => store.beginInfraRetry(id)
        const orchestrator = buildTridentOrchestrator(orchestratorOpts)
        loop = new TridentTickLoop({
          store,
          step: orchestrator.step,
          on_terminal,
          ...transitionOpt,
          ...watchOpt,
          ...livenessOpt,
        })
        drain = orchestrator.drain
      } else {
        loop = new TridentTickLoop({
          store,
          deps: stubAdvanceDeps(),
          on_terminal,
          ...transitionOpt,
          ...watchOpt,
          ...livenessOpt,
        })
      }
      // §F2 — REGISTER BEFORE START (failure-atomic; see reminders module).
      // `describeAll`, not `describe`: trident owns up to THREE timers — the 90 s sweep,
      // the 2 s wake-on-change watcher, and the 15 s liveness probe — and an
      // unregistered timer is one the inventory reports as healthy by never mentioning it.
      for (const descriptor of loop.describeAll()) loopRegistry.register(descriptor)
      loop.start()
      return drain !== undefined ? { store, loop, drain } : { store, loop }
    },
    shutdown: async (instance) => {
      // §F1 — stop the tick loop FIRST (no new FIRE turns launch), then drain
      // the orchestrator's in-flight FIRE turns, so a clean shutdown quiesces
      // trident before `db.close()`. `drain` is only present on the wired path.
      await instance.loop.stop()
      if (instance.drain !== undefined) await instance.drain()
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
      // CronJobRegistry when present so the wiring's
      // wow-dispatcher and THIS scheduler read from one shared instance.
      // See CompositionInput.cron_jobs docblock for the full incident.
      const jobs = input.cron_jobs ?? new CronJobRegistry()
      const handlers = new CronHandlerRegistry()
      const state = new CronStateStore(input.db)
      const scheduler = new CronScheduler({
        jobs,
        handlers,
        db: input.db,
        owner_slug: input.project_slug,
      })
      // P1 S4 doesn't auto-start jobs — handlers are wired by the modules
      // that own each job (vault-backup, focus_score_recompute, …) BEFORE scheduler.start.
      // The boot shell triggers start() after all modules register handlers.
      return { jobs, handlers, state, scheduler }
    },
    shutdown: async (instance) => {
      // §F1 — quiescing stop: awaits any in-flight cron fire before teardown.
      await instance.scheduler.stop()
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
          owner_slug: input.project_slug,
          tracker: input.heartbeat_tracker,
        }),
      )
      supervisor.registerDetector(
        new StuckAgentDetector({
          owner_slug: input.project_slug,
          process_registry: processRegistry,
        }),
      )
      const crashedOpts: ConstructorParameters<typeof CrashedAgentDetector>[0] = {
        owner_slug: input.project_slug,
        process_registry: processRegistry,
      }
      if (input.pid_probe !== undefined) crashedOpts.pid_probe = input.pid_probe
      supervisor.registerDetector(new CrashedAgentDetector(crashedOpts))
      // F4 (D-8 = wire) — register the remaining THREE detectors so all SIX run
      // live. Their state sources are now available: the cron module (jobs +
      // state) is a dep, the busy-retry exhaustion counter is a process-wide
      // observability count (`persistence/retry.ts`), and the substrate
      // credential pool arrives via `input.watchdog_credential_pool`.
      //
      // 4. overrun_cron — a cron job whose last run overran its expected budget.
      supervisor.registerDetector(
        new OverrunCronDetector({
          owner_slug: input.project_slug,
          jobs: cron.jobs,
          state: cron.state,
        }),
      )
      // 5. db_lock_contention — a rising count of SQLite busy-retry EXHAUSTIONS
      //    over a window (write-path starvation under lock contention).
      supervisor.registerDetector(
        new DbLockContentionDetector({
          owner_slug: input.project_slug,
          counter: { exhaustionCount: () => busyRetryExhaustionCount() },
        }),
      )
      // 6. substrate_cooldown_saturation — every credential in the pool cooling
      //    down at once (no substrate can dispatch). Watches the composer's LLM
      //    pool; an empty/absent pool never fires but is still registered (all
      //    six always wired).
      supervisor.registerDetector(
        new SubstrateCooldownDetector({
          owner_slug: input.project_slug,
          pool: input.watchdog_credential_pool ?? {
            credentials: [],
            strategy: 'fill_first',
            cursor: -1,
          },
          substrate_kind: 'llm',
        }),
      )
      // §F2 — REGISTER BEFORE START (failure-atomic; see reminders module).
      loopRegistry.register(supervisor.describe())
      supervisor.start()
      return { store, supervisor }
    },
    shutdown: async (instance) => {
      // AWAIT the quiescing stop so an in-flight tick's persist/notify drains
      // before `graph.shutdown()` returns and the gateway closes the DB (round-7).
      await instance.supervisor.stop()
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
          owner_slug: input.project_slug,
          jobs: cron.jobs,
          handlers: cron.handlers,
          handler,
        }
        if (seanCfg.interval_ms !== undefined) registerInput.interval_ms = seanCfg.interval_ms
        registerSeanEllisCron(registerInput)
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
          owner_slug: input.project_slug,
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
          // Merge-mode detection needs the PUBLISHER'S credential, not the
          // gateway's ambient `gh` state (which is empty by design — the token
          // is injected per spawn). A composer that supplied no overnight config
          // gets the honest "nothing wired" source, which refuses a GitHub-backed
          // overnight build by NAME instead of asking a bare `gh` and getting a
          // truthful answer about the wrong process. It is given no handle
          // deliberately: the project slug is not an owner handle, and passing it
          // here made the refusal name an identity that was never looked up.
          publisher_credential:
            overnightCfg?.publisher_credential ?? unwiredPublisherCredential(),
          ...(overnightCfg?.deliver !== undefined ? { deliver: overnightCfg.deliver } : {}),
          // The composer's topic beats the onboarding-row read (ISSUES #443 —
          // on Open that row never carries one, so the brief was skipped).
          ...(overnightCfg?.general_topic_id !== undefined
            ? { general_topic_id: overnightCfg.general_topic_id }
            : {}),
          // The engine's log sink defaulted to ABSENT, so every dispatch,
          // rejection and delivery failure it reported went to `undefined?.()`
          // — a whole subsystem running overnight with no operational trace.
          // Route it at the composition boundary, as the tasks-projection
          // writer does. Volume is a handful of lines per ~30-min tick.
          // (Delivery FAILURES are not left to this log alone: they are counted
          // into `MorningBriefResult.delivery_failures` and surface in the
          // cron tick's own `detail` — see `runMorningBrief`.)
          log: (msg: string): void => {
            moduleLog.info('overnight_engine', { project: input.project_slug, detail: msg })
          },
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
        moduleLog.info('cores_install_summary', {
          project: input.project_slug,
          discovered: result.discovered,
          installed: result.installed.size,
          failed: result.failures.length,
        })
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
        tasksComposerLog.warn('tasks_store_undefined_with_subscribers', {
          project: input.project_slug,
          focus_score_cron: tasksCfg.enable_focus_score_cron === true,
          reminder_link: tasksCfg.enable_reminder_link === true,
          projection: tasksCfg.projection !== undefined,
          detail:
            'subscriber feature(s) enabled but tasksCfg.store is undefined. The fallback store will ' +
            'not be shared with HTTP surfaces / Tasks-Core, so writes through those surfaces will NOT ' +
            'fire subscribers. Thread a canonical TaskStore via composition.tasks.store + ' +
            'buildCoresBackendFactories({ canonicalTaskStore }) — see Argus r2 BLOCKING #2 (PR #221, 2026-05-20).',
        })
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
      // "do this next" pick once per day per instance.
      //
      // A null `nudge_engine.llm` is NOT a safe no-op (this comment used to
      // claim it was). `runNudgePass` runs the staleness pass at
      // `gateway/tasks/p6/nudge-engine.ts:306` — which writes focus-score decay
      // and skip counts to `tasks` (`staleness-engine.ts:182-215`) — BEFORE it
      // reaches the `llm === null` bail at `nudge-engine.ts:337-340`. So an
      // llm-less tick mutates task scores every day and still never writes a
      // `current_focus_pick` row. Callers must therefore only set
      // `enable_nudge_engine_cron` when they have an llm to pass; the Open
      // composer does exactly that (`open/composer.ts`, gated on `proactiveLlm`).
      if (tasksCfg.enable_nudge_engine_cron === true) {
        const ne = tasksCfg.nudge_engine ?? { llm: null }
        const nudgeHandlerDeps: Parameters<typeof buildNudgeEngineHandler>[0] = {
          db: input.db,
          llm: ne.llm,
        }
        if (ne.personaLoader !== undefined) {
          nudgeHandlerDeps.personaLoader = ne.personaLoader
        }
        // ISSUES #40 — resolve the owner's timezone from `instance_metadata`
        // so the daily nudge pick keys `current_focus_pick.day` on the
        // owner's actual wall clock, not the LA-hardcoded
        // `DEFAULT_OWNER_TIMEZONE`. Precedence: an explicit config override
        // (test / composer seam) wins; else a PER-TICK resolver that reads the
        // stored per-instance zone at each engine invocation (the migration
        // 0045 contract resolves the zone "at engine invocation" — so a
        // mid-run timezone change takes effect on the next tick without a
        // restart). `readOwnerTimezone` returns null → the pass falls back to
        // `DEFAULT_OWNER_TIMEZONE` (legacy instances provisioned before
        // migration 0050, or any instance whose column is unset).
        if (ne.timezone !== undefined) {
          nudgeHandlerDeps.timezone = ne.timezone
        } else {
          // Key the read on the DISPATCHED owner_slug (not the composition-time
          // `input.project_slug`): the hosted first-handler-wins model shares
          // one handler across instances, so the resolver must look up the
          // tick's owner — consistent with the pass querying `input.db` by
          // `ctx.owner_slug`.
          nudgeHandlerDeps.resolveTimezone = (
            owner_slug: string,
          ): string | undefined =>
            readOwnerTimezone(input.db, owner_slug) ?? undefined
        }
        if (ne.now !== undefined) nudgeHandlerDeps.now = ne.now
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

        // NOTE (ISSUES #504): the second morning brief used to be composed and
        // cron-registered HERE. It is gone — its provider slots (calendarToday,
        // entityDeltas, projectStatus) were never wired in production, so the brief
        // it posted could only apologise for not having checked the calendar. The
        // morning brief is now the RITUAL, fired as an ordinary reminder onto the
        // owner's own session by the reminders tick.

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
          // Owner's stored zone wins over the host-derived static `tz`, resolved
          // per tick (see the brief above). This one is load-bearing twice over:
          // the sweep's `day` is also the key `readTodayPick` reads the ranker's
          // pick by, so a host-zone day makes the lookup MISS for the hours the
          // UTC↔owner offset spans, not merely mistime the post.
          if (proactiveCfg.timezone !== undefined) sweepDeps.tz = proactiveCfg.timezone
          sweepDeps.resolveTimezone = (owner_slug: string): string | undefined =>
            readOwnerTimezone(input.db, owner_slug) ?? undefined
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

      // Email Core consolidation P1 — the `email-pipeline-poll` cron. Gated on
      // the composition root supplying the bundle (`open/composer.ts`): the
      // tick needs a Gmail client, the `deliver` seam, the owner's app topic
      // and (optionally) the substrate LLM, none of which this module can
      // reach. Absent ⇒ nothing registers, exactly like the proactive block
      // above. Registration shape is the idle-nudge precedent.
      if (input.email_pipeline !== undefined) {
        const emailPipelineHandler = buildEmailPipelinePollHandler(input.email_pipeline)
        registerEmailPipelineCron({
          jobs: cronDeps.jobs,
          handlers: cronDeps.handlers,
          handler: emailPipelineHandler,
          ...(input.email_pipeline.interval_ms !== undefined
            ? { interval_ms: input.email_pipeline.interval_ms }
            : {}),
        })
      }

      let projection: ProjectionWriter | null = null
      if (tasksCfg.projection !== undefined) {
        const projectionOpts: Parameters<typeof buildProjectionWriter>[0] = {
          store,
          resolveProjectDir: tasksCfg.projection.resolveProjectDir,
          // The writer's DEFAULT log sink is a no-op (`tasks/projection/write.ts`),
          // so an unwritable Projects dir or a full disk would have failed
          // silently forever. Route it at the composition boundary instead — a
          // write error is a warning, a skip/ok is debug-level noise.
          log: (event): void => {
            if (event.kind === 'write_error') {
              tasksComposerLog.warn('tasks_projection_write_failed', {
                project: input.project_slug,
                project_id: event.project_id,
                error: event.message,
              })
            }
          },
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
