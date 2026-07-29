/**
 * D3 (2026-07) — relocated from the dissolved `chat-bridge.test.ts` to sit
 * with its module `gateway/http/routed-senders.ts` (the channel-agnostic
 * routed onboarding senders split out of the chat-bridge cluster).
 */

import { describe, expect, test } from 'bun:test'
import {
  buildRoutedSendButtonPrompt,
  buildRoutedSendImportProgress,
  type SendImportProgressArgs,
} from '../routed-senders.ts'
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
    const result = await send({ owner_slug: 'alice', topic_id: 'web:u-1', prompt: samplePrompt })
    expect(result.was_new).toBe(true)
    expect(received).toHaveLength(1)
    const first = received[0]
    if (first === undefined || first.type !== 'agent_message') throw new Error('expected agent_message')
    expect(first.body).toBe('Body')
  })
  test('returns was_new=false when web sender missing', async () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const send = buildRoutedSendButtonPrompt({ webRegistry: reg })
    const result = await send({ owner_slug: 'alice', topic_id: 'web:u-missing', prompt: samplePrompt })
    expect(result.was_new).toBe(false)
  })
  test('routes tg:<chat> to telegramSender when supplied', async () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const calls: Array<{ owner_slug: string; topic_id: string; prompt: ButtonPrompt }> = []
    const tg = async (input: { owner_slug: string; topic_id: string; prompt: ButtonPrompt }) => {
      calls.push(input)
      return { message_id: 'tg-msg-1', was_new: true }
    }
    const send = buildRoutedSendButtonPrompt({ webRegistry: reg, telegramSender: tg })
    const result = await send({ owner_slug: 'alice', topic_id: 'tg:123:5', prompt: samplePrompt })
    expect(calls).toHaveLength(1)
    // The forwarded request must be threaded through verbatim — a routing
    // bug that swapped owner_slug / topic_id / prompt would pass a
    // call-count-only assertion. Pin the exact payload incl. the threaded
    // `tg:123:5` (chat_id:thread_id) topic boundary.
    expect(calls[0]).toEqual({ owner_slug: 'alice', topic_id: 'tg:123:5', prompt: samplePrompt })
    expect(result.was_new).toBe(true)
    expect(result.message_id).toBe('tg-msg-1')
  })
  test('routes app:<user> to the composer-supplied app-socket holder + returns its result', async () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const calls: Array<{ owner_slug: string; topic_id: string; prompt: ButtonPrompt }> = []
    const appSocketRouter = {
      send: async (input: { owner_slug: string; topic_id: string; prompt: ButtonPrompt }) => {
        calls.push(input)
        return { message_id: 'app-msg-1', was_new: true }
      },
    }
    const send = buildRoutedSendButtonPrompt({ webRegistry: reg, appSocketRouter })
    const result = await send({ owner_slug: 'alice', topic_id: 'app:u-1', prompt: samplePrompt })
    expect(calls).toEqual([{ owner_slug: 'alice', topic_id: 'app:u-1', prompt: samplePrompt }])
    expect(result).toEqual({ message_id: 'app-msg-1', was_new: true })
  })
  test('app:<user> with no app-socket holder wired returns was_new=false (engine retries)', async () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const send = buildRoutedSendButtonPrompt({ webRegistry: reg })
    const result = await send({ owner_slug: 'alice', topic_id: 'app:u-1', prompt: samplePrompt })
    expect(result.was_new).toBe(false)
  })
  test('returns was_new=false for unknown topic prefix', async () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const send = buildRoutedSendButtonPrompt({ webRegistry: reg })
    const result = await send({ owner_slug: 'alice', topic_id: 'cli:123', prompt: samplePrompt })
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
    const orig_log = console.log
    const cap = (...args: unknown[]): void => {
      captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    }
    // The logger's default sink routes info→console.log; capture both.
    console.info = cap
    console.log = cap
    try {
      const send = buildRoutedSendButtonPrompt({ webRegistry: reg })
      await send({ owner_slug: 'alice', topic_id: 'web:u-leak', prompt: leakyPrompt })
    } finally {
      console.info = orig_info
      console.log = orig_log
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

describe('buildRoutedSendImportProgress', () => {
  const sampleEvent: SendImportProgressArgs['event'] = {
    type: 'import_progress',
    job_id: 'job-1',
    status: 'pass1-running',
    pass: 1,
    pct: 42.5,
    chunks_total_known: true,
  }
  test('routes web:<user> to the web registry + returns delivered=true with the event forwarded verbatim', async () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const received: ChatOutbound[] = []
    reg.register('web:u-1', (e) => received.push(e))
    const send = buildRoutedSendImportProgress({ webRegistry: reg })
    const result = await send({ owner_slug: 'alice', topic_id: 'web:u-1', event: sampleEvent })
    expect(result).toEqual({ delivered: true })
    // The UI-only import_progress envelope is passed through unmodified.
    expect(received).toEqual([sampleEvent])
  })
  test('returns delivered=false when no web sender is registered', async () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const send = buildRoutedSendImportProgress({ webRegistry: reg })
    const result = await send({ owner_slug: 'alice', topic_id: 'web:u-missing', event: sampleEvent })
    expect(result).toEqual({ delivered: false })
  })
  test('routes app:<user> to the composer-supplied holder + returns its result', async () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const calls: SendImportProgressArgs[] = []
    const appSocketRouter = {
      send: async (input: SendImportProgressArgs) => {
        calls.push(input)
        return { delivered: true }
      },
    }
    const send = buildRoutedSendImportProgress({ webRegistry: reg, appSocketRouter })
    const result = await send({ owner_slug: 'alice', topic_id: 'app:u-1', event: sampleEvent })
    expect(calls).toEqual([{ owner_slug: 'alice', topic_id: 'app:u-1', event: sampleEvent }])
    expect(result).toEqual({ delivered: true })
  })
  test('app:<user> with no holder wired drops silently (delivered=false)', async () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const send = buildRoutedSendImportProgress({ webRegistry: reg })
    const result = await send({ owner_slug: 'alice', topic_id: 'app:u-1', event: sampleEvent })
    expect(result).toEqual({ delivered: false })
  })
  test('tg:<chat> drops silently — no telegram progress channel (delivered=false, no warn)', async () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const warns: string[] = []
    const orig_warn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    }
    try {
      const send = buildRoutedSendImportProgress({ webRegistry: reg })
      const result = await send({ owner_slug: 'alice', topic_id: 'tg:123:5', event: sampleEvent })
      expect(result).toEqual({ delivered: false })
    } finally {
      console.warn = orig_warn
    }
    // Telegram is a KNOWN silent-drop channel for progress — it must NOT
    // warn (only genuinely-unknown prefixes warn).
    expect(warns.join('\n')).not.toContain('event=drop')
  })
  test('unknown topic prefix drops with a warn (delivered=false)', async () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const warns: string[] = []
    const orig_warn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    }
    try {
      const send = buildRoutedSendImportProgress({ webRegistry: reg })
      const result = await send({ owner_slug: 'alice', topic_id: 'cli:123', event: sampleEvent })
      expect(result).toEqual({ delivered: false })
    } finally {
      console.warn = orig_warn
    }
    const all_warns = warns.join('\n')
    expect(all_warns).toContain('event=drop')
    expect(all_warns).toContain('reason=unknown-channel')
    expect(all_warns).toContain('job=job-1')
  })
})
