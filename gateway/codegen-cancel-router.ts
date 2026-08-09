import {
  CodegenTaskNotFoundError,
  CodegenInputError,
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
  status(input: { task_id: string }): Promise<ReturnType<CodegenOrchestrator['status']> | UnifiedTridentState>
  fetch(input: { task_id: string }): Promise<ReturnType<CodegenOrchestrator['fetch']> | UnifiedTridentState>
  cancel(input: { task_id: string }): Promise<UnifiedCancelResult>
}

/** Keep the legacy Code-Gen tool surface, but make its cancel operation aware of
 * the foundational Trident store that now owns `/code` dispatches. */
export function routeCodegenCancel(
  legacy: CodegenOrchestrator,
  trident: TridentRunStore,
  _ownerSlug: string,
  terminator: TridentTerminator = buildTridentTerminator({ store: trident }),
): UnifiedCodegenOrchestrator {
  const validate = (taskId: string, tool: string): string => {
    if (typeof taskId !== 'string' || taskId.trim().length === 0) {
      throw new CodegenInputError(tool, 'task_id', 'must be a non-empty string')
    }
    return taskId.trim()
  }
  const resolve = (taskId: string) => trident.resolveReference(taskId)
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
  })
  return new Proxy(legacy, {
    get(target, prop) {
      if (prop === 'status' || prop === 'fetch') {
        return async (input: { task_id: string }) => {
          const taskId = validate(input.task_id, `codegen_${prop}`)
          try {
            return await target[prop]({ task_id: taskId })
          } catch (error) {
            if (!(error instanceof CodegenTaskNotFoundError)) throw error
          }
          const run = resolve(taskId)
          if (run === null) throw new CodegenTaskNotFoundError(taskId)
          return state(run)
        }
      }
      if (prop !== 'cancel') {
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async (input: { task_id: string }): Promise<UnifiedCancelResult> => {
        const taskId = validate(input.task_id, 'codegen_cancel')
        try {
          const result = await target.cancel({ task_id: taskId })
          return {
            ...result,
            dispatch_path: 'legacy_codegen',
            phase: result.cancelled ? 'cancelled' : result.prior_status,
            reason: null,
            already_terminal: !result.cancelled,
          }
        } catch (error) {
          if (!(error instanceof CodegenTaskNotFoundError)) throw error
        }

        const before = resolve(taskId)
        if (before === null) throw new CodegenTaskNotFoundError(taskId)
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
          { reason: 'cancelled via codegen_cancel', runObservers: false },
        )
        const current = result.run ?? trident.get(before.id)
        if (current === null) throw new CodegenTaskNotFoundError(taskId)
        return {
          cancelled: result.won,
          prior_status: 'trident_run',
          dispatch_path: 'trident',
          phase: current.phase,
          reason: current.failure_reason,
          ...(!result.won && isTerminalPhase(current.phase) ? { already_terminal: true } : {}),
        }
      }
    },
  }) as unknown as UnifiedCodegenOrchestrator
}
