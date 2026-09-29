import { isAbsolute } from 'node:path'
import { verifyNativeDispatchChildBound, type NativeDispatchLease, type SignedNativeDispatchRecord } from '@neutronai/runtime/workers/claude-native-dispatch-receipt.ts'
import type { AttemptRow } from './attempt-ledger.ts'

/** Host-DB provenance only. The lease pin is independently obtained from the
 * original admission authority, never copied from the receipt being verified. */
export interface NativeUsageBinding {
  version: 1
  lease: NativeDispatchLease
  receipt: SignedNativeDispatchRecord
  directory: string
  captured_at: number
}

export function validNativeUsageBinding(attempt: AttemptRow | null, binding: NativeUsageBinding): boolean {
  try {
    const request = binding.receipt.body.request
    return !!attempt && binding.version === 1 && Number.isSafeInteger(binding.captured_at) && binding.captured_at >= 0
      && typeof binding.directory === 'string' && isAbsolute(binding.directory)
      && attempt.attempt_id === 'dispatch' && attempt.provider === 'anthropic' && attempt.placement === 'in-repl'
      && attempt.run_id === request.run_id && attempt.step_id === request.step_id
      && attempt.role === request.role && attempt.resolved_model === request.model_id
      && attempt.prepared_at !== null && attempt.started_at !== null
      && verifyNativeDispatchChildBound(binding.receipt, request, binding.lease)
  } catch { return false }
}
