/**
 * @neutronai/tasks/projection — barrel.
 */

export {
  buildProjectionWriter,
  DEFAULT_PROJECTION_DEBOUNCE_MS,
} from './write.ts'

export type {
  ProjectionWriter,
  ProjectionWriterOptions,
  ProjectionContext,
  ProjectionLogEvent,
} from './write.ts'

export {
  renderStatusBlock,
  renderActionsFile,
  formatPriorityTag,
  formatDueDateTag,
} from './format.ts'

export type {
  RenderStatusBlockInput,
  RenderActionsFileInput,
} from './format.ts'

export {
  findMarkedBlock,
  replaceMarkedBlock,
  PROJECTION_BLOCK_START,
  PROJECTION_BLOCK_END,
} from './parse.ts'

export type { MarkedBlockRange } from './parse.ts'
