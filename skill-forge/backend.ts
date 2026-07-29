/**
 * @neutronai/skill-forge — the shared agent-native backend.
 *
 * Agent-native parity is a hard invariant: anything the user can do, the live
 * chat agent can do too. Skill Forge's user-facing actions — list the pending
 * proposals, approve one (registering its skill file), decline one — are
 * surfaced BOTH as MCP tools (`tool.ts`) AND as the `/skills` chat command
 * (`command.ts`). This module is the ONE backend both surfaces call, so neither
 * holds any lifecycle logic of its own: list reads the store, approve/decline
 * delegate to the `SkillForge` orchestrator (which owns the propose→approve
 * gate + the disk write).
 */

import type { SkillForge, ApproveResult } from './forge.ts'
import type { SkillForgeProposalsStore } from './proposals-store.ts'
import type { ProposalEdits, ProposalRecord } from './types.ts'

/** The minimal surface the `skill_forge` tools + `/skills` command share. */
export interface SkillForgeBackend {
  /** The currently-pending proposals (read-only). */
  listPending(): Promise<ProposalRecord[]>
  /** Approve a pending proposal: distill (with optional edits) + write the skill. */
  approve(id: string, edits?: ProposalEdits): Promise<ApproveResult>
  /** Decline a pending proposal. Creates nothing. */
  decline(id: string): Promise<ProposalRecord>
}

/**
 * Build the shared backend from the orchestrator + its store. Reads go to the
 * store; writes go through `SkillForge` so the propose→approve gate (and the
 * "a skill file only ever appears via an explicit approve" guarantee) is never
 * bypassed.
 */
export function buildSkillForgeBackend(
  forge: SkillForge,
  store: SkillForgeProposalsStore,
): SkillForgeBackend {
  return {
    listPending: () => store.listPending(),
    approve: (id, edits) => forge.approve(id, edits),
    decline: (id) => forge.decline(id),
  }
}
