import type { NativeDispatchParent } from '../../../workers/claude-native-dispatch-receipt.ts'
import type { BoundedWorkRequest } from '../../../bounded-work.ts'
import { fenceLostSession } from './boot-adoption.ts'
import { childByKey, committedDispatches, pendingChildKills, pendingSpawns, pool, supervisedBySessionKey } from './pool-state.ts'
import { readProcessIdentity, type ProcessIdentity } from './process-identity.ts'
import { readRegistryState } from './repl-registry.ts'
import type { ReplSession } from './repl-session.ts'

type Predicate = (sessionId: string) => boolean
interface ObservationDeps { identity?: (pid: number) => ProcessIdentity | undefined }
interface PreparationDeps extends ObservationDeps { requests?: readonly BoundedWorkRequest[] }

/** The caller owns the durable project admission fence and complete affected-work
 * census. This local check never treats a quiet pane as native-work completion. */
function inspect(parent: NativeDispatchParent, quarantined: Predicate, deps: PreparationDeps):
  { key: string; session?: ReplSession } | undefined {
  if (parent.processIdentity === null) return undefined
  const identity = (deps.identity ?? readProcessIdentity)(parent.pid)
  if (identity?.boot_id !== parent.processIdentity.boot_id ||
      identity.start_ticks !== parent.processIdentity.start_ticks) return undefined
  const paths = new Set([...supervisedBySessionKey.values()].map(o => o.replRegistryPath).filter(p => p !== undefined))
  const matches: Array<{ key: string; session?: ReplSession }> = []
  for (const path of paths) {
    const state = readRegistryState(path)
    if (state.kind !== 'loaded' || state.droppedKeys.length !== 0) return undefined
    for (const [key, record] of Object.entries(state.registry)) {
      if (record.sessionId !== parent.sessionId) continue
      if (record.pid !== parent.pid || record.child_generation !== parent.childGeneration ||
          pendingSpawns.has(key) || pendingChildKills.has(key) || (committedDispatches.get(key) ?? 0) !== 0) return undefined
      const entry = pool.get(key)
      if (entry === undefined) {
        // A retry after restart must not re-adopt the quarantined live parent.
        if (!quarantined(parent.sessionId) || childByKey.has(key)) return undefined
        matches.push({ key })
        continue
      }
      if (Bun.peek.status(entry) !== 'fulfilled') return undefined
      const session = Bun.peek(entry) as ReplSession
      if (session.pooledAs !== entry || session.sessionId !== parent.sessionId || session.childGeneration !== parent.childGeneration ||
          session.child.pid !== parent.pid || childByKey.get(key) !== session.child || session.hasChildExited() ||
          session.activeTurn !== undefined || (deps.requests === undefined
            ? session.turnSlotHeld !== 0 : !session.hasOnlyQuarantineRequests(deps.requests))) return undefined
      matches.push({ key, session })
    }
  }
  return matches.length === 1 ? matches[0] : undefined
}

export function inspectConversationQuarantine(parent: NativeDispatchParent, quarantined: Predicate,
  deps: PreparationDeps = {}): boolean {
  try { return inspect(parent, quarantined, deps) !== undefined } catch { return false }
}

/** Called only after durable quarantine. The caller either drains accepted work
 * or supplies the complete prepared request set for independently observed exit. No await
 * splits the exact local identity/busy checks from detachment. Never closes,
 * signals, deletes a registry row or submits input on either PTY substrate. */
export function quarantinePersistentConversation(parent: NativeDispatchParent, quarantined: Predicate,
  deps: PreparationDeps = {}): boolean {
  try {
    if (!quarantined(parent.sessionId)) return false
    const found = inspect(parent, quarantined, deps)
    if (found === undefined) return false
    if (found.session !== undefined) fenceLostSession(found.key, found.session, 'conversation permanently quarantined')
    return true
  } catch { return false }
}
