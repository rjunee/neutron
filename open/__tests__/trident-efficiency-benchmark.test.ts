import { expect, test } from 'bun:test'
import { assertEfficient, EFFICIENCY_SCENARIOS, EfficiencyTrace, type EfficiencyReport, type EfficiencyScenario } from './fixtures/trident-efficiency-benchmark.ts'

function report(scenario: EfficiencyScenario): EfficiencyReport {
  const rounds = scenario === 'code-fix' || scenario === 'moved-head' ? 2 : 1
  const recovered = ['unchanged-head', 'moved-head', 'interruption', 'pending-interruption'].includes(scenario)
  return { timing_unit: 'scripted-workload-unit', barrier_complete: true, scenario, scheduling: 'concurrent', counts: { plan: scenario === 'moved-head' ? 2 : 1,
    build: scenario === 'moved-head' ? 2 : 1, fix: scenario === 'code-fix' ? 1 : 0,
    review: rounds * 3, synthesis: rounds, install: recovered ? 2 : 1, verify: recovered ? 3 : 2, proof: rounds },
  decisions: [], intervals: Array.from({ length: rounds * 3 }, (_, index) => ({ stage: `review:${index}`, start: Math.floor(index / 3) * 20, end: Math.floor(index / 3) * 20 + 10 })),
  outcomes: scenario === 'pending-interruption' ? ['blocked', 'unknown'] : recovered ? ['unknown', 'merged'] : ['merged'],
  usage: { tokens: null, cost: null, source: 'scripted-provider-no-usage' } }
}

test.each([...EFFICIENCY_SCENARIOS])('benchmark oracle accepts required work and rejects redispatch or skipped work: %s', scenario => {
  const valid = report(scenario)
  expect(() => assertEfficient(valid)).not.toThrow()
  for (const direction of [-1, 1]) {
    const changed = structuredClone(valid)
    changed.counts.build += direction
    expect(() => assertEfficient(changed)).toThrow('Unexpected build dispatch count')
    for (const key of ['install', 'verify', 'proof'] as const) {
      const changedPreparation = structuredClone(valid)
      changedPreparation.counts[key] += direction
      expect(() => assertEfficient(changedPreparation)).toThrow('Unexpected preparation or proof count')
    }
  }
})

test('benchmark oracle refuses a serial or missing review but permits concurrent intervals', () => {
  const valid = report('fresh')
  expect(() => assertEfficient(valid)).not.toThrow()
  const serial = structuredClone(valid)
  serial.intervals.forEach((value, index) => { value.start = index * 10; value.end = (index + 1) * 10 })
  expect(() => assertEfficient(serial)).toThrow('Independent reviews serialized')
  const absent = structuredClone(valid)
  absent.intervals = []
  expect(() => assertEfficient(absent)).toThrow('Missing review interval')
})

test('workload clock joins overlapping intervals without summing them as elapsed time', () => {
  const trace = new EfficiencyTrace()
  const first = trace.begin('first', 10), second = trace.begin('second', 20)
  first(); second(); trace.begin('after', 1)()
  expect(trace.intervals).toEqual([{ stage: 'first', start: 0, end: 10 }, { stage: 'second', start: 0, end: 20 }, { stage: 'after', start: 20, end: 21 }])
})

test('benchmark rejects a changed outcome, including a falsely merged interrupted run', () => {
  const valid = report('pending-interruption')
  expect(() => assertEfficient(valid)).not.toThrow()
  valid.outcomes = ['blocked', 'merged']
  expect(() => assertEfficient(valid)).toThrow('Gate outcome changed')
})
