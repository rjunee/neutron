import { createLogger } from '@neutronai/logger'
import { modelTierRegistry } from '../model-tiers.ts'
import type { Provider } from '@neutronai/runtime/bounded-work.ts'
import type { BuildSnapshot, ReviewDecision } from '../build-run.ts'
import { validateTrailer, type VerdictTrailer } from './result-contract.ts'
import type { ReviewProgress } from './review-progress.ts'
import { decideEscalation, findingIdentity } from './escalation.ts'
// `infrastructure()` takes a STRING, so this uses the runtime helper directly rather
// than the gate wrapper in `./unknown-cause.ts`, which returns a `GateResult`.
import { TERMINAL_CAUSE_MAX, unknownCause } from '@neutronai/runtime/refusal-cause.ts'

export interface ReviewSeat {
  id: string
  provider: Provider
  modelId: string
  /** Host-configured family for models behind a shared transport. */
  family?: string
  role: 'core' | 'peer'
  enabled: boolean
}
export interface SeatObservation {
  runId: string
  head: string
  round: number
  provider: Provider
  modelId: string
  /** null explicitly means missing host model telemetry; omission retains host configuration. */
  family?: string | null
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
const infrastructure = (detail: string): ReviewDecision => blocked(`infra-only: ${detail}`)

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
export async function reviewPanel(source: ReviewSource | undefined, payload: unknown, snapshot: BuildSnapshot, round: number, runId: string, replansUsed = 0, builder?: Pick<ReviewSeat, 'provider' | 'modelId' | 'family'>, recordProgress?: (value: ReviewProgress) => void): Promise<ReviewDecision> {
  const trailer = validateTrailer('verdict', unmarked(payload))
  if (!trailer.ok) return infrastructure(`Review trailer ${trailer.reason} at ${trailer.path}`)
  if (!source) return infrastructure('Review panel observation source is missing')
  try {
    const seats = source.seats.filter(seat => seat.enabled)
    if (seats.some(seat => !seat.id || !seat.modelId) || !seats.some(seat => seat.role === 'core') || new Set(seats.map(seat => seat.id)).size !== seats.length) return infrastructure('Review core seat configuration is missing or duplicated')
    const registry = modelTierRegistry()
    const families = [...seats, ...(builder ? [builder] : [])].map(seat => seat.family
      ?? registry.find(model => model.model_id === seat.modelId)?.group
      ?? (seat.provider === 'pi' ? `pi:${seat.modelId}` : seat.provider))
    let unknownFamily = false
    // The standalone review and recorded synthesis are independently authored.
    // Both retain a veto; matching provenance does not require identical findings.
    const verdicts: VerdictTrailer[] = [trailer.value]
    for (const seat of seats) {
      const observed = await readReviewSeat(source, seat, snapshot, round)
      if (!observed) return infrastructure(`Review seat ${seat.id} (${seat.provider}) has no recorded observation`)
      if (observed.runId !== runId || observed.head !== snapshot.head || observed.round !== round || observed.provider !== seat.provider || observed.modelId !== seat.modelId) return infrastructure(`Review seat ${seat.id} (${seat.provider}) provenance does not match run, revision, round, provider or model`)
      if (observed.family === null) unknownFamily = true
      if (observed.status !== 'completed') return blocked(`Review seat ${seat.id} (${seat.provider}) is ${observed.status}`)
      const checked = validateTrailer('verdict', unmarked(observed.payload))
      if (!checked.ok) return infrastructure(`Review seat ${seat.id} (${seat.provider}) verdict is unusable`)
      verdicts.push(checked.value)
    }
    if (unknownFamily) {
      createLogger('trident').warn('panel-unknown-family', { 'configuration-accepted': true })
    } else if (families.length > 1 && new Set(families).size === 1) {
      createLogger('trident').warn('panel-single-family', { family: families[0]!, seats: families.length, 'configuration-accepted': true })
    }
    const recorded = await source.readSynthesis(snapshot, round)
    if (!recorded || recorded.runId !== runId || recorded.head !== snapshot.head || recorded.round !== round) return infrastructure('Review synthesis provenance does not match run, revision and round')
    const synthesis = validateTrailer('verdict', unmarked(recorded.payload))
    if (!synthesis.ok) return infrastructure('Review recorded synthesis is unusable')
    verdicts.push(synthesis.value)
    const blockers = verdicts.flatMap(v => v.findings).filter(f => f.severity !== 'minor' && f.severity !== 'nit')
    const actionable = verdicts.flatMap(v => v.findings).filter(f => f.severity !== 'nit').map(findingIdentity)
    recordProgress?.({ findings: [...new Set(actionable)], blockingCount: blockers.length })
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
    if (recorded.checkpoint !== 'argus-approved') return infrastructure('Review recorded approval checkpoint is missing')
    return { kind: 'approve' }
  } catch (error) { return infrastructure(unknownCause('Review panel host observation failed', error, runId).slice(0, TERMINAL_CAUSE_MAX)) }
}
