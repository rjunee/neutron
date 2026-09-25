import type { AgentSpec } from '@neutronai/runtime/substrate.ts'

/** Exact host conversation scope; null is General. Legacy wake specs carry the
 * metering sentinel `general`; a literal named general project must be explicit. */
export function actingTurnProjectId(spec: AgentSpec): string | null {
  const ctx = spec.metering_context
  if (ctx?.conversationProjectId !== undefined) return ctx.conversationProjectId
  const legacy = ctx?.project_id
  return legacy === undefined || legacy === 'general' ? null : legacy
}
