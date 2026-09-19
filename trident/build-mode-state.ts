import type { ResumeCheckpoint } from './build-run.ts'
import type { TridentRun, TridentRunStore } from './store.ts'

const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
export type BuildModeState = { checkpoint: ResumeCheckpoint; iteration: number; consumed?: { round: number; head: string } }
type BuildRetrySource = { prior: TridentRun; eventId: number; state: BuildModeState }

export const retrySourceIdentity = (run: TridentRun): string =>
  JSON.stringify([run.id, run.project_slug, run.repo_path, run.branch, run.task, run.merge_mode, run.ralph])

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
  const c = state?.checkpoint
  if (state?.runId !== run.id || state?.branch !== run.branch || state?.base !== run.base_sha
    || state?.repo !== run.repo_path || state?.projectSlug !== run.project_slug || state?.mergeMode !== run.merge_mode
    || typeof state?.worktree !== 'string' || state.worktree.length === 0
    // Terminal cleanup may remove the original worktree. Its path is never used
    // by an importer; an active host still requires its exact bound worktree.
    || (!(terminalSource && run.worktree === null) && state.worktree !== run.worktree)
    || !Number.isSafeInteger(state.iteration) || state.iteration < 0
    || !c || (c.head !== null && (typeof c.head !== 'string' || !oid.test(c.head)))
    || !['built', 'approved', 'rejected', 'fixed', 'ralph-task-built', 'ralph-task-built-deviated'].includes(c.stage)
    || !Number.isSafeInteger(c.round) || c.round < 0 || ![0, 1].includes(c.replansUsed)
    || !Array.isArray(c.findings) || !c.findings.every((f: any) => f && ['code', 'lane'].includes(f.kind) && typeof f.actionable === 'boolean' && typeof f.text === 'string')
    || !Array.isArray(c.previousFindings) || !c.previousFindings.every((f: unknown) => typeof f === 'string')
    || (c.previousBlockingCount !== undefined && (!Number.isSafeInteger(c.previousBlockingCount) || c.previousBlockingCount < 0))
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
  if (prior.phase !== 'failed' || !prior.base_sha || !oid.test(prior.base_sha)) return null
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
  // Never inherit approval or an unresolved worker reservation. A bare Ralph
  // build has not established that its remaining plan is empty.
  if (checkpoint.pending !== undefined || checkpoint.head === null || checkpoint.round < 1
    || !(checkpoint.stage === 'fixed' || (checkpoint.stage === 'built' && !prior.ralph))) return null
  return { prior, eventId: event.id, state }
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
      || proof.identity !== retrySourceIdentity(run) || proof.recordedHead !== link.head
      || typeof proof.baseSha !== 'string' || !oid.test(proof.baseSha) || proof.baseSha !== prior?.base_sha
      || typeof proof.observedHead !== 'string' || !oid.test(proof.observedHead)
      || proof.observedHead === proof.recordedHead) throw new Error('Retry source invalidation is invalid')
    return null
  }
  if (!prior || prior.id === run.id || prior.project_slug !== run.project_slug || prior.repo_path !== run.repo_path
    || prior.branch !== run.branch || prior.task !== run.task || prior.merge_mode !== run.merge_mode || prior.ralph !== run.ralph
    || prior.base_sha !== run.base_sha) throw new Error('Retry source no longer matches the dispatched run')
  const source = retryModeSource(store, prior, seen)
  if (!source || source.eventId !== link.eventId || source.state.checkpoint.head !== link.head
    || run.inner_checkpoint_head !== link.head) throw new Error('Retry source checkpoint changed after dispatch')
  return source
}
