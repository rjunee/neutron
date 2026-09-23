import { applyReviewCi, type ReviewCiAssessment } from './gates/review-ci.ts'
import { builderBranch, confirmedMerged, fixLanded } from './gates/build-transition.ts'
import { createLogger } from '@neutronai/logger'
// `blocked()` takes a STRING, so this uses the runtime helper rather than the gate
// wrapper in `./gates/unknown-cause.ts`, which returns a `GateResult`.
import { TERMINAL_CAUSE_MAX, unknownCause } from '@neutronai/runtime/refusal-cause.ts'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { clampPlanBranchBrief, validateTrailer, type PlanTrailer } from './gates/result-contract.ts'
import { isExecutionStrategy, type ExecutionStrategy, type ExecutionStrategySource } from './execution-strategy.ts'
import { normalizeLegacyStoredExecutionPlan } from './legacy-execution-compat.ts'
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
import type { ReviewPanelObservation } from './gates/review-panel.ts'

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
export type NominationRepair = { kind: 'repair-nomination'; finding: string }
export type PublicationGateResult = GateResult | NominationRepair
export type ReviewDecision =
  | { kind: 'approve' }
  | { kind: 'fix'; findings: readonly string[]; blockingCount?: number }
  | { kind: 're-plan'; findings: readonly string[]; whatIsMissing: string; blockingCount?: number }
  | Exclude<GateResult, { kind: 'allow' }>

export type ExecutionPlan = PlanTrailer
export type ExecutionStrategyObservation = {
  kind: 'known'
  strategy: ExecutionStrategy | null
  rationale: string | null
  plan: ExecutionPlan | null
  source: ExecutionStrategySource | null
} | { kind: 'unknown'; detail: string }
export interface PlanProbe {
  found: boolean
  body: string
  /** SHA-256 of the committed bytes, independently measured by the host. */
  sha256: string
  uncheckedCount: number
}
export type PlanCommit = { kind: 'known'; head: string } | Exclude<GateResult, { kind: 'allow' }>
export interface TaskHandoffIntent { iteration: number; builtHead: string; body: string }
export interface ResumeCheckpoint {
  head: string | null
  stage: 'built' | 'approved' | 'rejected' | 'fixed' | 'task-built' | 'task-built-deviated'
  round: number
  /** Persisted by the host alongside the review checkpoint. */
  replansUsed?: number
  previousBlockingCount?: number
  /** Host-validated plan remainder at the completed task-sequence build; absent is unknown. */
  remainingTasks?: number | undefined
  /** Completed intermediate task: spend is durable before the Git ledger write. */
  handoff?: TaskHandoffIntent | undefined
  findings: readonly { kind: 'code' | 'lane'; actionable: boolean; text: string }[]
  previousFindings: readonly string[]
  /** Baseline retained across completion checkpoints; omission is legacy evidence. */
  previousReview?: ReviewProgress | null
  /** Explicit provenance, independent of round numbers and branch movement. */
  reviewBaseline?: 'none' | 'required'
  /** Re-present only the original request to its idempotent runner. Legacy pending
   * rows without the host continuation remain unknown. */
  pending?: { phase: WorkPhase; step_id: string; recovery?: PendingRecovery } | undefined
}

interface PendingRecovery {
  request: BoundedWorkRequest
  inputs: ReturnType<typeof recoveryInputs>
  round: number
  snapshot: BuildSnapshot
  previous: unknown
  findings: readonly string[]
  planner: 'full' | 'next'
  committedPlan?: PlanProbe
  plan: ExecutionPlan | null
  executionStrategy: ExecutionStrategy | null
  /** Null records known absence; omission is incomplete recovery evidence. */
  previousReview: ReviewProgress | null
  reviewBaseline: 'none' | 'required'
}

function validReviewBaseline(marker: unknown, progress: unknown): boolean {
  return marker === 'none' ? progress === null : marker === 'required' && validReviewProgress(progress)
}

function validReviewProgress(value: unknown): value is ReviewProgress {
  if (!value || typeof value !== 'object') return false
  const progress = value as ReviewProgress
  return Array.isArray(progress.findings) && progress.findings.every(f => typeof f === 'string' && f.trim().length > 0)
    && Number.isSafeInteger(progress.blockingCount) && progress.blockingCount >= 0
}

function recoveryInputs(input: BuildRunInput, maxRounds: number) {
  // owned_pr is fresh-admission provenance, and can appear after this run publishes.
  // The original and measured snapshots bind recovery to the actual PR instead.
  const { start: _start, owned_pr: _ownedPr, executionStrategy: _strategy, workers, ...identity } = input
  // JSON checkpoints omit absent optional inputs; compare that same durable form.
  return { ...Object.fromEntries(Object.entries(identity).filter(([, value]) => value !== undefined)),
    ...(input.mode === 'implementation' ? { taskIteration: input.taskIteration ?? 0 } : {}), maxRounds, workers: Object.fromEntries(
    Object.entries(workers).map(([role, { runner, request }]) => [role, { provider: runner.provider, request }]),
  ) }
}
export interface BuildModeHost {
  loadExecutionStrategy(): Promise<ExecutionStrategyObservation>
  /** Persist the validated proposal before builder dispatch; refresh cannot reclassify. */
  selectExecutionStrategy(value: { strategy: ExecutionStrategy; rationale: string; plan: ExecutionPlan; refresh: boolean }): Promise<GateResult>
  loadResume(): Promise<ResumeCheckpoint | null>
  /** Only the driver supplies this state; never pass a worker trailer here. */
  saveCheckpoint(checkpoint: ResumeCheckpoint): Promise<void>
  /** Diff must be generated using this exact OID, not a moving branch name. */
  regenerateDiff(head: string): Promise<{ kind: 'known'; diff: string } | { kind: 'unknown'; detail: string }>
  probePlan(head: string): Promise<PlanProbe | null>
  /** Commit the host-rendered task ledger (the branch's own `.trident/ledgers/<branch>.md`) on top of
   * `snapshot`, which must still be the live revision. Idempotent: a tip whose
   * committed ledger already equals `body` returns that tip and writes nothing.
   * `known` carries the resulting full head, which the driver re-measures. */
  commitPlan(value: { body: string; snapshot: BuildSnapshot }): Promise<PlanCommit>
  /** Read-only proof that a moved tip is exactly the intended ledger-only child. */
  recoverTaskHandoff?(value: { intent: TaskHandoffIntent; snapshot: BuildSnapshot }): Promise<GateResult>
  /** Atomically consume the old result and persist the next iteration. Must be
   * idempotent by run_id + round, and compare the expected head before advancing.
   * An unknown response is reconciled by the host before another buildRun call. */
  advanceTask(value: { run_id: string; round: number; snapshot: BuildSnapshot; remainingTasks: number }): Promise<GateResult>
}

export interface BuildRunInput {
  run_id: string
  mode: 'implementation' | 'wave' | 'bound_pr'
  executionStrategy?: ExecutionStrategy | null
  start: 'fresh' | 'resume'
  merge_mode?: 'pr' | 'local'
  bound_pr?: number
  /** PR proven by dispatch to belong to this card's prior terminal run. */
  owned_pr?: number
  pinnedTaskId?: string
  taskIteration?: number
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
  /** Narrow compatibility for the original, still-reserved legacy request. Never
   * authorize new work or substitute provider, grants, budget or worker identity. */
  validateLegacyPendingRequest?(workers: PendingRecovery['inputs']['workers']): Promise<GateResult>
  prepareWork(request: BoundedWorkRequest, context: { snapshot: BuildSnapshot; previous: unknown; findings: readonly string[]; planner?: 'full' | 'next'; executionStrategy?: ExecutionStrategy | null; committedPlan?: PlanProbe; suiteScope?: 'full-suite' | 'subset'; testStrategy?: string }): Promise<void>
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
  observeReview(snapshot: BuildSnapshot, round: number): Promise<ReviewPanelObservation>
  reviewGate(payload: unknown, observation: ReviewPanelObservation, snapshot: BuildSnapshot, round: number, replansUsed?: number, recordProgress?: (value: ReviewProgress) => void): Promise<ReviewDecision>
  // publishGate owns mutation proof and publication readiness; mergeGate owns CI,
  // base drift and pinned-head merge eligibility. Both run on host observations.
  publishGate(snapshot: BuildSnapshot, mergeMode?: 'pr' | 'local'): Promise<PublicationGateResult>
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
  | { kind: 'continued'; snapshot: BuildSnapshot; remainingTasks: number; cause: 'task-built' }
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
const uncheckedLine = /^\s*- \[ \]\s+/
const unchecked = (body: string): string[] => body.split('\n').filter(line => uncheckedLine.test(line))

/**
 * THE TASK LEDGER. A task-sequence plan's `implementationPlan` is a checkbox list — one
 * `- [x] T<n>: …` line per task already built on this branch, one `- [ ] T<n>: …`
 * line per task still to build, the top task first — and the host commits it at
 * every handoff, at the branch's own `.trident/ledgers/<branch>.md`
 * (`taskLedgerPath`, trident/production-host-effects.ts). That committed file is the
 * ONLY thing G026's cheap continuation planner can read (`probePlan` archives it at
 * the tip), so a plan whose counts disagree with its own boxes would hand the next
 * iteration a ledger that says something different from what this iteration built.
 *
 * Before this, nothing in the typed host wrote a ledger: the planner's lived only in
 * `plan.result`, `probePlan` found main's stale root copy with zero unchecked boxes,
 * and every continuation re-planned from scratch (spec item
 * a-retry-must-resume-from-the-checkpoint, acceptance 2).
 *
 * This shape check applies where a ledger is committed: `remainingTasks > 0`.
 * Separately, full refreshes preserve the accepted pending queue even when the
 * new proposal claims to be terminal. The top task is compared with its checkbox marker
 * stripped on both sides: `T1: foo` and `- [ ] T1: foo` name the same task (the
 * publication title strips the marker for the same reason, open/wiring/project-build.ts).
 */
const taskText = (line: string): string => line.trim().replace(/^- \[ \]\s+/, '').trim()
function ledgerAgrees(plan: ExecutionPlan): boolean {
  if (plan.remainingTasks === 0) return true
  const open = unchecked(plan.implementationPlan)
  return open.length === plan.remainingTasks + 1 && taskText(open[0]!) === taskText(plan.topTask)
}
/** The ledger with its top task — the first unchecked line — ticked. */
function tickTopTask(body: string): string {
  const lines = body.split('\n')
  const top = lines.findIndex(line => uncheckedLine.test(line))
  lines[top] = lines[top]!.replace('- [ ]', '- [x]')
  return lines.join('\n')
}

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
  return validateTrailer('plan', value).ok
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
  if (input.mode !== 'implementation' && input.mode !== 'wave') return blocked('Unknown build mode')
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
    if ((input.mode === 'implementation' || input.start === 'resume') && !modes) return blocked('Mode host is required')
    // Wave is an explicit host mode, but migrated waves still need their stored
    // provenance to reconcile an original pre-cutover worker reservation.
    const selection = modes ? await modes.loadExecutionStrategy() : null
    if (selection?.kind === 'unknown') return unknown(selection.detail)
    const selected = input.mode === 'implementation' ? selection : null
    const legacySelection = selection?.source === 'legacy' ? selection : null
    let strategy = selected?.strategy ?? null
    if (selected && (strategy === null
      ? selected.source !== null || selected.rationale !== null || selected.plan !== null
      : !isExecutionStrategy(strategy) || !['planner', 'legacy'].includes(selected.source ?? '')
        || typeof selected.rationale !== 'string' || !selected.rationale.trim()
        || (selected.plan === null ? selected.source !== 'legacy'
          : !executionPlan(selected.plan) || selected.plan.strategy !== strategy))) {
      return unknown('Persisted execution strategy is missing valid selection evidence')
    }
    if (input.mode === 'implementation' && input.executionStrategy !== undefined && input.executionStrategy !== strategy) {
      return unknown('Execution strategy changed after launch preparation')
    }
    let acceptedPlan = selected?.plan ?? null
    const resume = input.start === 'resume' ? await modes!.loadResume() : null
    if (input.mode === 'implementation' && strategy === null && resume && resume.pending?.phase !== 'plan') {
      return unknown('Resume requires a persisted execution strategy before completed work can be reused')
    }
    phase = resume?.pending?.phase ?? phase
    step_id = resume?.pending?.step_id ?? step_id
    let snapshot: BuildSnapshot
    const initial = await deps.measure()
    if (initial.kind === 'unknown') return unknown(initial.detail)
    snapshot = initial.value
    if (!local && confirmedMerged(snapshot)) return { kind: 'merged', snapshot }
    let recovery = resume?.pending?.recovery
    if (resume?.pending) {
      const pending = resume.pending
      const original = recovery?.request
      let expectedInputs = recoveryInputs(input, maxRounds)
      let expectedRequest = input.workers[pending.phase].request
      if (legacySelection && recovery && deps.validateLegacyPendingRequest
        && !isDeepStrictEqual(recovery.inputs.workers, expectedInputs.workers)) {
        const compatible = gateStop(await deps.validateLegacyPendingRequest(recovery.inputs.workers))
        if (compatible) return compatible
        expectedInputs = { ...expectedInputs, workers: recovery.inputs.workers }
        expectedRequest = recovery.inputs.workers[pending.phase]!.request
      }
      const expected = { ...expectedRequest, run_id: input.run_id,
        step_id: pending.step_id, role: pending.phase, needs_approval_decision: false }
      if (!recovery || !isDeepStrictEqual(original, expected)
          || !isDeepStrictEqual(recovery.inputs, expectedInputs)
          || !Number.isSafeInteger(recovery.round) || recovery.round < 0
          || !recovery.snapshot || typeof recovery.snapshot.head !== 'string' || typeof recovery.snapshot.diff !== 'string'
          || (recovery.snapshot.pr !== null && (!recovery.snapshot.pr
            || !Number.isSafeInteger(recovery.snapshot.pr.number) || recovery.snapshot.pr.number < 1
            || typeof recovery.snapshot.pr.head !== 'string' || !['OPEN', 'CLOSED', 'MERGED'].includes(recovery.snapshot.pr.state)))
          || !Array.isArray(recovery.findings) || !recovery.findings.every(f => typeof f === 'string')
          || !['full', 'next'].includes(recovery.planner) || !('previous' in recovery)
          || !(recovery.executionStrategy === null || isExecutionStrategy(recovery.executionStrategy))
          || (pending.phase !== 'plan' && input.mode === 'implementation' && recovery.executionStrategy !== strategy)
          || (recovery.plan !== null && !executionPlan(recovery.plan))
          || !validReviewBaseline(recovery.reviewBaseline, recovery.previousReview)
          || ((pending.phase === 'fix' || (resume.replansUsed ?? 0) > 0) && recovery.reviewBaseline !== 'required')
          || recovery.reviewBaseline !== resume.reviewBaseline
          || !isDeepStrictEqual(recovery.previousReview, resume.previousReview)) {
        return unknown('Resume cannot validate the original pending worker request and context')
      }
      if (pending.phase === 'build' && acceptedPlan === null && selected?.source === 'legacy'
        && recovery.plan !== null && recovery.plan.strategy === strategy) {
        const adopted = gateStop(await modes!.selectExecutionStrategy({ strategy: recovery.plan.strategy,
          rationale: recovery.plan.rationale, plan: structuredClone(recovery.plan), refresh: true }))
        if (adopted) return adopted
        const observed = await modes!.loadExecutionStrategy()
        if (observed.kind === 'unknown') return unknown(observed.detail)
        if (observed.strategy !== strategy || observed.source !== 'legacy'
          || observed.rationale !== recovery.plan.rationale || !isDeepStrictEqual(observed.plan, recovery.plan)) {
          return unknown('Legacy pending plan persistence was not confirmed')
        }
        acceptedPlan = structuredClone(recovery.plan)
      }
      const expectedStep = `${input.run_id}${recovery.executionStrategy === 'task_sequence' ? `:task:${input.taskIteration ?? 0}` : ''}:${pending.phase}:${recovery.round}`
        + (pending.phase === 'review' ? `:head:${recovery.snapshot.head}` : '')
      if (pending.step_id !== expectedStep || (pending.phase !== 'plan' && recovery.round > maxRounds)
          || (pending.phase === 'build' && (!recovery.plan
            || (input.mode === 'implementation' && (strategy === null || recovery.plan.strategy !== strategy
              || !isDeepStrictEqual(recovery.plan, acceptedPlan)))))) {
        return unknown('Resume cannot validate the original pending worker identity')
      }
      // Read-only work cannot explain movement. Mutating work is reconciled below
      // against its original input revision and the independently measured result.
      if ((pending.phase === 'review' || !recovery.request.writable) && !corroborates(recovery.snapshot, snapshot)) {
        return unknown('Pending worker input revision changed before recovery')
      }
    }
    if (local && snapshot.pr !== null) return blocked('Local build has a PR')
    // Receipt provenance establishes ownership; a fresh checkout can still be at base.
    // Publication and merge enforce equality with the reviewed head later.
    const ownsMeasuredPr = snapshot.pr !== null && snapshot.pr.number === input.owned_pr
      && snapshot.pr.state === 'OPEN'
    if (input.start === 'fresh' && snapshot.pr !== null && !ownsMeasuredPr) {
      return blocked('Fresh build already has a PR')
    }

    let replansUsed = resume?.replansUsed ?? 0
    if (replansUsed !== 0 && replansUsed !== 1) return blocked('Invalid recorded re-plan count')
    let skipBuild = false
    let discardHandoff = false
    let resumeTaskHandoff: ExecutionPlan | null = null
    let approved = false
    let firstRound = 1
    let resumeFix = false
    // A resume whose recorded head is a real commit that the branch has since LEFT.
    // Only this shape must not reuse the round-0 result identities: the retained
    // `plan:0` / `build:0` files describe the checkpointed revision, and movement
    // deliberately invalidates that revision and everything derived from it. An
    // absent head, a wave task, or a task_sequence task rebuild reuse round 0 as before —
    // four existing cases pin that, and the first draft of this fix broke all four
    // by treating every resume as a moved one.
    let headMoved = false
    let previous: readonly string[] = resume?.previousFindings ?? []
    if (resume && (!validReviewBaseline(resume.reviewBaseline, resume.previousReview)
        || ((replansUsed > 0 || resume.stage === 'fixed' || resume.stage === 'rejected') && resume.reviewBaseline !== 'required'))) {
      return unknown('Resume prior review baseline is missing or invalid')
    }
    let previousReview: ReviewProgress | undefined = resume?.previousReview ?? undefined
    let reviewBaseline: 'none' | 'required' = resume?.reviewBaseline ?? 'none'
    let previousBlockingCount = resume?.previousBlockingCount ?? resume?.previousFindings.length ?? 0
    if (resume && (!Number.isSafeInteger(resume.round) || resume.round < 0)) return blocked('Invalid recorded review round')
    if (resume && !recovery) {
      firstRound = Math.max(1, resume.round)
      previous = resume.previousFindings
      if (fullOid(resume.head) && snapshot.head !== 'absent' && !fullOid(snapshot.head)) {
        return failed('Required resume head is unreadable', 'resume-head-unreadable')
      }
      headMoved = fullOid(resume.head) && fullOid(snapshot.head) && resume.head !== snapshot.head
      if (resume.handoff) {
        const intent = resume.handoff
        if (strategy !== 'task_sequence' || resume.stage !== 'built' || !acceptedPlan
          || acceptedPlan.remainingTasks !== resume.remainingTasks || !ledgerAgrees(acceptedPlan)
          || acceptedPlan.remainingTasks <= 0 || intent.body !== tickTopTask(acceptedPlan.implementationPlan)
          || !Number.isSafeInteger(intent.iteration) || intent.iteration < 0 || !fullOid(intent.builtHead)) {
          return unknown('Task ledger intent disagrees with the completed task')
        }
        if (resume.head !== snapshot.head) {
          if (!modes!.recoverTaskHandoff) return unknown('Task ledger recovery host is missing')
          const recovered = snapshot.head === 'absent' ? { kind: 'blocked' as const, on: 'Task branch is absent' }
            : await modes!.recoverTaskHandoff({ intent, snapshot })
          if (recovered.kind === 'unknown') return unknown(recovered.detail)
          if (recovered.kind === 'allow') {
            resume.head = snapshot.head
            headMoved = false
          } else discardHandoff = true
        }
        // Spend may already be one ahead of the unresolved handoff's identity.
        input = { ...input, taskIteration: intent.iteration + (discardHandoff ? 1 : 0) }
      }
      // G038: arbitrary movement rebuilds. Only an exact full OID (including
      // the ledger child independently authenticated above) opens a fast path.
      if (fullOid(resume.head) && resume.head === snapshot.head
          && input.mode !== 'wave' && !resume.stage.startsWith('task-built')) {
        const regenerated = await modes!.regenerateDiff(resume.head)
        if (regenerated.kind === 'unknown') return unknown(regenerated.detail)
        // G040: an empty regenerated diff cannot authorize review or approval.
        if (regenerated.diff.trim().length > 0) {
          if (regenerated.diff !== snapshot.diff) return blocked('Regenerated diff disagrees with host measurement')
          // A builder checkpoint precedes the ledger/iteration handoff. Reusing
          // its head must not turn an intermediate task into a completed card.
          if (strategy === 'task_sequence' && resume.stage === 'built') {
            if (!Number.isSafeInteger(resume.remainingTasks) || resume.remainingTasks! < 0
              || !acceptedPlan || acceptedPlan.remainingTasks !== resume.remainingTasks || !ledgerAgrees(acceptedPlan)) {
              return unknown('Task-sequence built checkpoint cannot establish its remaining task handoff')
            }
            if (resume.remainingTasks !== 0) resumeTaskHandoff = structuredClone(acceptedPlan)
          }
          skipBuild = true
          approved = resume.stage === 'approved'
          resumeFix = resume.stage === 'rejected' && resume.findings.some(f => f.kind === 'code' && f.actionable)
        } else if (resume.handoff) {
          // G040 cannot reuse a completed no-op at the launch base. Retire its
          // already spent identity before reserving a budget-checked rebuild.
          discardHandoff = true
          input = { ...input, taskIteration: resume.handoff.iteration + 1 }
        }
      }
    }
    let planner: 'full' | 'next' = 'full'
    let committedPlan: PlanProbe | undefined
    const taskIteration = input.taskIteration ?? 0
    if (strategy === 'task_sequence' && !skipBuild && !recovery) {
      // G026: only a clean handoff can use the cheap planner, with periodic refresh.
      const clean = resume?.stage === 'task-built' && Number.isSafeInteger(taskIteration)
        && taskIteration > 0 && taskIteration % 5 !== 0
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
      durable = { ...durable, replansUsed, previousFindings: previous, previousBlockingCount,
        previousReview: previousReview ?? null, reviewBaseline, ...patch }
      await modes?.saveCheckpoint(structuredClone(durable))
    }
    if (discardHandoff) {
      await checkpoint({ handoff: undefined, stage: 'task-built-deviated' })
    }
    if (acceptedPlan && strategy === 'task_sequence' && !skipBuild && !recovery) {
      // Every new task planner, including a clean continuation, needs remaining
      // durable budget. Settling a completed handoff or reconciling an existing
      // worker dispatches no new work and must remain possible at the cap.
      const budget = gateStop(await modes!.selectExecutionStrategy({ strategy,
        rationale: acceptedPlan.rationale, plan: structuredClone(acceptedPlan), refresh: true }))
      if (budget) return budget
    } else if (resume?.handoff && resume.head === snapshot.head) {
      // Persist the independently authenticated child before ordinary handoff.
      await checkpoint({ head: snapshot.head })
    }
    let previousPayload: unknown = acceptedPlan
    let findings: readonly string[] = []
    if (recovery) {
      snapshot = structuredClone(recovery.snapshot)
      previousPayload = recovery.previous
      findings = recovery.findings
      planner = recovery.planner
      committedPlan = recovery.committedPlan
      firstRound = Math.max(1, resume!.round, recovery.round)
      previousReview = recovery.previousReview ?? undefined
      reviewBaseline = recovery.reviewBaseline
      skipBuild = recovery.request.role === 'review' || recovery.request.role === 'fix'
      resumeFix = recovery.request.role === 'fix'
    }
    async function work(role: WorkPhase, round: number): Promise<{ payload: unknown; review?: ReviewPanelObservation } | { stop: BuildRunOutcome }> {
      phase = role
      step_id = recovery?.request.step_id ?? `${input.run_id}${strategy === 'task_sequence' ? `:task:${input.taskIteration ?? 0}` : ''}:${role}:${round}`
      // Review is read-only and its result is meaningful only for this measured
      // revision. A resumed round can keep its number while its head changes;
      // reusing that round's old id would recover the previous head's approval.
      // Exact-head recovery keeps the same id, including its pending reservation.
      if (role === 'review' && !recovery) step_id += `:head:${snapshot.head}`
      if (!validReviewBaseline(reviewBaseline, previousReview ?? null)
          || ((role === 'fix' || replansUsed > 0) && reviewBaseline !== 'required')) {
        return { stop: unknown('Worker continuation requires prior review progress') }
      }
      const { runner, request } = input.workers[role]
      const boundedRequest: BoundedWorkRequest = recovery?.request ?? {
        ...request, run_id: input.run_id, step_id, role, needs_approval_decision: false,
      }
      if (recovery && (boundedRequest.role !== role || boundedRequest.step_id !== step_id)) {
        return { stop: unknown('Resume would dispatch a different pending worker') }
      }
      const execute = recovery ? runner.recover?.bind(runner) : runner.run.bind(runner)
      if (!execute) return { stop: unknown('Pending worker runner cannot recover without dispatch') }
      // Only the validated plan can defer a task-sequence builder's full suite. Fixes and
      // terminal tasks require it, regardless of a strategy supplied at launch.
      const suiteScope = role === 'build' && strategy === 'task_sequence' && plan !== null && plan.remainingTasks > 0
        ? 'subset' : 'full-suite'
      if (!recovery) await deps.prepareWork(boundedRequest, { snapshot: structuredClone(snapshot), previous: previousPayload, findings, planner,
        executionStrategy: strategy,
        ...(committedPlan ? { committedPlan } : {}), ...((role === 'build' || role === 'fix') ? { suiteScope } : {}) })
      if (role === 'review') {
        if (!deps.reviewArtifact) return { stop: unknown('Review artifact host is missing') }
        const artifact = gateStop(await deps.reviewArtifact(boundedRequest, snapshot))
        if (artifact) return { stop: artifact }
      }
      if (!recovery) await checkpoint({ pending: { phase: role, step_id, recovery: {
        request: structuredClone(boundedRequest), inputs: structuredClone(recoveryInputs(input, maxRounds)), round,
        snapshot: structuredClone(snapshot), previous: previousPayload ?? null, findings, planner,
        ...(committedPlan ? { committedPlan } : {}), plan, executionStrategy: strategy, previousReview: previousReview ?? null, reviewBaseline,
      } }, round: Math.max(durable.round, round) })
      let outcome: BoundedWorkOutcome
      let review: ReviewPanelObservation | undefined
      try {
        if (role === 'review' && recovery) {
          // Reconcile the original worker before starting any other producer. A
          // missing reservation cannot fall through to an ordinary dispatch.
          outcome = await execute(boundedRequest, placementFor(runner.provider, input.repl_provider), signal)
          if (outcome.kind === 'completed') review = await deps.observeReview(structuredClone(snapshot), round)
        } else if (role === 'review') {
          if (!deps.observeReview) return { stop: unknown('Review observation host is missing') }
          // Readiness, CI, suite and artifact preparation have all passed. Start
          // every independent producer before awaiting a verdict, and drain both
          // sides even when one rejects. No fix or merge can race a live reviewer.
          const [standalone, panel] = await Promise.allSettled([
            Promise.resolve().then(() => execute(boundedRequest, placementFor(runner.provider, input.repl_provider), signal)),
            Promise.resolve().then(() => deps.observeReview(structuredClone(snapshot), round)),
          ])
          if (standalone.status === 'rejected') throw standalone.reason
          if (panel.status === 'rejected') throw panel.reason
          outcome = standalone.value
          review = panel.value
        } else outcome = await execute(boundedRequest, placementFor(runner.provider, input.repl_provider), signal)
      } catch (error) {
        if (role === 'review') return { stop: blocked(unknownCause('infra-only: Review producer failed during the review join', error, input.run_id).slice(0, TERMINAL_CAUSE_MAX)) }
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
          round: role === 'fix' ? round + 1 : Math.max(durable.round, 1, round + 1), pending: undefined, findings: [],
          ...(role === 'build' ? { remainingTasks: strategy === 'task_sequence' ? plan!.remainingTasks : 0,
            handoff: strategy === 'task_sequence' && plan!.remainingTasks > 0
              ? { iteration: taskIteration, builtHead: measured.head, body: tickTopTask(plan!.implementationPlan) } : undefined } : {}) })
      }
      // Only reconciliation of an original pre-cutover reservation may translate
      // the old planner shape. Every newly dispatched planner uses the closed v2
      // contract, including later work on a migrated run.
      const legacyPlan = role === 'plan' && recovery?.request.result.schema === 'project-plan'
        && legacySelection ? normalizeLegacyStoredExecutionPlan(result.payload,
          { execution_strategy: legacySelection.strategy, strategy_source: legacySelection.source }) : null
      const payload = role === 'plan' ? clampPlanBranchBrief(legacyPlan ?? result.payload) : result.payload
      previousPayload = payload
      recovery = undefined
      return { payload, ...(review ? { review } : {}) }
    }

    /** Spend and intent precede Git. A lost commit acknowledgement is recovered
     * only after the host proves the exact direct-child ledger-only revision. */
    async function commitLedger(body: string): Promise<BuildRunOutcome | null> {
      const committed = await modes!.commitPlan({ body, snapshot: structuredClone(snapshot) })
      if (committed.kind === 'blocked') return blocked(committed.on)
      if (committed.kind === 'unknown') return unknown(committed.detail)
      const observation = await deps.measure()
      if (observation.kind === 'unknown') return unknown(observation.detail)
      if (!fullOid(committed.head) || observation.value.head !== committed.head) {
        return unknown('Task ledger commit is not the measured branch head')
      }
      const moved = observation.value.head !== snapshot.head
      snapshot = observation.value
      if (moved) await checkpoint({ head: snapshot.head, stage: 'built', pending: undefined, findings: [] })
      return null
    }

    let plan: ExecutionPlan | null = recovery?.plan ?? null
    async function planAndBuild(round: number): Promise<BuildRunOutcome | null> {
      const replanning = replansUsed > 0
      const replanFailed = (reason: string) => blocked(`design-gap: re-plan-failed: ${reason}`)
      const recoveringBuild = recovery?.request.role === 'build'
      const planned = recoveringBuild ? { payload: recovery!.plan } : await work('plan', round)
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
      {
        // G025: a completed worker with a null planner payload is still no plan.
        if (!executionPlan(planned.payload)) return blocked('Planner returned no execution plan')
        plan = { ...planned.payload }
        if (input.mode === 'implementation' && strategy !== null && plan.strategy !== strategy) {
          return blocked('Planner cannot change the persisted execution strategy')
        }
        if (input.mode === 'implementation' && plan.strategy === 'single' && plan.remainingTasks !== 0) {
          return blocked('Single execution plan must cover the whole work without remaining tasks')
        }
        // G029: execution uses measured identity, bytes and remaining count.
        if (committedPlan) {
          plan.implementationPlan = committedPlan.body
          plan.topTask = unchecked(committedPlan.body)[0]!
          plan.remainingTasks = committedPlan.uncheckedCount - 1
        }
        // G025, ledger shape: checked on the plan the build will EXECUTE, after G029
        // replaced a cheap planner's claims with the committed bytes. task-sequence only — a
        // wave member's top task and count are the pin's, not the planner's.
        if (input.mode === 'implementation' && plan.strategy === 'task_sequence' && !ledgerAgrees(plan)) {
          return blocked('Planner returned no execution plan: the task ledger disagrees with topTask/remainingTasks')
        }
        if (input.mode === 'implementation' && plan.strategy === 'task_sequence'
            && acceptedPlan && !committedPlan && !recoveringBuild) {
          // A full planner may revise execution details, but only the host's
          // completed handoff can remove a task from the accepted pending queue.
          // Matching the saved count prevents advancing twice if selection was
          // persisted before the planner reservation was cleared on a restart.
          const pending = unchecked(acceptedPlan.implementationPlan).map(taskText)
          // Previously accepted terminal plans can name their sole task without
          // checkbox syntax. Preserve that identity rather than inventing a queue.
          const opaqueTerminal = pending.length === 0 && acceptedPlan.remainingTasks === 0
          if (opaqueTerminal) pending.push(taskText(acceptedPlan.topTask))
          if (resume?.stage === 'task-built' && resume.head === snapshot.head
              && acceptedPlan.remainingTasks > 0 && resume.remainingTasks === acceptedPlan.remainingTasks) pending.shift()
          const proposed = unchecked(plan.implementationPlan).map(taskText)
          if (opaqueTerminal && proposed.length === 0 && plan.remainingTasks === 0) proposed.push(taskText(plan.topTask))
          if (!isDeepStrictEqual(proposed, pending) || pending.length === 0
              || plan.remainingTasks !== pending.length - 1 || taskText(plan.topTask) !== pending[0]) {
            return blocked('Planner cannot change the host-owned pending task sequence')
          }
        }
        if (input.mode === 'wave') {
          const pinned = unchecked(plan.implementationPlan).find(line =>
            line.trim().slice(6).split(/[:\s]/, 1)[0] === input.pinnedTaskId)
          if (!pinned || !input.pinnedTaskId) return blocked('Plan has no unchecked pinned wave task')
          plan.topTask = pinned
          plan.remainingTasks = 0
        }
        if (input.mode === 'implementation' && !recoveringBuild) {
          const persisted = gateStop(await modes!.selectExecutionStrategy({ strategy: plan.strategy,
            rationale: plan.rationale, plan: structuredClone(plan), refresh: acceptedPlan !== null || strategy !== null }))
          if (persisted) return persisted
          const observed = await modes!.loadExecutionStrategy()
          if (observed.kind === 'unknown') return unknown(observed.detail)
          if (observed.strategy !== plan.strategy || observed.source !== (selected?.source ?? 'planner')
            || observed.rationale !== plan.rationale
            || !isDeepStrictEqual(observed.plan, plan)) return unknown('Execution strategy persistence was not confirmed')
          strategy = plan.strategy
          acceptedPlan = structuredClone(plan)
          // The accepted decision is durable before clearing the planner reservation.
          // A restart in between reconciles that same planner request and decision.
          await checkpoint({ pending: undefined })
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
      if (strategy === 'task_sequence' && plan!.remainingTasks > 0) {
        // THE LEDGER IS COMMITTED AT A HANDOFF ONLY, never on the final iteration. A
        // handoff's next reader is the continuation planner, which reads the committed
        // file. The final iteration's next readers are review and publication, which
        // bind every worker receipt — the suite checkpoint, the mutation nomination, the
        // publication body — to the head the BUILDER reported (`readArtifact`,
        // open/wiring/project-build.ts). A host commit on top would leave the reviewed
        // head with no receipt at all, so no multi-task card could ever merge (measured
        // end to end: `open/__tests__/project-build-e2e.test.ts`, the task-sequence-handoff
        // retry). The merged ledger therefore records the last handoff's state — at
        // the branch's OWN path, so no two cards' ledgers meet in a merge, and as
        // prose the mutation gate treats as inert, so a documentation-only card keeps
        // its exemption with the ledger in its diff.
        return handoffTask(plan!)
      }
      return null
    }
    async function handoffTask(completed: ExecutionPlan): Promise<BuildRunOutcome> {
      // Older completed checkpoints lack an intent. Upgrade before any Git write.
      if (!durable.handoff) await checkpoint({ handoff: { iteration: taskIteration,
        builtHead: snapshot.head, body: tickTopTask(completed.implementationPlan) } })
      const ledger = await commitLedger(tickTopTask(completed.implementationPlan))
      if (ledger) return ledger
      // G037: consume the old result before acknowledging the next iteration.
      // The measured ledger commit carries the completed task for its next reader.
      const handoff = gateStop(await modes!.advanceTask({ run_id: input.run_id, round: taskIteration,
        snapshot, remainingTasks: completed.remainingTasks }))
      if (handoff) return handoff
      return { kind: 'continued', snapshot, remainingTasks: completed.remainingTasks, cause: 'task-built' }
    }
    if (resumeTaskHandoff) return await handoffTask(resumeTaskHandoff)
    if (!skipBuild) {
      // A rebuild after the head MOVED must not reuse the round-0 result identities
      // (see `headMoved`). Every other rebuild keeps them.
      const stop = await planAndBuild(recovery?.round ?? (headMoved ? firstRound : 0))
      if (stop) return stop
    }
    if (resumeFix) {
      if (firstRound >= maxRounds) return blocked('Review requires orchestrator arbitration: round ceiling')
      findings = recovery?.findings ?? resume!.findings.filter(f => f.kind === 'code' && f.actionable).map(f => f.text)
      if (!recovery && firstRound >= 3 && findings.some(f => previous.includes(f))) return blocked('Review requires orchestrator arbitration: repeated finding')
      if (!recovery && replansUsed > 0 && (findings.some(f => previous.includes(f)) || findings.length >= previousBlockingCount)) return blocked('Review requires orchestrator arbitration: post-re-plan trigger')
      if (!recovery) {
        previous = findings
        previousBlockingCount = previousReview?.blockingCount ?? previousBlockingCount
      }
      const fixed = await work('fix', firstRound)
      if ('stop' in fixed) return fixed.stop
      firstRound++
    }
    async function repairNomination(repair: NominationRepair, round: number): Promise<BuildRunOutcome | null> {
      if (recovery) return unknown('Pending worker must be reconciled before nomination repair')
      findings = [repair.finding]
      await checkpoint({ head: snapshot.head, stage: 'rejected', round, pending: undefined,
        previousReview: { findings, blockingCount: 1 }, reviewBaseline: 'required',
        findings: findings.map(text => ({ kind: 'code' as const, actionable: true, text })) })
      if (round >= maxRounds) return blocked('Review requires orchestrator arbitration: round ceiling')
      const current = { findings, blockingCount: 1 }
      const progress = gateStop(reviewProgress(previousReview, current))
      if (progress) return progress
      previousReview = current
      reviewBaseline = 'required'
      previous = [...findings]
      previousBlockingCount = current.blockingCount
      approved = false
      const fix = await work('fix', round)
      return 'stop' in fix ? fix.stop : null
    }
    async function publishCandidate(): Promise<BuildRunOutcome | NominationRepair | null> {
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
      const assessment = await deps.publishGate(snapshot, input.merge_mode)
      if (assessment.kind === 'repair-nomination') return assessment
      const publishGate = gateStop(assessment)
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

    for (;;) {
      for (let round = firstRound; !approved; round++) {
        if (round > maxRounds) return blocked('Review requires orchestrator arbitration: round ceiling')
        phase = 'review'
        step_id = null
        // G035/G043: both fresh builds and fixes need a measured review artifact.
        if (!fullOid(snapshot.head) || !snapshot.diff.trim()) return unknown('Review requires a full branch head and nonempty diff artifact')
        if (!local) {
          const stop = await publishCandidate()
          if (stop?.kind === 'repair-nomination') {
            const refusal = await repairNomination(stop, round)
            if (refusal) return refusal
            continue
          }
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
        if (!result.review) return unknown('Review panel observation is missing')
        const panel = await deps.reviewGate(result.payload, result.review, snapshot, round, replansUsed, value => {
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
            previousReview: currentReview ?? null, reviewBaseline: 'required',
            findings: decision.findings.map(text => ({ kind: 'code' as const, actionable: true, text })) })
        }
        if (decision.kind === 're-plan' && replansUsed !== 0) return blocked('Review requires orchestrator arbitration: re-plan already spent')
        const progress = gateStop(reviewProgress(previousReview, currentReview))
        if (progress) return progress
        if (decision.kind === 'approve') {
          await checkpoint({ head: snapshot.head, stage: 'approved', round, pending: undefined, findings: [] })
          firstRound = round
          break
        }
        previousReview = currentReview
        reviewBaseline = 'required'
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
        if (stop?.kind === 'repair-nomination') {
          const refusal = await repairNomination(stop, firstRound)
          if (refusal) return refusal
          firstRound++
          continue
        }
        if (stop) return stop
      }
      break
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
