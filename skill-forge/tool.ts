/**
 * @neutronai/skill-forge — agent-native tool surface (`skill_forge_list` +
 * `skill_forge_decide`).
 *
 * Agent-native parity (a hard invariant): the owner manages Skill Forge
 * proposals through the `/skills` chat command (`command.ts`); the live chat
 * agent manages them through THESE tools. Both call the SAME `SkillForgeBackend`
 * (`backend.ts`) — the tools hold no lifecycle logic of their own.
 *
 * TWO tools, mirroring doc-search's read/write split (`doc_search` vs the
 * mutating surface):
 *   - `skill_forge_list`  — read-only (`read:project_data`, `auto`): the pending
 *     proposals, so the agent can SEE what's awaiting a decision.
 *   - `skill_forge_decide` — write (`write:project_data`, `prompt-user`): approve
 *     (writes a skill file spliced into every future LLM turn) or decline. The
 *     propose→approve gate is Skill Forge's whole point, so an agent-initiated
 *     decision surfaces to the owner for a one-tap approval rather than firing
 *     silently — the same posture `dispatch_agent` uses for a costly action.
 */

import type { JsonSchemaDocument } from '../core-sdk/types.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { SkillForgeBackend } from './backend.ts'
import type { ProposalEdits } from './types.ts'

export const SKILL_FORGE_LIST_TOOL = 'skill_forge_list'
export const SKILL_FORGE_DECIDE_TOOL = 'skill_forge_decide'

const listInputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

const listOutputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    proposals: {
      type: 'array',
      description: 'The pending Skill Forge proposals awaiting an approve/decline decision.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          proposed_name: { type: 'string' },
          what_it_does: { type: 'string' },
          triggers: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'proposed_name', 'what_it_does', 'triggers'],
      },
    },
  },
  required: ['proposals'],
}

const decideInputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    decision: {
      type: 'string',
      enum: ['approve', 'decline'],
      description:
        'Approve the proposal (distill + write its native SKILL.md pack into the agent skills dir), or decline it (creates nothing).',
    },
    proposal_id: {
      type: 'string',
      description: 'The id of the pending proposal to act on (from skill_forge_list).',
    },
    name: {
      type: 'string',
      description: 'Optional rename applied on approve (the skill slug + filename).',
    },
    what_it_does: {
      type: 'string',
      description: 'Optional override of the one-paragraph summary applied on approve.',
    },
    triggers: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional override of the trigger phrases applied on approve.',
    },
  },
  required: ['decision', 'proposal_id'],
  additionalProperties: false,
}

const decideOutputSchema: JsonSchemaDocument = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string', description: 'The new proposal status ("approved" or "declined").' },
    skill_path: {
      type: 'string',
      description: 'Absolute path of the written skill markdown (approve only).',
    },
  },
  required: ['id', 'status'],
}

interface DecideArgs {
  decision?: unknown
  proposal_id?: unknown
  name?: unknown
  what_it_does?: unknown
  triggers?: unknown
}

function editsFrom(a: DecideArgs): ProposalEdits | undefined {
  const edits: ProposalEdits = {}
  if (typeof a.name === 'string' && a.name.trim().length > 0) edits.name = a.name.trim()
  if (typeof a.what_it_does === 'string' && a.what_it_does.trim().length > 0) {
    edits.whatItDoes = a.what_it_does.trim()
  }
  if (Array.isArray(a.triggers)) {
    const triggers = a.triggers.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    if (triggers.length > 0) edits.triggers = triggers
  }
  return Object.keys(edits).length > 0 ? edits : undefined
}

/**
 * Register the `skill_forge_list` + `skill_forge_decide` tools against
 * `registry`, both backed by the shared `SkillForgeBackend`. Returns the
 * registered tool names.
 */
export function registerSkillForgeToolSurface(
  registry: ToolRegistry,
  backend: SkillForgeBackend,
): string[] {
  registry.register({
    name: SKILL_FORGE_LIST_TOOL,
    description:
      'List the pending Skill Forge proposals — workflows Skill Forge detected as skill-worthy and ' +
      'is offering to save as re-invokable skills. Returns each proposal id, name, triggers, and ' +
      'summary so you can decide which to approve via skill_forge_decide.',
    input_schema: listInputSchema,
    output_schema: listOutputSchema,
    capability_required: 'read:project_data',
    approval_policy: 'auto',
    handler: async () => {
      const proposals = await backend.listPending()
      return {
        proposals: proposals.map((p) => ({
          id: p.id,
          proposed_name: p.proposed_name,
          what_it_does: p.what_it_does,
          triggers: p.triggers,
        })),
      }
    },
  })

  registry.register({
    name: SKILL_FORGE_DECIDE_TOOL,
    description:
      'Approve or decline a pending Skill Forge proposal. Approving distills the workflow into a ' +
      'native SKILL.md pack in the agent skills dir (immediately discoverable + invokable via the ' +
      'Skill mechanism, survives a fresh session); declining creates nothing. Use skill_forge_list ' +
      'first to get the proposal_id.',
    input_schema: decideInputSchema,
    output_schema: decideOutputSchema,
    capability_required: 'write:project_data',
    approval_policy: 'prompt-user',
    handler: async (args) => {
      const a = (args ?? {}) as DecideArgs
      const decision = a.decision
      if (decision !== 'approve' && decision !== 'decline') {
        throw new Error('skill_forge_decide: "decision" must be "approve" or "decline"')
      }
      const id = typeof a.proposal_id === 'string' ? a.proposal_id.trim() : ''
      if (id.length === 0) {
        throw new Error('skill_forge_decide: "proposal_id" is required and must be a non-empty string')
      }
      if (decision === 'decline') {
        const declined = await backend.decline(id)
        return { id: declined.id, status: declined.status }
      }
      const result = await backend.approve(id, editsFrom(a))
      return { id: result.proposal.id, status: result.proposal.status, skill_path: result.skill_path }
    },
  })

  return [SKILL_FORGE_LIST_TOOL, SKILL_FORGE_DECIDE_TOOL]
}
