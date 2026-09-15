import {
  placementFor,
  type BoundedWorkOutcome,
  type BoundedWorkRequest,
  type Provider,
  type WorkerRunner,
} from '@neutronai/runtime/bounded-work.ts'
import type { LeakPreflightOutcome } from './leak-preflight.ts'
import type { MergeDiffAssessment } from './merge.ts'
import type { TerminalCause } from './terminal-cause.ts'

export type BuildPhase = 'plan' | 'build' | 'review' | 'fix' | 'publish' | 'merge'
type WorkPhase = Extract<BuildPhase, 'plan' | 'build' | 'review' | 'fix'>
export interface BuildSnapshot {
  /** Resolved commit and complete diff, both measured by the host. */
  head: string
  diff: string
  pr: { number: number; head: string; state: 'OPEN' | 'CLOSED' | 'MERGED' } | null
}
export type Measurement = { kind: 'known'; value: BuildSnapshot } | { kind: 'unknown'; detail: string }
export type GateResult = { kind: 'allow' } | { kind: 'blocked'; on: string } | { kind: 'unknown'; detail: string }
export type ReviewDecision =
  | { kind: 'approve' }
  | { kind: 'fix'; findings: readonly string[] }
  | Exclude<GateResult, { kind: 'allow' }>

export interface BuildRunInput {
  run_id: string
  mode: 'pr' | 'ralph' | 'wave' | 'bound_pr'
  start: 'fresh' | 'resume'
  repl_provider: Provider
  workers: Record<WorkPhase, {
    runner: WorkerRunner
    request: Omit<BoundedWorkRequest, 'run_id' | 'step_id' | 'role' | 'needs_approval_decision'>
  }>
}

/** Required, host-owned seams; no permissive default implementation.
 * Gate extraction owners provide these callbacks. The runtime contract currently
 * exports WorkerRunner but no BuildHost; keep host effects here until that lands.
 */
export interface BuildRunDeps {
  prepareWork(request: BoundedWorkRequest, context: { snapshot: BuildSnapshot; previous: unknown; findings: readonly string[] }): Promise<void>
  measure(): Promise<Measurement>
  admissionGate(input: BuildRunInput): Promise<GateResult>
  // Existing module vocabularies are preserved across extraction.
  runLeakGatePreflight(snapshot: BuildSnapshot): Promise<LeakPreflightOutcome>
  assessMergeDiff(diff: string): MergeDiffAssessment
  // reviewGate owns panel provenance, cross-model seats, severity and arbiter rules.
  reviewGate(payload: unknown, snapshot: BuildSnapshot, round: number): Promise<ReviewDecision>
  // publishGate owns mutation proof and publication readiness; mergeGate owns CI,
  // base drift and pinned-head merge eligibility. Both run on host observations.
  publishGate(snapshot: BuildSnapshot): Promise<GateResult>
  mergeGate(snapshot: BuildSnapshot): Promise<GateResult>
  publish(snapshot: BuildSnapshot): Promise<void>
  merge(snapshot: BuildSnapshot): Promise<void>
}

export type BuildRunOutcome =
  | { kind: 'merged'; snapshot: BuildSnapshot }
  | { kind: 'blocked'; phase: BuildPhase; on: string; recipient: 'orchestrator' }
  | { kind: 'refused'; reason: 'ralph-unsupported' | 'wave-unsupported' | 'bound-pr-unsupported' | 'resume-unsupported' | 'worker-unsupported'; detail: string }
  | { kind: 'failed'; phase: BuildPhase; detail: string; cause: TerminalCause }
  /** Nonterminal: preserve the worker and its step identity; do not reap/re-fire. */
  | { kind: 'unknown'; phase: BuildPhase; step_id: string | null; detail: string }

function samePr(a: BuildSnapshot['pr'], b: BuildSnapshot['pr']): boolean {
  return a === null ? b === null : b !== null && a.number === b.number && a.head === b.head && a.state === b.state
}

/** A trailer is untrusted even when a harness says the turn completed. */
function corroborates(value: unknown, measured: BuildSnapshot): value is BuildSnapshot & { payload?: unknown } {
  if (typeof value !== 'object' || value === null) return false
  const claim = value as Partial<BuildSnapshot>
  return claim.head === measured.head && claim.diff === measured.diff
    && claim.pr !== undefined && samePr(claim.pr, measured.pr)
}

/** Fresh PR state machine. Control flow and every side effect stay in this host. */
export async function buildRun(input: BuildRunInput, deps: BuildRunDeps, signal: AbortSignal): Promise<BuildRunOutcome> {
  let phase: BuildPhase = 'plan'
  let step_id: string | null = null
  const blocked = (on: string): BuildRunOutcome => ({ kind: 'blocked', phase, on, recipient: 'orchestrator' })
  const unknown = (detail: string): BuildRunOutcome => ({ kind: 'unknown', phase, step_id, detail })
  const failed = (detail: string, cause: TerminalCause = 'workflow-threw'): BuildRunOutcome => ({ kind: 'failed', phase, detail, cause })
  const gateStop = (gate: GateResult): BuildRunOutcome | null => {
    if (gate.kind === 'blocked') return blocked(gate.on)
    if (gate.kind === 'unknown') return unknown(gate.detail)
    return null
  }
  try {
    if (input.mode !== 'pr') {
      const reasons = { ralph: 'ralph-unsupported', wave: 'wave-unsupported', bound_pr: 'bound-pr-unsupported' } as const
      return { kind: 'refused', reason: reasons[input.mode], detail: 'Only fresh PR builds are supported' }
    }
    if (input.start !== 'fresh') return { kind: 'refused', reason: 'resume-unsupported', detail: 'Only fresh PR builds are supported' }
    // Enumerate every reachable worker role at admission, including later fixes.
    for (const role of ['plan', 'build', 'review', 'fix'] as const) {
      const { runner } = input.workers[role]
      const support = runner.supports(role, placementFor(runner.provider, input.repl_provider))
      if (!support.ok) return { kind: 'refused', reason: 'worker-unsupported', detail: `${role}: ${support.reason}: ${support.detail}` }
    }
    const admission = gateStop(await deps.admissionGate(input))
    if (admission) return admission

    let snapshot: BuildSnapshot
    const initial = await deps.measure()
    if (initial.kind === 'unknown') return unknown(initial.detail)
    snapshot = initial.value
    if (snapshot.pr !== null) return blocked('Fresh build already has a PR')

    let previousPayload: unknown = null
    let findings: readonly string[] = []
    async function work(role: WorkPhase, round: number): Promise<{ payload: unknown } | { stop: BuildRunOutcome }> {
      phase = role
      step_id = `${input.run_id}:${role}:${round}`
      const { runner, request } = input.workers[role]
      const boundedRequest: BoundedWorkRequest = {
        ...request, run_id: input.run_id, step_id, role, needs_approval_decision: false,
      }
      await deps.prepareWork(boundedRequest, { snapshot: structuredClone(snapshot), previous: previousPayload, findings })
      const outcome: BoundedWorkOutcome = await runner.run(
        boundedRequest, placementFor(runner.provider, input.repl_provider), signal)
      switch (outcome.kind) {
        case 'unknown': return { stop: unknown(outcome.detail) }
        case 'blocked': return { stop: blocked(outcome.on) }
        case 'refused': return { stop: blocked(`Worker refused: ${outcome.reason}`) }
        case 'failed': return { stop: failed(`${outcome.class}: ${outcome.detail}`) }
        case 'completed': break
      }
      const observation = await deps.measure()
      if (observation.kind === 'unknown') return { stop: unknown(observation.detail) }
      const measured = observation.value
      if (!corroborates(outcome.result, measured)) return { stop: failed('Worker trailer disagrees with host measurement', 'built-head-unverified') }
      // Read-only review must describe exactly the revision sent to the panel.
      if (role === 'review' && (measured.head !== snapshot.head || measured.diff !== snapshot.diff || !samePr(measured.pr, snapshot.pr))) {
        return { stop: blocked('Reviewed revision changed during review') }
      }
      snapshot = measured
      previousPayload = outcome.result.payload
      return { payload: outcome.result.payload }
    }

    for (const role of ['plan', 'build'] as const) {
      const result = await work(role, 0)
      if ('stop' in result) return result.stop
    }
    let previous: readonly string[] = []
    for (let round = 1; ; round++) {
      const result = await work('review', round)
      if ('stop' in result) return result.stop
      const decision = await deps.reviewGate(result.payload, snapshot, round)
      if (decision.kind === 'blocked') return blocked(decision.on)
      if (decision.kind === 'unknown') return unknown(decision.detail)
      if (decision.kind === 'approve') break
      if (round >= 5 || (round >= 3 && decision.findings.some(finding => previous.includes(finding)))) {
        return blocked('Review requires orchestrator arbitration: repeated finding or round ceiling')
      }
      findings = decision.findings
      previous = decision.findings
      const fix = await work('fix', round)
      if ('stop' in fix) return fix.stop
    }

    const reviewed = snapshot
    phase = 'publish'
    step_id = null
    const leak = await deps.runLeakGatePreflight(reviewed)
    if (leak.status !== 'clean' && leak.status !== 'fixed') return blocked(`Leak preflight: ${leak.status}`)
    const publishObservation = await deps.measure()
    if (publishObservation.kind === 'unknown') return unknown(publishObservation.detail)
    snapshot = publishObservation.value
    if (leak.head !== reviewed.head || !corroborates(reviewed, snapshot)) return blocked('Revision changed after review')
    const diff = deps.assessMergeDiff(snapshot.diff)
    if (!diff.allow) return blocked(diff.reason)
    const publishGate = gateStop(await deps.publishGate(snapshot))
    if (publishGate) return publishGate
    const beforePublish = await deps.measure()
    if (beforePublish.kind === 'unknown') return unknown(beforePublish.detail)
    if (!corroborates(snapshot, beforePublish.value)) return blocked('Revision changed during publication gates')
    await deps.publish(snapshot)

    phase = 'merge'
    const published = await deps.measure()
    if (published.kind === 'unknown') return unknown(published.detail)
    snapshot = published.value
    if (snapshot.head !== reviewed.head || snapshot.diff !== reviewed.diff || snapshot.pr?.state !== 'OPEN' || snapshot.pr.head !== reviewed.head) {
      return blocked('Published PR does not match reviewed revision')
    }
    const mergeGate = gateStop(await deps.mergeGate(snapshot))
    if (mergeGate) return mergeGate
    const beforeMerge = await deps.measure()
    if (beforeMerge.kind === 'unknown') return unknown(beforeMerge.detail)
    if (!corroborates(snapshot, beforeMerge.value)) return blocked('Revision changed during merge gates')
    // The merge implementation must atomically enforce snapshot.pr.head.
    await deps.merge(snapshot)
    const merged = await deps.measure()
    if (merged.kind === 'unknown') return unknown(merged.detail)
    if (merged.value.pr?.state !== 'MERGED' || merged.value.pr.number !== snapshot.pr.number || merged.value.pr.head !== reviewed.head) {
      return blocked('Merge not confirmed for reviewed PR')
    }
    return { kind: 'merged', snapshot: merged.value }
  } catch (error) {
    // A host exception can follow a successful external write. Preserve uncertainty.
    return unknown(error instanceof Error ? error.message : String(error))
  }
}
