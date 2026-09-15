export type CiRunConclusion = 'success' | 'failure'

export type CiRunObservation =
  | { kind: 'unreadable'; reason: string }
  | { kind: 'absent' }
  | { kind: 'running'; headSha: string }
  | { kind: 'completed'; headSha: string; conclusion: CiRunConclusion }

export type CiReadinessVerdict =
  | { kind: 'green'; headSha: string }
  | { kind: 'red'; headSha: string }
  | { kind: 'no-run'; headSha: string }
  | { kind: 'in-progress'; headSha: string }
  | { kind: 'cannot-read'; headSha: string; reason: string }
  | { kind: 'wrong-head'; headSha: string; observedHeadSha: string }

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
  return observation.conclusion === 'success'
    ? { kind: 'green', headSha }
    : { kind: 'red', headSha }
}

export function isCiGreen(verdict: CiReadinessVerdict): boolean {
  return verdict.kind === 'green'
}
