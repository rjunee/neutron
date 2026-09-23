/** Execution grouping is a persisted planner decision, independent of governance. */
export type ExecutionStrategy = 'single' | 'task_sequence'
export type ExecutionStrategySource = 'planner' | 'legacy'

export function isExecutionStrategy(value: unknown): value is ExecutionStrategy {
  return value === 'single' || value === 'task_sequence'
}

/** Only readers of rows with migration provenance may translate old vocabulary. */
export function legacyCheckpointName(value: string): string {
  return value === 'ralph-task-built' ? 'task-built'
    : value === 'ralph-task-built-deviated' ? 'task-built-deviated'
      : value === 'ralph-plan' ? 'task-plan' : value === 'ralph-task' ? 'task-build' : value
}
