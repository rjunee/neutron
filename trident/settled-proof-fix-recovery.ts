import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { readdirSync } from 'node:fs'
import { isDeepStrictEqual as equal } from 'node:util'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import type { ResumeCheckpoint } from './build-run.ts'
import type { BuildModeState } from './build-mode-state.ts'
import type { TridentRun, TridentRunStore } from './store.ts'
import { evidenceReader } from './settled-review-recovery.ts'
import { briefIntegrity } from './gates/brief-integrity.ts'
import { validateTrailer } from './gates/result-contract.ts'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
type Recovery = NonNullable<NonNullable<ResumeCheckpoint['pending']>['recovery']>
export interface ProofFixBindings {
  workers: Recovery['inputs']['workers']
  briefs: Record<string, string>
}
/** Relocation changes paths; it cannot change a paid worker's model or authority. */
export function proofFixWorkerMatches(bindings: ProofFixBindings, role: string,
  current: Recovery['inputs']['workers'][string], brief: string): boolean {
  const previous = bindings.workers[role]
  const comparable = (request: typeof current.request) => {
    const { cwd: _cwd, brief: _brief, result, ...rest } = request
    return { ...rest, result: { schema: result.schema } }
  }
  return !!previous && previous.provider === current.provider
    && equal(comparable(previous.request), comparable(current.request)) && bindings.briefs[role] === brief
}
const approves = (value: unknown): boolean => {
  const result = validateTrailer('verdict', value)
  return result.ok && result.value.verdict === 'APPROVE' && result.value.findings.length === 0
    && result.value.escalate === undefined
}

/** A terminal, unchanged fix can retain a candidate, never declare that fix landed.
 * Require the exact initial build → review → suite-only rejection → settled fix
 * sequence. All review producers independently approve; a worker's diagnosis of
 * pre-existing failure is deliberately irrelevant. The original red suite and
 * terminal checkpoint remain immutable. This import buys fresh proof and review. */
export function settledProofFixRecovery(store: TridentRunStore, run: TridentRun,
  state: BuildModeState, parseState: (meta: string | null) => BuildModeState): ProofFixBindings | null {
  try {
    const c = state.checkpoint
    const fix = c.pending?.recovery
    if (run.phase !== 'failed' || run.execution_strategy !== 'single' || run.strategy_source !== 'planner'
      || !run.failure_reason?.endsWith('Fix round did not move the measured branch head')
      || c.stage !== 'rejected' || c.pending?.phase !== 'fix' || !fix || c.head === null
      || c.round !== 1 || c.replansUsed !== 0 || c.reviewStop !== undefined || c.handoff !== undefined
      || c.remainingTasks !== 0 || c.reviewBaseline !== 'required' || run.max_rounds <= c.round
      || fix.round !== c.round || fix.snapshot.head !== c.head || !fix.snapshot.diff.trim()
      || fix.executionStrategy !== 'single' || fix.inputs.maxRounds !== run.max_rounds
      || Reflect.get(fix.inputs, 'run_id') !== run.id || Reflect.get(fix.inputs, 'mode') !== 'implementation'
      || Reflect.get(fix.inputs, 'merge_mode') !== run.merge_mode || fix.inputs.taskIteration !== state.iteration
      || fix.reviewBaseline !== c.reviewBaseline || !equal(fix.previousReview, c.previousReview)
      || c.pending.step_id !== `${run.id}:fix:1`) return null
    const events = store.stageEvents(run.id)
    const modes = events.filter(event => event.stage === 'build-mode-state')
    // These are the immediate construction sites, not a search for an older good state.
    if (modes.length !== 7) return null
    const planning = parseState(modes[0]!.meta).checkpoint.pending
    if (planning?.phase !== 'plan' || !planning.recovery) return null
    const [building, built, reviewing, rejected, latest] = modes.slice(-5)
      .map(event => parseState(event.meta))
    const { pending: _pending, ...settled } = c
    if (!equal(latest, state) || !equal(rejected!.checkpoint, settled)
      || built!.checkpoint.stage !== 'built' || built!.checkpoint.head !== c.head
      || built!.checkpoint.pending !== undefined || built!.checkpoint.round !== 1
      || building!.checkpoint.pending?.phase !== 'build'
      || !equal(reviewing!.checkpoint, { ...built!.checkpoint, pending: reviewing!.checkpoint.pending })
      || reviewing!.checkpoint.pending?.phase !== 'review') return null
    const build = building!.checkpoint.pending!.recovery!
    const review = reviewing!.checkpoint.pending!.recovery!
    if (!build || !review || !equal(review.snapshot, fix.snapshot)
      || !equal(build.inputs.workers, fix.inputs.workers) || !equal(review.inputs, fix.inputs)
      || !equal(build.plan, fix.plan) || !equal(review.plan, fix.plan)
      || !equal(fix.plan, JSON.parse(run.strategy_plan ?? 'null'))
      || build.executionStrategy !== 'single' || build.round !== 0 || review.round !== 1) return null
    const root = dirname(fix.request.result.path)
    if (basename(root) !== encodeURIComponent(run.id)) return null
    const evidence = evidenceReader()
    evidence.directory(root)
    const inventory = readdirSync(root).sort()
    if (inventory.length > 4096) return null
    const json = (path: string): any => JSON.parse(evidence.read(path))
    const attempts = store.attempts(run.id)
    if (attempts.some(row => row.ended_at === null || row.outcome !== 'completed')) return null
    const journal = (request: BoundedWorkRequest) => json(join(root,
      `attempt-request-${digest([run.id, request.step_id, 'dispatch'])}.json`))
    const attempt = (request: BoundedWorkRequest, head: string) => {
      const rows = attempts.filter(row => row.step_id === request.step_id && row.attempt_id === 'dispatch')
      if (rows.length !== 1) return null
      const row = rows[0]!
      const saved = journal(request)
      return row.run_id === run.id && row.role === request.role && row.resolved_model === request.model_id
        && row.head_sha === head && row.prepared_at !== null && row.started_at !== null
        && equal(saved.request, request) && saved.provider === row.provider && saved.placement === row.placement
        && ['phase', 'task_id', 'head_sha', 'review_seat', 'requested_model'].every(key =>
          saved.attribution?.[key] === row[key as keyof typeof row]) ? row : null
    }
    for (const name of inventory.filter(name => /^attempt-request-[a-f0-9]{64}\.json$/.test(name))) {
      const saved = json(join(root, name))
      if (saved.request?.run_id !== run.id
        || name !== `attempt-request-${digest([run.id, saved.request.step_id, 'dispatch'])}.json`
        || !attempts.some(row => row.step_id === saved.request.step_id && row.attempt_id === 'dispatch')) return null
    }
    const bindings: ProofFixBindings = { workers: fix.inputs.workers, briefs: {} }
    const worker = (role: 'plan' | 'build' | 'review' | 'fix', recovery: Recovery) => {
      const request = recovery.request
      const version = role === 'plan' ? 'v4' : 'v3'
      const row = attempt(request, recovery.snapshot.head)
      const prefix = new Map([['anthropic', 'claude'], ['openai-codex', 'codex'], ['pi', 'pi']]).get(row?.provider ?? '')
      if (!row || !prefix || row.review_seat !== null || row.placement !== 'in-repl'
        || row.provider !== Reflect.get(recovery.inputs, 'repl_provider') || row.provider !== fix.inputs.workers[role]?.provider
        || request.cwd !== (state as BuildModeState & { worktree: string }).worktree
        || request.result.path !== join(root, `${role}.result`)
        || request.result.schema !== (role === 'plan' ? 'project-plan-v2' : role === 'review' ? 'project-review' : 'project-build')
        || request.brief.path !== join(root, `${role}.strategy-${version}.brief.${role}.host`)
        || request.run_id !== run.id || request.role !== role || request.needs_approval_decision !== false
        || request.writable !== (role !== 'review') || request.tools !== (role === 'review' ? 'read-only' : 'edit-and-run')
        || !equal(request, { ...fix.inputs.workers[role]?.request, run_id: run.id,
          step_id: request.step_id, role, needs_approval_decision: false })
        || evidence.read(join(root, `${prefix}-step-${digest([run.id, request.step_id])}.json`))
          !== JSON.stringify(request) + '\n#dispatch-armed\n') return null
      const brief = evidence.read(request.brief.path)
      const context = json(`${request.brief.path}.context.json`)
      if (briefIntegrity(brief) !== request.brief.integrity || !brief.includes(`${request.brief.path}.context.json`)
        || !equal(context.request, request) || !equal(context.snapshot, recovery.snapshot)
        || !equal(context.findings, recovery.findings) || !equal(context.previous ?? null, recovery.previous)
        || context.planner !== recovery.planner || context.executionStrategy !== recovery.executionStrategy) return null
      const value = json(request.result.path)
      if (value.kind !== 'completed' || value.schema !== request.result.schema
        || value.run_id !== run.id || value.step_id !== request.step_id
        || value.result?.head !== (role === 'plan' ? build.snapshot.head : c.head)) return null
      if (role === 'plan') {
        if (!validateTrailer('plan', value.result.payload).ok || !equal(value.result.payload, fix.plan)) return null
      } else if (role === 'review') {
        if (!approves(value.result.payload) || !equal(value.result.pr, recovery.snapshot.pr)
          || value.result.diff !== recovery.snapshot.diff) return null
      } else {
        const payload = validateTrailer('forge', value.result.payload)
        if (!payload.ok || payload.value.branch !== run.branch || payload.value.commitSha !== c.head
          || payload.value.worktreePath !== request.cwd || payload.value.deviatedFromSpec === true) return null
      }
      if (role === 'fix' && !equal(value.result.pr, recovery.snapshot.pr)) return null
      bindings.briefs[role] = evidence.read(join(root, `${role}.strategy-${version}.brief`))
      if (!bindings.briefs[role]!.startsWith(`${run.task}\n\n`)
        || brief !== `${bindings.briefs[role]}\n\nRead the host turn context at ${request.brief.path}.context.json before doing this task.\n`) return null
      return row
    }
    if (planning.step_id !== `${run.id}:plan:0` || !worker('plan', planning.recovery)
      || build.request.step_id !== `${run.id}:build:0`
      || review.request.step_id !== `${run.id}:review:1:head:${c.head}`
      || !worker('build', build) || !worker('review', review) || !worker('fix', fix)) return null

    const rows = attempts.filter(row => row.review_seat !== null)
    if (rows.length < 2 || rows.filter(row => row.role === 'synthesis').length !== 1
      || new Set(rows.map(row => row.review_seat)).size !== rows.length) return null
    const names = inventory.filter(name => /^review-[a-f0-9]{64}$/.test(name))
    if (names.length !== rows.length || names.length > 128) return null
    const observations = new Map<string, unknown>()
    let synthesis: any
    for (const name of names) {
      const directory = join(root, name)
      evidence.directory(directory)
      const receipt = json(join(directory, 'receipt.json'))
      const request = json(join(directory, 'request.json')) as BoundedWorkRequest
      const briefText = evidence.read(join(directory, 'brief.json'))
      const brief = JSON.parse(briefText)
      const row = attempt(request, c.head)
      const observed = receipt.observation
      const result = json(join(directory, 'result.json'))
      if (!row || row.review_seat === null || !rows.includes(row) || observations.has(row.review_seat)
        || receipt.version !== 1 || receipt.identity !== name.slice(7) || receipt.state !== 'settled'
        || receipt.invalidated !== undefined || receipt.requestHash !== digest(request)
        || request.step_id !== `${name}:1:0` || request.run_id !== run.id || !['review', 'synthesis'].includes(request.role)
        || request.cwd !== fix.request.cwd || request.writable !== false || request.tools !== 'read-only'
        || request.needs_approval_decision !== false || request.result.schema !== 'verdict'
        || request.result.path !== join(directory, 'result.json') || request.brief.path !== join(directory, 'brief.json')
        || request.brief.integrity !== briefIntegrity(briefText) || brief.project !== run.project_slug
        || brief.seat !== row.review_seat || brief.round !== c.round || !equal(brief.snapshot, fix.snapshot)
        || observed?.status !== 'completed' || observed.runId !== run.id || observed.head !== c.head
        || observed.round !== c.round || observed.provider !== row.provider || observed.modelId !== row.resolved_model
        || !approves(observed.payload) || result.kind !== 'completed' || result.schema !== 'verdict'
        || result.run_id !== run.id || result.step_id !== request.step_id || !equal(result.result, observed.payload)) return null
      observations.set(row.review_seat, observed)
      if (request.role === 'synthesis') synthesis = brief
      else if (brief.panel !== undefined) return null
    }
    const panel = rows.filter(row => row.role === 'review').map(row => observations.get(row.review_seat!))
    if (!synthesis || !Array.isArray(synthesis.panel)
      || !equal(panel.map(value => JSON.stringify(value)).sort(), synthesis.panel.map((value: unknown) => JSON.stringify(value)).sort())) return null

    const suiteEvent = events.filter(event => event.stage === 'build-suite-receipt').at(-1)
    const suite = JSON.parse(suiteEvent?.meta ?? 'null')
    const report = suite?.receipt?.report
    const owned = JSON.stringify([run.id, run.project_slug, run.repo_path,
      (state as BuildModeState & { worktree: string }).worktree, run.branch, run.base_sha])
    if (suite?.version !== 2 || suite.owner !== owned || suite.adoptedFrom !== undefined
      || suite.receipt?.kind !== 'known' || suite.receipt.runId !== run.id || suite.receipt.head !== c.head
      || suite.receipt.round !== c.round || suite.receipt.scope !== 'full-suite' || !suite.receipt.strategy
      || !Number.isInteger(report?.hostExitCode) || report.hostExitCode === 0 || report.suiteOutcome !== 'deferred'
      || report.hostSuiteWorker !== true || typeof report.hostDiagnostics !== 'string' || !report.hostDiagnostics.trim()
      || !suite.identity || suite.observation?.before?.identity !== suite.identity
      || suite.observation?.after?.identity !== suite.identity
      || suite.observation?.hostExitCode !== report.hostExitCode) return null
    const finding = `FULL SUITE NOT PROVEN: ${report.hostDiagnostics}`
    const baseline = report.hostFailureId ? { findings: [report.hostFailureId], blockingCount: 1 }
      : { findings: [], blockingCount: 1, unknownIdentities: true }
    if (!equal(c.findings, [{ kind: 'code', actionable: true, text: finding }])
      || !equal(fix.findings, [finding]) || !equal(c.previousReview, baseline)) return null
    return evidence.stable() && equal(readdirSync(root).sort(), inventory)
      && equal(store.attempts(run.id), attempts) && equal(store.stageEvents(run.id), events)
      && equal(store.get(run.id), run) ? bindings : null
  } catch { return null }
}
