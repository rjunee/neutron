/**
 * @neutronai/wire-types — AgentEngagementMode RE-EXPORT (L6).
 *
 * The Connect group-chat engagement vocabulary is owned by
 * `@neutronai/contracts` (L2 leaf, `contracts/agent-engagement.ts`). L6 does
 * NOT re-fork it — it re-exports the type so the pure clients (the Expo app)
 * have ONE node-free leaf to reach for, killing the hand mirror that used to
 * live at `app/lib/projects-client.ts` (`export type AgentEngagementMode =
 * 'tag_gated' | 'all_messages'`). `@neutronai/contracts` and
 * `@neutronai/wire-types` are both contracts-band leaves, so this same-band
 * edge is legal + acyclic (contracts does not import wire-types).
 */

export type { AgentEngagementMode } from '@neutronai/contracts'
export {
  ALL_AGENT_ENGAGEMENT_MODES,
  DEFAULT_AGENT_ENGAGEMENT_MODE,
  isAgentEngagementMode,
} from '@neutronai/contracts'
