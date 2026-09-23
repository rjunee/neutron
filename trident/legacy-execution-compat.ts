import { isExecutionStrategy } from './execution-strategy.ts'
import { validateTrailer, type PlanTrailer } from './gates/result-contract.ts'
import type { TridentRun } from './store.ts'

type LegacySelection = Pick<TridentRun, 'execution_strategy' | 'strategy_source'>

/** Stored pre-cutover plans only. Fresh worker output must use the strict schema.
 * Never repair a partial new proposal or override any supplied selection field. */
export function normalizeLegacyStoredExecutionPlan(value: unknown, run: LegacySelection): PlanTrailer | null {
  if (run.strategy_source !== 'legacy' || !isExecutionStrategy(run.execution_strategy)
    || !value || typeof value !== 'object' || Array.isArray(value)
    || 'strategy' in value || 'rationale' in value) return null
  const result = validateTrailer('plan', { ...value, strategy: run.execution_strategy,
    rationale: 'Execution strategy preserved from the legacy run selection.' })
  if (!result.ok) return null
  // The old single-build path ignored the planner's remainder and built the
  // complete change. Validate the original count before translating that meaning;
  // neither malformed evidence nor a task-sequence remainder may be erased.
  return run.execution_strategy === 'single' ? { ...result.value, remainingTasks: 0 } : result.value
}
