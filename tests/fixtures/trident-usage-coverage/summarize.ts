/**
 * USAGE-COVERAGE REDUCER (test support).
 *
 * Folds per-attempt measurements of ONE selected scalar metric (for example a
 * receipt's input token count) into `{ knownTokens, unknownAttempts, complete }`.
 *
 * Coverage is a statement about that selected measurement only. It is NOT
 * execution validity, billing completeness or provider trust:
 *   - a `null` measurement is unknown, never zero;
 *   - a measured zero is known and stays zero;
 *   - failed attempts are summed exactly like completed ones (spend is not
 *     dropped because the attempt failed);
 *   - incomplete coverage never vetoes a run; callers decide nothing from it.
 *
 * Pure: the input is only read, never sorted, spliced or assigned. Diagnostics
 * name the record index and the violated rule, never a record's values.
 */

export type UsageCoverageOutcome = 'completed' | 'failed'

export interface UsageCoverageRecord {
  attemptId: string
  outcome: UsageCoverageOutcome
  tokens: number | null
}

export interface UsageCoverageSummary {
  knownTokens: number
  unknownAttempts: number
  complete: boolean
}

const requiredKeys = ['attemptId', 'outcome', 'tokens'] as const

export function summarizeUsageCoverage(input: unknown): UsageCoverageSummary {
  if (!Array.isArray(input)) throw new TypeError('usage-coverage input must be an array of records')
  const records: readonly unknown[] = input
  const seen = new Map<string, number>()
  let knownTokens = 0
  let unknownAttempts = 0
  for (let index = 0; index < records.length; index += 1) {
    const record: unknown = records[index]
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      throw new TypeError(`record ${index}: must be an object`)
    }
    for (const key of requiredKeys) {
      if (!Object.hasOwn(record, key)) throw new TypeError(`record ${index}: missing required field ${key}`)
    }
    const { attemptId, outcome, tokens } = record as Record<(typeof requiredKeys)[number], unknown>
    if (typeof attemptId !== 'string' || attemptId.length === 0 || attemptId !== attemptId.trim()) {
      throw new TypeError(`record ${index}: attemptId must be a nonempty string without leading or trailing whitespace`)
    }
    const earlier = seen.get(attemptId)
    if (earlier !== undefined) throw new TypeError(`record ${index}: attemptId duplicates record ${earlier}`)
    seen.set(attemptId, index)
    if (outcome !== 'completed' && outcome !== 'failed') {
      throw new TypeError(`record ${index}: outcome must be "completed" or "failed"`)
    }
    if (tokens === null) { unknownAttempts += 1; continue }
    if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0) throw new TypeError(`record ${index}: tokens must be null or a nonnegative safe integer`)
    knownTokens += tokens
    if (!Number.isSafeInteger(knownTokens)) throw new RangeError(`record ${index}: summed tokens exceed the safe integer range`)
  }
  return { knownTokens, unknownAttempts, complete: unknownAttempts === 0 }
}
