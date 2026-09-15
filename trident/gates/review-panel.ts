import type { Provider } from '@neutronai/runtime/bounded-work.ts'
import type { BuildSnapshot, ReviewDecision } from '../build-run.ts'
import { validateTrailer, type VerdictTrailer } from './result-contract.ts'
import { decideEscalation, findingIdentity } from './escalation.ts'

export interface ReviewSeat {
  id: string
  provider: Provider
  modelId: string
  role: 'core' | 'peer'
  enabled: boolean
}
export interface SeatObservation {
  runId: string
  head: string
  round: number
  provider: Provider
  modelId: string
  status: 'completed' | 'deferred' | 'unavailable' | 'rate-limited'
  payload: unknown
}
export interface ReviewSource {
  /** Project configuration, independent of worker output. */
  seats: readonly ReviewSeat[]
  readSeat(seat: ReviewSeat, snapshot: BuildSnapshot, round: number): Promise<SeatObservation | null>
  /** One bounded retry of deferred work, followed by an authoritative read. */
  retrySeat(seat: ReviewSeat, snapshot: BuildSnapshot, round: number): Promise<void>
  readSynthesis(snapshot: BuildSnapshot, round: number): Promise<{
    runId: string; head: string; round: number; checkpoint: string; payload: unknown
  } | null>
}
const unknown = (detail: string): ReviewDecision => ({ kind: 'unknown', detail })
const blocked = (on: string): ReviewDecision => ({ kind: 'blocked', on })

/** G062: reserved host markers cannot exempt model findings. */
function unmarked(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || !('findings' in payload) || !Array.isArray(payload.findings)) return payload
  return { ...payload, findings: payload.findings.map((finding: unknown) => {
    if (!finding || typeof finding !== 'object') return finding
    const clean = { ...finding } as Record<string, unknown>
    delete clean.advisory
    if (clean.kind === 'lane' || clean.kind === 'suite') delete clean.kind
    return clean
  }) }
}

/** G059: never overwrite a completed review or immediately retry a rate limit. */
export async function readReviewSeat(source: ReviewSource, seat: ReviewSeat, snapshot: BuildSnapshot, round: number): Promise<SeatObservation | null> {
  let observed = await source.readSeat(seat, snapshot, round)
  if (observed === null || observed.status === 'deferred') {
    try {
      await source.retrySeat(seat, snapshot, round)
      observed = await source.readSeat(seat, snapshot, round) ?? observed
    } catch { /* Keep the original observation when retry fails. */ }
  }
  return observed
}

/** G057–G062, G104: re-read the recorded panel for this exact revision and round. */
export async function reviewPanel(source: ReviewSource | undefined, payload: unknown, snapshot: BuildSnapshot, round: number, runId: string, replansUsed = 0): Promise<ReviewDecision> {
  const trailer = validateTrailer('verdict', unmarked(payload))
  if (!trailer.ok) return unknown(`Review trailer ${trailer.reason} at ${trailer.path}`)
  if (!source) return unknown('Review panel observation source is missing')
  try {
    const seats = source.seats.filter(seat => seat.enabled)
    if (seats.some(seat => !seat.id || !seat.modelId) || !seats.some(seat => seat.role === 'core') || new Set(seats.map(seat => seat.id)).size !== seats.length) return unknown('Review core seat configuration is missing or duplicated')
    const verdicts: VerdictTrailer[] = []
    for (const seat of seats) {
      const observed = await readReviewSeat(source, seat, snapshot, round)
      if (!observed) return unknown(`Review seat ${seat.id} (${seat.provider}) has no recorded observation`)
      if (observed.runId !== runId || observed.head !== snapshot.head || observed.round !== round || observed.provider !== seat.provider || observed.modelId !== seat.modelId) return unknown(`Review seat ${seat.id} (${seat.provider}) provenance does not match run, revision, round, provider or model`)
      if (observed.status !== 'completed') return blocked(`Review seat ${seat.id} (${seat.provider}) is ${observed.status}`)
      const checked = validateTrailer('verdict', unmarked(observed.payload))
      if (!checked.ok) return unknown(`Review seat ${seat.id} (${seat.provider}) verdict is unusable`)
      verdicts.push(checked.value)
    }
    const recorded = await source.readSynthesis(snapshot, round)
    if (!recorded || recorded.runId !== runId || recorded.head !== snapshot.head || recorded.round !== round) return unknown('Review synthesis provenance does not match run, revision and round')
    const synthesis = validateTrailer('verdict', unmarked(recorded.payload))
    if (!synthesis.ok) return unknown('Review recorded synthesis is unusable')
    // Compare decoded data, independent of object key ordering.
    const canonical = (value: VerdictTrailer) => JSON.stringify([value.verdict, value.findings.map(f => [f.severity, f.title, f.evidence, f.file, f.symbol, f.rule, f.line]), value.escalate?.kind, value.escalate?.whatIsMissing])
    if (canonical(synthesis.value) !== canonical(trailer.value)) return blocked('Review worker trailer differs from recorded synthesis')
    verdicts.push(synthesis.value)
    const blockers = verdicts.flatMap(v => v.findings).filter(f => f.severity !== 'minor' && f.severity !== 'nit')
    let replan: ReviewDecision | undefined
    for (const verdict of verdicts) {
      if (!verdict.escalate) continue
      const escalation = decideEscalation({ claim: verdict.escalate, claimVerdict: verdict.verdict, replansUsed, round })
      if (escalation.action !== 're-plan') return blocked(`Review requires orchestrator arbitration: ${escalation.refusedClaim || verdict.escalate.kind}: ${verdict.escalate.whatIsMissing}`)
      replan = { kind: 're-plan', whatIsMissing: escalation.whatIsMissing, findings: [...new Set(blockers.map(findingIdentity))], blockingCount: blockers.length }
    }
    if (replan) return replan
    if (blockers.length > 0) {
      const identities = blockers.map(findingIdentity)
      if (identities.some(id => !id)) return unknown('Review blocking findings have no stable identity for arbitration')
      return { kind: 'fix', findings: [...new Set(identities)], blockingCount: blockers.length }
    }
    if (verdicts.some(v => v.verdict === 'COMMENT' || (v.verdict === 'REQUEST_CHANGES' && v.findings.length === 0))) return blocked('Review has an unresolved verdict without nonblocking findings')
    if (recorded.checkpoint !== 'argus-approved') return unknown('Review recorded approval checkpoint is missing')
    return { kind: 'approve' }
  } catch { return unknown('Review panel host observation failed') }
}
