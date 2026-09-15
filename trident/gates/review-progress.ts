import type { GateResult } from '../build-run.ts'

/** Decoded, recorded panel evidence. Counts and identities are computed by the host. */
export interface ReviewProgress {
  findings: readonly string[]
  blockingCount: number
}

/** Compare against the panel preceding the last dispatched fix or replacement build. */
export function reviewProgress(previous: ReviewProgress | undefined, current: ReviewProgress | undefined): GateResult {
  if (!current || !Number.isSafeInteger(current.blockingCount) || current.blockingCount < 0 || current.findings.some(id => !id.trim())) {
    return { kind: 'unknown', detail: 'Review progress needs readable host findings and blocker/major count' }
  }
  if (!previous) return { kind: 'allow' }
  // G070: severity cannot erase a finding that survived work between these panels.
  if (current.findings.some(id => previous.findings.includes(id))) {
    return { kind: 'blocked', on: 'Review requires orchestrator arbitration: repeated finding' }
  }
  // G071: advisory-only rounds do not assert that code repairs failed to converge.
  if (previous.blockingCount > 0 && current.blockingCount >= previous.blockingCount) {
    return { kind: 'blocked', on: 'Review requires orchestrator arbitration: no-progress' }
  }
  return { kind: 'allow' }
}
