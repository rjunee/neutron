/**
 * 2026-05-28 final-handoff sprint — Test 4.
 *
 * Spec: `[B] Connect a Telegram bot` tap mints an instance-scoped
 * Telegram-bind token via the engine dep + emits a follow-up containing
 * `https://t.me/<bot>?start=bind_<token>` (Codex review caught the
 * Telegram start-payload grammar requirement — colons are NOT allowed).
 * The phase stays at
 * `completed`.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'

import {
  buildFinalHandoffEngine,
  makeDispatchRecorder,
  setupFinalHandoffTest,
  tapHandoffChoice,
  walkToCompleted,
  type FinalHandoffTestSetup,
} from './final-handoff-test-helpers.ts'
import {
  FINAL_HANDOFF_TELEGRAM_BIND_CHOICE,
} from '../final-handoff-prompts.ts'

let setup: FinalHandoffTestSetup

beforeEach(() => {
  setup = setupFinalHandoffTest()
})

afterEach(() => {
  setup.cleanup()
})

describe('final-handoff [B] telegram-bind button', () => {
  test('mints token via engine dep + emits t.me/<bot>?start=bind_<token>', async () => {
    const rec = makeDispatchRecorder()
    const mintCalls: Array<{ project_slug: string; user_id: string }> = []
    const mint = mock(
      async (input: { project_slug: string; user_id: string }): Promise<string | null> => {
        mintCalls.push(input)
        return 'tok-abc-123'
      },
    )
    const engine = buildFinalHandoffEngine({
      setup,
      wowDispatcher: rec.hook,
      mintTelegramBindToken: mint,
      telegramBotUsername: 'neutron_test_bot',
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
      choice_value: FINAL_HANDOFF_TELEGRAM_BIND_CHOICE,
      observed_at: 1_700_000_010_000,
    })
    expect(setup.sentPrompts.length).toBe(before + 1)
    expect(mint).toHaveBeenCalledTimes(1)
    expect(mintCalls[0]?.project_slug).toBe('casey')
    expect(mintCalls[0]?.user_id).toBe('u-1')
    const followup = setup.sentPrompts[before]!.prompt
    expect(followup.body).toContain('https://t.me/neutron_test_bot?start=bind_tok-abc-123')
    expect(followup.metadata?.['final_handoff_shape']).toBe('telegram-bind')
    expect(followup.metadata?.['final_handoff_telegram_bind_link']).toBe(
      'https://t.me/neutron_test_bot?start=bind_tok-abc-123',
    )
    expect(followup.options.length).toBe(1)
    expect(followup.options[0]?.body.toLowerCase()).toContain('done')
    const s = await setup.stateStore.get('casey', 'u-1')
    expect(s!.phase).toBe('completed')
    expect(s!.phase_state['active_prompt_id']).toBe(followup.prompt_id)
  })

  test('mint failure (null return) falls back to a non-empty nonce so the URL still renders', async () => {
    const rec = makeDispatchRecorder()
    const mint = mock(async (): Promise<string | null> => null)
    const engine = buildFinalHandoffEngine({
      setup,
      wowDispatcher: rec.hook,
      mintTelegramBindToken: mint,
      telegramBotUsername: 'neutron_test_bot',
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
      choice_value: FINAL_HANDOFF_TELEGRAM_BIND_CHOICE,
      observed_at: 1_700_000_010_000,
    })
    expect(setup.sentPrompts.length).toBe(before + 1)
    const followup = setup.sentPrompts[before]!.prompt
    // URL still has a non-empty token tail so a user click doesn't 404.
    // Telegram start payload grammar: `[A-Za-z0-9_-]+`, max 64 chars
    // total. The leading `bind_` prefix is fine; the fallback token
    // must NOT introduce any disallowed character (colon, dot, plus,
    // etc.) or the bot would silently drop the payload.
    expect(followup.body).toMatch(/https:\/\/t\.me\/neutron_test_bot\?start=bind_[A-Za-z0-9_-]+/)
    expect(followup.body).not.toMatch(/start=bind_[^\s)]*[:./+=]/)
  })

  test('rejects a minted token that violates Telegram start-payload grammar (JWT with dots) and falls back to nonce', async () => {
    const rec = makeDispatchRecorder()
    const jwtLike = 'eyJhbGciOi.eyJ0ZW5hbnQiOi.signature' // 36 chars but contains dots
    const mint = mock(async (): Promise<string | null> => jwtLike)
    const engine = buildFinalHandoffEngine({
      setup,
      wowDispatcher: rec.hook,
      mintTelegramBindToken: mint,
      telegramBotUsername: 'neutron_test_bot',
    })
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
      choice_value: FINAL_HANDOFF_TELEGRAM_BIND_CHOICE,
      observed_at: 1_700_000_010_000,
    })
    const followup = setup.sentPrompts[setup.sentPrompts.length - 1]!.prompt
    // The URL must NOT contain the rejected JWT (which had dots).
    expect(followup.body).not.toContain(jwtLike)
    // Whatever token did land must be grammar-clean.
    const match = followup.body.match(/start=bind_([^\s)]+)/)
    expect(match).not.toBeNull()
    const token = match![1]!
    expect(token.length).toBeGreaterThan(0)
    expect(token.length).toBeLessThanOrEqual(58)
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true)
  })
})
