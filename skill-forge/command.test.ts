/**
 * skill-forge/command.test.ts — the `/skills` chat command + its ChatCommandFilter.
 *
 * Asserts the parser grammar, that the filter falls through (`null`) for any
 * non-`/skills` body (so the chat path reaches the LLM), and that each
 * subcommand routes to the shared backend — the agent-native twin of the
 * `skill_forge_*` tools.
 */

import { describe, expect, test } from 'bun:test'

import type { SkillForgeBackend } from './backend.ts'
import type { ApproveResult } from './forge.ts'
import type { ProposalEdits, ProposalRecord } from './types.ts'
import {
  buildSkillForgeChatCommandFilter,
  parseSkillForgeCommand,
} from './command.ts'

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
      return { proposal: { ...proposal(id), status: 'approved' }, skill_path: `/tmp/${id}.md` }
    },
    decline: async (id) => {
      rec.declined.push(id)
      return { ...proposal(id), status: 'declined' }
    },
  }
}

function input(body: string) {
  return { user_id: 'owner', project_slug: 'owner', channel_topic_id: 'owner', body }
}

describe('parseSkillForgeCommand', () => {
  test('non-/skills body → not_a_skills_command', () => {
    expect(parseSkillForgeCommand('hello').kind).toBe('unrecognized')
    expect(parseSkillForgeCommand('/skillsfoo').kind).toBe('unrecognized')
  })
  test('/skills and /skills list → list', () => {
    expect(parseSkillForgeCommand('/skills').kind).toBe('list')
    expect(parseSkillForgeCommand('/skills list').kind).toBe('list')
  })
  test('/skills approve <id> [name]', () => {
    expect(parseSkillForgeCommand('/skills approve abc')).toEqual({ kind: 'approve', id: 'abc' })
    expect(parseSkillForgeCommand('/skills approve abc my-name')).toEqual({
      kind: 'approve',
      id: 'abc',
      name: 'my-name',
    })
  })
  test('/skills decline <id>', () => {
    expect(parseSkillForgeCommand('/skills decline abc')).toEqual({ kind: 'decline', id: 'abc' })
  })
  test('approve/decline with no id → unrecognized', () => {
    expect(parseSkillForgeCommand('/skills approve').kind).toBe('unrecognized')
    expect(parseSkillForgeCommand('/skills decline').kind).toBe('unrecognized')
  })
  test('/skills help → help', () => {
    expect(parseSkillForgeCommand('/skills help').kind).toBe('help')
  })
})

describe('buildSkillForgeChatCommandFilter', () => {
  test('returns null for a non-command body (falls through to the LLM)', async () => {
    const filter = buildSkillForgeChatCommandFilter(fakeBackend([], { approved: [], declined: [] }))
    expect(await filter.match(input('what is the weather'))).toBeNull()
  })

  test('/skills list surfaces the pending proposals', async () => {
    const filter = buildSkillForgeChatCommandFilter(
      fakeBackend([proposal('p1')], { approved: [], declined: [] }),
    )
    const res = await filter.match(input('/skills'))
    expect(res).not.toBeNull()
    expect(res!.text).toContain('p1')
  })

  test('/skills approve routes to the backend with the rename edit', async () => {
    const rec: Recorder = { approved: [], declined: [] }
    const filter = buildSkillForgeChatCommandFilter(fakeBackend([], rec))
    const res = await filter.match(input('/skills approve p9 better-name'))
    expect(res!.text).toContain('Approved')
    expect(rec.approved).toEqual([{ id: 'p9', edits: { name: 'better-name' } }])
  })

  test('/skills decline routes to the backend', async () => {
    const rec: Recorder = { approved: [], declined: [] }
    const filter = buildSkillForgeChatCommandFilter(fakeBackend([], rec))
    const res = await filter.match(input('/skills decline p7'))
    expect(res!.text).toContain('Declined')
    expect(rec.declined).toEqual(['p7'])
  })

  test('backend error surfaces as an error result, not a throw', async () => {
    const filter = buildSkillForgeChatCommandFilter({
      listPending: async () => {
        throw new Error('db down')
      },
      approve: async () => {
        throw new Error('nope')
      },
      decline: async () => {
        throw new Error('nope')
      },
    })
    const res = await filter.match(input('/skills list'))
    expect(res!.error?.code).toBe('backend_error')
  })
})
