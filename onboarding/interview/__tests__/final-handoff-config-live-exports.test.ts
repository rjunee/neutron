// K11b1 survivor — the LIVE exports of `final-handoff-config.ts` outlived the
// conversational drive. `buildTelegramBindDeepLink` + `TELEGRAM_BIND_TOKEN_TTL_MS`
// are consumed by the agent-settings Core backend (`cores/free/agent-settings/
// src/backend.ts`), `MOBILE_APP_URL` is re-exported by `landing/server.ts`, and
// `resolveTelegramBotUsername` is read by the telegram webhook — none of them die
// with K11b1's drive excision. Their prior coverage lived only in the deleted
// final-handoff prompt-drive suites, so this file re-pins them engine-free.
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TELEGRAM_BOT_USERNAME,
  MOBILE_APP_URL,
  TELEGRAM_BIND_START_PAYLOAD_PREFIX,
  TELEGRAM_BIND_TOKEN_TTL_MS,
  buildTelegramBindDeepLink,
  resolveTelegramBotUsername,
} from '../final-handoff-config.ts'

describe('final-handoff-config live exports (post-K11b1)', () => {
  test('TELEGRAM_BIND_TOKEN_TTL_MS is a 1-hour window', () => {
    expect(TELEGRAM_BIND_TOKEN_TTL_MS).toBe(60 * 60 * 1_000)
  })

  test('resolveTelegramBotUsername falls back to the default when unset/blank', () => {
    expect(resolveTelegramBotUsername({})).toBe(DEFAULT_TELEGRAM_BOT_USERNAME)
    expect(resolveTelegramBotUsername({ NEUTRON_TELEGRAM_BOT_USERNAME: '' })).toBe(
      DEFAULT_TELEGRAM_BOT_USERNAME,
    )
    expect(resolveTelegramBotUsername({ NEUTRON_TELEGRAM_BOT_USERNAME: '   ' })).toBe(
      DEFAULT_TELEGRAM_BOT_USERNAME,
    )
  })

  test('resolveTelegramBotUsername strips a leading @ and trims', () => {
    expect(resolveTelegramBotUsername({ NEUTRON_TELEGRAM_BOT_USERNAME: '@my_bot' })).toBe('my_bot')
    expect(resolveTelegramBotUsername({ NEUTRON_TELEGRAM_BOT_USERNAME: '  spaced_bot  ' })).toBe(
      'spaced_bot',
    )
  })

  test('buildTelegramBindDeepLink builds a t.me start-payload URL carrying the bind token', () => {
    const url = buildTelegramBindDeepLink({ bot_username: 'neutron_assistant_bot', bind_token: 'abc123' })
    expect(url).toBe(`https://t.me/neutron_assistant_bot?start=${TELEGRAM_BIND_START_PAYLOAD_PREFIX}abc123`)
    expect(url.startsWith('https://t.me/')).toBe(true)
    expect(url).toContain('abc123')
  })

  test('MOBILE_APP_URL is empty or a /mobile suffix (never a bare base)', () => {
    expect(MOBILE_APP_URL === '' || MOBILE_APP_URL.endsWith('/mobile')).toBe(true)
  })
})
