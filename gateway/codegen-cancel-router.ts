import {
  CodegenTaskNotFoundError,
  type CodegenOrchestrator,
  type CodegenTaskStatus,
} from '@neutronai/codegen-core'
import { isTerminalPhase } from '@neutronai/trident/state-machine.ts'
import type { TridentRunStore } from '@neutronai/trident/store.ts'
import { buildTridentTerminator } from '@neutronai/trident/terminate.ts'

export interface UnifiedCancelResult {
  cancelled: boolean
  prior_status: CodegenTaskStatus | 'trident_run'
  dispatch_path?: 'legacy_codegen' | 'trident'
  phase?: string
  reason?: string | null
  already_terminal?: boolean
}

/** Keep the legacy Code-Gen tool surface, but make its cancel operation aware of
 * the foundational Trident store that now owns `/code` dispatches. */
export function routeCodegenCancel(
  legacy: CodegenOrchestrator,
  trident: TridentRunStore,
): CodegenOrchestrator {
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

        const result = await buildTridentTerminator({ store: trident }).terminate(
          before.id,
          'stopped',
          { reason: 'cancelled via codegen_cancel' },
        )
        return {
          cancelled: result.won,
          prior_status: 'trident_run',
          dispatch_path: 'trident',
          phase: result.run?.phase ?? before.phase,
          reason: result.run?.failure_reason ?? null,
          ...(!result.won ? { already_terminal: true } : {}),
        }
      }
    },
  })
}
