/**
 * D3 (2026-07) — relocated from the dissolved `chat-bridge.test.ts` to sit
 * with its module `gateway/http/web-topic-id.ts` (extracted in R5 / audit
 * P1-2; its test had lingered in the chat-bridge suite).
 */

import { describe, expect, test } from 'bun:test'
import { webTopicId } from '../web-topic-id.ts'

describe('webTopicId', () => {
  test('returns stable web:<user_id> shape', () => {
    expect(webTopicId('u-1')).toBe('web:u-1')
    expect(webTopicId('alice@example.com')).toBe('web:alice@example.com')
  })
})
