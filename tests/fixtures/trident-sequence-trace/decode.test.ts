import { describe, expect, test } from 'bun:test'
import { decodeSequenceTrace, type SequenceTrace, type TraceDecodeResult } from './decode.ts'

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function decoded(input: unknown): SequenceTrace {
  const result = decodeSequenceTrace(input)
  if (!result.ok) throw new Error(`expected an accepted trace, got: ${result.reason}`)
  return result.trace
}

// The expected accepted result for an exact plain-data trace literal.
function accepted(trace: unknown): TraceDecodeResult {
  return { ok: true, trace: trace as SequenceTrace }
}

function reasonOf(input: unknown): string {
  const result = decodeSequenceTrace(input)
  if (result.ok) throw new Error('expected a refused trace')
  return result.reason
}

const SENTINEL = 'SENTINEL-DO-NOT-ECHO'
const RUN_ID = 'run-fixture-1'

// Every reason the decoder can produce, and nothing else.
const REASON_GRAMMAR =
  /^(input is not an object|input could not be read|runId is not a nonempty trimmed string|taskCount is not a safe integer of at least two|events is not an array|event \d+: (not an object|task is not a safe integer from one through taskCount|kind is not continued or merged|remainingTasks is not a nonnegative safe integer))$/

const TWO_TASK_COMPLETED = {
  runId: RUN_ID,
  taskCount: 2,
  events: [
    { task: 1, kind: 'continued', remainingTasks: 1 },
    { task: 2, kind: 'merged', remainingTasks: 0 },
  ],
}

function withEvent(event: unknown, taskCount = 3): unknown {
  return { runId: RUN_ID, taskCount, events: [event] }
}

const VALID_EVENT = { task: 1, kind: 'continued', remainingTasks: 2 }

describe('decodeSequenceTrace accepts the structure', () => {
  test('a two-task completed trace decodes exactly', () => {
    expect(decodeSequenceTrace(TWO_TASK_COMPLETED)).toEqual(accepted(TWO_TASK_COMPLETED))
  })

  test('a three-task trace decodes exactly', () => {
    const trace = {
      runId: RUN_ID,
      taskCount: 3,
      events: [
        { task: 1, kind: 'continued', remainingTasks: 2 },
        { task: 2, kind: 'continued', remainingTasks: 1 },
        { task: 3, kind: 'merged', remainingTasks: 0 },
      ],
    }
    expect(decodeSequenceTrace(trace)).toEqual(accepted(trace))
  })

  test('an empty events array is structurally valid', () => {
    expect(decodeSequenceTrace({ runId: RUN_ID, taskCount: 2, events: [] })).toEqual({
      ok: true,
      trace: { runId: RUN_ID, taskCount: 2, events: [] },
    })
  })

  test('boundary values: task one, task equal to taskCount, zero remaining, maximum safe taskCount', () => {
    const max = Number.MAX_SAFE_INTEGER
    const trace = {
      runId: RUN_ID,
      taskCount: max,
      events: [
        { task: 1, kind: 'continued', remainingTasks: 0 },
        { task: max, kind: 'merged', remainingTasks: max },
      ],
    }
    expect(decodeSequenceTrace(trace)).toEqual(accepted(trace))
    expect(decoded(withEvent({ task: 3, kind: 'merged', remainingTasks: 0 })).events).toEqual([
      { task: 3, kind: 'merged', remainingTasks: 0 },
    ])
  })

  test('runId is retained byte-for-byte, including internal whitespace and unicode', () => {
    const runId = 'run  with\tinner — café'
    expect(decoded({ runId, taskCount: 2, events: [] }).runId).toBe(runId)
  })
})

describe('decodeSequenceTrace judges structure, not sequence order', () => {
  test.each([
    ['merged first', [{ task: 1, kind: 'merged', remainingTasks: 0 }, { task: 2, kind: 'continued', remainingTasks: 0 }]],
    ['a repeated task', [{ task: 1, kind: 'continued', remainingTasks: 2 }, { task: 1, kind: 'continued', remainingTasks: 2 }]],
    ['a reordered trace', [{ task: 2, kind: 'continued', remainingTasks: 1 }, { task: 1, kind: 'continued', remainingTasks: 2 }]],
    ['remainingTasks disagreeing with the task', [{ task: 1, kind: 'continued', remainingTasks: 7 }]],
    ['events after a merge', [{ task: 3, kind: 'merged', remainingTasks: 0 }, { task: 3, kind: 'continued', remainingTasks: 0 }]],
  ])('%s decodes ok', (_label, events) => {
    const input = { runId: RUN_ID, taskCount: 3, events }
    expect(decodeSequenceTrace(input)).toEqual(accepted(input))
  })
})

describe('decodeSequenceTrace ignores and drops extra properties', () => {
  test('extra top-level and per-event properties are absent from the output', () => {
    const trace = decoded({
      runId: RUN_ID,
      taskCount: 2,
      extra: 'top',
      events: [{ task: 1, kind: 'continued', remainingTasks: 1, note: 'event', [SENTINEL]: true }],
    })
    expect(Object.keys(trace).sort()).toEqual(['events', 'runId', 'taskCount'])
    expect(Object.keys(trace.events[0]!).sort()).toEqual(['kind', 'remainingTasks', 'task'])
    expect(trace).toEqual({ runId: RUN_ID, taskCount: 2, events: [{ task: 1, kind: 'continued', remainingTasks: 1 }] })
  })
})

describe('decodeSequenceTrace refuses with the exact reason', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['number', 3],
    ['string', 'trace'],
    ['boolean', true],
    ['array', [TWO_TASK_COMPLETED]],
    ['function', () => TWO_TASK_COMPLETED],
    ['symbol', Symbol('trace')],
    ['bigint', 2n],
  ])('non-object input: %s', (_label, input) => {
    expect(decodeSequenceTrace(input)).toEqual({ ok: false, reason: 'input is not an object' })
  })

  const runIdCases: [string, Record<string, unknown>][] = [
    ['missing', { taskCount: 2, events: [] }],
    ['empty', { runId: '', taskCount: 2, events: [] }],
    ['whitespace only', { runId: '   ', taskCount: 2, events: [] }],
    ['leading whitespace', { runId: ' x', taskCount: 2, events: [] }],
    ['trailing whitespace', { runId: 'x ', taskCount: 2, events: [] }],
    ['number', { runId: 7, taskCount: 2, events: [] }],
    ['null', { runId: null, taskCount: 2, events: [] }],
  ]
  test.each(runIdCases)('runId %s', (_label, input) => {
    expect(decodeSequenceTrace(input)).toEqual({ ok: false, reason: 'runId is not a nonempty trimmed string' })
  })

  const taskCountCases: [string, unknown][] = [
    ['one', 1],
    ['zero', 0],
    ['negative', -2],
    ['fractional', 2.5],
    ['string', '3'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['2**53', 2 ** 53],
    ['null', null],
  ]
  test('taskCount missing', () => {
    expect(decodeSequenceTrace({ runId: RUN_ID, events: [] })).toEqual({
      ok: false,
      reason: 'taskCount is not a safe integer of at least two',
    })
  })
  test.each(taskCountCases)('taskCount %s', (_label, taskCount) => {
    expect(decodeSequenceTrace({ runId: RUN_ID, taskCount, events: [] })).toEqual({
      ok: false,
      reason: 'taskCount is not a safe integer of at least two',
    })
  })

  test('events missing', () => {
    expect(decodeSequenceTrace({ runId: RUN_ID, taskCount: 2 })).toEqual({ ok: false, reason: 'events is not an array' })
  })
  test.each([
    ['object', { 0: VALID_EVENT, length: 1 }],
    ['string', '[]'],
    ['null', null],
  ])('events %s', (_label, events) => {
    expect(decodeSequenceTrace({ runId: RUN_ID, taskCount: 2, events })).toEqual({ ok: false, reason: 'events is not an array' })
  })

  test.each([
    ['null', null],
    ['array', [1, 'continued', 2]],
    ['string', 'event'],
    ['number', 1],
  ])('event element %s', (_label, element) => {
    expect(decodeSequenceTrace(withEvent(element))).toEqual({ ok: false, reason: 'event 0: not an object' })
  })

  test('event element hole in a sparse array', () => {
    // eslint-disable-next-line no-sparse-arrays
    const events = [VALID_EVENT, , VALID_EVENT]
    expect(decodeSequenceTrace({ runId: RUN_ID, taskCount: 3, events })).toEqual({ ok: false, reason: 'event 1: not an object' })
  })

  const taskCases: [string, Record<string, unknown>][] = [
    ['zero', { task: 0, kind: 'continued', remainingTasks: 2 }],
    ['taskCount plus one', { task: 4, kind: 'continued', remainingTasks: 2 }],
    ['fractional', { task: 1.5, kind: 'continued', remainingTasks: 2 }],
    ['string', { task: '1', kind: 'continued', remainingTasks: 2 }],
    ['missing', { kind: 'continued', remainingTasks: 2 }],
    ['NaN', { task: Number.NaN, kind: 'continued', remainingTasks: 2 }],
  ]
  test.each(taskCases)('task %s', (_label, event) => {
    expect(decodeSequenceTrace(withEvent(event, 3))).toEqual({
      ok: false,
      reason: 'event 0: task is not a safe integer from one through taskCount',
    })
  })

  const kindCases: [string, Record<string, unknown>][] = [
    ['missing', { task: 1, remainingTasks: 2 }],
    ['wrong case', { task: 1, kind: 'Merged', remainingTasks: 2 }],
    ['near miss', { task: 1, kind: 'continue', remainingTasks: 2 }],
    ['empty', { task: 1, kind: '', remainingTasks: 2 }],
    ['null', { task: 1, kind: null, remainingTasks: 2 }],
  ]
  test.each(kindCases)('kind %s', (_label, event) => {
    expect(decodeSequenceTrace(withEvent(event))).toEqual({ ok: false, reason: 'event 0: kind is not continued or merged' })
  })

  const remainingCases: [string, Record<string, unknown>][] = [
    ['negative', { task: 1, kind: 'continued', remainingTasks: -1 }],
    ['fractional', { task: 1, kind: 'continued', remainingTasks: 0.5 }],
    ['string', { task: 1, kind: 'continued', remainingTasks: '0' }],
    ['missing', { task: 1, kind: 'continued' }],
    ['Infinity', { task: 1, kind: 'continued', remainingTasks: Number.POSITIVE_INFINITY }],
    ['2**53', { task: 1, kind: 'continued', remainingTasks: 2 ** 53 }],
  ]
  test.each(remainingCases)('remainingTasks %s', (_label, event) => {
    expect(decodeSequenceTrace(withEvent(event))).toEqual({
      ok: false,
      reason: 'event 0: remainingTasks is not a nonnegative safe integer',
    })
  })
})

describe('decodeSequenceTrace reports the first violation', () => {
  test('a bad runId and a bad taskCount report runId', () => {
    expect(reasonOf({ runId: ' ', taskCount: 1, events: 'x' })).toBe('runId is not a nonempty trimmed string')
  })

  test('a bad taskCount and bad events report taskCount', () => {
    expect(reasonOf({ runId: RUN_ID, taskCount: 1, events: 'x' })).toBe('taskCount is not a safe integer of at least two')
  })

  test('a valid event 0 and a bad event 1 report event 1', () => {
    expect(reasonOf({ runId: RUN_ID, taskCount: 3, events: [VALID_EVENT, { task: 1, kind: 'bad', remainingTasks: 0 }] }))
      .toBe('event 1: kind is not continued or merged')
  })

  test('a bad event 0 wins over a bad event 1', () => {
    expect(reasonOf({ runId: RUN_ID, taskCount: 3, events: [{ task: 9, kind: 'continued', remainingTasks: 0 }, null] }))
      .toBe('event 0: task is not a safe integer from one through taskCount')
  })

  test('within one event a bad task beats a bad kind, and a bad kind beats a bad remainingTasks', () => {
    expect(reasonOf(withEvent({ task: 0, kind: 'nope', remainingTasks: -1 }))).toBe(
      'event 0: task is not a safe integer from one through taskCount',
    )
    expect(reasonOf(withEvent({ task: 1, kind: 'nope', remainingTasks: -1 }))).toBe('event 0: kind is not continued or merged')
  })
})

describe('decodeSequenceTrace never echoes input', () => {
  const echoCases: [string, unknown][] = [
    ['runId', { runId: ` ${SENTINEL} `, taskCount: 2, events: [] }],
    ['kind', withEvent({ task: 1, kind: SENTINEL, remainingTasks: 0 })],
    ['task string', withEvent({ task: SENTINEL, kind: 'continued', remainingTasks: 0 })],
    ['remainingTasks string', withEvent({ task: 1, kind: 'merged', remainingTasks: SENTINEL })],
    ['taskCount string', { runId: RUN_ID, taskCount: SENTINEL, events: [] }],
    ['events string', { runId: RUN_ID, taskCount: 2, events: SENTINEL }],
    ['element string', withEvent(SENTINEL)],
  ]
  test.each(echoCases)('a sentinel in %s is not in the reason, which matches the fixed grammar', (_label, input) => {
    const reason = reasonOf(input)
    expect(reason).not.toContain(SENTINEL)
    expect(reason).not.toContain('SENTINEL')
    expect(reason).toMatch(REASON_GRAMMAR)
  })
})

describe('decodeSequenceTrace never throws', () => {
  test('a Proxy whose get trap throws', () => {
    const input = new Proxy(
      {},
      {
        get() {
          throw new Error(SENTINEL)
        },
      },
    )
    expect(decodeSequenceTrace(input)).toEqual({ ok: false, reason: 'input could not be read' })
  })

  test('an object with a throwing runId getter', () => {
    const input = {
      get runId(): string {
        throw new Error(SENTINEL)
      },
      taskCount: 2,
      events: [],
    }
    expect(decodeSequenceTrace(input)).toEqual({ ok: false, reason: 'input could not be read' })
  })

  test('an events array whose element getter throws', () => {
    const events: unknown[] = [VALID_EVENT]
    Object.defineProperty(events, 1, {
      get() {
        throw new Error(SENTINEL)
      },
      enumerable: true,
    })
    expect(decodeSequenceTrace({ runId: RUN_ID, taskCount: 3, events })).toEqual({ ok: false, reason: 'input could not be read' })
  })

  test('an event with a throwing remainingTasks getter', () => {
    const event = {
      task: 1,
      kind: 'continued',
      get remainingTasks(): number {
        throw new Error(SENTINEL)
      },
    }
    expect(decodeSequenceTrace(withEvent(event))).toEqual({ ok: false, reason: 'input could not be read' })
  })
})

describe('decodeSequenceTrace never mutates input and returns fresh objects', () => {
  test('a deep-frozen valid input decodes ok and serializes unchanged', () => {
    const input = deepFreeze(structuredClone(TWO_TASK_COMPLETED))
    const before = JSON.stringify(input)
    expect(decodeSequenceTrace(input)).toEqual(accepted(TWO_TASK_COMPLETED))
    expect(JSON.stringify(input)).toBe(before)
  })

  test('a non-frozen input is unchanged after decoding, including extra properties', () => {
    const input = {
      runId: RUN_ID,
      taskCount: 3,
      extra: { nested: [1, 2] },
      events: [
        { task: 2, kind: 'continued', remainingTasks: 1, note: 'x' },
        { task: 1, kind: 'merged', remainingTasks: 0 },
      ],
    }
    const snapshot = structuredClone(input)
    decoded(input)
    expect(input).toEqual(snapshot)
  })

  test('a refused input is unchanged after decoding', () => {
    const input = { runId: RUN_ID, taskCount: 3, events: [VALID_EVENT, { task: 9, kind: 'merged', remainingTasks: 0 }] }
    const snapshot = structuredClone(input)
    reasonOf(input)
    expect(input).toEqual(snapshot)
  })

  test('the output trace, events array and event objects are not the input objects', () => {
    const input = structuredClone(TWO_TASK_COMPLETED)
    const trace = decoded(input)
    expect(trace).not.toBe(input as unknown as SequenceTrace)
    expect(trace.events).not.toBe(input.events as unknown as SequenceTrace['events'])
    trace.events.forEach((event, index) => {
      expect(event).not.toBe(input.events[index] as unknown as typeof event)
      expect(event).toEqual(input.events[index] as unknown as typeof event)
    })
  })

  test('mutating the output does not change the input', () => {
    const input = structuredClone(TWO_TASK_COMPLETED)
    const snapshot = structuredClone(input)
    const trace = decoded(input)
    const events = trace.events as { task: number; kind: string; remainingTasks: number }[]
    events.push({ task: 2, kind: 'merged', remainingTasks: 0 })
    events[0]!.task = 99
    events[0]!.kind = 'merged'
    ;(trace as { runId: string }).runId = 'changed'
    expect(input).toEqual(snapshot)
  })

  test('mutating the input after decoding does not change a previously returned trace', () => {
    const input = structuredClone(TWO_TASK_COMPLETED)
    const trace = decoded(input)
    const snapshot = structuredClone(trace)
    input.events[0]!.task = 2
    input.events[1]!.kind = 'continued'
    input.events.push({ task: 1, kind: 'continued', remainingTasks: 1 })
    input.runId = 'changed'
    expect(trace).toEqual(snapshot)
  })

  test('two decodes of one input are equal but not the same objects', () => {
    const input = structuredClone(TWO_TASK_COMPLETED)
    const first = decodeSequenceTrace(input)
    const second = decodeSequenceTrace(input)
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    if (!first.ok || !second.ok) throw new Error('expected both decodes to accept')
    expect(first.trace).not.toBe(second.trace)
    expect(first.trace.events).not.toBe(second.trace.events)
    expect(first.trace.events[0]).not.toBe(second.trace.events[0])
  })
})
