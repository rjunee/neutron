import { isDeepStrictEqual } from 'node:util'
import { statSync } from 'node:fs'
import { poolKeyFor } from './pool.ts'
import { pool, pendingSpawns, retiringSessionKeys } from './pool-state.ts'
import { disownPane, getRecord, registryConversationScopeMatches, withOwnedRegistry, type ReplRegistryRecord } from './repl-registry.ts'
import { defaultListProcesses, scanTranscriptOwners, basenameOf } from './orphan-adoption.ts'
import { sessionJsonlPath } from './session-size-watchdog.ts'
import { resolveTranscriptProjectsDir } from './signatures.ts'
import { hasUnresolvedNativeChild } from './native-child-liveness.ts'
import type { PersistentReplSubstrateOptions } from './types.ts'

export type DeadChatReconciliation = { status: 'reconciled' } | { status: 'refused'; reason: string }
export interface DeadChatSlot {
  relinquish(pane: string, commit: () => boolean): Promise<boolean>
}

/** Only composition can supply authenticated historical evidence. This operation
 * gives up dead process ownership; it neither spawns nor rewrites launch grants. */
export async function reconcileHostTerminatedChat(options: PersistentReplSubstrateOptions,
  captured: ReplRegistryRecord, slot: DeadChatSlot, authorized: () => boolean,
  listProcesses = defaultListProcesses): Promise<DeadChatReconciliation> {
  const refuse = (reason: string): DeadChatReconciliation => ({ status: 'refused', reason })
  try {
    const key = poolKeyFor(options)
    if (!options.replRegistryPath || options.ephemeral || captured.sessionKey !== key
      || !registryConversationScopeMatches(captured, options)) return refuse('historical scope does not match current authority')
    const row = getRecord(options.replRegistryPath, key)
    const pane = row?.pane_handle ?? row?.host_terminated_chat?.pane
    if (!row || !pane || pane !== captured.pane_handle
      || row.host_terminated_chat && row.host_terminated_chat.childGeneration !== captured.child_generation
      || row.asleep_at !== undefined || row.spawn_reservation_by !== undefined
      || row.respawn_in_flight_at !== undefined || !row.has_session || !row.model || !row.reuse
      || row.cwd !== options.cwd || !registryConversationScopeMatches(row, options)) return refuse('record is not a recoverable active conversation')
    for (const field of ['sessionId', 'child_generation', 'pid', 'cwd', 'model', 'conversationProjectId', 'reuse', 'capped_at', 'admission_generation'] as const) {
      const actual = field === 'pid' ? row.pid ?? row.host_terminated_chat?.pid : row[field]
      if (!isDeepStrictEqual(actual, captured[field])) return refuse(`historical ${field} differs from the current record`)
    }
    const transcript = statSync(sessionJsonlPath(row.sessionId, row.cwd, resolveTranscriptProjectsDir(options)))
    if (!transcript.isFile() || transcript.size === 0) return refuse('recorded transcript unavailable')
    const safe = () => authorized() && !pool.has(key) && !pendingSpawns.has(key) && !retiringSessionKeys.has(key)
      && !hasUnresolvedNativeChild(options)
      && scanTranscriptOwners(row.sessionId, listProcesses, basenameOf(options.claude_bin ?? 'claude')).kind === 'none'
    if (!safe()) return refuse('current owner or admission is unresolved')
    const path = options.replRegistryPath
    const committed = await slot.relinquish(pane, () => {
      const result = withOwnedRegistry(path, registry => {
        if (!safe() || !isDeepStrictEqual(registry[key], row)) return { registry, result: false, skipSave: true }
        const { pid: _pid, devchannel_port: _port, ...retained } = disownPane(row)
        registry[key] = { ...retained, host_terminated_chat: { pane, pid: captured.pid!, childGeneration: captured.child_generation! } }
        return { registry, result: true }
      }, () => false)
      return result.persisted && result.result
    })
    return committed ? { status: 'reconciled' } : refuse('pane, journal, or registry changed during reconciliation')
  } catch (error) { return refuse(error instanceof Error ? error.message : String(error)) }
}
