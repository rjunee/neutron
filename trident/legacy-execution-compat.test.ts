import { expect, test } from 'bun:test'
import { normalizeLegacyStoredExecutionPlan } from './legacy-execution-compat.ts'
import { validateTrailer } from './gates/result-contract.ts'

const plan = { implementationPlan: '- [ ] T1: Finish', topTask: '- [ ] T1: Finish',
  executionSpec: 'Finish the accepted change', complexity: 'mechanical', remainingTasks: 0 }

for (const strategy of ['single', 'task_sequence'] as const) {
  test(`stored legacy ${strategy} plan retains payload and fixed strategy`, () => {
    const normalized = normalizeLegacyStoredExecutionPlan(plan, { execution_strategy: strategy, strategy_source: 'legacy' })
    expect(normalized).toMatchObject({ ...plan, strategy })
    expect(validateTrailer('plan', normalized).ok).toBe(true)
    expect(validateTrailer('plan', plan).ok).toBe(false)
    expect(plan).not.toHaveProperty('strategy')
  })
  for (const source of ['planner', null] as const) {
    test(`legacy plan cannot invent selection for ${strategy}/${source}`, () => {
      expect(normalizeLegacyStoredExecutionPlan(plan, { execution_strategy: strategy, strategy_source: source })).toBeNull()
    })
  }
}

test('legacy provenance without a selected strategy cannot repair a plan', () => {
  expect(normalizeLegacyStoredExecutionPlan(plan, { execution_strategy: null, strategy_source: 'legacy' })).toBeNull()
})

for (const patch of [{ strategy: 'single' }, { rationale: 'supplied' }, { strategy: undefined },
  { remainingTasks: -1 }, { complexity: 'invented' }, { topTask: '' }, { executionSpec: '' },
  { implementationPlan: '' }, { unknownField: true }]) {
  test(`stored-only normalization refuses malformed or new output ${JSON.stringify(patch)}`, () => {
    expect(normalizeLegacyStoredExecutionPlan({ ...plan, ...patch }, {
      execution_strategy: 'single', strategy_source: 'legacy',
    })).toBeNull()
  })
}

test('optional old branch brief survives but missing required old fields do not', () => {
  const run = { execution_strategy: 'task_sequence' as const, strategy_source: 'legacy' as const }
  expect(normalizeLegacyStoredExecutionPlan({ ...plan, branchBrief: 'Known branch state' }, run)?.branchBrief)
    .toBe('Known branch state')
  const { topTask: _topTask, ...incomplete } = plan
  expect(normalizeLegacyStoredExecutionPlan(incomplete, run)).toBeNull()
})

test('legacy single remainder becomes zero only after validation, preserving stored bytes', () => {
  const old = { ...plan, remainingTasks: 3 }
  const bytes = JSON.stringify(old)
  const normalized = normalizeLegacyStoredExecutionPlan(old, { execution_strategy: 'single', strategy_source: 'legacy' })
  expect(normalized).toMatchObject({ ...old, remainingTasks: 0, strategy: 'single' })
  expect(JSON.stringify(old)).toBe(bytes)
  expect(normalizeLegacyStoredExecutionPlan(old, { execution_strategy: 'task_sequence', strategy_source: 'legacy' }))
    .toMatchObject({ ...old, strategy: 'task_sequence' })
  expect(normalizeLegacyStoredExecutionPlan(old, { execution_strategy: 'single', strategy_source: 'planner' })).toBeNull()
  expect(normalizeLegacyStoredExecutionPlan({ ...old, strategy: 'single', rationale: 'New proposal' }, {
    execution_strategy: 'single', strategy_source: 'legacy',
  })).toBeNull()
})

for (const remainingTasks of [-1, 0.5, '3', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
  test(`legacy single rejects invalid remainder ${String(remainingTasks)} before normalization`, () => {
    expect(normalizeLegacyStoredExecutionPlan({ ...plan, remainingTasks }, {
      execution_strategy: 'single', strategy_source: 'legacy',
    })).toBeNull()
  })
}
