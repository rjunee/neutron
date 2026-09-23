import type { ResumeCheckpoint } from './build-run.ts'
import type { TridentRun, TridentRunStore } from './store.ts'
import { isExecutionStrategy, legacyCheckpointName } from './execution-strategy.ts'
import { normalizeLegacyStoredExecutionPlan } from './legacy-execution-compat.ts'

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
export type BuildModeState = { checkpoint: ResumeCheckpoint; iteration: number; consumed?: { round: number; head: string } }
type BuildRetrySource = { prior: TridentRun; eventId: number; state: BuildModeState }

export const retrySourceIdentity = (run: TridentRun): string =>
  JSON.stringify([run.id, run.project_slug, run.repo_path, run.branch, run.task, run.merge_mode, run.execution_strategy])

/** Old invalidation proofs retain their original boolean identity in the event log. */
function matchesRetrySourceIdentity(identity: unknown, run: TridentRun): boolean {
  return identity === retrySourceIdentity(run) || (run.strategy_source === 'legacy'
    && isExecutionStrategy(run.execution_strategy)
    && identity === JSON.stringify([run.id, run.project_slug, run.repo_path, run.branch, run.task,
      run.merge_mode, run.execution_strategy === 'task_sequence']))
}

function normalizeLegacyCheckpoint(state: any, run: TridentRun): void {
  if (run.strategy_source !== 'legacy' || !isExecutionStrategy(run.execution_strategy)) return
  const checkpoint = state?.checkpoint
  if (!checkpoint || typeof checkpoint !== 'object') return
  checkpoint.stage = legacyCheckpointName(checkpoint.stage)
  const recovery = checkpoint.pending?.recovery
  // The old host input mode is positive format evidence. A new-format checkpoint
  // with a missing selection remains corrupt even on a migrated row.
  const inputs = recovery?.inputs
  if (!inputs || typeof inputs !== 'object' || 'executionStrategy' in recovery
    || !['pr', 'ralph', 'wave'].includes(inputs.mode)) return
  if (inputs.mode === 'wave' && inputs.workers?.plan?.request?.result?.schema !== 'project-plan') return
  if ((inputs.mode === 'pr' && run.execution_strategy !== 'single')
    || (inputs.mode === 'ralph' && run.execution_strategy !== 'task_sequence')
    || ('ralphRound' in inputs && 'taskIteration' in inputs)
    || 'executionStrategy' in inputs) throw new Error('Legacy recovery selection contradicts its run')
  // The old single driver carried its accepted planner payload in `previous`,
  // while reserving `plan` for task and wave builds. Recover that exact payload.
  const oldSinglePendingBuild = inputs.mode === 'pr' && checkpoint.pending.phase === 'build'
  recovery.executionStrategy = inputs.mode === 'wave' ? null : run.execution_strategy
  if (inputs.mode !== 'wave') inputs.mode = 'implementation'
  if ('ralphRound' in inputs) {
    inputs.taskIteration = inputs.ralphRound
    delete inputs.ralphRound
  }
  if (inputs.mode === 'implementation' && inputs.taskIteration === undefined) inputs.taskIteration = 0
  const storedPlan = recovery.plan === null && oldSinglePendingBuild ? recovery.previous : recovery.plan
  if (storedPlan !== null || oldSinglePendingBuild) {
    const plan = normalizeLegacyStoredExecutionPlan(storedPlan, run)
    if (!plan) throw new Error('Legacy recovery execution plan is invalid')
    recovery.plan = plan
  }
  // Request, previous payload, worker metadata, review baseline and budgets are
  // deliberately untouched: the runner must recover its original reservation.
}

/** The latest host checkpoint is authoritative, including a pending provider arm. */
export function readBuildModeState(
  events: ReadonlyArray<{ stage: string; meta?: string | null }>,
  run: TridentRun,
): BuildModeState | null {
  const event = events.filter(event => event.stage === 'build-mode-state').at(-1)
  return event ? parseBuildModeState(event.meta ?? null, run) : null
}

/** Validate the original writer's identity before any state is consumed. */
export function parseBuildModeState(meta: string | null, run: TridentRun, terminalSource = false): BuildModeState {
  const state = JSON.parse(meta ?? 'null')
  normalizeLegacyCheckpoint(state, run)
  const c = state?.checkpoint
  if (state?.runId !== run.id || state?.branch !== run.branch || state?.base !== run.base_sha
    || state?.repo !== run.repo_path || state?.projectSlug !== run.project_slug || state?.mergeMode !== run.merge_mode
    || typeof state?.worktree !== 'string' || state.worktree.length === 0
    // Terminal cleanup may remove the original worktree. Its path is never used
    // by an importer; an active host still requires its exact bound worktree.
    || (!(terminalSource && run.worktree === null) && state.worktree !== run.worktree)
    || !Number.isSafeInteger(state.iteration) || state.iteration < 0
    || !c || (c.head !== null && (typeof c.head !== 'string' || !oid.test(c.head)))
    || !['built', 'approved', 'rejected', 'fixed', 'task-built', 'task-built-deviated'].includes(c.stage)
    || !Number.isSafeInteger(c.round) || c.round < 0 || ![0, 1].includes(c.replansUsed)
    || !Array.isArray(c.findings) || !c.findings.every((f: any) => f && ['code', 'lane'].includes(f.kind) && typeof f.actionable === 'boolean' && typeof f.text === 'string')
    || !Array.isArray(c.previousFindings) || !c.previousFindings.every((f: unknown) => typeof f === 'string')
    || (c.previousBlockingCount !== undefined && (!Number.isSafeInteger(c.previousBlockingCount) || c.previousBlockingCount < 0))
    || (c.remainingTasks !== undefined && (!Number.isSafeInteger(c.remainingTasks) || c.remainingTasks < 0))
    || (state.consumed !== undefined && (!Number.isSafeInteger(state.consumed?.round) || state.consumed.round < 0
      || typeof state.consumed.head !== 'string' || !oid.test(state.consumed.head)))
    || (c.pending !== undefined && (!c.pending || !['plan', 'build', 'review', 'fix'].includes(c.pending.phase) || typeof c.pending.step_id !== 'string' || !c.pending.step_id.startsWith(`${run.id}:`)))) {
    throw new Error('Host mode checkpoint is missing valid identity or state')
  }
  return state
}

export function retryModeSource(store: TridentRunStore, prior: TridentRun, seen = new Set<string>()): BuildRetrySource | null {
  if (seen.has(prior.id)) throw new Error('Retry source cycle')
  seen.add(prior.id)
  if (prior.phase !== 'failed' || !prior.base_sha || !oid.test(prior.base_sha)
    || !isExecutionStrategy(prior.execution_strategy)) return null
  const event = store.stageEvents(prior.id).filter(event => event.stage === 'build-mode-state').at(-1)
  if (!event) {
    // Preparation can fail before loadResume writes this run's own mode state.
    // Keep that immediate predecessor and pin its source event; every older edge
    // is still validated, and a real mode event below always supersedes the link.
    const inherited = readBuildRetrySource(store, prior, seen)
    const link = store.stageEvents(prior.id).filter(event => event.stage === 'build-retry-source').at(-1)
    return inherited && link ? { prior, eventId: link.id, state: inherited.state } : null
  }
  const state = parseBuildModeState(event.meta, prior, true)
  const checkpoint = state.checkpoint
  // Never inherit approval or an unresolved worker reservation. A terminal task-sequence
  // build may retry publication/review only when its host checkpoint records an
  // empty validated plan. Legacy/partial builds cannot establish that fact.
  if (checkpoint.pending !== undefined || checkpoint.head === null) return null
  if (checkpoint.round >= 1 && (checkpoint.stage === 'fixed' || (checkpoint.stage === 'built'
    && (prior.execution_strategy === 'single' || checkpoint.remainingTasks === 0)))) {
    return { prior, eventId: event.id, state }
  }
  return taskContinuationSource(prior, state) ? { prior, eventId: event.id, state } : null
}

/**
 * A GOVERNED ITERATION THAT HANDED BACK IS A CONTINUATION SOURCE (spec item
 * a-retry-must-resume-from-the-checkpoint, gap 2). `advanceTask`
 * (production-host-effects.ts) writes a `task-built` state with the head it
 * consumed, an advanced `iteration` and `round` reset to 0; a retry that adopted one and
 * died before building re-mints the same checkpoint under its own identity, so the
 * chain survives more than one failed attempt. Adopting that state does not skip a
 * build or a review — the retry still builds the next task — it lets that iteration
 * open with the committed plan (`build-run.ts`, G026) instead of paying for the full
 * planning survey again. The branch tip is still proven against the recorded head at
 * dispatch (board-dispatch.ts) and again at launch (launch-preparation.ts).
 *
 * `task-built-deviated` is never a source: a deviated build left a committed
 * plan the code no longer matches, so its retry must re-plan in full.
 */
function taskContinuationSource(prior: TridentRun, state: BuildModeState): boolean {
  const checkpoint = state.checkpoint
  return prior.execution_strategy === 'task_sequence' && checkpoint.stage === 'task-built' && checkpoint.head !== null
}

/** True when a typed retry source hands forward a task-sequence continuation, not a review. */
export function isTaskContinuationSource(source: BuildRetrySource): boolean {
  return source.state.checkpoint.stage === 'task-built'
}

/** The dispatch-minted link authorizes importing state, never prior receipts. */
export function readBuildRetrySource(store: TridentRunStore, run: TridentRun, seen = new Set<string>()): BuildRetrySource | null {
  const event = store.stageEvents(run.id).filter(event => event.stage === 'build-retry-source').at(-1)
  if (!event) return null
  const link = JSON.parse(event.meta ?? 'null')
  if (link?.runId !== run.id || typeof link?.priorRunId !== 'string') throw new Error('Retry source identity is invalid')
  const prior = store.get(link.priorRunId)
  const invalidated = store.stageEvents(run.id).filter(event => event.stage === 'build-retry-source-invalidated').at(-1)
  if (invalidated) {
    // The host validated this exact source before re-pinning a falsified seed.
    // Its old base no longer describes the fresh run. Only that explicit intent,
    // never an unreadable or replaced link, permits dropping source adoption.
    const proof = JSON.parse(invalidated.meta ?? 'null')
    if (proof?.runId !== run.id || proof.sourceEventId !== event.id || proof.sourceMeta !== event.meta
      || !matchesRetrySourceIdentity(proof.identity, run) || proof.recordedHead !== link.head
      || typeof proof.baseSha !== 'string' || !oid.test(proof.baseSha) || proof.baseSha !== prior?.base_sha
      || typeof proof.observedHead !== 'string' || !oid.test(proof.observedHead)
      || proof.observedHead === proof.recordedHead) throw new Error('Retry source invalidation is invalid')
    return null
  }
  if (!prior || prior.id === run.id || prior.project_slug !== run.project_slug || prior.repo_path !== run.repo_path
    || prior.branch !== run.branch || prior.task !== run.task || prior.merge_mode !== run.merge_mode
    || !isExecutionStrategy(run.execution_strategy) || prior.execution_strategy !== run.execution_strategy
    || prior.base_sha !== run.base_sha) throw new Error('Retry source no longer matches the dispatched run')
  const source = retryModeSource(store, prior, seen)
  if (!source || source.eventId !== link.eventId || source.state.checkpoint.head !== link.head
    || run.inner_checkpoint_head !== link.head) throw new Error('Retry source checkpoint changed after dispatch')
  return source
}
