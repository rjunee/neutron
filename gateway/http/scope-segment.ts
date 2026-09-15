import { sanitizeProjectId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import { GENERAL_RAIL_ID } from '@neutronai/wire-types/topic-id.ts'

/** Resolve a project-or-General path segment without allowing the two scopes to alias. */
export function resolveScopeSegment(raw: unknown): string | null {
  if (raw === GENERAL_RAIL_ID) return GENERAL_RAIL_ID
  return sanitizeProjectId(raw)
}
