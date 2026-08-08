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

export type UnifiedCodegenOrchestrator = Omit<CodegenOrchestrator, 'cancel'> & {
  cancel(input: { task_id: string }): Promise<UnifiedCancelResult>
}

/** Keep the legacy Code-Gen tool surface, but make its cancel operation aware of
 * the foundational Trident store that now owns `/code` dispatches. */
export function routeCodegenCancel(
  legacy: CodegenOrchestrator,
  trident: TridentRunStore,
  terminator: TridentTerminator = buildTridentTerminator({ store: trident }),
): UnifiedCodegenOrchestrator {
  return new Proxy(legacy, {
    get(target, prop, receiver) {
      if (prop !== 'cancel') return Reflect.get(target, prop, receiver)
      return async (input: { task_id: string }): Promise<UnifiedCancelResult> => {
        try {
          const result = await target.cancel(input)
          return { ...result, dispatch_path: 'legacy_codegen' }
        } catch (error) {
          if (!(error instanceof CodegenTaskNotFoundError)) throw error
        }

        const before = trident.get(input.task_id)
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
