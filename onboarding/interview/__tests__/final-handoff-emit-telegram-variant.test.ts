/**
 * 2026-05-28 final-handoff sprint — Test 2.
 *
 * Spec: on `wow_fired → completed` over the Telegram channel, the
 * handoff prompt collapses to 2 buttons (Mobile-app + Skip). The
 * Telegram-bot bind CTA is suppressed because the user is already on
 * Telegram.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  buildFinalHandoffEngine,
  makeDispatchRecorder,
  setupFinalHandoffTest,
  walkToCompleted,
  type FinalHandoffTestSetup,
} from './final-handoff-test-helpers.ts'
import {
  FINAL_HANDOFF_METADATA_TAG,
  FINAL_HANDOFF_MOBILE_APP_CHOICE,
  FINAL_HANDOFF_SKIP_CHOICE,
  FINAL_HANDOFF_TELEGRAM_BIND_CHOICE,
} from '../final-handoff-prompts.ts'

let setup: FinalHandoffTestSetup

beforeEach(() => {
  setup = setupFinalHandoffTest()
})

afterEach(() => {
  setup.cleanup()
})

describe('final-handoff emit (telegram channel)', () => {
  test('emits buttons-free + freeform close on Telegram (no mobile/skip/telegram CTAs)', async () => {
    // Items 7 + 9 (2026-06-19, `final-handoff-prompts.ts`) — on the
    // Telegram channel the user is already on their phone, so even the
    // mobile-app affordance is dropped: the close is buttons-free and the
    // user replies to the actionable invite by typing. The Telegram-bot
    // bind CTA and the Skip dead-end were removed in the same pass.
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({ setup, wowDispatcher: rec.hook })
    const { prompt } = await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'tg:1',
      channel_kind: 'telegram',
    })
    expect(prompt.metadata?.[FINAL_HANDOFF_METADATA_TAG]).toBe(true)
    expect(prompt.metadata?.['final_handoff_channel']).toBe('telegram')
    // Buttons-free close — the user answers the invite by typing.
    expect(prompt.options.length).toBe(0)
    expect(prompt.allow_freeform).toBe(true)
    const values = prompt.options.map((o) => o.value)
    expect(values).not.toContain(FINAL_HANDOFF_MOBILE_APP_CHOICE)
    expect(values).not.toContain(FINAL_HANDOFF_SKIP_CHOICE)
    expect(values).not.toContain(FINAL_HANDOFF_TELEGRAM_BIND_CHOICE)
    // Ends with the actionable invite so the General topic doesn't dead-end.
    expect(prompt.body).toContain("What's something I can help you with right now?")
  })

  test('post-emit state still records the active_prompt_id on the completed row', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({ setup, wowDispatcher: rec.hook })
    const { prompt } = await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'tg:1',
      channel_kind: 'telegram',
    })
    const s = await setup.stateStore.get('casey', 'u-1')
    expect(s!.phase).toBe('completed')
    expect(s!.phase_state['active_prompt_id']).toBe(prompt.prompt_id)
  })
})
