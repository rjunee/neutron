/**
 * @neutronai/runtime/subagent — public barrel for subagent dispatch.
 *
 * Lifted from OpenClaw's `subagent-*.ts` family, hardened with Hermes-style
 * signed-delegation tokens. Substrate-agnostic — works on CC, Codex CLI, or
 * GPT-5.5 API by composing each substrate's `Substrate.start` under the
 * subagent registry.
 */

export {
  SubagentRegistry,
  MAX_SPAWN_DEPTH,
  MAX_CHILDREN_PER_AGENT,
  MAX_CONCURRENT_SUBAGENTS,
} from './registry.ts'
export type { SubagentRecord, SubagentStatus, AgentKind, CreateRecordInput } from './registry.ts'

export { spawnSubagent } from './spawn.ts'
export type { SpawnInput, SpawnDeps, DelegationClaims, DelegationVerifier } from './spawn.ts'

export {
  newControlState,
  registerCanceller,
  cancelRun,
  failRun,
  statusOf,
  waitForCompletion,
} from './control.ts'
export type { ControlState, Canceller } from './control.ts'

export { formatAnnouncement, renderAnnouncementMarkdown } from './announce.ts'
export type { AnnouncementPayload, FormatAnnouncementInput } from './announce.ts'

export { runLifecycleTick, STALE_THRESHOLD_MS } from './lifecycle.ts'
export type { LifecycleDeps } from './lifecycle.ts'

export { runAgentWatchdog, DEFAULT_STUCK_THRESHOLD_MS } from './watchdog.ts'
export type {
  AgentWatchdogDeps,
  AgentWatchdogEvent,
  AgentWatchdogNotifier,
  AgentWatchdogResult,
  StuckThresholdConfig,
  WatchdogReason,
} from './watchdog.ts'
