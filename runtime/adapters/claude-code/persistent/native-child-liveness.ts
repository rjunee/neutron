import type { PersistentReplSubstrateOptions } from './types.ts'

// Queries, not cached liveness: the gateway owns durable child admission.
type Query = (projectId: string | null) => boolean
const queries = new Map<string, { all: Query; chat: Query }>()
export function setNativeChildLiveness(owner: string, query: Query | undefined, chatQuery?: Query): void {
  if (query) queries.set(owner, { all: query, chat: chatQuery ?? query })
  else queries.delete(owner)
}

type ScopedOptions = Pick<PersistentReplSubstrateOptions, 'user_id' | 'conversationProjectId' | 'project_id' | 'nativeChildCensusRole'>
function unresolved(options: ScopedOptions | undefined, role: 'all' | 'chat'): boolean {
  if (!options || options.user_id === undefined) return false
  const query = queries.get(options.user_id)?.[role]
  if (!query) return false
  // Only known unscoped auxiliary constructors are exempt. Explicit owner scope
  // cannot be weakened by an auxiliary marker, and missing provenance is unknown.
  if (options.conversationProjectId === undefined && options.project_id === undefined &&
      (options.nativeChildCensusRole === 'setup' || options.nativeChildCensusRole === 'fire')) return false
  // Legacy named scopes are unambiguous. Missing scope and the legacy General
  // sentinel are not: only an explicit null establishes the General conversation.
  const scope = options.conversationProjectId !== undefined ? options.conversationProjectId
    : options.project_id && options.project_id !== 'general' && options.project_id !== 'default' ? options.project_id : undefined
  if (scope === undefined) return true
  try { return query(scope) } catch { return true }
}

export function hasUnresolvedNativeChild(options: ScopedOptions | undefined): boolean {
  return unresolved(options, 'all')
}

/** Only ordinary chat can queue ahead of a unique locally preparing child.
 * Eviction, model changes and adoption still read every durable child lease. */
export function hasUnresolvedNativeChildForChat(options: ScopedOptions | undefined): boolean {
  return unresolved(options, 'chat')
}
