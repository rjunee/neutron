/**
 * ACCEPTED-CHILD OVERLAP CHECK (test support).
 *
 * Decides whether exactly two accepted children ran concurrently, from their
 * `{ childId, acceptedAt, finishedAt, inputTokens }` records, and reports the
 * INPUT-token measurement coverage of the pair.
 *
 * Semantics:
 *   - overlap is strict: `max(acceptedAt) < min(finishedAt)`. Intervals that
 *     merely touch (one finishes at the instant the other is accepted) or run
 *     serially do NOT overlap and report `overlapDuration` 0;
 *   - the selected metric is input tokens only — never total billed tokens,
 *     cache tokens or cost;
 *   - a `null` count is unknown, never zero; a measured zero is known and stays
 *     zero;
 *   - unknown counts never veto valid intervals: overlap is decided from the
 *     intervals alone, and `complete` only reports whether both counts are known.
 *
 * Contract: validation failure THROWS — `TypeError` for every shape or value
 * rule, `RangeError` when the summed known counts leave the safe integer range.
 * Diagnostics name the record index and the violated rule, never a value.
 *
 * Pure: the input is only read, never sorted, spliced or assigned; a fresh
 * result object is returned per call. This fixture proves nothing about live
 * concurrency, provider savings or complete telemetry coverage; it only checks
 * synthetic or separately-observed records.
 */

export interface ChildOverlapRecord {
  childId: string
  acceptedAt: number
  finishedAt: number
  inputTokens: number | null
}

export interface ChildOverlapResult {
  overlap: boolean
  overlapDuration: number
  knownInputTokens: number
  unknownChildren: number
  complete: boolean
}

const requiredKeys = ['childId', 'acceptedAt', 'finishedAt', 'inputTokens'] as const

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validateRecord(value: unknown, index: number): ChildOverlapRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`record ${index}: must be an object`)
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`record ${index}: missing required field ${key}`)
  }
  if (Object.keys(value).length !== requiredKeys.length) {
    throw new TypeError(`record ${index}: must have exactly the fields ${requiredKeys.join(', ')}`)
  }
  const { childId, acceptedAt, finishedAt, inputTokens } = value as Record<(typeof requiredKeys)[number], unknown>
  if (typeof childId !== 'string' || childId.length === 0 || childId !== childId.trim()) {
    throw new TypeError(`record ${index}: childId must be a nonempty string without leading or trailing whitespace`)
  }
  if (!isNonnegativeSafeInteger(acceptedAt)) throw new TypeError(`record ${index}: acceptedAt must be a nonnegative safe integer`)
  if (!isNonnegativeSafeInteger(finishedAt)) throw new TypeError(`record ${index}: finishedAt must be a nonnegative safe integer`)
  if (!(acceptedAt < finishedAt)) throw new TypeError(`record ${index}: acceptedAt must be strictly less than finishedAt`)
  if (inputTokens !== null && (typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens < 0)) {
    throw new TypeError(`record ${index}: inputTokens must be null or a nonnegative safe integer`)
  }
  return { childId, acceptedAt, finishedAt, inputTokens }
}

export function checkChildOverlap(input: unknown): ChildOverlapResult {
  if (!Array.isArray(input)) throw new TypeError('child-overlap input must be an array of exactly two records')
  const items: readonly unknown[] = input
  if (items.length !== 2) throw new TypeError('child-overlap input must be an array of exactly two records')
  const first = validateRecord(items[0], 0)
  const second = validateRecord(items[1], 1)
  if (second.childId === first.childId) throw new TypeError('record 1: childId duplicates record 0')

  const latestAccepted = Math.max(first.acceptedAt, second.acceptedAt)
  const earliestFinished = Math.min(first.finishedAt, second.finishedAt)
  const overlap = latestAccepted < earliestFinished
  const overlapDuration = overlap ? earliestFinished - latestAccepted : 0

  let knownInputTokens = 0
  let unknownChildren = 0
  const children = [first, second]
  for (let index = 0; index < children.length; index += 1) {
    const tokens = children[index]!.inputTokens
    if (tokens === null) {
      unknownChildren += 1
      continue
    }
    knownInputTokens += tokens
    if (!Number.isSafeInteger(knownInputTokens)) {
      throw new RangeError(`record ${index}: summed inputTokens exceed the safe integer range`)
    }
  }
  return { overlap, overlapDuration, knownInputTokens, unknownChildren, complete: unknownChildren === 0 }
}
