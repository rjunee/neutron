/**
 * 2026-05-28 wow-cleanup sprint — Fix A.
 *
 * The wow_fired first-week brief must address the USER's first name, not
 * the agent's name. Sam's verbatim feedback 2026-05-28: "Why is
 * referring to me as 'rainman'? Rainman is the name of the agent, my
 * name is Sam."
 *
 * Root cause: engine.ts:buildWowSignalsFromState() was setting
 * `display_name = agent_name ?? project_slug`, which then flowed into
 * `01-first-week-brief.ts:templateBrief()` and got used as the welcome
 * addressee. Fix lives in two places (defense in depth):
 *   1. engine.ts now prefers `phase_state.user_first_name` over
 *      agent_name when building `display_name`.
 *   2. `01-first-week-brief.ts:templateBrief()` reads
 *      `phase_state_json.user_first_name` directly so it is protected
 *      against any caller that still ships display_name = agent_name.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import action01 from '../../wow-moment/actions/01-first-week-brief.ts'
import {
  buildContext,
  makeFixture,
  teardown,
  type TestFixture,
} from '../../wow-moment/__tests__/test-helpers.ts'

let fix: TestFixture
beforeEach(() => {
  fix = makeFixture()
})
afterEach(() => {
  teardown(fix)
  rmSync(fix.dir, { recursive: true, force: true })
})

describe('Fix A — welcome addresses user_first_name, not agent_name', () => {
  test('templateBrief welcome line uses phase_state.user_first_name', async () => {
    const ctx = buildContext(fix, {
      interview: {
        // Simulate the legacy bug: display_name is the AGENT name.
        display_name: 'rainman',
        archetype_blend: ['Guide'],
        phase_state_json: {
          user_first_name: 'Sam',
          agent_name: 'rainman',
        },
      },
    })
    await action01.run(ctx)
    const sent = fix.channelCalls.texts[0]
    expect(sent).toBeDefined()
    expect(sent!.body).toContain('Welcome Sam.')
    expect(sent!.body).not.toContain('Welcome rainman')
  })

  test('templateBrief falls back to display_name when user_first_name absent (legacy callers)', async () => {
    const ctx = buildContext(fix, {
      interview: {
        display_name: 'Casey',
        archetype_blend: ['Athena'],
        phase_state_json: {},
      },
    })
    await action01.run(ctx)
    const sent = fix.channelCalls.texts[0]
    expect(sent).toBeDefined()
    expect(sent!.body).toContain('Welcome Casey.')
  })

  test('templateBrief renders "Welcome friend." when no name available at all', async () => {
    const ctx = buildContext(fix, {
      interview: {
        archetype_blend: ['Guide'],
        phase_state_json: {},
      },
    })
    await action01.run(ctx)
    const sent = fix.channelCalls.texts[0]
    expect(sent).toBeDefined()
    expect(sent!.body).toContain('Welcome friend.')
    expect(sent!.body).not.toContain('Welcome undefined')
  })

  test('user_first_name takes precedence even when both are set', async () => {
    const ctx = buildContext(fix, {
      interview: {
        // Both populated — the bug case: agent_name in display_name and
        // user_first_name also in phase_state. The right pick is the
        // user's first name.
        display_name: 'rainman',
        archetype_blend: ['Musashi'],
        phase_state_json: {
          user_first_name: 'Sam',
          agent_name: 'rainman',
        },
      },
    })
    await action01.run(ctx)
    const sent = fix.channelCalls.texts[0]
    expect(sent!.body.startsWith('Welcome Sam. Here is the week ahead through a Musashi lens.')).toBe(true)
  })
})
