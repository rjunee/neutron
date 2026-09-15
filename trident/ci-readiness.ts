export type CiRunConclusion = 'success' | 'failure'
export interface RequiredCheckConfiguration { kind: 'resolved'; required: string[]; appBound: string[]; produced: string[] | null }
export type RequiredCheckObservation = RequiredCheckConfiguration | { kind: 'unknown'; reason: string }
export type CiRollupRow = { name?: unknown; context?: unknown; __typename?: unknown; status?: unknown; state?: unknown; conclusion?: unknown }

export type CiRunObservation =
  | { kind: 'unreadable'; reason: string }
  | { kind: 'absent' }
  | { kind: 'running'; headSha: string }
  | { kind: 'configuration-error'; headSha: string; reason: string }
  | { kind: 'completed'; headSha: string; conclusion: CiRunConclusion }

export type CiReadinessVerdict =
  | { kind: 'green'; headSha: string }
  | { kind: 'red'; headSha: string }
  | { kind: 'configuration-error'; headSha: string; reason: string }
  | { kind: 'no-run'; headSha: string }
  | { kind: 'in-progress'; headSha: string }
  | { kind: 'cannot-read'; headSha: string; reason: string }
  | { kind: 'wrong-head'; headSha: string; observedHeadSha: string }

const pendingStates = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'])
type Row = { name: string; kind: 'CheckRun' | 'StatusContext'; terminal: boolean; conclusion: string }
function normalizeRow(value: CiRollupRow): Row | null {
  const upper = (input: unknown) => typeof input === 'string' ? input.toUpperCase() : ''
  const name = typeof value?.name === 'string' && value.name !== '' ? value.name
    : typeof value?.context === 'string' && value.context !== '' ? value.context : ''
  if (name === '') return null
  const checkShape = typeof value.status === 'string' && value.status !== ''
  const statusContext = upper(value.__typename) === 'STATUSCONTEXT' || (!checkShape && typeof value.state === 'string' && value.state !== '')
  if (statusContext) {
    const state = upper(value.state)
    return { name, kind: 'StatusContext', terminal: state !== '' && !pendingStates.has(state), conclusion: state }
  }
  const conclusion = upper(value.conclusion)
  return { name, kind: 'CheckRun', terminal: upper(value.status) === 'COMPLETED' && conclusion !== '', conclusion }
}

/** Classify one complete PR rollup against a resolved required-check snapshot. */
export function classifyCiRollup(headSha: string, mergeable: unknown, rows: unknown,
  config: RequiredCheckObservation, elapsedMs: number, graceMs: number): CiRunObservation {
  if (config.kind === 'unknown') return { kind: 'unreadable', reason: config.reason }
  if (typeof mergeable !== 'string' || !Array.isArray(rows)) return { kind: 'unreadable', reason: 'PR readiness is malformed' }
  if (mergeable.toUpperCase() !== 'MERGEABLE') return { kind: 'running', headSha }
  const byName = new Map<string, Row[]>()
  for (const value of rows) {
    const row = normalizeRow(value as CiRollupRow)
    if (!row) return { kind: 'unreadable', reason: 'PR readiness contains a malformed row' }
    byName.set(row.name, [...(byName.get(row.name) ?? []), row])
  }
  const bound = new Set(config.appBound)
  const eligible = (name: string) => (byName.get(name) ?? []).filter(row => !bound.has(name) || row.kind === 'CheckRun')
  const ran = (name: string) => eligible(name).filter(row => row.conclusion !== 'SKIPPED')
  let settled = byName.size > 0
  for (const group of byName.values()) for (const row of group) if (row.conclusion !== 'SKIPPED' && !row.terminal) settled = false
  for (const name of config.required) {
    if (eligible(name).length > 0) continue
    if (config.produced !== null && config.produced.length > 0 && !config.produced.includes(name)
      && elapsedMs >= graceMs && settled) return { kind: 'configuration-error', headSha, reason: `required check ${name} is not produced` }
    return { kind: 'absent' }
  }
  const names = config.required.length > 0 ? config.required : [...byName.keys()]
  if (names.length === 0 || names.some(name => ran(name).length === 0)) return { kind: 'absent' }
  if (names.some(name => ran(name).some(row => !row.terminal))) return { kind: 'running', headSha }
  const green = (row: Row) => row.conclusion === 'SUCCESS' || row.conclusion === 'NEUTRAL'
  return { kind: 'completed', headSha, conclusion: names.some(name => ran(name).some(row => !green(row))) ? 'failure' : 'success' }
}

export function confirmConfigurationError(first: CiRunObservation, fresh: RequiredCheckObservation,
  reclassify: (config: RequiredCheckConfiguration) => CiRunObservation): CiRunObservation {
  if (first.kind !== 'configuration-error' || fresh.kind !== 'resolved') return first
  return reclassify(fresh)
}

/** Only a completed successful run at the requested PR head is green. */
export function ciReadinessForHead(
  headSha: string,
  observation: CiRunObservation,
): CiReadinessVerdict {
  if (observation.kind === 'unreadable') {
    return { kind: 'cannot-read', headSha, reason: observation.reason }
  }
  if (observation.kind === 'absent') return { kind: 'no-run', headSha }
  if (observation.headSha !== headSha) {
    return { kind: 'wrong-head', headSha, observedHeadSha: observation.headSha }
  }
  if (observation.kind === 'running') return { kind: 'in-progress', headSha }
  if (observation.kind === 'configuration-error') return observation
  return observation.conclusion === 'success'
    ? { kind: 'green', headSha }
    : { kind: 'red', headSha }
}

export function isCiGreen(verdict: CiReadinessVerdict): boolean {
  return verdict.kind === 'green'
}
