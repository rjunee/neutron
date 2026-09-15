import { createHash } from 'node:crypto'
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

export interface ExecutionPlan {
  implementationPlan: string
  topTask: string
  remainingTasks: number
  executionSpec: string
}
export interface PlanProbe {
  found: boolean
  body: string
  /** SHA-256 of the committed bytes, independently measured by the host. */
  sha256: string
  uncheckedCount: number
}
export interface ResumeCheckpoint {
  head: string | null
  stage: 'built' | 'approved' | 'rejected' | 'fixed' | 'ralph-task-built' | 'ralph-task-built-deviated'
  round: number
  findings: readonly { kind: 'code' | 'lane'; actionable: boolean; text: string }[]
  previousFindings: readonly string[]
  /** A running/unobserved turn must be settled by its host, never dispatched again. */
  pending?: { phase: WorkPhase; step_id: string }
}
export interface BuildModeHost {
  loadResume(): Promise<ResumeCheckpoint | null>
  /** Diff must be generated using this exact OID, not a moving branch name. */
  regenerateDiff(head: string): Promise<{ kind: 'known'; diff: string } | { kind: 'unknown'; detail: string }>
  probePlan(head: string): Promise<PlanProbe | null>
  /** Atomically consume the old result and persist the next iteration. Must be
   * idempotent by run_id + round, and compare the expected head before advancing.
   * An unknown response is reconciled by the host before another buildRun call. */
  advanceRalph(value: { run_id: string; round: number; snapshot: BuildSnapshot; remainingTasks: number }): Promise<GateResult>
}

export interface BuildRunInput {
  run_id: string
  mode: 'pr' | 'ralph' | 'wave' | 'bound_pr'
  start: 'fresh' | 'resume'
  merge_mode?: 'pr' | 'local'
  bound_pr?: number
  pinnedTaskId?: string
  ralphRound?: number
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
  modes?: BuildModeHost
  prepareWork(request: BoundedWorkRequest, context: { snapshot: BuildSnapshot; previous: unknown; findings: readonly string[]; planner?: 'full' | 'next'; committedPlan?: PlanProbe }): Promise<void>
  measure(): Promise<Measurement>
  admissionGate(input: BuildRunInput): Promise<GateResult>
  // Existing module vocabularies are preserved across extraction.
  runLeakGatePreflight(snapshot: BuildSnapshot): Promise<LeakPreflightOutcome>
  assessMergeDiff(diff: string): MergeDiffAssessment
  // reviewGate owns panel provenance, cross-model seats, severity and arbiter rules.
  reviewGate(payload: unknown, snapshot: BuildSnapshot, round: number): Promise<ReviewDecision>
  // publishGate owns mutation proof and publication readiness; mergeGate owns CI,
  // base drift and pinned-head merge eligibility. Both run on host observations.
  publishGate(snapshot: BuildSnapshot, mergeMode?: 'pr' | 'local'): Promise<GateResult>
  mergeGate(snapshot: BuildSnapshot, mergeMode?: 'pr' | 'local'): Promise<GateResult>
  publish(snapshot: BuildSnapshot): Promise<void>
  /** Local effects must pin the reviewed head, preserve the branch and merge without rewriting it. */
  merge(snapshot: BuildSnapshot): Promise<void>
  confirmLocalMerge?(snapshot: BuildSnapshot): Promise<GateResult>
}

export type BuildRunOutcome =
  | { kind: 'merged'; snapshot: BuildSnapshot }
  | { kind: 'blocked'; phase: BuildPhase; on: string; recipient: 'orchestrator' }
  | { kind: 'built'; snapshot: BuildSnapshot; cause: 'wave-member-built' }
  | { kind: 'continued'; snapshot: BuildSnapshot; remainingTasks: number; cause: 'ralph-task-built' }
  | { kind: 'refused'; reason: 'worker-unsupported'; detail: string }
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

const fullOid = (head: string | null): head is string => typeof head === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)
const unchecked = (body: string): string[] => body.split('\n').filter(line => /^\s*- \[ \]\s+/.test(line))
function executionPlan(value: unknown): value is ExecutionPlan {
  if (!value || typeof value !== 'object') return false
  const plan = value as ExecutionPlan
  return typeof plan.implementationPlan === 'string' && typeof plan.topTask === 'string'
    && typeof plan.executionSpec === 'string' && Number.isSafeInteger(plan.remainingTasks) && plan.remainingTasks >= 0
}

/** Build state machine. Control flow and every side effect stay in this host. */
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
    // Enumerate every reachable worker role at admission, including later fixes.
    for (const role of ['plan', 'build', 'review', 'fix'] as const) {
      const { runner } = input.workers[role]
      const support = runner.supports(role, placementFor(runner.provider, input.repl_provider))
      if (!support.ok) return { kind: 'refused', reason: 'worker-unsupported', detail: `${role}: ${support.reason}: ${support.detail}` }
    }
    const local = input.merge_mode === 'local'
    if (local && input.mode === 'bound_pr') return blocked('Bound PR cannot use local merge mode')
    if (local && !deps.confirmLocalMerge) return unknown('Local merge confirmation source is missing')
    const admission = gateStop(await deps.admissionGate(input))
    if (admission) return admission

    const modes = deps.modes
    if ((input.mode === 'ralph' || input.start === 'resume') && !modes) return blocked('Mode host is required')
    const resume = input.start === 'resume' ? await modes!.loadResume() : null
    if (resume?.pending) {
      phase = resume.pending.phase
      step_id = resume.pending.step_id
      return unknown('Resume awaits the existing worker observation')
    }

    let snapshot: BuildSnapshot
    const initial = await deps.measure()
    if (initial.kind === 'unknown') return unknown(initial.detail)
    snapshot = initial.value
    if (local && snapshot.pr !== null) return blocked('Local build has a PR')
    if (input.mode === 'bound_pr') {
      if (!Number.isSafeInteger(input.bound_pr) || snapshot.pr?.number !== input.bound_pr || snapshot.pr?.state !== 'OPEN') {
        return blocked('Bound PR is not the requested open PR')
      }
    } else if (input.start === 'fresh' && snapshot.pr !== null) return blocked('Fresh build already has a PR')

    let skipBuild = false
    let approved = false
    let firstRound = 1
    let resumeFix = false
    let previous: readonly string[] = []
    if (resume) {
      if (!Number.isSafeInteger(resume.round) || resume.round < 0) return blocked('Invalid recorded review round')
      firstRound = Math.max(1, resume.round)
      previous = resume.previousFindings
      if (fullOid(resume.head) && snapshot.head !== 'absent' && !fullOid(snapshot.head)) {
        return failed('Required resume head is unreadable', 'resume-head-unreadable')
      }
      // G038: absence/movement rebuilds; only an exact full OID opens a fast path.
      if (fullOid(resume.head) && resume.head === snapshot.head
          && input.mode !== 'wave' && !resume.stage.startsWith('ralph-task-built')) {
        const regenerated = await modes!.regenerateDiff(resume.head)
        if (regenerated.kind === 'unknown') return unknown(regenerated.detail)
        // G040: an empty regenerated diff cannot authorize review or approval.
        if (regenerated.diff.trim().length > 0) {
          if (regenerated.diff !== snapshot.diff) return blocked('Regenerated diff disagrees with host measurement')
          skipBuild = true
          approved = resume.stage === 'approved'
          resumeFix = resume.stage === 'rejected' && resume.findings.some(f => f.kind === 'code' && f.actionable)
        }
      }
    }
    let planner: 'full' | 'next' = 'full'
    let committedPlan: PlanProbe | undefined
    const ralphRound = input.ralphRound ?? 0
    if (input.mode === 'ralph' && !skipBuild) {
      // G026: only a clean handoff can use the cheap planner, with periodic refresh.
      const clean = resume?.stage === 'ralph-task-built' && Number.isSafeInteger(ralphRound)
        && ralphRound > 0 && ralphRound % 5 !== 0
      if (clean) {
        const probe = await modes!.probePlan(snapshot.head)
        // G027 and G028: independently measured committed bytes and count agree.
        if (probe && probe.found && probe.body.trim().length > 0
            && Number.isSafeInteger(probe.uncheckedCount) && probe.uncheckedCount > 0
            && createHash('sha256').update(probe.body).digest('hex') === probe.sha256
            && unchecked(probe.body).length === probe.uncheckedCount) {
          planner = 'next'
          committedPlan = probe
        }
      }
    }

    let previousPayload: unknown = null
    let findings: readonly string[] = []
    async function work(role: WorkPhase, round: number): Promise<{ payload: unknown } | { stop: BuildRunOutcome }> {
      phase = role
      step_id = `${input.run_id}${input.mode === 'ralph' ? `:task:${input.ralphRound ?? 0}` : ''}:${role}:${round}`
      const { runner, request } = input.workers[role]
      const boundedRequest: BoundedWorkRequest = {
        ...request, run_id: input.run_id, step_id, role, needs_approval_decision: false,
      }
      await deps.prepareWork(boundedRequest, { snapshot: structuredClone(snapshot), previous: previousPayload, findings, planner, ...(committedPlan ? { committedPlan } : {}) })
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
      if (input.mode === 'bound_pr' && (measured.pr?.number !== input.bound_pr || measured.pr?.state !== 'OPEN')) {
        return { stop: blocked('Worker changed the bound PR identity') }
      }
      // Read-only review must describe exactly the revision sent to the panel.
      if (role === 'review' && (measured.head !== snapshot.head || measured.diff !== snapshot.diff || !samePr(measured.pr, snapshot.pr))) {
        return { stop: blocked('Reviewed revision changed during review') }
      }
      snapshot = measured
      previousPayload = outcome.result.payload
      return { payload: outcome.result.payload }
    }

    let plan: ExecutionPlan | null = null
    if (!skipBuild) {
      const planned = await work('plan', 0)
      if ('stop' in planned) return planned.stop
      if (input.mode === 'ralph' || input.mode === 'wave') {
        // G025: a completed worker with a null planner payload is still no plan.
        if (!executionPlan(planned.payload)) return blocked('Planner returned no execution plan')
        plan = { ...planned.payload }
        // G029: execution uses measured identity, bytes and remaining count.
        if (committedPlan) {
          plan.implementationPlan = committedPlan.body
          plan.topTask = unchecked(committedPlan.body)[0]!
          plan.remainingTasks = committedPlan.uncheckedCount - 1
        }
        if (input.mode === 'wave') {
          const pinned = unchecked(plan.implementationPlan).find(line =>
            line.trim().slice(6).split(/[:\s]/, 1)[0] === input.pinnedTaskId)
          if (!pinned || !input.pinnedTaskId) return blocked('Plan has no unchecked pinned wave task')
          plan.topTask = pinned
          plan.remainingTasks = 0
        }
        previousPayload = plan
      }
      const built = await work('build', 0)
      if ('stop' in built) return built.stop
      if (input.mode === 'wave') {
        // G034: even a corroborated short hash cannot become a join result.
        if (!fullOid(snapshot.head)) return failed('Wave build requires a full commit OID', 'built-head-unverified')
        return { kind: 'built', snapshot, cause: 'wave-member-built' }
      }
      if (input.mode === 'ralph' && plan!.remainingTasks > 0) {
        // G037: consume the old result before acknowledging the next iteration.
        const handoff = gateStop(await modes!.advanceRalph({ run_id: input.run_id, round: ralphRound,
          snapshot, remainingTasks: plan!.remainingTasks }))
        if (handoff) return handoff
        return { kind: 'continued', snapshot, remainingTasks: plan!.remainingTasks, cause: 'ralph-task-built' }
      }
    }
    if (resumeFix) {
      if (firstRound >= 5) return blocked('Review requires orchestrator arbitration: round ceiling')
      findings = resume!.findings.filter(f => f.kind === 'code' && f.actionable).map(f => f.text)
      if (firstRound >= 3 && findings.some(f => previous.includes(f))) return blocked('Review requires orchestrator arbitration: repeated finding')
      previous = findings
      const fixed = await work('fix', firstRound)
      if ('stop' in fixed) return fixed.stop
      firstRound++
    }
    for (let round = firstRound; !approved; round++) {
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
    const publishGate = gateStop(await deps.publishGate(snapshot, input.merge_mode))
    if (publishGate) return publishGate
    const beforePublish = await deps.measure()
    if (beforePublish.kind === 'unknown') return unknown(beforePublish.detail)
    if (!corroborates(snapshot, beforePublish.value)) return blocked('Revision changed during publication gates')
    if (!local) await deps.publish(snapshot)

    phase = 'merge'
    const published = await deps.measure()
    if (published.kind === 'unknown') return unknown(published.detail)
    snapshot = published.value
    if (local ? !corroborates(reviewed, snapshot) || snapshot.pr !== null : (input.mode === 'bound_pr' && snapshot.pr?.number !== input.bound_pr) || snapshot.head !== reviewed.head || snapshot.diff !== reviewed.diff || snapshot.pr?.state !== 'OPEN' || snapshot.pr.head !== reviewed.head) {
      return blocked(local ? 'Local revision changed before merge' : 'Published PR does not match reviewed revision')
    }
    const mergeGate = gateStop(await deps.mergeGate(snapshot, input.merge_mode))
    if (mergeGate) return mergeGate
    const beforeMerge = await deps.measure()
    if (beforeMerge.kind === 'unknown') return unknown(beforeMerge.detail)
    if (!corroborates(snapshot, beforeMerge.value)) return blocked('Revision changed during merge gates')
    // The merge effect must atomically enforce the reviewed head and assessed base.
    await deps.merge(snapshot)
    const merged = await deps.measure()
    if (merged.kind === 'unknown') return unknown(merged.detail)
    if (local) {
      if (merged.value.head !== reviewed.head || merged.value.pr !== null) return blocked('Local revision changed during merge')
      const confirmation = gateStop(await deps.confirmLocalMerge!(reviewed))
      if (confirmation) return confirmation
    } else if (merged.value.pr?.state !== 'MERGED' || merged.value.pr.number !== snapshot.pr!.number || merged.value.pr.head !== reviewed.head) {
      return blocked('Merge not confirmed for reviewed PR')
    }
    return { kind: 'merged', snapshot: merged.value }
  } catch (error) {
    // A host exception can follow a successful external write. Preserve uncertainty.
    return unknown(error instanceof Error ? error.message : String(error))
  }
}
