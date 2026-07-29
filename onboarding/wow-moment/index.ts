/**
 * @neutronai/onboarding/wow-moment — public barrel.
 *
 * Per docs/plans/P2-onboarding-v2.md § 5 + § 9 (v1 contracts preserved
 * in docs/plans/P2-onboarding.md § 2.5 / § 4).
 */

export {
  ActionRunner,
  DEFAULT_ACTION_TIMEOUT_MS,
  type ActionRunnerDeps,
  type RunActionInput,
  type RunActionOutput,
} from './action-runner.ts'

export {
  WowTelemetry,
  ALL_WOW_ACTION_IDS,
  type EventLogger,
  type WowActionId,
  type WowEngagedEvent,
  type WowEngagement,
  type WowEventRow,
  type WowFiredEvent,
  type WowTelemetryDeps,
} from './telemetry.ts'

export {
  pickWowActions,
  _setCachedSystemPromptForTests,
  type WowSelectorCollectedData,
  type WowSelectorDeps,
  type WowSelectorInput,
  type WowSelectorLogger,
  type WowSelectorResult,
} from './llm-selector.ts'

export type {
  BriefSubstrate,
  CapturedProject,
  GmailDraftClient,
  GmailScopeState,
  RitualEntry,
  StalledEmailThread,
  WowActionContext,
  WowActionModule,
  WowActionResult,
  WowChannelAdapter,
  WowInterviewState,
} from './action-types.ts'

export type { NonWorkInterest } from './actions/06-interest-check-in.ts'
