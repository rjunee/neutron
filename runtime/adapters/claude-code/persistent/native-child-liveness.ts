import type { PersistentReplSubstrateOptions } from './types.ts'

// Queries, not cached liveness: the gateway owns durable child admission.
const queries = new Map<string, (projectId: string | null) => boolean>()
export function setNativeChildLiveness(owner: string, query: ((projectId: string | null) => boolean) | undefined): void {
  if (query) queries.set(owner, query)
  else queries.delete(owner)
}

export function hasUnresolvedNativeChild(options: Pick<PersistentReplSubstrateOptions, 'user_id' | 'conversationProjectId' | 'project_id' | 'nativeChildCensusRole'> | undefined): boolean {
  if (!options || options.user_id === undefined) return false
  const query = queries.get(options.user_id)
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
