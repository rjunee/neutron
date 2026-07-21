/**
 * @neutronai/agent-dispatch — public barrel.
 *
 * The general agent-dispatch surface: named specialists (research → Atlas,
 * review → Sentinel) + an ad-hoc "run this task" agent, built ON the
 * `runtime/subagent/` registry/spawn-guard/watchdog primitive. Spawns via the
 * substrate (never a direct api.anthropic.com call), supervised by the
 * already-ported watchdog, and reports results back to chat. Agent-native: the
 * `dispatch_agent` tool + the `/dispatch` command share one `DispatchService`.
 */

export {
  DISPATCH_KINDS,
  AGENT_KIND_BY_DISPATCH_KIND,
  DISPATCH_KIND_BY_AGENT_KIND,
  ADHOC_SYSTEM_PROMPT,
  type DispatchKind,
  type DispatchPersonaKind,
} from './prompts.ts'

export {
  DispatchService,
  DispatchValidationError,
  type DispatchServiceDeps,
  type DispatchBoardBinder,
  type DispatchRequest,
  type DispatchHandle,
  type DispatchOutcome,
  type DispatchTurn,
  type DispatchTurnInput,
  type DispatchTurnResult,
  type DispatchReport,
  type DispatchReporter,
  type DeliveryTarget,
  type PersonaLoader,
  type PersonaPrompt,
} from './service.ts'

export { defaultPersonaLoader } from './persona.ts'

export {
  buildCancellableDispatchTurn,
  type CancellableDispatchTurnOptions,
} from './substrate-turn.ts'

export {
  buildDispatchWatchdogNotifier,
  buildDispatchSuspectedStuckNotifier,
  buildDispatchStuckAlertSink,
  selectDispatchAlertTopics,
  buildBootSweepReport,
  scheduleDispatchLifecycleWatchdog,
  LIFECYCLE_WATCHDOG_TICK_MS,
} from './watchdog-report.ts'
export type {
  DispatchSuspectedStuckAlert,
  DispatchSuspectedStuckSink,
  DispatchStuckAlertSinkEffects,
  AppWsAlertRegistry,
  DispatchAlertRouteOptions,
  ScheduleDispatchLifecycleWatchdogDeps,
} from './watchdog-report.ts'

export {
  registerDispatchToolSurface,
  DISPATCH_AGENT_TOOL,
  type DispatchToolSurfaceOptions,
} from './tool.ts'

export {
  createBoardResearchStarter,
  type BoardResearchStarterDeps,
  type BoardResearchStartResult,
  type BoardResearchItem,
} from './board-research-start.ts'

export {
  parseDispatchCommand,
  executeDispatchCommand,
  parseAndExecuteDispatchCommand,
  type DispatchCommand,
  type DispatchCommandResponse,
  type DispatchCommandContext,
  type DispatchCommandErrorCode,
} from './command.ts'
