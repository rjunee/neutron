/**
 * STRICT COMPLETED-SEQUENCE VALIDATOR (test support).
 *
 * Judges the ORDER of a trace already decoded by `./decode.ts`. A legitimate
 * same-run task sequence of `taskCount` (N) tasks is exactly:
 *
 *   event i (zero-based), task k = i + 1:
 *     k < N  =>  { task: k, kind: 'continued', remainingTasks: N - k }
 *     k = N  =>  { task: N, kind: 'merged',    remainingTasks: 0 }
 *
 * Three outcomes:
 *   - accepted:   all N events present and each matches the rule above;
 *   - incomplete: a proper prefix (zero through N - 1 events) of that exact
 *                 sequence, so nothing has merged yet;
 *   - rejected:   anything else.
 *
 * Per event, in this order, the FIRST violation is reported:
 *   1. an event after the final task merged (index at least N);
 *   2. task is not the next task (index + 1): rejects repeats, skips,
 *      reordering and a sequence that does not start at task one;
 *   3. kind: a non-final task must continue, the final task must merge;
 *   4. remainingTasks equals N minus the task.
 *
 * Callers must pass `decodeSequenceTrace` output; structure is not rechecked.
 * Pure: the trace is only read, fresh objects are returned on every call, and
 * `validateCompletedSequence` never throws (an unreadable trace is rejected
 * with `trace could not be read`). Rejection reasons carry a zero-based event
 * index only, never any input bytes.
 */

import type { SequenceTrace } from './decode.ts'

export type SequenceValidation =
  | { readonly status: 'accepted'; readonly runId: string; readonly taskCount: number }
  | {
      readonly status: 'incomplete'
      readonly runId: string
      readonly taskCount: number
      readonly completedTasks: number
      readonly nextTask: number
    }
  | { readonly status: 'rejected'; readonly reason: string }

function reject(reason: string): SequenceValidation {
  return { status: 'rejected', reason }
}

function validate(trace: SequenceTrace): SequenceValidation {
  const runId = trace.runId
  const taskCount = trace.taskCount
  const events = trace.events
  const length = events.length
  for (let index = 0; index < length; index += 1) {
    if (index >= taskCount) return reject(`event ${index}: follows the merge`)
    const event = events[index]!
    const expectedTask = index + 1
    if (event.task !== expectedTask) return reject(`event ${index}: task is not the next task`)
    const final = expectedTask === taskCount
    if (final && event.kind !== 'merged') return reject(`event ${index}: final task did not merge`)
    if (!final && event.kind !== 'continued') return reject(`event ${index}: merged before the final task`)
    if (event.remainingTasks !== taskCount - expectedTask) {
      return reject(`event ${index}: remainingTasks does not match the task`)
    }
  }
  if (length === taskCount) return { status: 'accepted', runId, taskCount }
  return { status: 'incomplete', runId, taskCount, completedTasks: length, nextTask: length + 1 }
}

export function validateCompletedSequence(trace: SequenceTrace): SequenceValidation {
  try {
    return validate(trace)
  } catch {
    return reject('trace could not be read')
  }
}
