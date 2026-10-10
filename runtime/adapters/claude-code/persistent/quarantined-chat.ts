import { isDeepStrictEqual } from 'node:util'
import type { NativeDispatchParent } from '../../../workers/claude-native-dispatch-receipt.ts'
import { childByKey, committedDispatches, pendingChildKills, pendingSpawns, pool } from './pool-state.ts'
import { classifyRecordedPid, readProcessIdentity } from './process-identity.ts'
import { readRegistryState } from './repl-registry.ts'
import type { QuarantinedChatIdentity } from './project-workspaces.ts'

export interface CompletedConversationQuarantine { operationId: string; parent: NativeDispatchParent; nativeLoop?: 'terminated' }
export type CompletedQuarantineReader = (scope: string | null, sessionId: string) => CompletedConversationQuarantine | undefined

/** Metadata-only terminal handoff after the canonical recovery has completed.
 * The preserved registry identifies the pane; completed authority identifies its
 * native process. Neither quiet output nor a prepared tombstone is sufficient. */
export async function relinquishQuarantinedConversationChat(input: {
  scope: string | null
  registryPath: string
  pane: string
  completed: CompletedQuarantineReader
  relinquish: (identity: QuarantinedChatIdentity, current: () => boolean) => Promise<boolean>
}): Promise<boolean> {
  try {
    const state = readRegistryState(input.registryPath)
    if (state.kind !== 'loaded' || state.droppedKeys.length !== 0) return false
    const rows = Object.values(state.registry).filter(row => row.pane_handle === input.pane)
    if (rows.length !== 1) return false
    const row = rows[0]!, proof = input.completed(input.scope, row.sessionId)
    if (!proof || row.conversationProjectId !== input.scope || !row.has_session
      || row.asleep_at !== undefined || row.spawn_reservation_by !== undefined || row.respawn_in_flight_at !== undefined
      || row.sessionId !== proof.parent.sessionId || row.pid !== proof.parent.pid
      || row.child_generation !== proof.parent.childGeneration || !proof.parent.processIdentity
      || !proof.parent.launch?.argv.some(arg => arg.includes(row.channelName))) return false
    const current = () => {
      const fresh = readRegistryState(input.registryPath), key = row.sessionKey
      return fresh.kind === 'loaded' && fresh.droppedKeys.length === 0
        && Object.values(fresh.registry).filter(r => r.pane_handle === input.pane).length === 1
        && isDeepStrictEqual(fresh.registry[key], row) && isDeepStrictEqual(input.completed(input.scope, row.sessionId), proof)
        && (proof.nativeLoop === 'terminated'
          ? ['confirmed-gone', 'not-comparable'].includes(classifyRecordedPid(proof.parent.pid, proof.parent.processIdentity))
          : isDeepStrictEqual(readProcessIdentity(proof.parent.pid), proof.parent.processIdentity))
        && !pool.has(key) && !childByKey.has(key) && !pendingSpawns.has(key) && !pendingChildKills.has(key)
        && (committedDispatches.get(key) ?? 0) === 0
    }
    if (!current()) return false
    return await input.relinquish({ operationId: proof.operationId, sessionId: row.sessionId,
      childGeneration: proof.parent.childGeneration, pid: proof.parent.pid, processIdentity: proof.parent.processIdentity,
      pane: input.pane, channelName: row.channelName }, current)
  } catch { return false }
}
