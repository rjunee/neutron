/**
 * @neutronai/skill-forge — trident adapter.
 *
 * Maps a terminal (done) Trident run — the runtime's canonical multi-step
 * workflow (forge-init → plan → build → argus review → fix → done) — into the
 * generic `CompletedWorkflow` Skill Forge audits.
 *
 * THE LIVE SEAM (documented, not wired in this PR): the tick loop's
 * `onTerminal(run)` hook (`trident/tick.ts`) fires the instant a run reaches a
 * terminal phase. Composing Skill Forge there is one call:
 *
 *   if (run.phase === 'done') {
 *     await skillForge.onWorkflowCompleted(completedWorkflowFromTridentRun(run))
 *   }
 *
 * Kept a pure function (no I/O) so it is unit-testable and the composition
 * layer owns the wiring.
 */

import type { CompletedWorkflow, WorkflowStep } from './types.ts'

/**
 * Minimal shape this adapter needs from a Trident run — a structural subset of
 * `trident/store.ts:TridentRun`, so the skill-forge package does not take a
 * build dependency on `@neutronai/trident`.
 */
export interface TridentRunLike {
  phase: string
  project_slug: string
  task: string
  branch: string | null
  pr: number | null
  ralph: boolean
  chat_id: string | null
  thread_id: string | null
}

/** The procedure a happy-path Trident run executes, as named steps. */
function tridentSteps(ralph: boolean): WorkflowStep[] {
  const steps: WorkflowStep[] = [
    { action: 'trident.plan', summary: 'plan the change' },
  ]
  if (ralph) steps.push({ action: 'trident.ralph-task', summary: 'one-task-per-context build loop' })
  else steps.push({ action: 'trident.build', summary: 'implement the change' })
  steps.push({ action: 'trident.argus-review', summary: 'multi-agent code review' })
  steps.push({ action: 'trident.fix', summary: 'apply review findings' })
  steps.push({ action: 'trident.merge', summary: 'merge + clean up' })
  return steps
}

export function completedWorkflowFromTridentRun(run: TridentRunLike): CompletedWorkflow {
  const topic_id =
    run.chat_id !== null
      ? run.thread_id !== null
        ? `${run.chat_id}:${run.thread_id}`
        : run.chat_id
      : undefined
  const artifacts: string[] = []
  if (run.branch !== null) artifacts.push(`branch ${run.branch}`)
  if (run.pr !== null) artifacts.push(`PR #${run.pr}`)
  const wf: CompletedWorkflow = {
    project_slug: run.project_slug,
    intent: run.task,
    steps: tridentSteps(run.ralph),
    artifacts,
    succeeded: run.phase === 'done',
  }
  if (topic_id !== undefined) wf.topic_id = topic_id
  return wf
}
