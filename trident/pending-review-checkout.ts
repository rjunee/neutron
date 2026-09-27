import { readBuildModeState } from './build-mode-state.ts'
import type { EnvCapableHostRunner } from './git-mode.ts'
import { isTerminalPhase } from './state-machine.ts'
import type { TridentRun, TridentRunStore } from './store.ts'

/** Recover only the published input of this run's interrupted read-only review.
 * The caller must fetch and verify this exact branch head before creating a tree;
 * the driver still corroborates the entire original snapshot before recovery. */
export async function pendingReviewCheckoutHead(store: Pick<TridentRunStore, 'stageEvents'>,
  run: TridentRun, baseBranch: string, runHost: EnvCapableHostRunner): Promise<string | null> {
  const checkpoint = readBuildModeState(store.stageEvents(run.id), run)?.checkpoint
  if (checkpoint?.pending?.phase !== 'review') return null
  const pending = checkpoint.pending
  const recovery = pending.recovery
  const snapshot = recovery?.snapshot
  if (isTerminalPhase(run.phase) || run.merge_mode !== 'pr'
    || !checkpoint.head || !snapshot || checkpoint.head !== snapshot.head
    || !snapshot.pr || snapshot.pr.state !== 'OPEN' || snapshot.pr.head !== checkpoint.head
    || !Number.isSafeInteger(run.published_pr) || run.published_pr! <= 0
    || run.pr !== run.published_pr || snapshot.pr.number !== run.published_pr
    || recovery?.request.run_id !== run.id || recovery.request.step_id !== pending.step_id
    || recovery.request.role !== 'review' || recovery.request.writable !== false) {
    throw new Error('Pending review checkout lacks owned publication evidence')
  }
  const observed = await runHost(['gh', 'pr', 'view', String(run.published_pr), '--json',
    'number,headRefOid,state,headRefName,baseRefName,isCrossRepository'], run.repo_path)
  if (!observed.ok || observed.timed_out) throw new Error('Pending review PR is unreadable')
  const pr = JSON.parse(observed.stdout)
  if (pr?.number !== run.published_pr || pr.headRefOid !== checkpoint.head || pr.state !== 'OPEN'
    || pr.headRefName !== run.branch || pr.baseRefName !== baseBranch || pr.isCrossRepository !== false) {
    throw new Error('Pending review PR no longer matches its checkpoint')
  }
  return checkpoint.head
}
