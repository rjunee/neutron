/**
 * EXACT-SCOPE INPUT-USAGE COMPARATOR (test support).
 *
 * Compares observed input-token usage between a `before` and an `after` side,
 * each carrying the caller's DECLARED `{ task, gates, models }` scope and a list
 * of `{ attemptId, inputTokens }` attempts.
 *
 * What this does and does not establish:
 *   - scopes match only when all three declared strings are exactly equal; no
 *     trimming, case folding, parsing or whitespace collapsing is used to
 *     manufacture equivalence. It checks declared equality, not whether the
 *     declarations are truthful or scientifically adequate;
 *   - the scalar is observed input tokens only, never total billed tokens,
 *     cache counts or cost;
 *   - a `null` count is unknown, never zero; a measured zero is known;
 *   - a reduction is reported only for matched scopes with complete telemetry on
 *     both sides; otherwise it is `null`. Zero and negative reductions are
 *     legitimate. No percentage is computed and nothing is vetoed on
 *     incomplete telemetry.
 *
 * Pure: the input is only read. Every validation failure throws
 * `ScopeUsageInputError` whose message names a structural path and the violated
 * rule, never an input value.
 */

export interface ScopeDeclaration {
  task: string
  gates: string
  models: string
}

export interface ScopeUsageAttempt {
  attemptId: string
  inputTokens: number | null
}

export interface ScopeUsageSide {
  scope: ScopeDeclaration
  attempts: ScopeUsageAttempt[]
}

export interface ScopeUsageInput {
  before: ScopeUsageSide
  after: ScopeUsageSide
}

export interface ScopeUsageSummary {
  knownInputTokens: number
  unknownAttempts: number
  complete: boolean
}

export type ScopeUsageKind = 'matched' | 'unmatched'

export interface ScopeUsageComparison {
  kind: ScopeUsageKind
  before: ScopeUsageSummary
  after: ScopeUsageSummary
  inputTokenReduction: number | null
}

export class ScopeUsageInputError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'ScopeUsageInputError'
  }
}

type SideName = 'before' | 'after'

interface ValidatedSide {
  scope: ScopeDeclaration
  summary: ScopeUsageSummary
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  if (Object.keys(value).length !== keys.length) return false
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) return false
  }
  return true
}

function isTrimmedNonempty(value: unknown): value is string {
  // trim() is used only to REFUSE padded strings, never to compare.
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

const scopeFields = ['task', 'gates', 'models'] as const

function validateScope(value: unknown, path: string): ScopeDeclaration {
  if (!isPlainRecord(value) || !hasExactKeys(value, scopeFields)) {
    throw new ScopeUsageInputError(`${path}: must be an object with exactly the keys task, gates and models`)
  }
  for (const field of scopeFields) {
    if (!isTrimmedNonempty(value[field])) {
      throw new ScopeUsageInputError(`${path}.${field}: must be a nonempty string without leading or trailing whitespace`)
    }
  }
  return { task: value.task as string, gates: value.gates as string, models: value.models as string }
}

function validateSide(value: unknown, side: SideName): ValidatedSide {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['scope', 'attempts'])) {
    throw new ScopeUsageInputError(`${side}: must be an object with exactly the keys scope and attempts`)
  }
  const scope = validateScope(value.scope, `${side}.scope`)
  const attempts: unknown = value.attempts
  if (!Array.isArray(attempts)) throw new ScopeUsageInputError(`${side}.attempts: must be an array`)
  const records: readonly unknown[] = attempts
  const seen = new Map<string, number>()
  let knownInputTokens = 0
  let unknownAttempts = 0
  for (let index = 0; index < records.length; index += 1) {
    const path = `${side}.attempts[${index}]`
    const record: unknown = records[index]
    if (!isPlainRecord(record) || !hasExactKeys(record, ['attemptId', 'inputTokens'])) {
      throw new ScopeUsageInputError(`${path}: must be an object with exactly the keys attemptId and inputTokens`)
    }
    const attemptId: unknown = record.attemptId
    if (!isTrimmedNonempty(attemptId)) {
      throw new ScopeUsageInputError(`${path}.attemptId: must be a nonempty string without leading or trailing whitespace`)
    }
    const earlier = seen.get(attemptId)
    if (earlier !== undefined) throw new ScopeUsageInputError(`${path}.attemptId: duplicates ${side}.attempts[${earlier}]`)
    seen.set(attemptId, index)
    const inputTokens: unknown = record.inputTokens
    if (inputTokens === null) { unknownAttempts += 1; continue }
    if (typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens < 0) {
      throw new ScopeUsageInputError(`${path}.inputTokens: must be null or a nonnegative safe integer`)
    }
    knownInputTokens += inputTokens
    if (!Number.isSafeInteger(knownInputTokens)) {
      throw new ScopeUsageInputError(`${path}: summed inputTokens exceed the safe integer range`)
    }
  }
  return { scope, summary: { knownInputTokens, unknownAttempts, complete: unknownAttempts === 0 } }
}

export function compareScopeUsage(input: unknown): ScopeUsageComparison {
  if (!isPlainRecord(input) || !hasExactKeys(input, ['before', 'after'])) {
    throw new ScopeUsageInputError('input: must be an object with exactly the keys before and after')
  }
  // Both sides are fully validated before any comparison is made.
  const before = validateSide(input.before, 'before')
  const after = validateSide(input.after, 'after')
  const matched = before.scope.task === after.scope.task
    && before.scope.gates === after.scope.gates
    && before.scope.models === after.scope.models
  const kind: ScopeUsageKind = matched ? 'matched' : 'unmatched'
  // Both operands lie in [0, MAX_SAFE_INTEGER], so the difference is always a safe integer.
  const inputTokenReduction = matched && before.summary.complete && after.summary.complete
    ? before.summary.knownInputTokens - after.summary.knownInputTokens
    : null
  return { kind, before: before.summary, after: after.summary, inputTokenReduction }
}
