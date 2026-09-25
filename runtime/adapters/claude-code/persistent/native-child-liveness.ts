import type { PersistentReplSubstrateOptions } from './types.ts'

// Queries, not cached liveness: the gateway owns durable child admission.
const queries = new Map<string, (projectId: string | null) => boolean>()
export function setNativeChildLiveness(owner: string, query: (projectId: string | null) => boolean): void {
  queries.set(owner, query)
}

export function hasUnresolvedNativeChild(options: Pick<PersistentReplSubstrateOptions, 'user_id' | 'conversationProjectId'> | undefined): boolean {
  if (!options || options.user_id === undefined || options.conversationProjectId === undefined) return false
  const query = queries.get(options.user_id)
  if (!query) return false
  try { return query(options.conversationProjectId) } catch { return true }
}
