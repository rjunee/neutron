import { describe, expect, test } from 'bun:test'
import { decodeSequenceTrace } from './decode.ts'

const ev = (task: unknown, kind: unknown, remainingTasks: unknown): Record<string, unknown> => ({ task, kind, remainingTasks })
const tr = (events: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ runId: 'run-1', taskCount: 3, events, ...overrides })

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

describe('decodeSequenceTrace accepts structurally valid traces', () => {
  test('a two-task completed trace', () => {
    const input = tr([ev(1, 'continued', 1), ev(2, 'merged', 0)], { taskCount: 2 })
    expect(decodeSequenceTrace(input)).toEqual({
      ok: true,
      trace: { runId: 'run-1', taskCount: 2, events: [{ task: 1, kind: 'continued', remainingTasks: 1 }, { task: 2, kind: 'merged', remainingTasks: 0 }] },
    })
  })

  test('a three-task completed trace', () => {
    const input = tr([ev(1, 'continued', 2), ev(2, 'continued', 1), ev(3, 'merged', 0)])
    expect(decodeSequenceTrace(input)).toEqual({
      ok: true,
      trace: {
        runId: 'run-1',
        taskCount: 3,
        events: [
          { task: 1, kind: 'continued', remainingTasks: 2 },
          { task: 2, kind: 'continued', remainingTasks: 1 },
          { task: 3, kind: 'merged', remainingTasks: 0 },
        ],
      },
    })
  })

  test('an empty events array is valid', () => {
    expect(decodeSequenceTrace(tr([]))).toEqual({ ok: true, trace: { runId: 'run-1', taskCount: 3, events: [] } })
  })

  test('extra properties at trace and event level are ignored and absent from the decoded value', () => {
    const result = decodeSequenceTrace({ ...tr([{ ...ev(1, 'continued', 2), note: 'x', at: 7 }]), extra: true, meta: { a: 1 } })
    expect(result).toEqual({ ok: true, trace: { runId: 'run-1', taskCount: 3, events: [{ task: 1, kind: 'continued', remainingTasks: 2 }] } })
    if (!result.ok) throw new Error('expected ok')
    expect(Object.keys(result.trace).sort()).toEqual(['events', 'runId', 'taskCount'])
    expect(Object.keys(result.trace.events[0]!).sort()).toEqual(['kind', 'remainingTasks', 'task'])
  })

  test('taskCount at the maximum safe integer with task 1 is accepted', () => {
    const result = decodeSequenceTrace(tr([ev(1, 'continued', 5)], { taskCount: Number.MAX_SAFE_INTEGER }))
    expect(result.ok).toBe(true)
  })

  test('task equal to taskCount is accepted', () => {
    expect(decodeSequenceTrace(tr([ev(3, 'merged', 0)])).ok).toBe(true)
  })

  test('a large remainingTasks is accepted', () => {
    expect(decodeSequenceTrace(tr([ev(1, 'continued', Number.MAX_SAFE_INTEGER)])).ok).toBe(true)
  })

  test.each([
    ['reordered tasks', [ev(2, 'continued', 1), ev(1, 'continued', 2)]],
    ['duplicated task', [ev(1, 'continued', 2), ev(1, 'continued', 2)]],
    ['premature merge', [ev(1, 'merged', 0)]],
    ['events after merge', [ev(1, 'continued', 2), ev(2, 'continued', 1), ev(3, 'merged', 0), ev(3, 'merged', 0)]],
    ['wrong remaining counts', [ev(1, 'continued', 0), ev(2, 'continued', 9)]],
  ] as const)('field-valid but out-of-sequence events still decode (%s): order is the validator\'s concern', (_label, events) => {
    const result = decodeSequenceTrace(tr(events))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.trace.events).toHaveLength(events.length)
  })
})

describe('decodeSequenceTrace rejects invalid structure with a typed result', () => {
  const fails = { ok: false as const, error: expect.any(String) as string }

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [ev(1, 'continued', 1)]],
    ['a string', '{"runId":"r"}'],
    ['a number', 7],
    ['a boolean', true],
  ] as const)('non-object input: %s', (_label, input) => {
    const result = decodeSequenceTrace(input)
    expect(result).toEqual(fails)
    expect(result).toEqual({ ok: false, error: 'trace: must be an object' })
  })

  const invalidTraces: ReadonlyArray<readonly [string, unknown]> = [
    ['runId missing', { taskCount: 2, events: [] }],
    ['runId empty', tr([], { runId: '' })],
    ['runId leading whitespace', tr([], { runId: ' padded' })],
    ['runId trailing whitespace', tr([], { runId: 'padded ' })],
    ['runId whitespace only', tr([], { runId: '   ' })],
    ['runId number', tr([], { runId: 7 })],
    ['runId null', tr([], { runId: null })],
    ['taskCount missing', { runId: 'r', events: [] }],
    ['taskCount 1', tr([], { taskCount: 1 })],
    ['taskCount 0', tr([], { taskCount: 0 })],
    ['taskCount -2', tr([], { taskCount: -2 })],
    ['taskCount fractional', tr([], { taskCount: 2.5 })],
    ['taskCount NaN', tr([], { taskCount: Number.NaN })],
    ['taskCount Infinity', tr([], { taskCount: Number.POSITIVE_INFINITY })],
    ['taskCount string', tr([], { taskCount: '2' })],
    ['taskCount unsafe', tr([], { taskCount: Number.MAX_SAFE_INTEGER + 1 })],
    ['events missing', { runId: 'r', taskCount: 2 }],
    ['events object', tr({ 0: ev(1, 'continued', 1) })],
    ['events string', tr('[]')],
    ['events null', tr(null)],
  ]
  test.each(invalidTraces)('malformed trace: %s', (_label, input) => {
    const result = decodeSequenceTrace(input)
    expect(result).toEqual(fails)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toMatch(/^trace: /)
  })

  const invalidEvents: ReadonlyArray<readonly [string, unknown]> = [
    ['event null', null],
    ['event array', [1, 'continued', 2]],
    ['event string', 'continued'],
    ['event number', 1],
    ['task missing', { kind: 'continued', remainingTasks: 1 }],
    ['kind missing', { task: 2, remainingTasks: 1 }],
    ['remainingTasks missing', { task: 2, kind: 'continued' }],
    ['task 0', ev(0, 'continued', 1)],
    ['task taskCount + 1', ev(4, 'continued', 1)],
    ['task fractional', ev(1.5, 'continued', 1)],
    ['task string', ev('1', 'continued', 1)],
    ['task NaN', ev(Number.NaN, 'continued', 1)],
    ['kind wrong case', ev(2, 'MERGED', 0)],
    ['kind blocked', ev(2, 'blocked', 1)],
    ['kind empty', ev(2, '', 1)],
    ['kind null', ev(2, null, 1)],
    ['remainingTasks negative', ev(2, 'continued', -1)],
    ['remainingTasks fractional', ev(2, 'continued', 0.5)],
    ['remainingTasks string', ev(2, 'continued', '0')],
    ['remainingTasks null', ev(2, 'continued', null)],
    ['remainingTasks undefined', ev(2, 'continued', undefined)],
  ]
  test.each(invalidEvents)('malformed event: %s', (_label, event) => {
    const result = decodeSequenceTrace(tr([ev(1, 'continued', 2), event]))
    expect(result).toEqual(fails)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toMatch(/^event 1: /)
  })

  test('diagnostics name the location and rule, never input values', () => {
    const sentinel = 'SENTINEL-DO-NOT-ECHO'
    const cases: unknown[] = [
      tr([], { runId: ` ${sentinel}` }),
      tr([], { taskCount: sentinel }),
      tr(sentinel),
      tr([ev(1, sentinel, 2)]),
      tr([ev(sentinel, 'continued', 2)]),
      tr([ev(1, 'continued', sentinel)]),
      tr([sentinel]),
      sentinel,
    ]
    for (const input of cases) {
      const result = decodeSequenceTrace(input)
      if (result.ok) throw new Error('expected failure')
      expect(result.error.length).toBeGreaterThan(0)
      expect(result.error).not.toContain(sentinel)
      expect(result.error).toMatch(/^(trace|event \d+): /)
    }
  })
})

describe('decodeSequenceTrace never mutates its input', () => {
  test('a frozen valid input is read only, unchanged and shares no references with the result', () => {
    const input = deepFreeze(tr([{ ...ev(1, 'continued', 2), extra: [1, 2] }, ev(2, 'continued', 1)], { meta: { a: 1 } }))
    const before = JSON.stringify(input)
    const result = decodeSequenceTrace(input)
    expect(JSON.stringify(input)).toBe(before)
    if (!result.ok) throw new Error('expected ok')
    const events = input['events'] as readonly unknown[]
    expect(result.trace.events).not.toBe(events)
    expect(result.trace.events[0]).not.toBe(events[0])
  })

  test('a frozen invalid input is left untouched on the error path', () => {
    const input = deepFreeze(tr([ev(1, 'continued', 2), ev(2, 'continued', -1)]))
    const before = JSON.stringify(input)
    expect(decodeSequenceTrace(input)).toEqual({ ok: false, error: expect.any(String) })
    expect(JSON.stringify(input)).toBe(before)
  })

  test('a mutable input is not modified and later input edits do not reach the result', () => {
    const events = [ev(1, 'continued', 2)]
    const input = tr(events)
    const result = decodeSequenceTrace(input)
    if (!result.ok) throw new Error('expected ok')
    events[0]!['task'] = 3
    events.push(ev(3, 'merged', 0))
    expect(result.trace.events).toEqual([{ task: 1, kind: 'continued', remainingTasks: 2 }])
    expect(Object.isFrozen(input)).toBe(false)
    expect(Object.isFrozen(events)).toBe(false)
  })

  test('two calls on the same input return equal but distinct objects', () => {
    const input = deepFreeze(tr([ev(1, 'continued', 2)]))
    const first = decodeSequenceTrace(input)
    const second = decodeSequenceTrace(input)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    if (!first.ok || !second.ok) throw new Error('expected ok')
    expect(first.trace).not.toBe(second.trace)
    expect(first.trace.events).not.toBe(second.trace.events)
  })
})
