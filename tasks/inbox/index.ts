/**
 * @neutronai/tasks/inbox — barrel.
 *
 * The markdown task surface: a JSONL append-queue (`task-inbox.jsonl`),
 * a scanner that drains it into the canonical `TaskStore`, and the
 * rendered `tasks.md` + `DASHBOARD.md` projections. Models Vajra's
 * markdown-first task workflow on top of the SQLite store.
 */

export {
  parseInbox,
  parseInboxLine,
  priorityTagToStorage,
  ALL_INBOX_ACTIONS,
} from './types.ts'

export type {
  InboxAction,
  PriorityTag,
  InboxRow,
  ParseError,
  ParsedInbox,
} from './types.ts'

export {
  applyInboxRow,
  applyInboxRows,
  listAllTasks,
  TASK_SOURCE_INBOX,
} from './apply.ts'

export type {
  ApplyStatus,
  ApplyOutcome,
  ApplyDeps,
} from './apply.ts'

export {
  effectiveBucket,
  renderTasksMarkdown,
  renderDashboardMarkdown,
  DEFAULT_DONE_WINDOW_DAYS,
} from './render.ts'

export type {
  PriorityBucket,
  RenderTasksMarkdownInput,
  RenderDashboardMarkdownInput,
} from './render.ts'

export {
  appendInboxRow,
  runTaskScan,
} from './scanner.ts'

export type {
  TaskScanPaths,
  RunTaskScanDeps,
  TaskScanResult,
  InboxAppendInput,
} from './scanner.ts'
