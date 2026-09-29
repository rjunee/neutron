import { poolKeyFor } from './pool.ts'
import { authFingerprintFor } from './repl-session.ts'
import { registryConversationScopeMatches, withOwnedRegistry } from './repl-registry.ts'
import { retiringSessionKeys } from './pool-state.ts'
import { fencedReasonFor } from './boot-adoption.ts'
import { hasUnresolvedNativeChild } from './native-child-liveness.ts'
import type { PersistentReplSubstrateOptions } from './types.ts'

export interface CapRearmRequest {
  projectId: string | null
  sessionKey: string
  sessionId: string
  childGeneration: string
  cappedAt: number
}

export function isCapRearmRequest(value: unknown): value is CapRearmRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).sort().join(',') === 'cappedAt,childGeneration,projectId,sessionId,sessionKey'
    && (v.projectId === null || typeof v.projectId === 'string' && !!v.projectId.trim())
    && ['sessionKey', 'sessionId', 'childGeneration'].every(k => typeof v[k] === 'string' && !!v[k].trim())
    && Number.isSafeInteger(v.cappedAt) && (v.cappedAt as number) > 0
}

/** Operator authority is supplied by composition, never by registry contents.
 * This only releases an exact cap episode. Ordinary recovery independently owns
 * admission, transcript/owner verification and any later resume. */
export function rearmReplCap(options: PersistentReplSubstrateOptions, request: CapRearmRequest,
  authorized: () => boolean): boolean {
  try {
    if (!isCapRearmRequest(request) || !options.replRegistryPath || options.ephemeral
      || options.conversationProjectId !== request.projectId || poolKeyFor(options) !== request.sessionKey) return false
    const expected = authFingerprintFor(options.env, options.sinkTokenPath)
    const outcome = withOwnedRegistry(options.replRegistryPath, registry => {
      const row = registry[request.sessionKey]
      if (!row || row.sessionId !== request.sessionId || row.child_generation !== request.childGeneration
        || row.capped_at !== request.cappedAt || row.asleep_at !== undefined
        || row.respawn_in_flight_at !== undefined || row.spawn_reservation_by !== undefined
        || !row.has_session || !row.model?.trim() || row.cwd !== options.cwd
        || !registryConversationScopeMatches(row, options) || row.reuse?.auth_fingerprint !== expected
        || retiringSessionKeys.has(request.sessionKey) || fencedReasonFor(request.sessionKey) !== undefined
        || !authorized() || hasUnresolvedNativeChild(options)) {
        return { registry, result: false, skipSave: true }
      }
      const { capped_at: _cap, ...uncapped } = row
      registry[request.sessionKey] = uncapped
      return { registry, result: true }
    }, () => false)
    return outcome.persisted && outcome.result
  } catch { return false }
}
