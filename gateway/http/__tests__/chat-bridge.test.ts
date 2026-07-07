/**
 * K11b0 survivor tests for gateway/http/chat-bridge.ts — the RETAINED
 * production symbols after the dead `/ws/chat` ChatBridge factory was
 * excised: `webTopicId`, `renderButtonPromptForWeb`,
 * `InMemoryWebChatSenderRegistry`, and `buildRoutedSendButtonPrompt`.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildRoutedSendButtonPrompt,
  InMemoryWebChatSenderRegistry,
  renderButtonPromptForWeb,
  webTopicId,
  type WebChatSenderRegistry,
} from '../chat-bridge.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import type { ChatOutbound } from '../../../landing/server.ts'

describe('webTopicId', () => {
  test('returns stable web:<user_id> shape', () => {
    expect(webTopicId('u-1')).toBe('web:u-1')
    expect(webTopicId('alice@example.com')).toBe('web:alice@example.com')
  })
})

describe('renderButtonPromptForWeb', () => {
  test('maps ButtonPrompt → ChatOutbound preserving options', () => {
    const prompt: ButtonPrompt = {
      prompt_id: '00000000-0000-4000-8000-000000000001',
      body: 'Pick one',
      options: [
        { label: 'A', body: 'Continue', value: 'continue' },
        { label: 'B', body: 'Skip', value: 'skip' },
      ],
      allow_freeform: true,
    }
    const out = renderButtonPromptForWeb(prompt)
    if (out.type !== 'agent_message') throw new Error(`expected agent_message; got ${out.type}`)
    expect(out.body).toBe('Pick one')
    expect(out.prompt_id).toBe('00000000-0000-4000-8000-000000000001')
    expect(out.options).toEqual([
      { label: 'A', body: 'Continue', value: 'continue' },
      { label: 'B', body: 'Skip', value: 'skip' },
    ])
    expect(out.allow_freeform).toBe(true)
    // Legacy plain-button prompts MUST omit the kind on the wire so
    // existing web clients keep rendering the keyboard unchanged.
    expect(out.kind).toBeUndefined()
  })

  test('Sprint 28 — propagates kind + per-option image_url for image-gallery (Codex r4 P1)', () => {
    const prompt: ButtonPrompt = {
      prompt_id: '00000000-0000-4000-8000-000000000002',
      body: "Pick your agent's portrait.",
      options: [
        { label: 'A', body: 'Portrait 1', value: 'cand-A', image_url: '/profile-pic/candidate/cand-A.png' },
        { label: 'B', body: 'Skip portrait', value: 'skip-portrait' },
      ],
      allow_freeform: false,
      kind: 'image-gallery',
    }
    const out = renderButtonPromptForWeb(prompt)
    if (out.type !== 'agent_message') throw new Error(`expected agent_message; got ${out.type}`)
    expect(out.kind).toBe('image-gallery')
    const opts = out.options ?? []
    expect(opts[0]?.image_url).toBe('/profile-pic/candidate/cand-A.png')
    expect(opts[1]?.image_url).toBeUndefined()
  })

  // P2 v2 § 6.2 (S4) — a valid single-source upload affordance is
  // propagated so the web client renders the upload bar.
  test('propagates a valid chatgpt upload_affordance', () => {
    const prompt: ButtonPrompt = {
      prompt_id: '00000000-0000-4000-8000-000000000003',
      body: 'Drag your ChatGPT export ZIP.',
      options: [{ label: 'A', body: 'Skip the import', value: 'skip' }],
      allow_freeform: true,
      metadata: { upload_affordance: { source: 'chatgpt' } },
    }
    const out = renderButtonPromptForWeb(prompt)
    if (out.type !== 'agent_message') throw new Error('expected agent_message')
    expect(out.upload_affordance).toEqual({ source: 'chatgpt' })
  })

  // remove-both-import-option (2026-06-06, Codex r1) — a stored prompt
  // EMITTED before this deploy in the removed two-upload 'both' flow
  // persisted `{source:'both'}`. On a post-deploy reconnect the gateway
  // REPLAYS that envelope verbatim. The narrowed render must NOT drop the
  // affordance (hiding the upload bar while the body asks for a ZIP = a
  // deploy-window dead-end) — it NORMALIZES legacy 'both' to 'chatgpt'
  // (the same single-source fallback the rebuild path uses).
  test("normalizes a legacy 'both' upload_affordance to chatgpt (deploy-window replay)", () => {
    const prompt: ButtonPrompt = {
      prompt_id: '00000000-0000-4000-8000-000000000004',
      body: 'Drag your export ZIP.',
      options: [{ label: 'A', body: 'Skip the import', value: 'skip' }],
      allow_freeform: true,
      metadata: { upload_affordance: { source: 'both' } },
    }
    const out = renderButtonPromptForWeb(prompt)
    if (out.type !== 'agent_message') throw new Error('expected agent_message')
    // Affordance preserved (NOT dropped) and normalized to a valid source.
    expect(out.upload_affordance).toEqual({ source: 'chatgpt' })
  })

  // Unrecognised / malformed affordance sources are still dropped.
  test('drops an unrecognised upload_affordance source', () => {
    const prompt: ButtonPrompt = {
      prompt_id: '00000000-0000-4000-8000-000000000005',
      body: 'Body',
      options: [],
      allow_freeform: true,
      metadata: { upload_affordance: { source: 'gemini' } },
    }
    const out = renderButtonPromptForWeb(prompt)
    if (out.type !== 'agent_message') throw new Error('expected agent_message')
    expect(out.upload_affordance).toBeUndefined()
  })
})

describe('InMemoryWebChatSenderRegistry', () => {
  test('register + send delivers to the registered callback', () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const sent: ChatOutbound[] = []
    reg.register('web:u-1', (e) => sent.push(e))
    const ok = reg.send('web:u-1', { type: 'agent_message', body: 'hi' })
    expect(ok).toBe(true)
    expect(sent).toHaveLength(1)
    const first = sent[0]
    if (first === undefined || first.type !== 'agent_message') throw new Error('expected agent_message')
    expect(first.body).toBe('hi')
  })
  test('send returns false when no sender is registered', () => {
    const reg = new InMemoryWebChatSenderRegistry()
    expect(reg.send('web:u-missing', { type: 'agent_message', body: 'hi' })).toBe(false)
  })
  test('register replaces a stale sender on reconnect', () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const first: ChatOutbound[] = []
    const second: ChatOutbound[] = []
    reg.register('web:u-1', (e) => first.push(e))
    reg.register('web:u-1', (e) => second.push(e))
    reg.send('web:u-1', { type: 'agent_message', body: 'hi' })
    expect(first).toHaveLength(0)
    expect(second).toHaveLength(1)
  })
  test('unregister removes the sender when ref matches', () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const sendFn = (): void => {}
    reg.register('web:u-1', sendFn)
    reg.unregister('web:u-1', sendFn)
    expect(reg.send('web:u-1', { type: 'agent_message', body: 'hi' })).toBe(false)
  })
  test('unregister is a no-op when a different sender is currently registered (identity-aware — Argus Sprint 18 r1 BLOCKING)', () => {
    // Replay-loser / old-socket scenario: tap A registers, tap B replaces
    // (concurrent reconnect or race-loser overwrite), then tap A's
    // catch-path or close-fire calls unregister. The new winner B's
    // sender must survive.
    const reg = new InMemoryWebChatSenderRegistry()
    const sentA: ChatOutbound[] = []
    const sentB: ChatOutbound[] = []
    const sendA = (e: ChatOutbound): void => {
      sentA.push(e)
    }
    const sendB = (e: ChatOutbound): void => {
      sentB.push(e)
    }
    reg.register('web:u-1', sendA)
    reg.register('web:u-1', sendB) // newer registration wins
    // Old/loser tries to unregister with its own send ref — must be a
    // no-op so the winner B keeps its routing.
    reg.unregister('web:u-1', sendA)
    expect(reg.send('web:u-1', { type: 'agent_message', body: 'hi' })).toBe(true)
    expect(sentB).toHaveLength(1)
    expect(sentA).toHaveLength(0)
  })
  test('unregister with stale ref after current sender already gone is a no-op', () => {
    const reg = new InMemoryWebChatSenderRegistry()
    const sendA = (): void => {}
    reg.register('web:u-1', sendA)
    reg.unregister('web:u-1', sendA)
    // Calling unregister again with the same stale ref is harmless.
    reg.unregister('web:u-1', sendA)
    expect(reg.send('web:u-1', { type: 'agent_message', body: 'x' })).toBe(false)
  })
})

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

