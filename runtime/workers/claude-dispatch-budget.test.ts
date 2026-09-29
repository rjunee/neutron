import { expect, test } from 'bun:test'
import { ClaudeDispatchBudget } from './claude-dispatch-budget.ts'

test('only measured writer queue wait is reimbursed once; preparation still costs time', () => {
  let now = 30
  const budget = new ClaudeDispatchBudget(100, () => now)
  const end = budget.beginQueue(new AbortController().signal)
  now = 80
  end()
  expect(budget.deadline_ms).toBe(150)
  expect(budget.deadline_ms - now).toBe(70)
  now = 120
  end()
  expect(budget.deadline_ms).toBe(150)
  expect(() => budget.beginQueue(new AbortController().signal)).toThrow('already consumed')
})

test.each(['expiry', 'late', 'cancelled'] as const)('queue %s cannot acquire execution time', scenario => {
  let now = 30
  const budget = new ClaudeDispatchBudget(100, () => now)
  const controller = new AbortController()
  const end = budget.beginQueue(controller.signal)
  now = scenario === 'expiry' ? 100 : scenario === 'late' ? 150 : 80
  if (scenario === 'cancelled') controller.abort()
  end()
  expect(budget.deadline_ms).toBe(100)
})
