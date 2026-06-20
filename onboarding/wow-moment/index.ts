/**
 * @neutronai/onboarding/wow-moment — public barrel.
 *
 * Per docs/plans/P2-onboarding-v2.md § 5 + § 9 (v1 contracts preserved
 * in docs/plans/P2-onboarding.md § 2.5 / § 4).
 */

export {
  WowDispatcher,
  DEFAULT_FREEFORM_PAUSE_MS,
  DEFAULT_INTER_ACTION_PAUSE_MS,
  DEFAULT_KEEP_TYPING_BUDGET_MS,
  type DispatchInput,
  type DispatchOutcome,
  type FreeformProbe,
  type RescheduleHook,
  type WowDispatcherDeps,
  type WowSelectionLogger,
} from './dispatcher.ts'

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
  ALWAYS_FIRE_FIRST,
  ALWAYS_FIRE_LAST,
  CANDIDATE_IDS,
  getActionModule,
  listDispatchOrder,
} from './catalogue.ts'

export {
  pickWowActions,
  _setCachedSystemPromptForTests,
  type WowSelectorCollectedData,
  type WowSelectorDeps,
  type WowSelectorInput,
  type WowSelectorLogger,
  type WowSelectorResult,
} from './llm-selector.ts'

export {
  WOW_OVERNIGHT_HANDLER_NAME,
  buildWowOvernightHandler,
  composeMorningCheckin,
  registerWowOvernightHandler,
  type BuildWowOvernightHandlerInput,
  type WowOvernightDeliverInput,
} from './overnight-cron.ts'

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
