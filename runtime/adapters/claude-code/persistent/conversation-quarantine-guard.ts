import { readRegistryState, registryConversationScopeMatches } from './repl-registry.ts'
import type { PersistentReplSubstrateOptions } from './types.ts'
import { SESSION_KEY_SEP } from './signatures.ts'

export function assertConversationAvailable(
  options: { isConversationQuarantined?: ((sessionId: string) => boolean) | undefined },
  sessionId: string,
): void {
  if (options.isConversationQuarantined?.(sessionId)) {
    throw Object.assign(new Error('persistent-repl: conversation is permanently quarantined'),
      { substrateErrorClass: 'repl_unreconciled' as const })
  }
}

/** Keep each quarantined row and transcript intact. A new canonical turn uses a
 * separate key and a fresh native UUID; nothing here resumes or copies history.
 * Durable rows, rather than a process-local counter, select the same successor
 * after restart. Unknown registry or quarantine authority always refuses. */
export function availableConversationKey(base: string, options: PersistentReplSubstrateOptions): string {
  if (options.isConversationQuarantined === undefined || options.replRegistryPath === undefined) return base
  const state = readRegistryState(options.replRegistryPath)
  if (state.kind === 'absent') return base
  if (state.kind === 'unreadable') throw new Error('persistent-repl: conversation registry unavailable')
  let key = base
  for (let depth = 0; depth < 64; depth++) {
    if (state.droppedKeys.includes(key)) throw new Error('persistent-repl: conversation registry row invalid')
    const record = state.registry[key]
    if (record === undefined) return key
    if (!registryConversationScopeMatches(record, options)) {
      throw new Error('persistent-repl: conversation scope is ambiguous or mismatched')
    }
    if (!options.isConversationQuarantined(record.sessionId)) return key
    key = `${key}${SESSION_KEY_SEP}after-quarantine${SESSION_KEY_SEP}${record.sessionId}`
  }
  throw new Error('persistent-repl: conversation quarantine successor bound exceeded')
}
