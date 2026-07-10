/**
 * @neutronai/tools — public barrel.
 *
 * Three primitives ship in
 * P1 S4: ToolRegistry (registration + lookup), ApprovalManager (HITL
 * persistence + state machine), ProcessRegistry (long-running subprocess
 * bookkeeping for cleanup + observability).
 */

export const __MODULE__ = '@neutronai/tools' as const

export { ToolRegistry } from './registry.ts'
export type {
  ToolRegistration,
  ToolHandler,
  ToolCallContext,
  ApprovalPolicy,
} from './registry.ts'

export { ApprovalManager, APPROVAL_DEFAULT_TTL_MS } from './approval.ts'
export type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRow,
  ApprovalNotifier,
  ApprovalManagerOptions,
} from './approval.ts'

export {
  ProcessRegistry,
  STUCK_PROCESS_INACTIVITY_MS,
  pushAmbientProcessRegistry,
  resolveAmbientProcessRegistry,
  registerLiveProcessSafe,
  touchLiveProcessSafe,
  unregisterLiveProcessSafe,
} from './process-registry.ts'
export type { ProcessRecord, ProcessRegisterInput } from './process-registry.ts'
