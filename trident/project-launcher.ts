import { fireAndForget } from '@neutronai/logger/fire-and-forget.ts'
import type { FireOutcome, InnerLoopInput, TridentWorkflowFirer } from './inner-loop.ts'
import { createProjectBuildHost, type ProjectBuildHostOptions, type ProjectBuildOutcome } from './project-build-host.ts'
import type { TridentRunStore } from './store.ts'

/** The canonical result field also carries nonterminal driver uncertainty. */
export function projectBuildPending(raw: string | null): boolean {
  try { return JSON.parse(raw ?? 'null')?.projectBuild?.kind === 'unknown' } catch { return false }
}

export function projectBuildResult(outcome: ProjectBuildOutcome, input: InnerLoopInput): string {
  if (outcome.kind === 'unknown') return JSON.stringify({ projectBuild: outcome })
  const snapshot = 'snapshot' in outcome ? outcome.snapshot : null
  return JSON.stringify({
    projectBuild: outcome,
    ok: outcome.kind === 'merged' || outcome.kind === 'built' || outcome.kind === 'continued',
    prMerged: outcome.kind === 'merged',
    publishRequested: outcome.kind === 'continued',
    built: outcome.kind === 'built' || outcome.kind === 'continued',
    verdict: outcome.kind === 'merged' ? 'APPROVE' : null,
    branch: input.run.branch, worktreePath: input.run.worktree,
    prNumber: snapshot?.pr?.number ?? input.run.pr,
    commitSha: snapshot?.head, reviewedHead: snapshot?.head,
    remainingTasks: outcome.kind === 'continued' ? outcome.remainingTasks : undefined,
    checkpoint: outcome.kind === 'merged' ? 'merged' : outcome.kind === 'built' ? 'wave-member-built' : outcome.kind === 'continued' ? 'ralph-task-built' : 'inner-error',
    terminalCauseKind: outcome.kind === 'failed' ? outcome.cause : undefined,
    terminalCause: outcome.kind === 'blocked' ? outcome.on : 'detail' in outcome ? outcome.detail : undefined,
  })
}

export interface ProjectLauncherOptions {
  store: TridentRunStore
  prepare(input: InnerLoopInput, signal: AbortSignal): Promise<ProjectBuildHostOptions>
  onError(error: unknown): void
  settleMs?: number
}

/** Start the typed driver in the host process; completion belongs to the store. */
export function createProjectLauncher(options: ProjectLauncherOptions): TridentWorkflowFirer {
  return async input => {
    const controller = new AbortController()
    const reservation = JSON.stringify({ projectBuild: { kind: 'unknown', phase: 'plan', step_id: null, detail: 'Project driver started; awaiting durable outcome' } })
    let reserved = false
    const started = Date.now()
    const launch = (async (): Promise<FireOutcome> => {
      try {
        if (projectBuildPending(options.store.get(input.run.id)?.inner_result ?? null)) {
          return { status: 'unconfirmed', error: 'Existing project build requires reconciliation' }
        }
        // Reserve before invoking work. A process death cannot turn an uncertain step into a replay.
        const saved = await options.store.compareProjectBuildResult(input.run.id, null, reservation)
        if (!saved) return { status: 'unconfirmed', error: 'Project launch reservation was not acquired' }
        reserved = true
        const host = await createProjectBuildHost(await options.prepare(input, controller.signal))
        const mode = input.run.bound_pr !== null ? 'bound_pr' : input.run.parent_run_id !== null ? 'wave' : input.run.ralph ? 'ralph' : 'pr'
        const running = host.run({ mode, start: input.resume_checkpoint ? 'resume' : 'fresh',
          ...(input.run.bound_pr !== null ? { bound_pr: input.run.bound_pr } : {}),
          ...(input.run.wave_task_id !== null ? { pinnedTaskId: input.run.wave_task_id } : {}),
        }, controller.signal)
        fireAndForget('project-build-outcome', running.then(async outcome => {
          const written = await options.store.compareProjectBuildResult(input.run.id, reservation, projectBuildResult(outcome, { ...input, run: options.store.get(input.run.id) ?? input.run }))
          if (!written) throw Error('Project outcome write was not confirmed')
        }), options.onError)
        return { status: 'fired', error: null }
      } catch (error) {
        if (reserved) await options.store.compareProjectBuildResult(input.run.id, reservation, JSON.stringify({ ok: false, checkpoint: 'inner-error', terminalCause: String(error) })).catch(options.onError)
        return { status: 'failed', error: String(error) }
      }
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const budget = options.settleMs ?? 10_000
    try {
      return await Promise.race([launch, new Promise<FireOutcome>(resolve => {
        timer = setTimeout(() => resolve({ status: 'unconfirmed', error: 'Project launch confirmation timed out',
          elapsed_ms: Date.now() - started, budget_ms: budget, turn_cancelled: false, settled: launch }), budget)
      })])
    } finally { clearTimeout(timer) }
  }
}
