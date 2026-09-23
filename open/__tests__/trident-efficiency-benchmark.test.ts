import { expect, test } from 'bun:test'
import { assertEfficient, compareEfficiency, EFFICIENCY_SCENARIOS, EfficiencyTrace, type EfficiencyReport, type EfficiencyScenario } from './fixtures/trident-efficiency-benchmark.ts'

function report(scenario: EfficiencyScenario): EfficiencyReport {
  const rounds = scenario === 'code-fix' || scenario === 'moved-head' ? 2 : 1
  const recovered = ['unchanged-head', 'moved-head', 'interruption', 'pending-interruption'].includes(scenario)
  return { scope: { fixture: 'oracle-control', task: 'Record a note',
    gates: { observed: ['admissionGate', 'reviewGate', 'mergeGate'], suite_strategy: 'full suite', intermediate_strategy: null, max_rounds: 3, merge_mode: 'pr' },
    models: [{ role: 'review', seat: 'adversarial', provider: 'anthropic', requested: 'opus', resolved: 'claude-opus', placement: 'in-repl' }] },
    timing_unit: 'scripted-workload-unit', barrier_complete: true, scenario, scheduling: 'concurrent', counts: { plan: scenario === 'moved-head' ? 2 : 1,
    build: scenario === 'moved-head' ? 2 : 1, fix: scenario === 'code-fix' ? 1 : 0,
    review: rounds * 3, synthesis: rounds, install: recovered ? 2 : 1, verify: recovered ? 3 : 2, proof: rounds },
  decisions: [], intervals: Array.from({ length: rounds * 3 }, (_, index) => ({ stage: `review:${index}`, start: Math.floor(index / 3) * 20, end: Math.floor(index / 3) * 20 + 10 })),
  outcomes: scenario === 'pending-interruption' ? ['blocked', 'merged'] : recovered ? ['unknown', 'merged'] : ['merged'],
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

test('benchmark rejects leaving a completed recoverable request unresolved', () => {
  const valid = report('pending-interruption')
  expect(() => assertEfficient(valid)).not.toThrow()
  valid.outcomes = ['blocked', 'unknown']
  expect(() => assertEfficient(valid)).toThrow('Gate outcome changed')
})

test('benchmark compares equivalent scopes independent of scheduling, call order and duplicate observations', () => {
  const before = report('fresh'), after = structuredClone(before)
  before.scheduling = 'serial-baseline'
  after.scope!.gates.observed.reverse()
  after.scope!.models.push(structuredClone(after.scope!.models[0]!))
  expect(compareEfficiency(before, after)).toEqual({ kind: 'matched' })
  // Unknown scripted usage remains unknown even when the workloads match.
  expect(after.usage).toEqual({ tokens: null, cost: null, source: 'scripted-provider-no-usage' })
})

test.each(['fixture', 'task', 'gates', 'suite', 'intermediate', 'rounds', 'merge', 'role', 'seat', 'provider', 'requested', 'resolved', 'placement', 'scenario', 'missing', 'empty-gates', 'empty-models'] as const)(
  'benchmark reports unmatched scope without claiming a saving: %s', change => {
    const before = report('fresh'), after = structuredClone(before)
    const scope = after.scope!
    if (change === 'fixture') scope.fixture = 'direct-orchestration-other-contract'
    else if (change === 'task') scope.task += ' and another task'
    else if (change === 'gates') scope.gates.observed.pop()
    else if (change === 'suite') scope.gates.suite_strategy = 'subset'
    else if (change === 'intermediate') scope.gates.intermediate_strategy = 'subset'
    else if (change === 'rounds') scope.gates.max_rounds++
    else if (change === 'merge') scope.gates.merge_mode = 'local'
    else if (change === 'scenario') after.scenario = 'code-fix'
    else if (change === 'missing') after.scope = null
    else if (change === 'empty-gates') scope.gates.observed = []
    else if (change === 'empty-models') scope.models = []
    else scope.models[0]![change] = 'changed'
    const reason = change === 'fixture' ? 'scripted fixture' : change === 'task' || change === 'scenario' ? change
      : change === 'missing' ? 'missing scope' : ['gates', 'suite', 'intermediate', 'rounds', 'merge', 'empty-gates'].includes(change) ? 'gates' : 'models'
    expect(compareEfficiency(before, after)).toEqual({ kind: 'unmatched', reasons: [reason] })
    expect(compareEfficiency(after, before)).toEqual({ kind: 'unmatched', reasons: [reason] })
    expect(compareEfficiency(before, structuredClone(before))).toEqual({ kind: 'matched' })
  })

test.each(['decisions', 'outcomes'] as const)('equivalent workload refuses changed %s', field => {
  const before = report('fresh'), after = structuredClone(before)
  after[field].push('blocked')
  expect(() => compareEfficiency(before, after)).toThrow('Equivalent scope changed gate decisions or outcomes')
  after[field] = [...before[field]]
  expect(compareEfficiency(before, after)).toEqual({ kind: 'matched' })
})
