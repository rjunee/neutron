/**
 * SEQUENCE-TRACE DECODER (test support).
 *
 * Decodes an untrusted JSON value shaped `{ runId, taskCount, events }` into a
 * typed `SequenceTrace`, where each event is `{ task, kind, remainingTasks }`.
 *
 * This decoder validates STRUCTURE only: field presence, types and ranges. It
 * says nothing about sequence order, completeness, premature merges or
 * repeated tasks; that judgement belongs to the validator that consumes the
 * decoded type. A field-valid but out-of-order trace decodes successfully.
 *
 * Pure: the input is only read, never assigned, sorted, spliced or frozen. The
 * returned trace is built from fresh objects carrying only the known fields,
 * so it shares no references with the input. Extra properties are ignored.
 * Diagnostics name the location and the violated rule, never an input value.
 * Invalid input yields a typed `{ ok: false, error }` result rather than a throw.
 */

export type SequenceEventKind = 'continued' | 'merged'

export interface SequenceTraceEvent {
  readonly task: number
  readonly kind: SequenceEventKind
  readonly remainingTasks: number
}

export interface SequenceTrace {
  readonly runId: string
  readonly taskCount: number
  readonly events: readonly SequenceTraceEvent[]
}

export type SequenceTraceDecodeResult =
  | { ok: true; trace: SequenceTrace }
  | { ok: false; error: string }

const traceKeys = ['runId', 'taskCount', 'events'] as const
const eventKeys = ['task', 'kind', 'remainingTasks'] as const

function isPlainRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(error: string): SequenceTraceDecodeResult {
  return { ok: false, error }
}

export function decodeSequenceTrace(input: unknown): SequenceTraceDecodeResult {
  if (!isPlainRecord(input)) return fail('trace: must be an object')
  for (const key of traceKeys) {
    if (!Object.hasOwn(input, key)) return fail(`trace: missing required field ${key}`)
  }
  const { runId, taskCount, events } = input as Record<(typeof traceKeys)[number], unknown>
  if (typeof runId !== 'string' || runId.length === 0 || runId !== runId.trim()) {
    return fail('trace: runId must be a nonempty string without leading or trailing whitespace')
  }
  if (typeof taskCount !== 'number' || !Number.isSafeInteger(taskCount) || taskCount < 2) {
    return fail('trace: taskCount must be a safe integer of at least 2')
  }
  if (!Array.isArray(events)) return fail('trace: events must be an array')
  const source: readonly unknown[] = events
  const decoded: SequenceTraceEvent[] = []
  for (let index = 0; index < source.length; index += 1) {
    const event: unknown = source[index]
    if (!isPlainRecord(event)) return fail(`event ${index}: must be an object`)
    for (const key of eventKeys) {
      if (!Object.hasOwn(event, key)) return fail(`event ${index}: missing required field ${key}`)
    }
    const { task, kind, remainingTasks } = event as Record<(typeof eventKeys)[number], unknown>
    if (typeof task !== 'number' || !Number.isSafeInteger(task) || task < 1 || task > taskCount) {
      return fail(`event ${index}: task must be a safe integer from 1 through taskCount`)
    }
    if (kind !== 'continued' && kind !== 'merged') {
      return fail(`event ${index}: kind must be "continued" or "merged"`)
    }
    if (typeof remainingTasks !== 'number' || !Number.isSafeInteger(remainingTasks) || remainingTasks < 0) {
      return fail(`event ${index}: remainingTasks must be a nonnegative safe integer`)
    }
    decoded.push(Object.freeze({ task, kind, remainingTasks }))
  }
  const trace: SequenceTrace = Object.freeze({ runId, taskCount, events: Object.freeze(decoded) })
  return { ok: true, trace }
}
