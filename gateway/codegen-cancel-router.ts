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

/**
 * Keep the legacy Code-Gen tool surface, but make its cancel operation aware of
 * the foundational Trident store that now owns `/code` dispatches.
 *
 * `terminator` IS REQUIRED, and used to have a default —
 * `= buildTridentTerminator({ store: trident })` — which is the exact shape of
 * silent degrade this repo keeps getting caught by. That default fabricated a
 * terminator with NO observer and NO `onTransition`, so a cancel still flipped the
 * phase and returned `cancelled: true` while the board never reconciled, the
 * skill-forge hook never ran, and no `projects_changed` reached the rail. Every
 * unit test passed, because a unit test constructs its own terminator anyway; the
 * only thing that could have caught it was the production composition, which was
 * the untested part.
 *
 * So the caller must now SAY which terminator it means. A missing thread is a
 * typecheck failure rather than a working-looking cancel with half the effects
 * missing, and the one place that legitimately has no observers to run
 * (`boot-cores-factories.ts`, when no composer threaded one) fabricates it
 * EXPLICITLY and logs that it did.
 */
export function routeCodegenCancel(
  legacy: CodegenOrchestrator,
  trident: TridentRunStore,
  _ownerSlug: string,
  terminator: TridentTerminator,
): UnifiedCodegenOrchestrator {
  const validate = (input: unknown, tool: string): string => {
    if (typeof input !== 'object' || input === null) {
      throw new CodegenInputError(tool, 'input', 'must be an object')
    }
    const taskId = (input as { task_id?: unknown }).task_id
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
          const taskId = validate(input, `codegen_${prop}`)
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
        const taskId = validate(input, 'codegen_cancel')
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
          { reason: 'cancelled via codegen_cancel' },
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
