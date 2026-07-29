/**
 * @neutronai/contracts — agent engagement mode vocabulary (L2 leaf).
 *
 * L2 (2026-07) — `AgentEngagementMode`, `ALL_AGENT_ENGAGEMENT_MODES`,
 * `DEFAULT_AGENT_ENGAGEMENT_MODE`, and the `isAgentEngagementMode` type
 * guard extracted VERBATIM out of `connect/agent-engagement.ts` into this
 * node-free leaf — piece 1 ("the mode vocabulary + a type guard") of that
 * file's own 4-piece breakdown; the mention-detection/routing LOGIC
 * (pieces 2-4: `detectAgentMention`, `resolveEngagement`,
 * `classifyTaggedIntent`) stays in `connect`, which is where it belongs.
 * `connect/agent-engagement.ts` re-exports all four symbols so existing
 * import specifiers (chat-bridge, projects store, agent-settings core)
 * stay valid (test-policy §2.2 barrel rule).
 */

/** The two engagement modes a shared project can be in (spec, Ryan-locked). */
export type AgentEngagementMode = 'tag_gated' | 'all_messages'

/** Every valid mode — iterated by the settings PATCH validator + tests. */
export const ALL_AGENT_ENGAGEMENT_MODES: readonly AgentEngagementMode[] = [
  'tag_gated',
  'all_messages',
]

/**
 * The schema + write-side default. A new shared project behaves like a
 * single-person chat (the agent sees every message) until the owner opts into
 * `tag_gated` (spec §"DEFAULT", Ryan 2026-06-26). Existing projects therefore
 * need no behaviour change.
 */
export const DEFAULT_AGENT_ENGAGEMENT_MODE: AgentEngagementMode = 'all_messages'

/** Narrow an untrusted value (wire body / DB read) to a valid mode. */
export function isAgentEngagementMode(value: unknown): value is AgentEngagementMode {
  return value === 'tag_gated' || value === 'all_messages'
}
