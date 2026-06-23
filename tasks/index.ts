export const __MODULE__ = '@neutronai/tasks' as const

export {
  TaskStore,
  TaskNotFoundError,
  ALL_TASK_STATUSES,
  ALL_TASK_ORDERS,
  NO_PROJECT,
  TASK_SOURCE_APP,
  TASK_SOURCE_TASKS_CORE,
  TASK_SOURCE_REMINDER,
  TASK_SOURCE_OVERNIGHT,
  TASK_SOURCE_HISTORY_IMPORT,
  TASK_SOURCE_CHAT,
} from './store.ts'

export type {
  Task,
  TaskStatus,
  TaskStatusFilter,
  TaskOrder,
  TaskMutationKind,
  TaskMutationEvent,
  TaskMutationListener,
  CreateTaskInput,
  UpdateTaskFields,
  ListTasksInput,
} from './store.ts'

export {
  computeFocusScore,
  priorityToFocusScale,
  FOCUS_SCORE_VERSION,
} from './focus-score.ts'

export type { ComputeFocusScoreInput } from './focus-score.ts'

export {
  FOCUS_SCORE_HANDLER_NAME,
  DEFAULT_FOCUS_SCORE_INTERVAL_MS,
  buildFocusScoreRecomputeHandler,
  buildFocusScoreRecomputeJob,
  registerFocusScoreRecomputeCron,
  recomputeFocusScoresForProject,
} from './focus-score-cron.ts'

export type {
  FocusScoreRecomputeHandlerDeps,
  FocusScoreRecomputeResult,
} from './focus-score-cron.ts'

export {
  TASK_PRIORITIZE_HANDLER_NAME,
  DEFAULT_TASK_PRIORITIZE_INTERVAL_MS,
  DEFAULT_TASK_PRIORITIZE_MODEL,
  DEFAULT_TASK_PRIORITIZE_TIMEOUT_MS,
  DEFAULT_TASK_PRIORITIZE_LIMIT,
  PRIORITIZE_SYSTEM_PROMPT,
  prioritizeTasksForProject,
  buildPrioritizeUserPrompt,
  parseRanking,
  buildTaskPrioritizeHandler,
  buildTaskPrioritizeJob,
  registerTaskPrioritizeCron,
} from './prioritize-llm.ts'

export type {
  PrioritizedBy,
  TaskPrioritizeResult,
  PrioritizeTasksForProjectInput,
} from './prioritize-llm.ts'

export {
  TASK_REMINDER_SOURCE,
  createLinkedReminder,
  cancelLinkedReminders,
  updateLinkedReminder,
  listLinkedRemindersForTask,
  attachReminderLinkSubscriber,
} from './reminder-link.ts'

export type {
  TaskReminderLink,
  ReminderLinkContext,
} from './reminder-link.ts'

export {
  buildProjectionWriter,
  PROJECTION_BLOCK_START,
  PROJECTION_BLOCK_END,
  DEFAULT_PROJECTION_DEBOUNCE_MS,
} from './projection/index.ts'

export type {
  ProjectionWriter,
  ProjectionWriterOptions,
  ProjectionContext,
} from './projection/index.ts'

export {
  renderStatusBlock,
  renderActionsFile,
  formatPriorityTag,
  formatDueDateTag,
} from './projection/format.ts'

export {
  findMarkedBlock,
  replaceMarkedBlock,
} from './projection/parse.ts'

export {
  seedTasksFromImportResult,
  priorityHintToInt,
  historyImportTaskHash,
} from './history-import-seeder.ts'

export type {
  SeedTasksFromImportResultInput,
  SeedTasksFromImportResultResult,
} from './history-import-seeder.ts'

export {
  createOvernightReviewTask,
  overnightReviewTaskHash,
  attachOvernightWorkCompletedHook,
} from './overnight-task-hook.ts'

export type {
  OvernightWorkCompletedEvent,
  CreateOvernightReviewTaskInput,
} from './overnight-task-hook.ts'

export {
  parseInbox,
  parseInboxLine,
  priorityTagToStorage,
  ALL_INBOX_ACTIONS,
  applyInboxRow,
  applyInboxRows,
  isTransientStoreError,
  listAllTasks,
  TASK_SOURCE_INBOX,
  effectiveBucket,
  renderTasksMarkdown,
  renderDashboardMarkdown,
  DEFAULT_DONE_WINDOW_DAYS,
  appendInboxRow,
  runTaskScan,
  TaskScanAbortedError,
} from './inbox/index.ts'

export type {
  InboxAction,
  PriorityTag,
  InboxRow,
  ParseError,
  ParsedInbox,
  ApplyStatus,
  ApplyOutcome,
  ApplyDeps,
  PriorityBucket,
  RenderTasksMarkdownInput,
  RenderDashboardMarkdownInput,
  TaskScanPaths,
  RunTaskScanDeps,
  TaskScanResult,
  InboxAppendInput,
} from './inbox/index.ts'
