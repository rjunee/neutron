import {
  CodegenTaskNotFoundError,
  type CodegenOrchestrator,
  type CodegenTaskStatus,
} from '@neutronai/codegen-core'
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts'
import type { TridentRunStore } from '@neutronai/trident/store.ts'
import { buildTridentTerminator, type TridentTerminator } from '@neutronai/trident/terminate.ts'

export interface UnifiedCancelResult {
  cancelled: boolean
  prior_status: CodegenTaskStatus | 'trident_run'
  dispatch_path?: 'legacy_codegen' | 'trident'
  phase?: string
  reason?: string | null
  already_terminal?: boolean
}

export interface UnifiedTridentState {
  status: string
  dispatch_path: 'trident'
  run_id: string
  phase: string
  reason: string | null
  already_terminal: boolean
  branch?: string
  worktree?: string
  pr_number?: number
  summary?: string
}

export type UnifiedCodegenOrchestrator = Pick<CodegenOrchestrator, 'dispatch'> & {
  status(input: { task_id: string }): ReturnType<CodegenOrchestrator['status']> | UnifiedTridentState
  fetch(input: { task_id: string }): ReturnType<CodegenOrchestrator['fetch']> | UnifiedTridentState
  cancel(input: { task_id: string }): Promise<UnifiedCancelResult>
}

/** Keep the legacy Code-Gen tool surface, but make its cancel operation aware of
 * the foundational Trident store that now owns `/code` dispatches. */
export function routeCodegenCancel(
  legacy: CodegenOrchestrator,
  trident: TridentRunStore,
  projectSlug: string,
  terminator: TridentTerminator = buildTridentTerminator({ store: trident }),
): UnifiedCodegenOrchestrator {
  const resolve = (taskId: string) => trident.resolveReference(projectSlug, taskId)
  const state = (run: NonNullable<ReturnType<typeof resolve>>): UnifiedTridentState => ({
    status: run.phase,
    dispatch_path: 'trident',
    run_id: run.id,
    phase: run.phase,
    reason: run.failure_reason,
    already_terminal: isTerminalPhase(run.phase),
    ...(run.branch !== null ? { branch: run.branch } : {}),
    ...(run.worktree !== null ? { worktree: run.worktree } : {}),
    ...(run.pr !== null ? { pr_number: run.pr } : {}),
    ...(run.task !== '' ? { summary: run.task } : {}),
  })
  return new Proxy(legacy, {
    get(target, prop) {
      if (prop === 'status' || prop === 'fetch') {
        return (input: { task_id: string }) => {
          try {
            return target[prop](input)
          } catch (error) {
            if (!(error instanceof CodegenTaskNotFoundError)) throw error
          }
          const run = resolve(input.task_id)
          if (run === null) throw new CodegenTaskNotFoundError(input.task_id)
          return state(run)
        }
      }
      if (prop !== 'cancel') {
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async (input: { task_id: string }): Promise<UnifiedCancelResult> => {
        try {
          const result = await target.cancel(input)
          return {
            ...result,
            dispatch_path: 'legacy_codegen',
            phase: result.prior_status,
            reason: null,
            already_terminal: !result.cancelled,
          }
        } catch (error) {
          if (!(error instanceof CodegenTaskNotFoundError)) throw error
        }

        const before = resolve(input.task_id)
        if (before === null) throw new CodegenTaskNotFoundError(input.task_id)
        if (isTerminalPhase(before.phase)) {
          return {
            cancelled: false,
            prior_status: 'trident_run',
            dispatch_path: 'trident',
            phase: before.phase,
            reason: before.failure_reason,
            already_terminal: true,
          }
        }

        const result = await terminator.terminate(
          before.id,
          'stopped',
          { reason: 'cancelled via codegen_cancel' },
        )
        const current = result.run ?? trident.get(before.id)
        if (current === null) throw new CodegenTaskNotFoundError(input.task_id)
        return {
          cancelled: result.won,
          prior_status: 'trident_run',
          dispatch_path: 'trident',
          phase: current.phase,
          reason: current.failure_reason,
          ...(!result.won ? { already_terminal: true } : {}),
        }
      }
    },
  }) as unknown as UnifiedCodegenOrchestrator
}
