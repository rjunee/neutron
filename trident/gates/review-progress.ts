import type { GateResult } from '../build-run.ts'

/** Decoded, recorded panel evidence. Counts and identities are computed by the host. */
export interface ReviewProgress {
  findings: readonly string[]
  blockingCount: number
  /** A host blocker lacks semantic failure identity; do not invent recurrence. */
  unknownIdentities?: boolean
}

/** Host arithmetic, carried to terminal readers without parsing the human reason. */
export interface ReviewStop {
  trigger: 'repeat-finding' | 'no-progress'
  previous: ReviewProgress
  current: ReviewProgress
}

/** Compare against the panel preceding the last dispatched fix or replacement build. */
export function reviewProgress(previous: ReviewProgress | undefined, current: ReviewProgress | undefined): GateResult {
  if (!current || !Number.isSafeInteger(current.blockingCount) || current.blockingCount < 0 || current.findings.some(id => !id.trim())
    || (current.unknownIdentities !== undefined && typeof current.unknownIdentities !== 'boolean')) {
    return { kind: 'unknown', detail: 'Review progress needs readable host findings and blocker/major count' }
  }
  if (!previous) return { kind: 'allow' }
  // G070: severity cannot erase a finding that survived work between these panels.
  if (current.findings.some(id => previous.findings.includes(id))) {
    return { kind: 'blocked', on: 'Review requires orchestrator arbitration: repeated finding',
      reviewStop: { trigger: 'repeat-finding', previous, current } }
  }
  // G071: advisory-only rounds do not assert that code repairs failed to converge.
  if (previous.blockingCount > 0 && current.blockingCount >= previous.blockingCount) {
    return { kind: 'blocked', on: 'Review requires orchestrator arbitration: no-progress',
      reviewStop: { trigger: 'no-progress', previous, current } }
  }
  // G072: falling counts do not establish progress when unresolved findings
  // cannot be compared. A green/earned-advisory current observation resolves the
  // unknown blocker and can proceed; the first red may still receive its fix.
  if (current.blockingCount > 0 && (previous.unknownIdentities || current.unknownIdentities)) {
    return { kind: 'unknown', detail: 'Review progress cannot compare unidentified host suite failures' }
  }
  return { kind: 'allow' }
}
