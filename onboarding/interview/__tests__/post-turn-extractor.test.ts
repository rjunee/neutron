/**
 * Path 1 post-turn onboarding scribe — unit tests.
 *
 * Verifies the fire-and-forget extractor: it pulls structured fields out of an
 * (assistant question, user answer) exchange, persists them byte-compatibly
 * into `phase_state`, never blocks/throws, and fires `onComplete` exactly when
 * the 5 required fields first become complete.
 */

import { test, expect } from 'bun:test'

import {
  buildPostTurnExtractor,
  buildPhaseStatePatch,
  parseExtractedFields,
} from '../post-turn-extractor.ts'
import type { AnthropicMessagesClient } from '../agent-name-suggester.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { auditRequiredFields } from '../required-fields-audit.ts'

const SLUG = 'acme'
const USER = 'owner:1'

/** A stub client that returns a fixed JSON envelope (one per call, in order). */
function stubClient(responses: string[]): AnthropicMessagesClient {
  let i = 0
  return {
    messages: {
      create: async () => {
        const text = responses[Math.min(i, responses.length - 1)] ?? '{}'
        i += 1
        return { content: [{ text }] }
      },
    },
  }
}

test('parseExtractedFields: strict parse + array coercion', () => {
  const parsed = parseExtractedFields(
    '{"user_first_name":"Sam","primary_projects":["A","B"],"non_work_interests":["climbing",{"name":"chess","cadence_hint":"weekly"}]}',
  )
  expect(parsed?.user_first_name).toBe('Sam')
  expect(parsed?.primary_projects).toEqual(['A', 'B'])
  expect(parsed?.non_work_interests).toEqual([{ name: 'climbing' }, { name: 'chess', cadence_hint: 'weekly' }])
  expect(parseExtractedFields('not json')).toBeNull()
  expect(parseExtractedFields('{}')).toEqual({})
})

test('buildPhaseStatePatch: merges arrays, dedupes, LLM-driven scalars', () => {
  const prior = { primary_projects: ['Topline'], user_first_name: 'Sam' }
  const patch = buildPhaseStatePatch(
    prior,
    { primary_projects: ['topline', 'Acme'], agent_personality: 'warm and direct', agent_name: 'Atlas' },
    'I want to call you Atlas',
  )
  // dedupe case-insensitive against prior, append new
  expect(patch['primary_projects']).toEqual(['Topline', 'Acme'])
  expect(patch['agent_personality']).toBe('warm and direct')
  // user_first_name already set in prior → not re-patched
  expect(patch['user_first_name']).toBeUndefined()
  // agent_name comes from the LLM field
  expect(patch['agent_name']).toBe('Atlas')
})

test('buildPhaseStatePatch: does NOT mis-extract an agent name from a general turn', () => {
  // No agent_name from the LLM + a conversational answer → no spurious name.
  const patch = buildPhaseStatePatch({}, { user_first_name: 'Sam' }, "I'm Sam and I build things")
  expect(patch['agent_name']).toBeUndefined()
  expect(patch['user_first_name']).toBe('Sam')
})

test('extractor persists fields and fires onComplete when 5 required fields complete', async () => {
  const store = new InMemoryOnboardingStateStore()
  // One LLM response that completes every required field at once.
  const client = stubClient([
    JSON.stringify({
      user_first_name: 'Sam',
      agent_name: 'Atlas',
      agent_personality: 'warm and direct',
      primary_projects: ['Topline', 'Acme', 'a book on focus'],
      non_work_interests: ['climbing'],
    }),
  ])
  let completedWith: { user_id: string } | null = null
  const extractor = buildPostTurnExtractor({
    anthropicClient: client,
    stateStore: store,
    project_slug: SLUG,
    onComplete: ({ user_id }) => {
      completedWith = { user_id }
    },
  })

  const state = await extractor.runOnce({
    user_id: USER,
    agent_text: 'Tell me about yourself and your work.',
    user_text:
      "I'm Sam, I work on Topline and Acme and a book on focus, and I climb. Call you Atlas, warm and direct.",
    observed_at: 1000,
  })

  expect(state).not.toBeNull()
  expect(state!.phase_state['user_first_name']).toBe('Sam')
  expect(state!.phase_state['agent_name']).toBe('Atlas')
  expect((state!.phase_state['primary_projects'] as string[]).length).toBe(3)
  expect(auditRequiredFields(state!.phase_state).next_to_collect).toBeNull()
  expect(completedWith).not.toBeNull()
  expect(completedWith!.user_id).toBe(USER)
})

test('extractor does NOT complete while fields are still missing', async () => {
  const store = new InMemoryOnboardingStateStore()
  const client = stubClient([JSON.stringify({ user_first_name: 'Sam' })])
  let completed = false
  const extractor = buildPostTurnExtractor({
    anthropicClient: client,
    stateStore: store,
    project_slug: SLUG,
    onComplete: () => {
      completed = true
    },
  })
  const state = await extractor.runOnce({
    user_id: USER,
    agent_text: 'What should I call you?',
    user_text: "I'm Sam",
    observed_at: 1000,
  })
  expect(state!.phase_state['user_first_name']).toBe('Sam')
  expect(state!.phase).toBe('work_interview_gap_fill')
  expect(completed).toBe(false)
})

test('extractor is a no-op once onboarding is completed (terminal phase)', async () => {
  const store = new InMemoryOnboardingStateStore()
  await store.upsert({ project_slug: SLUG, user_id: USER, phase: 'completed', completed_at: 1 })
  let called = false
  const extractor = buildPostTurnExtractor({
    anthropicClient: stubClient(['{}']),
    stateStore: store,
    project_slug: SLUG,
    onComplete: () => {
      called = true
    },
  })
  const state = await extractor.runOnce({
    user_id: USER,
    agent_text: 'hi',
    user_text: 'still chatting',
    observed_at: 2,
  })
  expect(state).toBeNull()
  expect(called).toBe(false)
})

test('extractor swallows LLM failure (never throws) — fire-and-forget safety', async () => {
  const store = new InMemoryOnboardingStateStore()
  const throwingClient: AnthropicMessagesClient = {
    messages: { create: async () => { throw new Error('boom') } },
  }
  const extractor = buildPostTurnExtractor({
    anthropicClient: throwingClient,
    stateStore: store,
    project_slug: SLUG,
  })
  // The LLM throwing must NOT reject the call (fire-and-forget). Nothing is
  // extracted this turn, and no onboarding_state row is created from an empty
  // extraction — but the call resolves cleanly.
  await expect(
    extractor.runOnce({
      user_id: USER,
      agent_text: 'What should I call you?',
      user_text: 'Atlas, please',
      observed_at: 1,
    }),
  ).resolves.toBeNull()
})
