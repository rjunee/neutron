import { describe, expect, test } from 'bun:test'
import { decodeSequenceTrace, type SequenceEventKind, type SequenceTrace, type SequenceTraceEvent } from './decode.ts'
import { validateSequenceTrace } from './validate.ts'

const ev = (task: number, kind: SequenceEventKind, remainingTasks: number): SequenceTraceEvent => ({ task, kind, remainingTasks })
const tr = (taskCount: number, events: readonly SequenceTraceEvent[]): SequenceTrace => ({ runId: 'run-1', taskCount, events })
const c = (task: number, remainingTasks: number): SequenceTraceEvent => ev(task, 'continued', remainingTasks)
const m = (task: number, remainingTasks: number): SequenceTraceEvent => ev(task, 'merged', remainingTasks)

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

describe('validateSequenceTrace accepts exactly the completed trace', () => {
  test('two-task completed trace is accepted', () => {
    expect(validateSequenceTrace(tr(2, [c(1, 1), m(2, 0)]))).toBe('accepted')
  })

  test('three-task completed trace is accepted', () => {
    expect(validateSequenceTrace(tr(3, [c(1, 2), c(2, 1), m(3, 0)]))).toBe('accepted')
  })
})

describe('validateSequenceTrace reports proper valid prefixes as incomplete', () => {
  test.each([
    ['empty events, two tasks', tr(2, [])],
    ['empty events, three tasks', tr(3, [])],
    ['task one continued of two', tr(2, [c(1, 1)])],
    ['task one continued of three', tr(3, [c(1, 2)])],
    ['tasks one and two continued of three', tr(3, [c(1, 2), c(2, 1)])],
  ] as const)('incomplete prefix: %s', (_label, trace) => {
    expect(validateSequenceTrace(trace)).toBe('incomplete')
  })
})

describe('validateSequenceTrace rejects every out-of-sequence trace', () => {
  test.each([
    ['premature merge at task one of two', tr(2, [m(1, 0)])],
    ['premature merge at task two of three', tr(3, [c(1, 2), m(2, 0)])],
    ['premature merge with a plausible nonzero remainder', tr(2, [m(1, 1)])],
    ['wrong continued count: zero remaining of two', tr(2, [c(1, 0)])],
    ['wrong continued count: two remaining of two', tr(2, [c(1, 2)])],
    ['wrong continued count: one remaining of three', tr(3, [c(1, 1)])],
    ['merged with a nonzero remainder', tr(2, [c(1, 1), m(2, 1)])],
    ['last position continued instead of merged', tr(2, [c(1, 1), c(2, 0)])],
    ['skipped first task', tr(3, [c(2, 1)])],
    ['skipped middle task', tr(3, [c(1, 2), m(3, 0)])],
    ['repeated task', tr(2, [c(1, 1), c(1, 1)])],
    ['reordered tasks', tr(3, [c(2, 1), c(1, 2), m(3, 0)])],
    ['a repeated merge after the merge', tr(2, [c(1, 1), m(2, 0), m(2, 0)])],
    ['a continued event after the merge', tr(2, [c(1, 1), m(2, 0), c(1, 1)])],
    ['more events than tasks with a field-valid tail', tr(2, [c(1, 1), m(2, 0), c(2, 0)])],
    ['a short trace with an invalid prefix is rejected, not incomplete', tr(3, [m(1, 0)])],
  ] as const)('rejected: %s', (_label, trace) => {
    expect(validateSequenceTrace(trace)).toBe('rejected')
  })
})

describe('validateSequenceTrace composes with decodeSequenceTrace (structure vs order)', () => {
  const raw = (taskCount: number, events: unknown[]): unknown => JSON.parse(JSON.stringify({ runId: 'run-1', taskCount, events }))
  const decodeOk = (input: unknown): SequenceTrace => {
    const result = decodeSequenceTrace(input)
    if (!result.ok) throw new Error(`expected decode ok: ${result.error}`)
    return result.trace
  }

  test('a decoded raw two-task completed trace is accepted', () => {
    const trace = decodeOk(raw(2, [
      { task: 1, kind: 'continued', remainingTasks: 1 },
      { task: 2, kind: 'merged', remainingTasks: 0 },
    ]))
    expect(validateSequenceTrace(trace)).toBe('accepted')
  })

  test('a decoded raw two-task prefix is incomplete', () => {
    const trace = decodeOk(raw(2, [{ task: 1, kind: 'continued', remainingTasks: 1 }]))
    expect(validateSequenceTrace(trace)).toBe('incomplete')
  })

  test.each([
    ['reordered tasks', [c(2, 1), c(1, 2)]],
    ['duplicated task', [c(1, 2), c(1, 2)]],
    ['premature merge', [m(1, 0)]],
    ['events after merge', [c(1, 2), c(2, 1), m(3, 0), m(3, 0)]],
    ['wrong remaining counts', [c(1, 0), c(2, 9)]],
  ] as const)('field-valid out-of-sequence rows decode ok and validate rejected: %s', (_label, events) => {
    const trace = decodeOk(raw(3, [...events]))
    expect(trace.events).toHaveLength(events.length)
    expect(validateSequenceTrace(trace)).toBe('rejected')
  })
})

describe('validateSequenceTrace never mutates its input', () => {
  test.each([
    ['accepted', tr(3, [c(1, 2), c(2, 1), m(3, 0)])],
    ['incomplete', tr(3, [c(1, 2)])],
    ['rejected', tr(3, [c(1, 2), m(2, 0)])],
  ] as const)('a deep-frozen %s trace is read only, unchanged and judged the same twice', (verdict, trace) => {
    const input = deepFreeze(structuredClone(trace))
    const before = JSON.stringify(input)
    const first = validateSequenceTrace(input)
    expect(JSON.stringify(input)).toBe(before)
    const second = validateSequenceTrace(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(first).toBe(verdict)
    expect(second).toBe(first)
  })

  test('a mutable trace is not frozen or modified by validation', () => {
    const events = [c(1, 1), m(2, 0)]
    const input = tr(2, events)
    expect(validateSequenceTrace(input)).toBe('accepted')
    expect(Object.isFrozen(input)).toBe(false)
    expect(Object.isFrozen(events)).toBe(false)
    expect(events).toEqual([c(1, 1), m(2, 0)])
  })
})
