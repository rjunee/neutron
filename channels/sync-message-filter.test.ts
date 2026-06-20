import { describe, expect, test } from 'bun:test'
import {
  SelfEchoFilter,
  hashText,
} from './adapters/telegram/sync-message-filter.ts'

describe('SelfEchoFilter', () => {
  test('flags a recently-sent message as a self-echo (and consumes it)', () => {
    const filter = new SelfEchoFilter({ now: () => 1000 })
    filter.recordSent({
      message_id: 'm1',
      channel_topic_id: 'chat:thread',
      text_hash: hashText('hello'),
      sent_at: 1000,
    })
    expect(filter.size()).toBe(1)
    expect(filter.isSelfEcho({ channel_topic_id: 'chat:thread', text_hash: hashText('hello') })).toBe(true)
    // consumed
    expect(filter.isSelfEcho({ channel_topic_id: 'chat:thread', text_hash: hashText('hello') })).toBe(false)
  })

  test('different topic_id never matches', () => {
    const filter = new SelfEchoFilter({ now: () => 1000 })
    filter.recordSent({
      message_id: 'm1',
      channel_topic_id: 'chatA',
      text_hash: hashText('hello'),
      sent_at: 1000,
    })
    expect(filter.isSelfEcho({ channel_topic_id: 'chatB', text_hash: hashText('hello') })).toBe(false)
  })

  test('expires entries past TTL', () => {
    let now = 1000
    const filter = new SelfEchoFilter({ ttl_ms: 100, now: () => now })
    filter.recordSent({
      message_id: 'm1',
      channel_topic_id: 'chat',
      text_hash: hashText('hi'),
      sent_at: 1000,
    })
    now = 2000
    expect(filter.isSelfEcho({ channel_topic_id: 'chat', text_hash: hashText('hi') })).toBe(false)
  })

  test('match by message_id when provided', () => {
    const filter = new SelfEchoFilter({ now: () => 1000 })
    filter.recordSent({
      message_id: 'm1',
      channel_topic_id: 'chat',
      text_hash: hashText('hi'),
      sent_at: 1000,
    })
    expect(
      filter.isSelfEcho({
        channel_topic_id: 'chat',
        text_hash: hashText('different'),
        message_id: 'm1',
      }),
    ).toBe(true)
  })

  test('hashText is deterministic', () => {
    expect(hashText('a')).toBe(hashText('a'))
    expect(hashText('abc')).not.toBe(hashText('abd'))
    // 8-char hex string
    expect(hashText('hello')).toMatch(/^[0-9a-f]{8}$/)
  })
})
