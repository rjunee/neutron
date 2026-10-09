import { describe, expect, test } from 'bun:test'
import { decodeSequenceTrace, type SequenceEventKind, type SequenceTrace } from './decode.ts'
import { validateCompletedSequence, type SequenceValidation } from './validate.ts'

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

type RawEvent = { task: number; kind: SequenceEventKind; remainingTasks: number }

const RUN_ID = 'run-fixture-1'
const SENTINEL = 'SENTINEL-DO-NOT-ECHO'

// Every reason the validator can produce, and nothing else.
const REASON_GRAMMAR =
  /^(trace could not be read|event \d+: (follows the merge|task is not the next task|final task did not merge|merged before the final task|remainingTasks does not match the task))$/

/** Builds a trace through the real T1 decoder, so every fixture is structurally valid. */
function trace(taskCount: number, events: readonly RawEvent[], runId = RUN_ID): SequenceTrace {
  const result = decodeSequenceTrace({ runId, taskCount, events })
  if (!result.ok) throw new Error(`fixture trace did not decode: ${result.reason}`)
  return result.trace
}

/** The exact legitimate event list for an N-task sequence. */
function completed(taskCount: number): RawEvent[] {
  const events: RawEvent[] = []
  for (let task = 1; task <= taskCount; task += 1) {
    events.push({ task, kind: task === taskCount ? 'merged' : 'continued', remainingTasks: taskCount - task })
  }
  return events
}

function reasonOf(result: SequenceValidation): string {
  if (result.status !== 'rejected') throw new Error(`expected a rejected trace, got ${result.status}`)
  return result.reason
}

describe('validateCompletedSequence accepts a completed sequence', () => {
  test.each([2, 3, 5])('a %i-task completed sequence is accepted exactly', (taskCount) => {
    expect(validateCompletedSequence(trace(taskCount, completed(taskCount)))).toEqual({
      status: 'accepted',
      runId: RUN_ID,
      taskCount,
    })
  })

  test('the literal three-task sequence: remaining two, then one, then zero at the merge', () => {
    const events: RawEvent[] = [
      { task: 1, kind: 'continued', remainingTasks: 2 },
      { task: 2, kind: 'continued', remainingTasks: 1 },
      { task: 3, kind: 'merged', remainingTasks: 0 },
    ]
    expect(validateCompletedSequence(trace(3, events))).toEqual({ status: 'accepted', runId: RUN_ID, taskCount: 3 })
  })

  test('runId is retained byte-for-byte, including internal whitespace and unicode', () => {
    const runId = 'run  with\tinner — café'
    expect(validateCompletedSequence(trace(2, completed(2), runId))).toEqual({ status: 'accepted', runId, taskCount: 2 })
  })
})

describe('validateCompletedSequence reports every proper prefix as incomplete', () => {
  for (const taskCount of [2, 3, 5]) {
    for (let length = 0; length < taskCount; length += 1) {
      test(`${length} of ${taskCount} events is incomplete with next task ${length + 1}`, () => {
        expect(validateCompletedSequence(trace(taskCount, completed(taskCount).slice(0, length)))).toEqual({
          status: 'incomplete',
          runId: RUN_ID,
          taskCount,
          completedTasks: length,
          nextTask: length + 1,
        })
      })
    }
  }

  test('an empty trace of a very large sequence is incomplete at task one', () => {
    const max = Number.MAX_SAFE_INTEGER
    expect(validateCompletedSequence(trace(max, []))).toEqual({
      status: 'incomplete',
      runId: RUN_ID,
      taskCount: max,
      completedTasks: 0,
      nextTask: 1,
    })
  })

  test('a prefix is never accepted: only the full length is', () => {
    const statuses = [0, 1, 2, 3].map((length) => validateCompletedSequence(trace(3, completed(3).slice(0, length))).status)
    expect(statuses).toEqual(['incomplete', 'incomplete', 'incomplete', 'accepted'])
  })
})

describe('validateCompletedSequence rejects every other sequence with the exact reason', () => {
  test.each<[string, number, RawEvent[], string]>([
    ['merged first', 3, [{ task: 1, kind: 'merged', remainingTasks: 0 }], 'event 0: merged before the final task'],
    [
      'merged at a middle task',
      3,
      [{ task: 1, kind: 'continued', remainingTasks: 2 }, { task: 2, kind: 'merged', remainingTasks: 1 }],
      'event 1: merged before the final task',
    ],
    [
      'a repeated task',
      3,
      [{ task: 1, kind: 'continued', remainingTasks: 2 }, { task: 1, kind: 'continued', remainingTasks: 2 }],
      'event 1: task is not the next task',
    ],
    [
      'a skipped task',
      3,
      [{ task: 1, kind: 'continued', remainingTasks: 2 }, { task: 3, kind: 'merged', remainingTasks: 0 }],
      'event 1: task is not the next task',
    ],
    [
      'a reordered trace',
      3,
      [{ task: 2, kind: 'continued', remainingTasks: 1 }, { task: 1, kind: 'continued', remainingTasks: 2 }],
      'event 0: task is not the next task',
    ],
    ['a sequence starting at task two', 3, [{ task: 2, kind: 'continued', remainingTasks: 1 }], 'event 0: task is not the next task'],
    [
      'the final task continued instead of merging',
      2,
      [{ task: 1, kind: 'continued', remainingTasks: 1 }, { task: 2, kind: 'continued', remainingTasks: 0 }],
      'event 1: final task did not merge',
    ],
    [
      'remainingTasks one too many',
      3,
      [{ task: 1, kind: 'continued', remainingTasks: 3 }],
      'event 0: remainingTasks does not match the task',
    ],
    [
      'remainingTasks one too few',
      3,
      [{ task: 1, kind: 'continued', remainingTasks: 1 }],
      'event 0: remainingTasks does not match the task',
    ],
    [
      'an intermediate task claiming zero remaining',
      3,
      [{ task: 1, kind: 'continued', remainingTasks: 2 }, { task: 2, kind: 'continued', remainingTasks: 0 }],
      'event 1: remainingTasks does not match the task',
    ],
    [
      'a merge claiming work remaining',
      2,
      [{ task: 1, kind: 'continued', remainingTasks: 1 }, { task: 2, kind: 'merged', remainingTasks: 1 }],
      'event 1: remainingTasks does not match the task',
    ],
    ['a repeated merge', 2, [...completed(2), { task: 2, kind: 'merged', remainingTasks: 0 }], 'event 2: follows the merge'],
    ['a continuation after the merge', 2, [...completed(2), { task: 1, kind: 'continued', remainingTasks: 1 }], 'event 2: follows the merge'],
    [
      'two events after a three-task merge',
      3,
      [...completed(3), { task: 3, kind: 'merged', remainingTasks: 0 }, { task: 1, kind: 'continued', remainingTasks: 2 }],
      'event 3: follows the merge',
    ],
  ])('%s', (_label, taskCount, events, reason) => {
    const result = validateCompletedSequence(trace(taskCount, events))
    expect(result).toEqual({ status: 'rejected', reason })
    expect(result).not.toHaveProperty('runId')
  })

  test('every structure-only trace the decoder admits but a sequence forbids is rejected', () => {
    // These decode ok (decode.test.ts pins that); order is this validator's job.
    const structureOnly: RawEvent[][] = [
      [{ task: 1, kind: 'merged', remainingTasks: 0 }, { task: 2, kind: 'continued', remainingTasks: 0 }],
      [{ task: 1, kind: 'continued', remainingTasks: 2 }, { task: 1, kind: 'continued', remainingTasks: 2 }],
      [{ task: 2, kind: 'continued', remainingTasks: 1 }, { task: 1, kind: 'continued', remainingTasks: 2 }],
      [{ task: 1, kind: 'continued', remainingTasks: 7 }],
      [{ task: 3, kind: 'merged', remainingTasks: 0 }, { task: 3, kind: 'continued', remainingTasks: 0 }],
    ]
    for (const events of structureOnly) {
      expect(reasonOf(validateCompletedSequence(trace(3, events)))).toMatch(REASON_GRAMMAR)
    }
  })
})

describe('validateCompletedSequence reports the first violation', () => {
  test('a bad event 0 wins over a bad event 1', () => {
    const events: RawEvent[] = [{ task: 1, kind: 'continued', remainingTasks: 9 }, { task: 3, kind: 'merged', remainingTasks: 0 }]
    expect(reasonOf(validateCompletedSequence(trace(3, events)))).toBe('event 0: remainingTasks does not match the task')
  })

  test('within one event a bad task beats a bad kind, and a bad kind beats a bad remainingTasks', () => {
    expect(reasonOf(validateCompletedSequence(trace(3, [{ task: 2, kind: 'merged', remainingTasks: 9 }])))).toBe(
      'event 0: task is not the next task',
    )
    expect(reasonOf(validateCompletedSequence(trace(3, [{ task: 1, kind: 'merged', remainingTasks: 9 }])))).toBe(
      'event 0: merged before the final task',
    )
    expect(
      reasonOf(validateCompletedSequence(trace(2, [{ task: 1, kind: 'continued', remainingTasks: 1 }, { task: 2, kind: 'continued', remainingTasks: 5 }]))),
    ).toBe('event 1: final task did not merge')
  })

  test('an earlier violation wins over events after the merge', () => {
    const events: RawEvent[] = [{ task: 1, kind: 'continued', remainingTasks: 0 }, ...completed(2).slice(1), { task: 2, kind: 'merged', remainingTasks: 0 }]
    expect(reasonOf(validateCompletedSequence(trace(2, events)))).toBe('event 0: remainingTasks does not match the task')
  })
})

describe('validateCompletedSequence never echoes input', () => {
  test('a sentinel runId never appears in a rejection reason, which matches the fixed grammar', () => {
    const runId = `run-${SENTINEL}`
    const reason = reasonOf(validateCompletedSequence(trace(3, [{ task: 1, kind: 'merged', remainingTasks: 0 }], runId)))
    expect(reason).not.toContain(SENTINEL)
    expect(reason).not.toContain('SENTINEL')
    expect(reason).toMatch(REASON_GRAMMAR)
  })
})

describe('validateCompletedSequence never throws', () => {
  test('a trace whose events getter throws is rejected as unreadable', () => {
    const unreadable = {
      runId: RUN_ID,
      taskCount: 2,
      get events(): SequenceTrace['events'] {
        throw new Error(SENTINEL)
      },
    } as SequenceTrace
    expect(validateCompletedSequence(unreadable)).toEqual({ status: 'rejected', reason: 'trace could not be read' })
  })

  test('a Proxy trace whose get trap throws is rejected as unreadable', () => {
    const unreadable = new Proxy(
      {},
      {
        get() {
          throw new Error(SENTINEL)
        },
      },
    ) as SequenceTrace
    expect(validateCompletedSequence(unreadable)).toEqual({ status: 'rejected', reason: 'trace could not be read' })
  })
})

describe('validateCompletedSequence is pure', () => {
  test('a deep-frozen trace validates and is unchanged', () => {
    const frozen = deepFreeze(trace(3, completed(3)))
    const before = JSON.stringify(frozen)
    expect(validateCompletedSequence(frozen)).toEqual({ status: 'accepted', runId: RUN_ID, taskCount: 3 })
    expect(JSON.stringify(frozen)).toBe(before)
  })

  test('accepted, incomplete and rejected calls leave the trace unchanged', () => {
    for (const input of [trace(3, completed(3)), trace(3, completed(3).slice(0, 1)), trace(3, [{ task: 2, kind: 'merged', remainingTasks: 0 }])]) {
      const snapshot = structuredClone(input)
      validateCompletedSequence(input)
      expect(input).toEqual(snapshot)
    }
  })

  test('two calls return equal but distinct results', () => {
    for (const input of [trace(2, completed(2)), trace(2, []), trace(2, [{ task: 2, kind: 'merged', remainingTasks: 0 }])]) {
      const first = validateCompletedSequence(input)
      const second = validateCompletedSequence(input)
      expect(first).toEqual(second)
      expect(first).not.toBe(second)
    }
  })
})
