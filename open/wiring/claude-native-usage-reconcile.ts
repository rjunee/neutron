import { observeClaudeChildUsage } from '@neutronai/runtime/workers/claude-child-observation.ts'
import { AttemptAccounting } from '@neutronai/trident/attempt-accounting.ts'
import type { TridentAttemptLedger } from '@neutronai/trident/attempt-ledger.ts'
import { validNativeUsageBinding } from '@neutronai/trident/native-usage-binding.ts'
import type { TridentRunStore, TridentRun } from '@neutronai/trident/store.ts'

/** Passive accounting only. No actor, result reader, admission mutator or
 * workflow recovery is available here. Each snapshot may remain incomplete. */
export async function reconcileClaudeNativeUsage(options: {
  attempts: TridentAttemptLedger
  ownerHandle: string
  runs: Pick<TridentRunStore, 'get'>
  projectIdForRun(run: TridentRun): string | null
  event(runId: string, stage: string, meta: string): Promise<unknown>
}): Promise<{ status: 'observed' | 'busy'; observed: number; unavailable: number }> {
  const release = options.attempts.acquireNativeUsagePass()
  if (!release) return { status: 'busy', observed: 0, unavailable: 0 }
  let observed = 0, unavailable = 0
  const deadline = Date.now() + 1000
  try {
    for (const key of options.attempts.nativeUsageCandidates()) {
      if (Date.now() >= deadline) break
      try {
        const binding = options.attempts.nativeUsageBinding(key)
        const run = options.runs.get(key.run_id)
        if (!binding || binding.lease.scope.ownerHandle !== options.ownerHandle
          || !run || binding.lease.scope.projectId !== options.projectIdForRun(run)
          || !validNativeUsageBinding(options.attempts.get(key), binding)) { unavailable++; continue }
        const { parent, nativeAgentId, request } = binding.receipt.body
        const observation = await observeClaudeChildUsage(binding.directory, parent!.sessionId, request, nativeAgentId!)
        if (!observation) { unavailable++; continue }
        const accounting = new AttemptAccounting(options.attempts, '', (stage, meta) => options.event(key.run_id, stage, meta))
        await accounting.observe(key, observation)
        observed++
      } catch { unavailable++ }
      finally { await options.attempts.nativeUsageChecked(key, Date.now()).catch(() => {}) }
    }
    return { status: 'observed', observed, unavailable }
  } finally { release() }
}
