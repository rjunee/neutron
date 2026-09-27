import type { TridentRun, TridentRunStore } from './store.ts'

const STAGE = 'build-publication-create-response'
const identity = (run: TridentRun, baseBranch: string, head: string) => JSON.stringify([
  run.id, run.project_slug, run.repo_path, run.worktree, run.branch, run.base_sha,
  run.merge_mode, baseBranch, head,
])

/** Retain the host's successful create response before independent PR inspection.
 * This is evidence to inspect, not published_pr ownership or permission to merge. */
export async function recordPublicationResponse(store: TridentRunStore, run: TridentRun,
  baseBranch: string, head: string, number: number): Promise<void> {
  await store.recordStageEvent(run.id, STAGE, JSON.stringify({ version: 1,
    identity: identity(run, baseBranch, head), number }))
}

/** A malformed latest response cannot fall back to older evidence or authorize
 * another create. Historical PR discovery without a response remains unowned. */
export function readPublicationResponse(store: TridentRunStore, run: TridentRun,
  baseBranch: string, head: string): number | null {
  const event = store.stageEvents(run.id).filter(event => event.stage === STAGE).at(-1)
  if (!event) return null
  const value = JSON.parse(event.meta ?? 'null')
  if (value?.version !== 1 || value.identity !== identity(run, baseBranch, head)
    || !Number.isSafeInteger(value.number) || value.number <= 0
    || (run.pr !== null && run.pr !== value.number)) {
    throw new Error('Retained publication response identity is invalid')
  }
  return value.number
}
