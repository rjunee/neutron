import { applyReviewCi, type ReviewCiAssessment } from './gates/review-ci.ts'
import { builderBranch, confirmedMerged, fixLanded } from './gates/build-transition.ts'
import { createLogger } from '@neutronai/logger'
// `blocked()` takes a STRING, so this uses the runtime helper rather than the gate
// wrapper in `./gates/unknown-cause.ts`, which returns a `GateResult`.
import { TERMINAL_CAUSE_MAX, unknownCause } from '@neutronai/runtime/refusal-cause.ts'
import { createHash } from 'node:crypto'
import { clampPlanBranchBrief, validateTrailer } from './gates/result-contract.ts'
import {
  placementFor,
  type BoundedWorkOutcome,
  type BoundedWorkRequest,
  type Provider,
  type WorkerRunner,
} from '@neutronai/runtime/bounded-work.ts'
import type { LeakPreflightOutcome } from './leak-preflight.ts'
import type { MergeDiffAssessment } from './merge.ts'
import { applyReviewSuite, type SuiteAssessment } from './gates/review-suite.ts'
import { reviewProgress, type ReviewProgress } from './gates/review-progress.ts'
import type { TerminalCause } from './terminal-cause.ts'
import type { PhaseUsageReport } from './phase-usage.ts'

const log = createLogger('trident')

export type BuildLeakPreflightOutcome = Omit<LeakPreflightOutcome, 'status'> & {
  status: LeakPreflightOutcome['status'] | 'unknown'
}

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
  | { kind: 'fix'; findings: readonly string[]; blockingCount?: number }
  | { kind: 're-plan'; findings: readonly string[]; whatIsMissing: string; blockingCount?: number }
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
  /** Persisted by the host alongside the review checkpoint. */
  replansUsed?: number
  previousBlockingCount?: number
  findings: readonly { kind: 'code' | 'lane'; actionable: boolean; text: string }[]
  previousFindings: readonly string[]
  /** A running/unobserved turn must be settled by its host, never dispatched again. */
  pending?: { phase: WorkPhase; step_id: string } | undefined
}
export interface BuildModeHost {
  loadResume(): Promise<ResumeCheckpoint | null>
  /** Only the driver supplies this state; never pass a worker trailer here. */
  saveCheckpoint(checkpoint: ResumeCheckpoint): Promise<void>
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
  /** PR proven by dispatch to belong to this card's prior terminal run. */
  owned_pr?: number
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
  /** Required host run-row reader; only an omitted field on a known row uses the stored default. */
  readReviewCap(runId: string): Promise<{ kind: 'known'; max_rounds?: number | undefined } | { kind: 'unknown'; detail: string }>
  assignedBranch?: string | undefined
  modes?: BuildModeHost
  prepareWork(request: BoundedWorkRequest, context: { snapshot: BuildSnapshot; previous: unknown; findings: readonly string[]; planner?: 'full' | 'next'; committedPlan?: PlanProbe }): Promise<void>
  /** Read back the materialized review input after preparation, before dispatch. */
  reviewArtifact?(request: BoundedWorkRequest, snapshot: BuildSnapshot): Promise<GateResult>
  measure(): Promise<Measurement>
  /** Resolve a differing commit claim and preserve a real conflict before refusing. */
  checkBuildClaim?(claim: string, snapshot: BuildSnapshot): Promise<GateResult>
  /** Re-measure fix ancestry against the host-held pre-fix revision. */
  checkFixLineage?(snapshot: BuildSnapshot, reviewedHead: string): Promise<GateResult>
  admissionGate(input: BuildRunInput): Promise<GateResult>
  // Existing module vocabularies are preserved across extraction.
  runLeakGatePreflight(snapshot: BuildSnapshot): Promise<BuildLeakPreflightOutcome>
  assessMergeDiff(diff: string): MergeDiffAssessment
  reviewReadiness?(snapshot: BuildSnapshot, signal: AbortSignal, mergeMode?: 'pr' | 'local'): Promise<GateResult>
  /** Local runs never publish a branch, so the host decides what CI evidence
   *  means for them, exactly as it does for `reviewReadiness`/`publishGate`. */
  reviewCi?(snapshot: BuildSnapshot, mergeMode?: 'pr' | 'local', signal?: AbortSignal): Promise<ReviewCiAssessment>
  reviewSuite?(snapshot: BuildSnapshot, round: number): Promise<SuiteAssessment>
  /** Terminal full-suite evidence, measured before final publication/merge progression. */
  /** REQUIRED. Terminal full-suite evidence, measured before merge. A driver with no
   * source for it cannot establish that the cumulative branch passes, so the decision
   * belongs at construction rather than as a runtime `unknown` each caller must recall. */
  publicationSuite(snapshot: BuildSnapshot): Promise<SuiteAssessment>
  // reviewGate owns panel provenance and severity, and records evidence before filtering.
  reviewGate(payload: unknown, snapshot: BuildSnapshot, round: number, replansUsed?: number, recordProgress?: (value: ReviewProgress) => void): Promise<ReviewDecision>
  // publishGate owns mutation proof and publication readiness; mergeGate owns CI,
  // base drift and pinned-head merge eligibility. Both run on host observations.
  publishGate(snapshot: BuildSnapshot, mergeMode?: 'pr' | 'local'): Promise<GateResult>
  mergeGate(snapshot: BuildSnapshot, mergeMode?: 'pr' | 'local'): Promise<GateResult>
  publish(snapshot: BuildSnapshot): Promise<void>
  /** Local effects must pin the reviewed head, preserve the branch and merge without rewriting it. */
  merge(snapshot: BuildSnapshot): Promise<void>
  /** Persist absolute totals for each model phase after every completed turn. */
  recordPhaseUsage(runId: string, phase: string, report: PhaseUsageReport): Promise<void>
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

/** Two HOST measurements describe the same revision. Both sides come from the same
 *  `readDiff`, so comparing the diff bytes is exact and free, and it is the point:
 *  these are the drift checks that catch the branch moving under a gate. */
function corroborates(value: unknown, measured: BuildSnapshot): value is BuildSnapshot & { payload?: unknown } {
  if (typeof value !== 'object' || value === null) return false
  const claim = value as Partial<BuildSnapshot>
  return claim.head === measured.head && claim.diff === measured.diff
    && claim.pr !== undefined && samePr(claim.pr, measured.pr)
}

/**
 * A WORKER'S trailer agrees with the host measurement. A trailer is untrusted even
 * when a harness says the turn completed, so this still checks it — but on what the
 * worker can actually be held to.
 *
 * NOT THE DIFF BYTES. This used to reuse `corroborates`, which demanded the worker
 * reproduce the host's diff byte for byte. The host produces it with
 * `--binary --no-ext-diff --no-textconv --full-index` and the brief never stated
 * that invocation, so a worker running a plain `git diff` returned an abbreviated
 * `index 00000000..3936b410` where the host had the full 40-hex pair — semantically
 * identical, textually different, and the run stopped with "Worker trailer disagrees
 * with host measurement". Measured on acceptance run 5a69ae54: 9505 bytes against the
 * host's 9719, first difference at byte 180, in the index line and nowhere else.
 *
 * Dropping it loses no safety, because `head` pins the exact commit: with the same
 * head and the host's own base, the diff is DETERMINED, so the only thing the byte
 * comparison could ever detect is git's output formatting. And the worker's diff is
 * discarded regardless — `snapshot = measured` below keeps the host's, and only
 * `result.payload` travels on. The gate rejected a value it then threw away.
 *
 * `pr` stays: it is a claim about the world that the head does not determine.
 */
function claimMatches(value: unknown, measured: BuildSnapshot): value is BuildSnapshot & { payload?: unknown } {
  if (typeof value !== 'object' || value === null) return false
  const claim = value as Partial<BuildSnapshot>
  return claim.head === measured.head && claim.pr !== undefined && samePr(claim.pr, measured.pr)
}

const fullOid = (head: string | null): head is string => typeof head === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)
const unchecked = (body: string): string[] => body.split('\n').filter(line => /^\s*- \[ \]\s+/.test(line))

/**
 * A worker trailer is a claim, not a panel verdict. Keep a schema-valid APPROVE
 * visible when the host cannot obtain its CI receipt, while leaving every verdict
 * consumer on the host-verified REVIEW_NOT_RUN path.
 */
function ciUnknownDetail(payload: unknown, detail: string): string {
  const trailer = validateTrailer('verdict', payload)
  return trailer.ok && trailer.value.verdict === 'APPROVE'
    ? `${detail}. Review worker reported APPROVE; host receipt not obtained.`
    : detail
}

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
  // G019 stays in the retained review-only executor, including on resume.
  if (input.mode === 'bound_pr') return blocked('bound_pr requires the retained review-only executor')
  try {
    // Enumerate every reachable worker role at admission, including later fixes.
    for (const role of ['plan', 'build', 'review', 'fix'] as const) {
      const { runner } = input.workers[role]
      const support = runner.supports(role, placementFor(runner.provider, input.repl_provider))
      if (!support.ok) return { kind: 'refused', reason: 'worker-unsupported', detail: `${role}: ${support.reason}: ${support.detail}` }
    }
    const local = input.merge_mode === 'local'
    if (local && !deps.confirmLocalMerge) return unknown('Local merge confirmation source is missing')
    const admission = gateStop(await deps.admissionGate(input))
    if (admission) return admission

    if (!deps.readReviewCap) return unknown('Review round cap source is missing')
    const cap = await deps.readReviewCap(input.run_id)
    if (cap.kind === 'unknown') return unknown(cap.detail)
    const maxRounds = cap.max_rounds === undefined ? 10 : cap.max_rounds
    if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) return unknown('Review round cap is invalid')

    const modes = deps.modes
    if ((input.mode === 'ralph' || input.start === 'resume') && !modes) return blocked('Mode host is required')
    const resume = input.start === 'resume' ? await modes!.loadResume() : null
    phase = resume?.pending?.phase ?? phase
    step_id = resume?.pending?.step_id ?? step_id
    let snapshot: BuildSnapshot
    const initial = await deps.measure()
    if (initial.kind === 'unknown') return unknown(initial.detail)
    snapshot = initial.value
    if (!local && confirmedMerged(snapshot)) return { kind: 'merged', snapshot }
    if (resume?.pending) {
      phase = resume.pending.phase
      step_id = resume.pending.step_id
      return unknown('Resume awaits the existing worker observation')
    }
    if (local && snapshot.pr !== null) return blocked('Local build has a PR')
    const ownsMeasuredPr = snapshot.pr !== null && snapshot.pr.number === input.owned_pr
      && snapshot.pr.state === 'OPEN' && snapshot.pr.head === snapshot.head
    if (input.start === 'fresh' && snapshot.pr !== null && !ownsMeasuredPr) {
      return blocked('Fresh build already has a PR')
    }

    let replansUsed = resume?.replansUsed ?? 0
    if (replansUsed !== 0 && replansUsed !== 1) return blocked('Invalid recorded re-plan count')
    let skipBuild = false
    let approved = false
    let firstRound = 1
    let resumeFix = false
    // A resume whose recorded head is a real commit that the branch has since LEFT.
    // Only this shape must not reuse the round-0 result identities: the retained
    // `plan:0` / `build:0` files describe the checkpointed revision, and movement
    // deliberately invalidates that revision and everything derived from it. An
    // absent head, a wave task, or a ralph task rebuild reuse round 0 as before —
    // four existing cases pin that, and the first draft of this fix broke all four
    // by treating every resume as a moved one.
    let headMoved = false
    let previous: readonly string[] = []
    let previousReview: ReviewProgress | undefined
    let previousBlockingCount = resume?.previousBlockingCount ?? resume?.previousFindings.length ?? 0
    if (resume) {
      if (!Number.isSafeInteger(resume.round) || resume.round < 0) return blocked('Invalid recorded review round')
      firstRound = Math.max(1, resume.round)
      previous = resume.previousFindings
      if (fullOid(resume.head) && snapshot.head !== 'absent' && !fullOid(snapshot.head)) {
        return failed('Required resume head is unreadable', 'resume-head-unreadable')
      }
      headMoved = fullOid(resume.head) && fullOid(snapshot.head) && resume.head !== snapshot.head
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

    let durable: ResumeCheckpoint = resume ?? { head: null, stage: 'built', round: 0,
      replansUsed: 0, findings: [], previousFindings: [] }
    async function checkpoint(patch: Partial<ResumeCheckpoint>) {
      durable = { ...durable, replansUsed, previousFindings: previous, previousBlockingCount, ...patch }
      await modes?.saveCheckpoint(structuredClone(durable))
    }
    let previousPayload: unknown = null
    let findings: readonly string[] = []
    const usageTotals = new Map<string, PhaseUsageReport>()
    async function work(role: WorkPhase, round: number): Promise<{ payload: unknown } | { stop: BuildRunOutcome }> {
      phase = role
      step_id = `${input.run_id}${input.mode === 'ralph' ? `:task:${input.ralphRound ?? 0}` : ''}:${role}:${round}`
      const { runner, request } = input.workers[role]
      const boundedRequest: BoundedWorkRequest = {
        ...request, run_id: input.run_id, step_id, role, needs_approval_decision: false,
      }
      await checkpoint({ pending: { phase: role, step_id }, round: Math.max(durable.round, round) })
      await deps.prepareWork(boundedRequest, { snapshot: structuredClone(snapshot), previous: previousPayload, findings, planner, ...(committedPlan ? { committedPlan } : {}) })
      if (role === 'review') {
        if (!deps.reviewArtifact) return { stop: unknown('Review artifact host is missing') }
        const artifact = gateStop(await deps.reviewArtifact(boundedRequest, snapshot))
        if (artifact) return { stop: artifact }
      }
      let outcome: BoundedWorkOutcome
      try {
        outcome = await runner.run(boundedRequest, placementFor(runner.provider, input.repl_provider), signal)
      } catch (error) {
        if (role === 'review') return { stop: blocked(unknownCause('infra-only: Review round threw before producing synthesis', error, input.run_id).slice(0, TERMINAL_CAUSE_MAX)) }
        if (role === 'plan' && replansUsed > 0) return { stop: blocked(unknownCause('design-gap: re-plan-failed: planner threw before producing a revised execution spec', error, input.run_id).slice(0, TERMINAL_CAUSE_MAX)) }
        throw error
      }
      switch (outcome.kind) {
        case 'unknown': return { stop: unknown(outcome.detail) }
        case 'blocked': return { stop: blocked(outcome.on) }
        case 'refused': return { stop: blocked(`Worker refused: ${outcome.reason}`) }
        case 'failed': return { stop: failed(`${outcome.class}: ${outcome.detail}`) }
        case 'completed': break
      }
      const usagePhase = role === 'plan' ? 'decomposition' : role === 'review' ? 'review_adversarial' : 'build'
      const priorUsage = usageTotals.get(usagePhase)
      const cacheRead = outcome.usage?.cache_read_input_tokens
      const report: PhaseUsageReport = {
        status: 'partial',
        input_tokens: outcome.usage === null || priorUsage?.input_tokens === null ? null : (priorUsage?.input_tokens ?? 0) + outcome.usage.input_tokens,
        output_tokens: outcome.usage === null || priorUsage?.output_tokens === null ? null : (priorUsage?.output_tokens ?? 0) + outcome.usage.output_tokens,
        cache_read_tokens: priorUsage
          ? priorUsage.cache_read_tokens === null || cacheRead === undefined ? null : priorUsage.cache_read_tokens + cacheRead
          : cacheRead ?? null,
        cache_creation_tokens: null,
        cost_usd: null,
        source: outcome.model_reported === null || priorUsage?.source === 'unknown-model' ? 'unknown-model'
          : priorUsage && priorUsage.source !== outcome.model_reported ? 'multiple-models' : outcome.model_reported,
        observed_at: Math.max(Date.now(), (priorUsage?.observed_at ?? -1) + 1),
      }
      await deps.recordPhaseUsage(input.run_id, usagePhase, report)
      usageTotals.set(usagePhase, report)
      let observation = await deps.measure()
      if (local && (role === 'build' || role === 'fix')) {
        // G032: the host owns the three-read budget; no worker sets it.
        for (let attempt = 1; attempt < 3 && (observation.kind === 'unknown' || !fullOid(observation.value.head)); attempt++) {
          observation = await deps.measure()
        }
        if (observation.kind === 'known' && !fullOid(observation.value.head)) {
          return { stop: unknown('Built head is missing or not a full commit OID after 3 read attempts') }
        }
      }
      if (observation.kind === 'unknown') return { stop: unknown(observation.detail) }
      const measured = observation.value
      // G036 precedes trailer and lost-round checks: merging can remove the branch.
      if (!local && confirmedMerged(measured, snapshot.pr)) return { stop: { kind: 'merged', snapshot: measured } }
      if (role === 'build' || role === 'fix') {
        const payload = outcome.result && typeof outcome.result === 'object' && 'payload' in outcome.result ? outcome.result.payload : undefined
        const branch = gateStop(builderBranch(deps.assignedBranch, payload))
        if (branch) return { stop: branch }
      }
      if (role === 'fix' && !fixLanded(snapshot.head, measured.head)) return { stop: failed('Fix round did not move the measured branch head', 'round-lost-work') }
      if (role === 'fix') {
        if (!deps.checkFixLineage) return { stop: unknown('Fix lineage host is missing') }
        const lineage = gateStop(await deps.checkFixLineage(measured, snapshot.head))
        if (lineage) return { stop: lineage }
      }
      let result = outcome.result
      if ((role === 'build' || role === 'fix') && result && typeof result === 'object'
          && 'head' in result && typeof result.head === 'string' && result.head !== measured.head
          && /^[a-f0-9]{4,64}$/i.test(result.head)) {
        if (!deps.checkBuildClaim) return { stop: unknown('Build claim resolution and preservation source is missing') }
        const claim = await deps.checkBuildClaim(result.head, measured)
        if (claim.kind === 'unknown') return { stop: unknown(claim.detail) }
        if (claim.kind === 'blocked') return { stop: failed(claim.on, 'built-head-unverified') }
        result = { ...result, head: measured.head }
      }
      if (!claimMatches(result, measured)) return { stop: failed('Worker trailer disagrees with host measurement', 'built-head-unverified') }
      // Read-only review must describe exactly the revision sent to the panel.
      if (role === 'review' && (measured.head !== snapshot.head || measured.diff !== snapshot.diff || !samePr(measured.pr, snapshot.pr))) {
        return { stop: blocked('Reviewed revision changed during review') }
      }
      snapshot = measured
      // The host records the produced head before returning it, so a crash after a
      // build or fix resumes from what was made rather than redoing it. `result` is
      // the trailer AFTER the measured head replaced any claim, which is the value
      // the rest of the driver uses.
      if (role === 'build' || role === 'fix') {
        await checkpoint({ head: measured.head, stage: role === 'fix' ? 'fixed' : 'built',
          round: role === 'fix' ? round + 1 : Math.max(durable.round, 1, round + 1), pending: undefined, findings: [] })
      }
      const payload = role === 'plan' ? clampPlanBranchBrief(result.payload) : result.payload
      previousPayload = payload
      return { payload }
    }

    let plan: ExecutionPlan | null = null
    async function planAndBuild(round: number): Promise<BuildRunOutcome | null> {
      const replanning = replansUsed > 0
      const replanFailed = (reason: string) => blocked(`design-gap: re-plan-failed: ${reason}`)
      const planned = await work('plan', round)
      if ('stop' in planned) {
        // Running or unreadable work retains its identity; it is not a failed plan.
        // Corroboration failures retain their existing measured-evidence cause.
        if (replanning && planned.stop.kind === 'failed' && planned.stop.cause === 'workflow-threw') return replanFailed(planned.stop.detail)
        return planned.stop
      }
      // G075: even PR mode must receive a usable replacement before rebuilding.
      if (replanning && (!planned.payload || typeof planned.payload !== 'object'
          || !('executionSpec' in planned.payload) || typeof planned.payload.executionSpec !== 'string'
          || !planned.payload.executionSpec.trim())) return replanFailed('planner returned no executionSpec')
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
      const built = await work('build', round)
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
      return null
    }
    if (!skipBuild) {
      // A rebuild after the head MOVED must not reuse the round-0 result identities
      // (see `headMoved`). Every other rebuild keeps them.
      const stop = await planAndBuild(headMoved ? firstRound : 0)
      if (stop) return stop
    }
    if (resumeFix) {
      if (firstRound >= maxRounds) return blocked('Review requires orchestrator arbitration: round ceiling')
      findings = resume!.findings.filter(f => f.kind === 'code' && f.actionable).map(f => f.text)
      if (firstRound >= 3 && findings.some(f => previous.includes(f))) return blocked('Review requires orchestrator arbitration: repeated finding')
      if (replansUsed > 0 && (findings.some(f => previous.includes(f)) || findings.length >= previousBlockingCount)) return blocked('Review requires orchestrator arbitration: post-re-plan trigger')
      previous = findings
      previousBlockingCount = findings.length
      previousReview = { findings: [...findings], blockingCount: findings.length }
      const fixed = await work('fix', firstRound)
      if ('stop' in fixed) return fixed.stop
      firstRound++
    }
    async function publishCandidate(): Promise<BuildRunOutcome | null> {
      const candidate = snapshot
      phase = 'publish'
      step_id = null
      const leak = await deps.runLeakGatePreflight(candidate)
      // G139: completed scans are advisory; CI enforces the findings.
      const emit = leak.status === 'clean' || leak.status === 'fixed' ? log.info : log.warn
      emit('leak_preflight', { run_id: input.run_id, status: leak.status, note: leak.note,
        findings: JSON.stringify(leak.findings), skipped_rules: leak.skipped_rules.join(', ') })
      if (leak.status === 'unknown' || leak.status === 'skipped-no-gate') return unknown(`Leak preflight did not run: ${leak.note}`)
      const publishObservation = await deps.measure()
      if (publishObservation.kind === 'unknown') return unknown(publishObservation.detail)
      snapshot = publishObservation.value
      if (leak.head !== candidate.head || !corroborates(candidate, snapshot)) return blocked('Revision changed during publication preflight')
      const diff = deps.assessMergeDiff(snapshot.diff)
      if (!diff.allow) return blocked(diff.reason)
      const publishGate = gateStop(await deps.publishGate(snapshot, input.merge_mode))
      if (publishGate) return publishGate
      const beforePublish = await deps.measure()
      if (beforePublish.kind === 'unknown') return unknown(beforePublish.detail)
      if (!corroborates(snapshot, beforePublish.value)) return blocked('Revision changed during publication gates')
      if (!local) await deps.publish(snapshot)

      const published = await deps.measure()
      if (published.kind === 'unknown') return unknown(published.detail)
      snapshot = published.value
      if (snapshot.head !== candidate.head || snapshot.diff !== candidate.diff
          || (!local && (snapshot.pr?.state !== 'OPEN' || snapshot.pr.head !== candidate.head
            || (candidate.pr !== null && snapshot.pr.number !== candidate.pr.number)))) {
        return blocked(local ? 'Local revision changed before merge' : 'Published PR does not match candidate revision')
      }
      return null
    }

    for (let round = firstRound; !approved; round++) {
      if (round > maxRounds) return blocked('Review requires orchestrator arbitration: round ceiling')
      phase = 'review'
      step_id = null
      // G035/G043: both fresh builds and fixes need a measured review artifact.
      if (!fullOid(snapshot.head) || !snapshot.diff.trim()) return unknown('Review requires a full branch head and nonempty diff artifact')
      if (!local) {
        const stop = await publishCandidate()
        if (stop) return stop
        phase = 'review'
      }
      if (!deps.reviewReadiness) return unknown('Review readiness host is missing')
      const readiness = gateStop(await deps.reviewReadiness(snapshot, signal, input.merge_mode))
      if (readiness) return readiness
      if (!deps.reviewSuite) return unknown('Review suite host is missing')
      const suite = await deps.reviewSuite(snapshot, round)
      if (suite.kind === 'unknown') return unknown(suite.detail)
      if (!deps.reviewCi) return unknown('Review CI host is missing')
      const ciBefore = await deps.reviewCi(snapshot, input.merge_mode, signal)
      if (ciBefore.kind === 'unknown') return unknown(ciBefore.detail)
      if (ciBefore.kind === 'blocked') return blocked(ciBefore.on)
      findings = [...findings, ...ciBefore.findings.map(f => `${f.title}: ${f.evidence}`)]
      findings = [...findings, ...suite.findings.map(f => `${f.title}: ${f.evidence}`)]
      const readyRevision = await deps.measure()
      if (readyRevision.kind === 'unknown') return unknown(readyRevision.detail)
      if (!corroborates(snapshot, readyRevision.value)) return blocked('Revision changed during review readiness')
      const result = await work('review', round)
      if ('stop' in result) return result.stop
      const ci = await deps.reviewCi(snapshot, input.merge_mode, signal)
      if (ci.kind === 'unknown') return unknown(ciUnknownDetail(result.payload, ci.detail))
      if (ci.kind === 'blocked') return blocked(ci.on)
      let currentReview: ReviewProgress | undefined
      const panel = await deps.reviewGate(result.payload, snapshot, round, replansUsed, value => {
        currentReview = { findings: [...value.findings], blockingCount: value.blockingCount }
      })
      const suiteDecision = applyReviewSuite(panel, suite)
      const decision = applyReviewCi(suiteDecision, ci)
      if (currentReview) {
        const suiteBlockers = [...suite.findings, ...ci.findings].filter(f => !f.advisory)
        currentReview = { findings: [...currentReview.findings, ...suiteBlockers.map(f => `${f.title}: ${f.evidence}`)], blockingCount: currentReview.blockingCount + suiteBlockers.length }
      }
      if (decision.kind === 'blocked') return blocked(decision.on)
      if (decision.kind === 'unknown') return unknown(decision.detail)
      // The rejection is recorded BEFORE the stops below. A repeated finding or an
      // exhausted round ends the run, and the orchestrator resumes from this row;
      // writing it only on the paths that continue would lose exactly the rounds
      // that need it.
      if (decision.kind === 'fix') {
        await checkpoint({ head: snapshot.head, stage: 'rejected', round, pending: undefined,
          findings: decision.findings.map(text => ({ kind: 'code' as const, actionable: true, text })) })
      }
      if (decision.kind === 're-plan' && replansUsed !== 0) return blocked('Review requires orchestrator arbitration: re-plan already spent')
      const progress = gateStop(reviewProgress(previousReview, currentReview))
      if (progress) return progress
      if (decision.kind === 'approve') {
        await checkpoint({ head: snapshot.head, stage: 'approved', round, pending: undefined, findings: [] })
        break
      }
      previousReview = currentReview
      if (decision.kind === 're-plan') {
        // G077: a replacement needs a subsequent review within the host's cap.
        if (round >= maxRounds) return blocked(`design-gap: re-plan-unreachable: ${decision.whatIsMissing}; no round left for the bounded re-plan`)
        replansUsed++
        findings = [decision.whatIsMissing, ...new Set([...decision.findings, ...currentReview!.findings])]
        await checkpoint({ head: null, stage: 'built', round: round + 1, pending: undefined, findings: [] })
        planner = 'full'
        committedPlan = undefined
        const stop = await planAndBuild(round)
        if (stop) return stop
        continue
      }
      if (round >= maxRounds) return blocked('Review requires orchestrator arbitration: round ceiling')
      findings = [...new Set([...decision.findings, ...currentReview!.findings])]
      const fix = await work('fix', round)
      if ('stop' in fix) return fix.stop
    }

    phase = 'publish'
    step_id = null
    if (!deps.publicationSuite) return unknown('Publication suite host is missing')
    const publicationSuite = await deps.publicationSuite(snapshot)
    if (publicationSuite.kind === 'unknown') return unknown(publicationSuite.detail)
    const suiteBlockers = publicationSuite.findings.filter(f => !f.advisory)
    if (suiteBlockers.length > 0) return blocked(suiteBlockers.map(f => `${f.title}: ${f.evidence}`).join('\n'))

    if (local || approved) {
      const stop = await publishCandidate()
      if (stop) return stop
    }

    const reviewed = snapshot
    phase = 'merge'
    const published = await deps.measure()
    if (published.kind === 'unknown') return unknown(published.detail)
    snapshot = published.value
    if (local ? !corroborates(reviewed, snapshot) || snapshot.pr !== null : !corroborates(reviewed, snapshot) || snapshot.pr?.state !== 'OPEN' || snapshot.pr.head !== reviewed.head) {
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
