import { describe, expect, test } from 'bun:test'

import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import {
  buildReminderDispatcher,
  deriveReminderProjectId,
  type ReminderLlm,
  type ReminderOutbound,
  type ReminderOutboundInput,
} from './dispatcher.ts'
import {
  MAX_DEGRADED_INTENT_CHARS,
  MAX_NUDGE_BODY_CHARS,
  overBoundNudgeBody,
  OVER_BOUND_NUDGE_BODY,
} from './message-shape.ts'
import type { Reminder } from './store.ts'

function makeReminder(over: Partial<Reminder> = {}): Reminder {
  return {
    id: 'r1',
    owner_slug: 'proj',
    topic_id: 'topic-1',
    fire_at: 1_700_000_000,
    message: 'take out the trash',
    status: 'pending',
    recurrence: null,
    recurrence_spec: null,
    ritual_id: null,
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
    // Metered to the DESTINATION project derived from topic_id, not the
    // instance owner_slug ('proj'). Default makeReminder's raw topic_id
    // ('topic-1') IS the destination project id (Reminders Core shape).
    expect(llm.specs[0]!.metering_context?.project_id).toBe('topic-1')
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

  // BLOCKING fix (Argus PR #7) — a PROJECT reminder gathers context for AND
  // meters to its DESTINATION project (encoded in topic_id), not the fixed
  // instance owner_slug.
  test('project reminder gathers context + meters by the topic_id project, not project_slug', async () => {
    const outbound = recordingOutbound()
    const llm = recordingLlm('composed')
    const gathered: Array<{ slug: string; project_id: string }> = []
    const d = buildReminderDispatcher({
      outbound,
      llm,
      context: {
        gather: (reminder, project_id) => {
          gathered.push({ slug: reminder.owner_slug, project_id })
          return `ctx for ${project_id}`
        },
      },
    })

    // App-surface shape: owner_slug is the instance, topic_id carries the
    // destination project as `app-project:<project_id>`.
    await d.dispatch(
      makeReminder({ owner_slug: 'owner-instance', topic_id: 'app-project:acme-app' }),
    )

    // Context source saw the destination project id, not the instance slug...
    expect(gathered).toEqual([{ slug: 'owner-instance', project_id: 'acme-app' }])
    expect(llm.specs[0]!.prompt).toContain('ctx for acme-app')
    // ...and the compose turn metered to the destination project, not the owner.
    expect(llm.specs[0]!.metering_context?.project_id).toBe('acme-app')
  })

  test('instance-level reminder (null topic_id) keys context + metering to project_slug', async () => {
    const outbound = recordingOutbound()
    const llm = recordingLlm('composed')
    const gathered: string[] = []
    const d = buildReminderDispatcher({
      outbound,
      llm,
      context: { gather: (_r, project_id) => { gathered.push(project_id); return '' } },
    })

    await d.dispatch(makeReminder({ owner_slug: 'home-instance', topic_id: null }))

    expect(gathered).toEqual(['home-instance'])
    expect(llm.specs[0]!.metering_context?.project_id).toBe('home-instance')
  })

  test('empty / whitespace message does not fire an empty body (no post)', async () => {
    const outbound = recordingOutbound()
    const llm = recordingLlm('should not be called')
    const d = buildReminderDispatcher({ outbound, llm })

    // Returns normally (so the tick advances the row) but posts nothing.
    await expect(d.dispatch(makeReminder({ message: '   \n  ' }))).resolves.toBeUndefined()
    // A reminder that is ONLY a [ROUTING] header has no body either.
    await d.dispatch(makeReminder({ message: '[ROUTING] target_thread: 5\n   ' }))

    expect(outbound.posts).toHaveLength(0)
    expect(llm.specs).toHaveLength(0)
  })
})

// #293 defect B, measured: at 14:11 and 14:36 a fire posted 3,413 and 3,336
// characters of the owner's private operational `message` — run ids, file
// paths, the agent's own reasoning about him — straight into his chat, because
// the compose step failed and the degrade path posted `row.message` raw. The
// bound below is what makes that unpostable; the verbatim degrade for a real
// one-line reminder is preserved, because that one is designed behaviour.
describe('buildReminderDispatcher — the refused-body bounds', () => {
  const LEAK_MARKER = 'LEAK_MARKER_XYZ'
  const longIntent = `OVERNIGHT BUILD DRIVER ${LEAK_MARKER} `.repeat(150)
  /** The refusal line for `makeReminder()`'s id — it NAMES the reminder. */
  const REFUSED_R1 = overBoundNudgeBody('r1')

  test('compose throws on a long intent → the intent is NEVER posted', async () => {
    expect(longIntent.length).toBeGreaterThan(MAX_NUDGE_BODY_CHARS)
    const outbound = recordingOutbound()
    const lines: string[] = []
    const llm: ReminderLlm = {
      compose: async () => {
        throw new Error('substrate down')
      },
    }
    const d = buildReminderDispatcher({ outbound, llm, log: (m) => lines.push(m) })

    await d.dispatch(makeReminder({ message: longIntent }))

    expect(outbound.posts).toHaveLength(1)
    const body = outbound.posts[0]!.body
    expect(body).not.toBe(longIntent)
    expect(body).not.toContain(LEAK_MARKER)
    expect(body).toBe(REFUSED_R1)
    expect(body.length).toBeLessThanOrEqual(MAX_DEGRADED_INTENT_CHARS)
    // The refusal is on the record, against the reminder id.
    const refusal = lines.find(
      (l) => l.includes('MAX_DEGRADED_INTENT_CHARS') && l.includes('refused'),
    )
    expect(refusal).toBeDefined()
    expect(refusal).toContain('r1')
  })

  // ACCEPTANCE CRITERION 3, at the size that actually occurs. 29% of live
  // reminder rows were 1001–2000 chars: under the round-1 single 2000-char
  // bound every one of them still posted `row.message` verbatim on a compose
  // failure. The degrade bound is 300, so they do not.
  test('compose throws on a 1900-char intent — under MAX_NUDGE_BODY_CHARS — and it is STILL not posted', async () => {
    const midIntent = `OVERNIGHT BUILD DRIVER ${LEAK_MARKER} `.repeat(48)
    expect(midIntent.length).toBeGreaterThan(MAX_DEGRADED_INTENT_CHARS)
    expect(midIntent.length).toBeLessThan(MAX_NUDGE_BODY_CHARS)
    const outbound = recordingOutbound()
    const llm: ReminderLlm = {
      compose: async () => {
        throw new Error('substrate down')
      },
    }
    const d = buildReminderDispatcher({ outbound, llm })

    await d.dispatch(makeReminder({ message: midIntent }))

    expect(outbound.posts[0]!.body).not.toContain(LEAK_MARKER)
    expect(outbound.posts[0]!.body).toBe(REFUSED_R1)
  })

  test('an empty compose result on a long intent also refuses the intent', async () => {
    const outbound = recordingOutbound()
    const d = buildReminderDispatcher({ outbound, llm: recordingLlm('   ') })

    await d.dispatch(makeReminder({ message: longIntent }))

    expect(outbound.posts[0]!.body).toBe(REFUSED_R1)
    expect(outbound.posts[0]!.body).not.toContain(LEAK_MARKER)
  })

  test('the refusal line names the reminder, so a recurring one is actionable', async () => {
    const outbound = recordingOutbound()
    const d = buildReminderDispatcher({ outbound, llm: recordingLlm('   ') })

    await d.dispatch(makeReminder({ id: 'rem-abc123', message: longIntent }))

    expect(outbound.posts[0]!.body).toContain('rem-abc123')
    expect(outbound.posts[0]!.body).not.toBe(OVER_BOUND_NUDGE_BODY)
  })

  test('a 3,400-char composed "nudge" is refused, not posted', async () => {
    const outbound = recordingOutbound()
    const lines: string[] = []
    const composed = 'C'.repeat(3_400)
    const d = buildReminderDispatcher({
      outbound,
      llm: recordingLlm(composed),
      log: (m) => lines.push(m),
    })

    await d.dispatch(makeReminder({ message: 'take out the trash' }))

    // Refused → treated exactly as a compose failure, so the bounded degrade
    // posts instead. The over-long body never reaches the topic, whole or cut.
    expect(outbound.posts[0]!.body).toBe('take out the trash')
    expect(outbound.posts[0]!.body).not.toContain('CCCC')
    expect(lines.some((l) => l.includes('over MAX_NUDGE_BODY_CHARS'))).toBe(true)
  })

  test('a composed body of exactly MAX_NUDGE_BODY_CHARS still posts', async () => {
    const outbound = recordingOutbound()
    const composed = 'C'.repeat(MAX_NUDGE_BODY_CHARS)
    const d = buildReminderDispatcher({ outbound, llm: recordingLlm(composed) })

    await d.dispatch(makeReminder())

    expect(outbound.posts[0]!.body).toBe(composed)
  })

  // A `>` NEEDS BOTH SIDES OF ITS EDGE. The test above pins the last accepted length and the
  // 3,400-character test sits far past it — neither can tell a `>` from a `>=`. One character
  // over is the only case that does, and reading the boundary wrong silently refuses a
  // legitimate nudge that happens to land exactly on the limit. The degraded-intent limit
  // already has both halves; this is the composed limit's missing half.
  test('a composed body ONE character over MAX_NUDGE_BODY_CHARS is refused', async () => {
    const outbound = recordingOutbound()
    const lines: string[] = []
    const composed = 'C'.repeat(MAX_NUDGE_BODY_CHARS + 1)
    const d = buildReminderDispatcher({
      outbound,
      llm: recordingLlm(composed),
      log: (m) => lines.push(m),
    })

    await d.dispatch(makeReminder({ message: 'take out the trash' }))

    // Refused → the bounded degrade posts the short literal instead; the over-long body
    // never reaches the topic, whole or cut.
    expect(outbound.posts[0]!.body).toBe('take out the trash')
    expect(outbound.posts[0]!.body).not.toBe(composed)
    expect(lines.some((l) => l.includes('over MAX_NUDGE_BODY_CHARS'))).toBe(true)
  })

  test('the short-literal degrade stays byte-identical when compose throws', async () => {
    const outbound = recordingOutbound()
    const llm: ReminderLlm = {
      compose: async () => {
        throw new Error('substrate down')
      },
    }
    const d = buildReminderDispatcher({ outbound, llm })

    await d.dispatch(makeReminder({ message: 'take out the trash' }))

    expect(outbound.posts[0]!.body).toBe('take out the trash')
  })
})

describe('deriveReminderProjectId', () => {
  const base: Reminder = {
    id: 'r',
    owner_slug: 'instance-slug',
    topic_id: null,
    fire_at: 0,
    message: 'm',
    status: 'pending',
    recurrence: null,
    recurrence_spec: null,
    ritual_id: null,
    source: null,
    created_at: 0,
    fired_at: null,
    cancelled_at: null,
  }

  test('null / empty / whitespace topic → instance project_slug', () => {
    expect(deriveReminderProjectId({ ...base, topic_id: null })).toBe('instance-slug')
    expect(deriveReminderProjectId({ ...base, topic_id: '' })).toBe('instance-slug')
    expect(deriveReminderProjectId({ ...base, topic_id: '   ' })).toBe('instance-slug')
  })

  test('raw topic (Reminders Core) → the topic IS the project id', () => {
    expect(deriveReminderProjectId({ ...base, topic_id: 'acme' })).toBe('acme')
  })

  test('app-project:<id> (app surface) → the project id', () => {
    expect(deriveReminderProjectId({ ...base, topic_id: 'app-project:acme-app' })).toBe('acme-app')
    // Degenerate empty suffix falls back to the instance slug.
    expect(deriveReminderProjectId({ ...base, topic_id: 'app-project:' })).toBe('instance-slug')
  })

  test('web:<user>:<project> → project; web:<user> (General) → instance', () => {
    expect(deriveReminderProjectId({ ...base, topic_id: 'web:owner:acme' })).toBe('acme')
    expect(deriveReminderProjectId({ ...base, topic_id: 'web:owner' })).toBe('instance-slug')
    expect(deriveReminderProjectId({ ...base, topic_id: 'web:owner:' })).toBe('instance-slug')
  })

  test('app-project:~general (the app General SCOPE) → instance, like its web twin', () => {
    // `~general` is a SCOPE, not a project — the app reminders surface reserves it
    // for the no-project case (`gateway/http/app-reminders-surface.ts`
    // `resolveScopeSegment`) precisely because no project can be called that. Left
    // to fall through, this would return the literal `~general` and the context
    // source would go looking for `<owner_home>/Projects/~general/STATUS.md`, a
    // directory that cannot exist. Same answer as `web:owner` above, for the same
    // reason.
    expect(deriveReminderProjectId({ ...base, topic_id: 'app-project:~general' })).toBe(
      'instance-slug',
    )
    // And ONLY the exact sentinel — a project id that merely starts with it is a
    // project. (It cannot reach here through the surface, which rejects `~`, but a
    // prefix test would be wrong in the same way it is wrong on the client.)
    expect(deriveReminderProjectId({ ...base, topic_id: 'app-project:~generalize' })).toBe(
      '~generalize',
    )
  })
})
