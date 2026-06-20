/**
 * 2026-05-28 final-handoff sprint — Test 3.
 *
 * Spec: `[A] Get the mobile app` tap emits a follow-up prompt whose
 * body surfaces the canonical `MOBILE_APP_URL` constant. The phase
 * stays at `completed`; `active_prompt_id` rotates to the follow-up
 * row.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  buildFinalHandoffEngine,
  makeDispatchRecorder,
  setupFinalHandoffTest,
  tapHandoffChoice,
  walkToCompleted,
  TEST_MOBILE_APP_URL,
  type FinalHandoffTestSetup,
} from './final-handoff-test-helpers.ts'
import {
  FINAL_HANDOFF_MOBILE_APP_CHOICE,
} from '../final-handoff-prompts.ts'
import { MOBILE_APP_URL } from '../final-handoff-config.ts'

let setup: FinalHandoffTestSetup

beforeEach(() => {
  setup = setupFinalHandoffTest()
})

afterEach(() => {
  setup.cleanup()
})

describe('final-handoff [A] mobile-app button', () => {
  test('emits a follow-up containing the MOBILE_APP_URL constant', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({ setup, wowDispatcher: rec.hook })
    const { prompt: handoff } = await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
    })
    const before = setup.sentPrompts.length
    await tapHandoffChoice({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      prompt_id: handoff.prompt_id,
      choice_value: FINAL_HANDOFF_MOBILE_APP_CHOICE,
      observed_at: 1_700_000_010_000,
    })
    // A follow-up prompt was sent.
    expect(setup.sentPrompts.length).toBe(before + 1)
    const followup = setup.sentPrompts[before]!.prompt
    // MOBILE_APP_URL is '' under the test harness; the engine injects the
    // non-empty TEST_MOBILE_APP_URL, which is what the body surfaces.
    expect(followup.body).toContain(MOBILE_APP_URL)
    expect(followup.body).toContain(TEST_MOBILE_APP_URL)
    expect(followup.metadata?.['final_handoff_mobile_app_url']).toBe(
      TEST_MOBILE_APP_URL,
    )
    expect(followup.metadata?.['final_handoff_shape']).toBe('mobile-app')
    // The follow-up surfaces a single Done affordance.
    expect(followup.options.length).toBe(1)
    expect(followup.options[0]?.body.toLowerCase()).toContain('done')
    // Phase remained completed; active_prompt_id rotated to the follow-up.
    const s = await setup.stateStore.get('casey', 'u-1')
    expect(s!.phase).toBe('completed')
    expect(s!.phase_state['active_prompt_id']).toBe(followup.prompt_id)
  })

  test('tap on the follow-up Done clears active_prompt_id and stays at completed', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({ setup, wowDispatcher: rec.hook })
    const { prompt: handoff } = await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
    })
    await tapHandoffChoice({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      prompt_id: handoff.prompt_id,
      choice_value: FINAL_HANDOFF_MOBILE_APP_CHOICE,
      observed_at: 1_700_000_010_000,
    })
    const followup = setup.sentPrompts[setup.sentPrompts.length - 1]!.prompt
    const before = setup.sentPrompts.length
    await tapHandoffChoice({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      prompt_id: followup.prompt_id,
      choice_value: followup.options[0]!.value,
      observed_at: 1_700_000_011_000,
    })
    // Done does not emit a further prompt; the engine clears the
    // active_prompt_id and leaves the chat surface quiet.
    expect(setup.sentPrompts.length).toBe(before)
    const s = await setup.stateStore.get('casey', 'u-1')
    expect(s!.phase).toBe('completed')
    expect(s!.phase_state['active_prompt_id']).toBeNull()
  })

  // Open-surface honesty fix (Argus PR #15, 2026-06-13). On a self-hosted
  // Open install with no `NEUTRON_WEB_APP_BASE`, MOBILE_APP_URL is '' and
  // there is no mobile page to point at. The mobile-app follow-up must be
  // SUPPRESSED entirely — never a dangling "Open that link" with no link.
  test('empty mobile-app URL → no follow-up, no dangling-link copy', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({
      setup,
      wowDispatcher: rec.hook,
      mobileAppUrl: '',
    })
    const { prompt: handoff } = await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
    })
    const before = setup.sentPrompts.length
    await tapHandoffChoice({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      prompt_id: handoff.prompt_id,
      choice_value: FINAL_HANDOFF_MOBILE_APP_CHOICE,
      observed_at: 1_700_000_010_000,
    })
    // No follow-up prompt was emitted at all.
    expect(setup.sentPrompts.length).toBe(before)
    // And nothing the user ever saw contains the dangling-link copy.
    const bodies = setup.sentPrompts.map((p) => p.prompt.body).join('\n')
    expect(bodies).not.toContain('Open that link on your phone')
    // The initial handoff prompt stays active so the user can pick another
    // option; phase remains completed.
    const s = await setup.stateStore.get('casey', 'u-1')
    expect(s!.phase).toBe('completed')
    expect(s!.phase_state['active_prompt_id']).toBe(handoff.prompt_id)
  })
})
