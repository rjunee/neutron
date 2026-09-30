import type { TridentRun, TridentStageEvent } from '../store.ts'

/** Exact durable host/native identities for consuming projection tests. */
export function quotaWaitEvents(run: TridentRun, retryAtMs: number | null = null,
  nested?: { parentStepId: string; stepId: string }): TridentStageEvent[] {
  const stepId = nested?.stepId ?? `${run.id}:plan:0`
  const childId = 'native-child-current'
  const event = (id: number, stage: string, meta: unknown): TridentStageEvent => ({
    id, run_id: run.id, stage, at: run.started_at, meta: JSON.stringify(meta),
  })
  return [
    event(1, 'build-mode-state', {
      runId: run.id, branch: run.branch, base: run.base_sha, repo: run.repo_path,
      projectSlug: run.project_slug, mergeMode: run.merge_mode, worktree: run.worktree, iteration: 0,
      checkpoint: { head: null, stage: 'built', round: 0, replansUsed: 0, findings: [], previousFindings: [],
        pending: { phase: nested ? 'review' : 'plan', step_id: nested?.parentStepId ?? stepId } },
    }),
    event(2, 'claude-native-child-bound', { stepId, childId, ...(nested ? { parentStepId: nested.parentStepId } : {}) }),
    event(3, 'claude-quota-waiting', { stepId, childId, retryAtMs }),
  ]
}
