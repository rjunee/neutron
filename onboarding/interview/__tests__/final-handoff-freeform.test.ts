/**
 * 2026-05-28 final-handoff sprint — Test 6.
 *
 * Spec: freeform replies on the initial handoff prompt route through a
 * keyword-aware classifier. "mobile" / "app" → mobile-app follow-up;
 * "telegram" / "tg" → telegram-bind follow-up; "skip" / "later" →
 * skip-ack follow-up. Replies that don't match a keyword are recorded
 * to the transcript without firing a follow-up.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  buildFinalHandoffEngine,
  makeDispatchRecorder,
  sendHandoffFreeform,
  setupFinalHandoffTest,
  walkToCompleted,
  type FinalHandoffTestSetup,
} from './final-handoff-test-helpers.ts'
import {
  routeFinalHandoffFreeform,
  FINAL_HANDOFF_MOBILE_APP_CHOICE,
  FINAL_HANDOFF_TELEGRAM_BIND_CHOICE,
  FINAL_HANDOFF_SKIP_CHOICE,
  FINAL_HANDOFF_DONE_CHOICE,
} from '../final-handoff-prompts.ts'
import { MOBILE_APP_URL } from '../final-handoff-config.ts'

let setup: FinalHandoffTestSetup

beforeEach(() => {
  setup = setupFinalHandoffTest()
})

afterEach(() => {
  setup.cleanup()
})

describe('routeFinalHandoffFreeform — pure classifier', () => {
  test('initial shape: "mobile" / "app" / "ios" → mobile-app', () => {
    expect(routeFinalHandoffFreeform('mobile', 'initial')).toBe(
      FINAL_HANDOFF_MOBILE_APP_CHOICE,
    )
    expect(routeFinalHandoffFreeform('show me the app', 'initial')).toBe(
      FINAL_HANDOFF_MOBILE_APP_CHOICE,
    )
    expect(routeFinalHandoffFreeform('iOS please', 'initial')).toBe(
      FINAL_HANDOFF_MOBILE_APP_CHOICE,
    )
  })

  test('initial shape: "telegram" / "tg" / "bot" → telegram-bind', () => {
    expect(routeFinalHandoffFreeform('telegram', 'initial')).toBe(
      FINAL_HANDOFF_TELEGRAM_BIND_CHOICE,
    )
    expect(routeFinalHandoffFreeform('connect the bot', 'initial')).toBe(
      FINAL_HANDOFF_TELEGRAM_BIND_CHOICE,
    )
  })

  test('initial shape: "skip" / "later" / "not now" → skip', () => {
    expect(routeFinalHandoffFreeform('skip', 'initial')).toBe(
      FINAL_HANDOFF_SKIP_CHOICE,
    )
    expect(routeFinalHandoffFreeform('later', 'initial')).toBe(
      FINAL_HANDOFF_SKIP_CHOICE,
    )
    expect(routeFinalHandoffFreeform('not now thanks', 'initial')).toBe(
      FINAL_HANDOFF_SKIP_CHOICE,
    )
  })

  test('initial shape: ambiguous text returns null', () => {
    expect(routeFinalHandoffFreeform('hi', 'initial')).toBeNull()
    expect(routeFinalHandoffFreeform('what?', 'initial')).toBeNull()
    expect(routeFinalHandoffFreeform('', 'initial')).toBeNull()
  })

  test('mobile-app / telegram-bind follow-up shapes route "done" + ack words to Done', () => {
    expect(routeFinalHandoffFreeform('done', 'mobile-app')).toBe(
      FINAL_HANDOFF_DONE_CHOICE,
    )
    expect(routeFinalHandoffFreeform('thanks', 'telegram-bind')).toBe(
      FINAL_HANDOFF_DONE_CHOICE,
    )
    expect(routeFinalHandoffFreeform('installed', 'mobile-app')).toBe(
      FINAL_HANDOFF_DONE_CHOICE,
    )
  })

  test('skip shape never re-routes', () => {
    expect(routeFinalHandoffFreeform('mobile', 'skip')).toBeNull()
    expect(routeFinalHandoffFreeform('telegram', 'skip')).toBeNull()
  })
})

describe('engine: freeform on the initial handoff prompt routes to the right handler', () => {
  test('"mobile" → mobile-app follow-up containing MOBILE_APP_URL', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({ setup, wowDispatcher: rec.hook })
    await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
    })
    const before = setup.sentPrompts.length
    await sendHandoffFreeform({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      text: 'show me the mobile app',
      observed_at: 1_700_000_010_000,
    })
    expect(setup.sentPrompts.length).toBe(before + 1)
    const followup = setup.sentPrompts[before]!.prompt
    expect(followup.body).toContain(MOBILE_APP_URL)
    expect(followup.metadata?.['final_handoff_shape']).toBe('mobile-app')
  })

  test('"telegram" → telegram-bind follow-up containing t.me/<bot>?start=bind_<token>', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({
      setup,
      wowDispatcher: rec.hook,
      mintTelegramBindToken: async () => 'freeform-tok',
      telegramBotUsername: 'neutron_test_bot',
    })
    await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
    })
    const before = setup.sentPrompts.length
    await sendHandoffFreeform({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      text: 'telegram bot please',
      observed_at: 1_700_000_010_000,
    })
    expect(setup.sentPrompts.length).toBe(before + 1)
    const followup = setup.sentPrompts[before]!.prompt
    expect(followup.body).toContain(
      'https://t.me/neutron_test_bot?start=bind_freeform-tok',
    )
  })

  test('"skip" → skip-ack follow-up', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({ setup, wowDispatcher: rec.hook })
    await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
    })
    const before = setup.sentPrompts.length
    await sendHandoffFreeform({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      text: 'skip for now',
      observed_at: 1_700_000_010_000,
    })
    expect(setup.sentPrompts.length).toBe(before + 1)
    const followup = setup.sentPrompts[before]!.prompt
    expect(followup.metadata?.['final_handoff_shape']).toBe('skip')
  })

  test('ambiguous freeform is transcript-appended without a follow-up emit', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildFinalHandoffEngine({ setup, wowDispatcher: rec.hook })
    await walkToCompleted({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
    })
    const before = setup.sentPrompts.length
    await sendHandoffFreeform({
      setup,
      engine,
      project_slug: 'casey',
      user_id: 'u-1',
      topic_id: 'web:u-1',
      channel_kind: 'app-socket',
      text: 'what does any of this mean',
      observed_at: 1_700_000_010_000,
    })
    expect(setup.sentPrompts.length).toBe(before)
    const s = await setup.stateStore.get('casey', 'u-1')
    expect(s!.phase).toBe('completed')
  })
})
