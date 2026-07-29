import { describe, expect, test } from 'bun:test'
import {
  KNOWN_PLATFORM_HINTS,
  getPlatformHint,
  selectPlatformHints,
} from './platform-hints.ts'

describe('platform-hints', () => {
  test('every named hint resolves to a non-empty body', () => {
    for (const name of KNOWN_PLATFORM_HINTS) {
      const body = getPlatformHint(name)
      expect(body.length).toBeGreaterThan(0)
    }
  })

  test('telegram channel returns the locked Telegram hint set', () => {
    const hints = selectPlatformHints('telegram')
    expect(hints).toContain('telegram_message_format')
    expect(hints).toContain('telegram_length_limit')
    expect(hints).not.toContain('cli_no_emoji_default')
  })

  test('cli channel returns the locked CLI hint set', () => {
    const hints = selectPlatformHints('cli')
    expect(hints).toContain('cli_no_emoji_default')
    expect(hints).toContain('cli_streaming_chunks')
  })

  test('email channel includes the no-em-dash rule', () => {
    const hints = selectPlatformHints('email')
    expect(hints).toContain('email_no_em_dash')
  })

  test('discord and slack channels return the locked sets', () => {
    expect(selectPlatformHints('discord')).toEqual(['discord_embed_format', 'discord_thread_context'])
    expect(selectPlatformHints('slack')).toEqual(['slack_block_kit', 'slack_thread_ts'])
  })

  test('web channel returns just the html-safety hint', () => {
    expect(selectPlatformHints('web')).toEqual(['web_html_safe'])
  })
})
