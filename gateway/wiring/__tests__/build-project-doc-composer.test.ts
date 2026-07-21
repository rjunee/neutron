/**
 * Item 4 — project-doc composer unit tests. The composer is a thin
 * prompt layer over the CC-substrate-backed AnthropicMessagesClient
 * shim; these tests pin the prompt contract + the throw-on-empty
 * failure shape the materializer's fallback relies on.
 */

import { describe, expect, test } from 'bun:test'
import { buildProjectDocComposer, DOC_MAX_TOKENS } from '../build-project-doc-composer.ts'
import type { AnthropicMessagesClient } from '@neutronai/onboarding/interview/anthropic-client.ts'
import { BEST_MODEL } from '@neutronai/runtime/models.ts'

interface RecordedCall {
  model: string
  system?: string
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>
  max_tokens: number
}

function stubClient(reply: string): { client: AnthropicMessagesClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const client: AnthropicMessagesClient = {
    messages: {
      async create(input) {
        calls.push({
          model: input.model,
          ...(input.system !== undefined ? { system: input.system } : {}),
          messages: input.messages,
          max_tokens: input.max_tokens,
        })
        return { content: [{ text: reply }] }
      },
    },
  }
  return { client, calls }
}

const docInput: Omit<
  Parameters<ReturnType<typeof buildProjectDocComposer>>[0],
  'kind'
> = {
  project_name: 'Topline',
  slug: 'topline',
  context: 'Billing SaaS you discuss weekly.',
  related: { entities: ['Topline'], topics: ['Topline invoicing'], interests: [] },
  transcript_excerpt: 'User: how do we price the tiers?',
}

describe('build-project-doc-composer', () => {
  test('dispatches BEST_MODEL with kind-specific prompts + the excerpt', async () => {
    const { client, calls } = stubClient('# Topline\n\nSynthesized overview.\n')
    const compose = buildProjectDocComposer({ clientForProject: () => client })

    const readme = await compose({ ...docInput, kind: 'readme' })
    expect(readme).toContain('Synthesized overview')

    expect(calls.length).toBe(1)
    const call = calls[0]!
    expect(call.model).toBe(BEST_MODEL)
    expect(call.max_tokens).toBe(DOC_MAX_TOKENS)
    expect(call.system ?? '').toContain('README.md')
    expect(call.system ?? '').toContain('Never use em dashes')
    const user = call.messages[0]?.content ?? ''
    expect(user).toContain('Project name: Topline')
    expect(user).toContain('Billing SaaS you discuss weekly.')
    expect(user).toContain('Topline invoicing')
    expect(user).toContain('how do we price the tiers?')

    await compose({ ...docInput, kind: 'transcript_summary' })
    expect(calls[1]?.system ?? '').toContain('transcript-summary')
  })

  test('throws on an empty synthesis (materializer falls back on this)', async () => {
    const { client } = stubClient('   ')
    const compose = buildProjectDocComposer({ clientForProject: () => client })
    await expect(compose({ ...docInput, kind: 'readme' })).rejects.toThrow(
      /empty readme synthesis/,
    )
  })

  // WHITE-BOX (#378, Approach A): the doc composer resolves the PER-PROJECT
  // isolated compose session by the project's slug on every call — so project 2/3
  // never compose their README/summary over a session shared with project 1.
  test('resolves the compose client PER PROJECT — keyed by slug', async () => {
    const askedFor: string[] = []
    const { client } = stubClient('# doc\n\nbody\n')
    const compose = buildProjectDocComposer({
      clientForProject: (project_id) => {
        askedFor.push(project_id)
        return client
      },
    })
    await compose({ ...docInput, slug: 'amascence', kind: 'readme' })
    await compose({ ...docInput, slug: 'dtc-ops', kind: 'transcript_summary' })
    expect(askedFor).toEqual(['amascence', 'dtc-ops'])
  })
})
