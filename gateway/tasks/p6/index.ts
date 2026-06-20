/**
 * @neutronai/gateway/tasks/p6 — daily nudge + staleness public exports.
 */

export {
  buildNudgePrompt,
  taskToSlateRow,
  NUDGE_RATIONALE_MAX_CHARS,
  NUDGE_SLATE_LLM_LIMIT,
  SKIP_OR_KILL_FLAG_DEFAULT,
  type NudgeContextBundle,
  type NudgeSlateRow,
  type YesterdayCompletion,
} from './nudge-engine-prompt.ts'

export {
  runStalenessPass,
  previousDay,
  parseTop3,
  DEFAULT_DEMOTION_THRESHOLD,
  DEFAULT_DECAY_FACTOR,
  DEFAULT_SKIP_OR_KILL_THRESHOLD,
  type StalenessPassInput,
  type StalenessPassResult,
} from './staleness-engine.ts'

export {
  runNudgePass,
  buildNudgeEngineHandler,
  buildNudgeEngineJob,
  registerNudgeEngineCron,
  parseLlmNudgeResponse,
  clampRationale,
  resolveOwnerDay,
  slateRowFromTask,
  NUDGE_ENGINE_HANDLER_NAME,
  DEFAULT_NUDGE_INTERVAL_MS,
  DEFAULT_NUDGE_TIMEOUT_MS,
  DEFAULT_NUDGE_MODEL,
  DEFAULT_OWNER_TIMEZONE,
  type NudgeEngineHandlerDeps,
  type NudgePassInput,
  type NudgePassOutcome,
} from './nudge-engine.ts'
