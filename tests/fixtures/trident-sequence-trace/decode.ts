/**
 * STRICT SEQUENCE-TRACE DECODER (test support).
 *
 * Decodes a synthetic task-sequence trace used by build E2E assertions:
 *
 *   { runId, taskCount, events: [{ task, kind, remainingTasks }, ...] }
 *
 * It validates STRUCTURE ONLY, never sequence order. Order, counts, repeats,
 * merge position and remaining-vs-task consistency belong to the separate
 * validator; a merged-first or reordered trace decodes here.
 *
 * Rules, checked in order, the first violation wins:
 *   - input is a non-null, non-array object;
 *   - runId is a nonempty string with no leading or trailing whitespace
 *     (retained byte-for-byte);
 *   - taskCount is a safe integer of at least two;
 *   - events is an array (an empty array is valid);
 *   - each event, by zero-based index: a non-null, non-array object; task a
 *     safe integer from one through taskCount; kind exactly `continued` or
 *     `merged`; remainingTasks a nonnegative safe integer.
 *
 * Extra properties are ignored and dropped. Pure: the input is only read,
 * each field exactly once, and fresh objects are returned on every call.
 * `decodeSequenceTrace` never throws: a throwing getter or Proxy trap yields
 * `input could not be read`. Rejection reasons carry a field name or a
 * zero-based event index only, never any input bytes. It imports nothing.
 */

export type SequenceEventKind = 'continued' | 'merged'

export interface SequenceEvent {
  readonly task: number
  readonly kind: SequenceEventKind
  readonly remainingTasks: number
}

export interface SequenceTrace {
  readonly runId: string
  readonly taskCount: number
  readonly events: readonly SequenceEvent[]
}

export type TraceDecodeResult =
  | { readonly ok: true; readonly trace: SequenceTrace }
  | { readonly ok: false; readonly reason: string }

function reject(reason: string): TraceDecodeResult {
  return { ok: false, reason }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decode(input: unknown): TraceDecodeResult {
  if (!isPlainRecord(input)) return reject('input is not an object')
  const runId = input.runId
  if (typeof runId !== 'string' || runId.length === 0 || runId !== runId.trim()) {
    return reject('runId is not a nonempty trimmed string')
  }
  const taskCount = input.taskCount
  if (!Number.isSafeInteger(taskCount) || (taskCount as number) < 2) {
    return reject('taskCount is not a safe integer of at least two')
  }
  const count = taskCount as number
  const rawEvents = input.events
  if (!Array.isArray(rawEvents)) return reject('events is not an array')
  const length = rawEvents.length
  const events: SequenceEvent[] = []
  for (let index = 0; index < length; index += 1) {
    const element: unknown = rawEvents[index]
    if (!isPlainRecord(element)) return reject(`event ${index}: not an object`)
    const task = element.task
    if (!Number.isSafeInteger(task) || (task as number) < 1 || (task as number) > count) {
      return reject(`event ${index}: task is not a safe integer from one through taskCount`)
    }
    const kind = element.kind
    if (kind !== 'continued' && kind !== 'merged') {
      return reject(`event ${index}: kind is not continued or merged`)
    }
    const remainingTasks = element.remainingTasks
    if (!Number.isSafeInteger(remainingTasks) || (remainingTasks as number) < 0) {
      return reject(`event ${index}: remainingTasks is not a nonnegative safe integer`)
    }
    events.push({ task: task as number, kind, remainingTasks: remainingTasks as number })
  }
  return { ok: true, trace: { runId, taskCount: count, events } }
}

export function decodeSequenceTrace(input: unknown): TraceDecodeResult {
  try {
    return decode(input)
  } catch {
    return reject('input could not be read')
  }
}
