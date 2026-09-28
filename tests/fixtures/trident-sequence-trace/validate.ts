/**
 * SEQUENCE-TRACE VALIDATOR (test support).
 *
 * Judges the ORDER of a structurally decoded `SequenceTrace` (see
 * `./decode.ts`, which owns structure). A completed trace for `taskCount` n
 * has exactly one event per task, in task order:
 *   - `continued` for tasks 1 through n - 1, each with
 *     `remainingTasks === n - task`;
 *   - then `merged` for task n with `remainingTasks === 0`.
 *
 * Verdicts:
 *   - `accepted`   exactly that completed trace;
 *   - `incomplete` any proper valid prefix of it, including no events;
 *   - `rejected`   anything else: a premature merge, a wrong remaining count,
 *                  a skipped, repeated or reordered task, a `continued` event
 *                  in the merge position, or any event after the merge.
 * Events are judged in order and the FIRST violation rejects, so a short trace
 * with an invalid prefix is `rejected`, never `incomplete`.
 *
 * Pure: the trace is only read, never sorted, spliced, assigned or frozen.
 * The function never throws.
 */

import type { SequenceTrace, SequenceTraceEvent } from './decode.ts'

export type SequenceTraceVerdict = 'accepted' | 'incomplete' | 'rejected'

function isExpectedEvent(event: SequenceTraceEvent, index: number, taskCount: number): boolean {
  const task = index + 1
  if (event.task !== task) return false
  if (task < taskCount) return event.kind === 'continued' && event.remainingTasks === taskCount - task
  return event.kind === 'merged' && event.remainingTasks === 0
}

export function validateSequenceTrace(trace: SequenceTrace): SequenceTraceVerdict {
  const taskCount = trace.taskCount
  let index = 0
  for (const event of trace.events) {
    if (index >= taskCount) return 'rejected'
    if (!isExpectedEvent(event, index, taskCount)) return 'rejected'
    index += 1
  }
  return index === taskCount ? 'accepted' : 'incomplete'
}
