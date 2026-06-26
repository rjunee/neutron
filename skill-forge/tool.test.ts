/**
 * skill-forge/tool.test.ts — the `skill_forge_*` agent-native tool surface.
 *
 * Asserts both tools register with the right capability + approval posture and
 * that their handlers route to the shared backend (agent-native parity: the
 * tools own no lifecycle logic — they call the same backend `/skills` does).
 */

import { describe, expect, test } from 'bun:test'

import { ToolRegistry } from '../tools/registry.ts'
import type { SkillForgeBackend } from './backend.ts'
import type { ApproveResult } from './forge.ts'
import type { ProposalEdits, ProposalRecord } from './types.ts'
import {
  registerSkillForgeToolSurface,
  SKILL_FORGE_DECIDE_TOOL,
  SKILL_FORGE_LIST_TOOL,
} from './tool.ts'

function proposal(id: string): ProposalRecord {
  return {
    id,
    workflow_signature: `sig-${id}`,
    project_slug: 'owner',
    topic_id: null,
    proposed_name: `skill-${id}`,
    triggers: [`do ${id}`],
    what_it_does: `does ${id}`,
    artifacts: [],
    workflow: { project_slug: 'owner', intent: id, steps: [], artifacts: [], succeeded: true },
    status: 'pending',
    skill_path: null,
    created_at: 1,
    decided_at: null,
  }
}

interface Recorder {
  approved: Array<{ id: string; edits?: ProposalEdits }>
  declined: string[]
}

function fakeBackend(pending: ProposalRecord[], rec: Recorder): SkillForgeBackend {
  return {
    listPending: async () => pending,
    approve: async (id, edits): Promise<ApproveResult> => {
      rec.approved.push(edits === undefined ? { id } : { id, edits })
      return { proposal: { ...proposal(id), status: 'approved' }, skill_path: `/tmp/skills/${id}.md` }
    },
    decline: async (id) => {
      rec.declined.push(id)
      return { ...proposal(id), status: 'declined' }
    },
  }
}

const CTX = { project_slug: 'owner', topic_id: null, call_id: 'c1', speaker_user_id: null }

describe('registerSkillForgeToolSurface', () => {
  test('registers both tools with read/write capability + approval split', () => {
    const reg = new ToolRegistry()
    const names = registerSkillForgeToolSurface(reg, fakeBackend([], { approved: [], declined: [] }))
    expect(names).toEqual([SKILL_FORGE_LIST_TOOL, SKILL_FORGE_DECIDE_TOOL])

    const list = reg.get(SKILL_FORGE_LIST_TOOL)!
    expect(list.capability_required).toBe('read:project_data')
    expect(list.approval_policy).toBe('auto')

    const decide = reg.get(SKILL_FORGE_DECIDE_TOOL)!
    expect(decide.capability_required).toBe('write:project_data')
    expect(decide.approval_policy).toBe('prompt-user')
  })

  test('skill_forge_list returns the pending proposals', async () => {
    const reg = new ToolRegistry()
    registerSkillForgeToolSurface(reg, fakeBackend([proposal('a'), proposal('b')], { approved: [], declined: [] }))
    const out = (await reg.get(SKILL_FORGE_LIST_TOOL)!.handler({}, CTX)) as {
      proposals: Array<{ id: string }>
    }
    expect(out.proposals.map((p) => p.id)).toEqual(['a', 'b'])
  })

  test('skill_forge_decide approve routes to backend.approve with edits', async () => {
    const reg = new ToolRegistry()
    const rec: Recorder = { approved: [], declined: [] }
    registerSkillForgeToolSurface(reg, fakeBackend([], rec))
    const out = (await reg
      .get(SKILL_FORGE_DECIDE_TOOL)!
      .handler({ decision: 'approve', proposal_id: 'x', name: 'renamed' }, CTX)) as {
      id: string
      status: string
      skill_path: string
    }
    expect(out.status).toBe('approved')
    expect(out.skill_path).toBe('/tmp/skills/x.md')
    expect(rec.approved).toEqual([{ id: 'x', edits: { name: 'renamed' } }])
  })

  test('skill_forge_decide decline routes to backend.decline', async () => {
    const reg = new ToolRegistry()
    const rec: Recorder = { approved: [], declined: [] }
    registerSkillForgeToolSurface(reg, fakeBackend([], rec))
    const out = (await reg
      .get(SKILL_FORGE_DECIDE_TOOL)!
      .handler({ decision: 'decline', proposal_id: 'y' }, CTX)) as { status: string }
    expect(out.status).toBe('declined')
    expect(rec.declined).toEqual(['y'])
  })

  test('skill_forge_decide rejects a bad decision / missing id', async () => {
    const reg = new ToolRegistry()
    registerSkillForgeToolSurface(reg, fakeBackend([], { approved: [], declined: [] }))
    const decide = reg.get(SKILL_FORGE_DECIDE_TOOL)!
    await expect(decide.handler({ decision: 'nope', proposal_id: 'z' }, CTX)).rejects.toThrow()
    await expect(decide.handler({ decision: 'approve', proposal_id: '' }, CTX)).rejects.toThrow()
  })
})
