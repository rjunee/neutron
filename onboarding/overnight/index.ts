/**
 * @neutronai/onboarding/overnight — public barrel.
 *
 * The real Autonomous Overnight-Work engine: a chat-driven `overnight_queue`
 * (SQLite runtime truth) rendered into each project's agent-maintained
 * STATUS.md `## Autonomous Overnight Work` block, where each queued item runs
 * AS a Trident run (`code_trident_runs`) driven Forge→Argus→merge, and the
 * morning brief reports the REAL terminal result of every run.
 */

export const __MODULE__ = '@neutronai/onboarding/overnight' as const

export {
  OvernightQueueStore,
  nextOwkId,
  owkDatePrefix,
} from './queue-store.ts'
export type {
  OvernightItem,
  OvernightAgentRole,
  OvernightPriority,
  OvernightStatus,
  CreateOvernightItemInput,
  OvernightItemUpdate,
} from './queue-store.ts'

export {
  OVERNIGHT_SECTION_HEADING,
  OVERNIGHT_OPT_IN_KEY,
  MAX_CONTEXT_FILE_BYTES,
  parseOvernightLine,
  parseOvernightSection,
  parseOptInFlag,
  resolveContextFile,
  checkContextGate,
  renderOvernightLine,
  renderOvernightSection,
  spliceOvernightSection,
  syncStatusMdSection,
} from './status-md-sync.ts'
export type {
  ParsedBullet,
  ContextResolution,
  ContextGateResult,
  ContextGateRejectionReason,
  StatusMdIO,
} from './status-md-sync.ts'

export {
  OvernightDispatcher,
  inOvernightWindow,
  currentWindowDate,
  localParts,
  shouldReport,
  tridentSlugFor,
  successResult,
  envMaxConcurrent,
  envMaxPerWindow,
  DEFAULT_TZ,
  WINDOW_OPEN_HOUR,
  WINDOW_CLOSE_HOUR,
  MAX_CONCURRENT_DEFAULT,
  MAX_PER_WINDOW_DEFAULT,
} from './dispatcher.ts'
export type {
  OvernightDispatcherDeps,
  OvernightTridentSeam,
  OvernightTridentCreateInput,
  OvernightTridentHandle,
  OvernightTridentSnapshot,
  OptedInProject,
  ResultDocWriter,
  RejectionSink,
  ScanResult,
  AdvanceResult,
} from './dispatcher.ts'

export {
  runMorningBrief,
  composeGeneralSummary,
  composeProjectDetail,
  selectWindowTransitions,
} from './morning-brief.ts'
export type {
  MorningBriefDeps,
  MorningBriefResult,
  MorningBriefDeliverInput,
} from './morning-brief.ts'

export {
  OVERNIGHT_HANDLER_NAME,
  buildOvernightEngineHandler,
  registerOvernightHandler,
  buildOvernightTridentSeam,
  enumerateOptedInProjects,
  defaultStatusMdIO,
  defaultResultDocWriter,
} from './register.ts'
export type {
  BuildOvernightEngineInput,
  OvernightEngineDeliver,
} from './register.ts'
