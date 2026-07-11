/**
 * D3 (2026-07) — relocated from the dissolved `chat-bridge.test.ts` to sit
 * with its module `gateway/http/routed-senders.ts` (the channel-agnostic
 * routed onboarding senders split out of the chat-bridge cluster).
 */

import { describe, expect, test } from 'bun:test'
import { buildRoutedSendButtonPrompt } from '../routed-senders.ts'
import { InMemoryWebChatSenderRegistry } from '../chat-sender-registry.ts'
import type { ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import type { ChatOutbound } from '@neutronai/landing/chat-protocol.ts'

describe('buildRoutedSendButtonPrompt', () => {
  const samplePrompt: ButtonPrompt = {
    prompt_id: '00000000-0000-4000-8000-000000000010',
    body: 'Body',
    options: [{ label: 'A', body: 'A', value: 'a' }],
    allow_freeform: false,
  }
  test('routes web:<user> to webRegistry', async () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const received: ChatOutbound[] = []
    reg.register('web:u-1', (e) => received.push(e))
    const send = buildRoutedSendButtonPrompt({ webRegistry: reg })
    const result = await send({ project_slug: 'alice', topic_id: 'web:u-1', prompt: samplePrompt })
    expect(result.was_new).toBe(true)
    expect(received).toHaveLength(1)
    const first = received[0]
    if (first === undefined || first.type !== 'agent_message') throw new Error('expected agent_message')
    expect(first.body).toBe('Body')
  })
  test('returns was_new=false when web sender missing', async () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const send = buildRoutedSendButtonPrompt({ webRegistry: reg })
    const result = await send({ project_slug: 'alice', topic_id: 'web:u-missing', prompt: samplePrompt })
    expect(result.was_new).toBe(false)
  })
  test('routes tg:<chat> to telegramSender when supplied', async () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const calls: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }> = []
    const tg = async (input: { project_slug: string; topic_id: string; prompt: ButtonPrompt }) => {
      calls.push(input)
      return { message_id: 'tg-msg-1', was_new: true }
    }
    const send = buildRoutedSendButtonPrompt({ webRegistry: reg, telegramSender: tg })
    const result = await send({ project_slug: 'alice', topic_id: 'tg:123:5', prompt: samplePrompt })
    expect(calls).toHaveLength(1)
    expect(result.was_new).toBe(true)
    expect(result.message_id).toBe('tg-msg-1')
  })
  test('returns was_new=false for unknown topic prefix', async () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const send = buildRoutedSendButtonPrompt({ webRegistry: reg })
    const result = await send({ project_slug: 'alice', topic_id: 'cli:123', prompt: samplePrompt })
    expect(result.was_new).toBe(false)
  })
  test('T10 r4 (Codex P1) — user-derived body bytes never enter the log line; log carries only length + sha8 fingerprint', async () => {
    // Re-emit branches (e.g. reEmitImportOfferedPaste) echo user-pasted
    // freeform text into prompt.body. The structural rule: NO body bytes
    // in journalctl, ever. This test pins the rule so any future
    // "let's just add the first N chars back for debugging" regression
    // is caught at test time, not at prod-leak time.
    const reg = new InMemoryWebChatSenderRegistry()
    reg.register('web:u-leak', () => {})
    const secret = 'secret-pasted-content-xyzzy-https://attacker.example/private-doc'
    const leakyPrompt: ButtonPrompt = {
      prompt_id: '00000000-0000-4000-8000-00000000abcd',
      body: `Paste-rejected — try again. You sent: "${secret}"`,
      options: [{ label: 'Skip', body: 'Skip', value: 'skip' }],
      allow_freeform: true,
    }
    const captured: string[] = []
    const orig_info = console.info
    console.info = (...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    }
    try {
      const send = buildRoutedSendButtonPrompt({ webRegistry: reg })
      await send({ project_slug: 'alice', topic_id: 'web:u-leak', prompt: leakyPrompt })
    } finally {
      console.info = orig_info
    }
    expect(captured.length).toBeGreaterThan(0)
    const all_logs = captured.join('\n')
    // The whole secret must be gone…
    expect(all_logs).not.toContain('xyzzy')
    expect(all_logs).not.toContain('attacker.example')
    expect(all_logs).not.toContain('secret-pasted-content')
    // …and so must any 16+ char substring of the body (defends against
    // a future "first 80 chars" or "first 20 chars" regression — even a
    // short prefix from a known body shape is a leak).
    for (let i = 0; i + 16 <= leakyPrompt.body.length; i++) {
      const window = leakyPrompt.body.slice(i, i + 16)
      // Skip windows that are pure whitespace / punctuation noise; the
      // structural test is "no body-shaped substring", not "no quote
      // characters appear anywhere". A 16-char alphanumeric window is
      // unambiguous body content.
      if (!/[A-Za-z]{6,}/.test(window)) continue
      expect(all_logs).not.toContain(window)
    }
    // Positive checks: the log MUST still carry the diagnostic fields
    // operators rely on (prompt_id, delivered, options count, fingerprint).
    expect(all_logs).toContain('prompt=00000000-0000-4000-8000-00000000abcd')
    expect(all_logs).toContain('delivered=true')
    expect(all_logs).toContain('options=1')
    expect(all_logs).toMatch(/body_len=\d+/)
    expect(all_logs).toMatch(/body_sha8=[0-9a-f]{8}/)
  })
})
