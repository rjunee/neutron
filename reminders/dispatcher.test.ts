import { describe, expect, test } from 'bun:test'

import type { AgentSpec } from '../runtime/substrate.ts'
import {
  buildReminderDispatcher,
  type ReminderLlm,
  type ReminderOutbound,
  type ReminderOutboundInput,
} from './dispatcher.ts'
import type { Reminder } from './store.ts'

function makeReminder(over: Partial<Reminder> = {}): Reminder {
  return {
    id: 'r1',
    project_slug: 'proj',
    topic_id: 'topic-1',
    fire_at: 1_700_000_000,
    message: 'take out the trash',
    status: 'pending',
    recurrence: null,
    source: null,
    created_at: 1_699_999_000,
    fired_at: null,
    cancelled_at: null,
    ...over,
  }
}

function recordingOutbound(): ReminderOutbound & { posts: ReminderOutboundInput[] } {
  const posts: ReminderOutboundInput[] = []
  return { posts, post: (m) => { posts.push(m); return true } }
}

function recordingLlm(reply: string): ReminderLlm & { specs: AgentSpec[] } {
  const specs: AgentSpec[] = []
  return { specs, compose: async (spec) => { specs.push(spec); return reply } }
}

describe('buildReminderDispatcher — composition + post', () => {
  test('composes via the LLM and posts the composed body to the topic', async () => {
    const outbound = recordingOutbound()
    const llm = recordingLlm('Trash night — bins out front before you crash.')
    const d = buildReminderDispatcher({ outbound, llm })

    await d.dispatch(makeReminder())

    expect(llm.specs).toHaveLength(1)
    expect(outbound.posts).toHaveLength(1)
    expect(outbound.posts[0]!.body).toBe('Trash night — bins out front before you crash.')
    expect(outbound.posts[0]!.topic_id).toBe('topic-1')
    expect(outbound.posts[0]!.reminder_id).toBe('r1')
  })

  test('the composition prompt carries the stored intent', async () => {
    const outbound = recordingOutbound()
    const llm = recordingLlm('composed')
    const d = buildReminderDispatcher({ outbound, llm })

    await d.dispatch(makeReminder({ message: 'water the office plants' }))

    expect(llm.specs[0]!.prompt).toContain('water the office plants')
    expect(llm.specs[0]!.metering_context?.project_id).toBe('proj')
  })

  test('gathered context is threaded into the prompt', async () => {
    const outbound = recordingOutbound()
    const llm = recordingLlm('composed')
    const d = buildReminderDispatcher({
      outbound,
      llm,
      context: { gather: () => 'STATUS: launch is T-2 days' },
    })

    await d.dispatch(makeReminder())

    expect(llm.specs[0]!.prompt).toContain('launch is T-2 days')
  })

  test('no LLM → degrades to the literal body, still posts', async () => {
    const outbound = recordingOutbound()
    const d = buildReminderDispatcher({ outbound, llm: null })

    await d.dispatch(makeReminder({ message: 'call the dentist' }))

    expect(outbound.posts).toHaveLength(1)
    expect(outbound.posts[0]!.body).toBe('call the dentist')
  })

  test('LLM throws → degrades to literal body (never drops the reminder)', async () => {
    const outbound = recordingOutbound()
    const llm: ReminderLlm = { compose: async () => { throw new Error('substrate down') } }
    const d = buildReminderDispatcher({ outbound, llm })

    await d.dispatch(makeReminder({ message: 'pay the rent' }))

    expect(outbound.posts[0]!.body).toBe('pay the rent')
  })

  test('LLM returns empty → degrades to literal body', async () => {
    const outbound = recordingOutbound()
    const d = buildReminderDispatcher({ outbound, llm: recordingLlm('   ') })

    await d.dispatch(makeReminder({ message: 'feed the cat' }))

    expect(outbound.posts[0]!.body).toBe('feed the cat')
  })

  test('null topic_id falls back to general_topic_id', async () => {
    const outbound = recordingOutbound()
    const d = buildReminderDispatcher({
      outbound,
      llm: recordingLlm('x'),
      general_topic_id: 'general',
    })

    await d.dispatch(makeReminder({ topic_id: null }))

    expect(outbound.posts[0]!.topic_id).toBe('general')
  })

  test('[ROUTING] header routes the post when topic_id is null', async () => {
    const outbound = recordingOutbound()
    const d = buildReminderDispatcher({ outbound, llm: recordingLlm('x') })

    await d.dispatch(
      makeReminder({ topic_id: null, message: '[ROUTING] target_thread: 99\nstandup time' }),
    )

    expect(outbound.posts[0]!.topic_id).toBe('99')
  })

  test('resolveTopicId maps the engine destination to the surface key', async () => {
    const outbound = recordingOutbound()
    const d = buildReminderDispatcher({
      outbound,
      llm: recordingLlm('x'),
      resolveTopicId: ({ explicit_topic }) =>
        explicit_topic === null ? 'web:owner' : `web:owner:${explicit_topic}`,
    })

    await d.dispatch(makeReminder({ topic_id: 'acme' }))
    expect(outbound.posts[0]!.topic_id).toBe('web:owner:acme')

    await d.dispatch(makeReminder({ topic_id: null }))
    expect(outbound.posts[1]!.topic_id).toBe('web:owner')
  })

  test('a rejected (false) post throws so the tick leaves the row pending', async () => {
    const rejecting: ReminderOutbound = { post: () => false }
    const d = buildReminderDispatcher({ outbound: rejecting, llm: recordingLlm('x') })

    await expect(d.dispatch(makeReminder())).rejects.toThrow(/post rejected/)
  })

  test('an accepted (true) post does not throw', async () => {
    const outbound = recordingOutbound()
    const d = buildReminderDispatcher({ outbound, llm: recordingLlm('x') })
    await expect(d.dispatch(makeReminder())).resolves.toBeUndefined()
  })

  test('context gather failure is non-fatal — still composes + posts', async () => {
    const outbound = recordingOutbound()
    const llm = recordingLlm('composed anyway')
    const d = buildReminderDispatcher({
      outbound,
      llm,
      context: { gather: () => { throw new Error('fs error') } },
    })

    await d.dispatch(makeReminder())

    expect(outbound.posts[0]!.body).toBe('composed anyway')
  })
})
