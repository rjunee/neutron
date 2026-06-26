/**
 * Tests for gateway/http/chat-bridge.ts — the production ChatBridge
 * factory + WebChatSenderRegistry that compose into createLandingServer.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPair, type KeyLike } from 'jose'
import {
  buildRoutedSendButtonPrompt,
  buildWebChatBridge,
  InMemoryWebChatSenderRegistry,
  renderButtonPromptForWeb,
  webTopicId,
  type WebChatSenderRegistry,
} from '../chat-bridge.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import { buildButtonPrompt } from '../../../channels/button-primitive.ts'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import {
  InMemoryConsumedTokens,
  issueStartToken,
  verifyStartToken,
  claimStartTokenJti,
  type ConsumedTokensStore,
  type StartTokenSigningKey,
  type StartTokenVerificationKey,
} from '@neutronai/runtime/__tests__/start-token-testkit.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import { InMemoryRecoveredReplyStore } from '../recovered-reply-store.ts'
import type { ChatOutbound } from '../../../landing/server.ts'
import type {
  AdvanceInput,
  AdvanceResult,
  InterviewEngine,
  StartInput,
  StartResult,
} from '../../../onboarding/interview/engine.ts'
import type { OnboardingState } from '../../../onboarding/interview/state-store.ts'

async function makeKeyPair(): Promise<{
  signing: StartTokenSigningKey
  verifying: StartTokenVerificationKey
}> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true })
  return {
    signing: { kid: 'kid-test', privateKey: privateKey as KeyLike },
    verifying: { kid: 'kid-test', publicKey: publicKey as KeyLike },
  }
}

function makeResolveKey(verifying: StartTokenVerificationKey): (kid: string) => Promise<KeyLike | null> {
  return async (kid) => (kid === verifying.kid ? verifying.publicKey : null)
}

/**
 * ISSUES #115 — the bridge now brackets every `engine.advance` /
 * `engine.start` with `agent_typing_start` + `agent_typing_end` envelopes
 * (the server-authoritative typing indicator). The routing / forwarding
 * tests below assert on BUSINESS envelopes (replies, errors, routing
 * probes), so strip the typing brackets before counting. Dedicated
 * coverage of the brackets themselves lives in
 * chat-bridge-typing-bracket.test.ts.
 */
function businessEnvelopes(arr: ChatOutbound[]): ChatOutbound[] {
  return arr.filter(
    (e) => e.type !== 'agent_typing_start' && e.type !== 'agent_typing_end',
  )
}

function makeFakeState(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    project_slug: overrides.project_slug ?? 'alice',
    user_id: overrides.user_id ?? 'test-user',
    phase: overrides.phase ?? 'signup',
    phase_state: overrides.phase_state ?? {},
    started_at: overrides.started_at ?? 0,
    last_advanced_at: overrides.last_advanced_at ?? 0,
    completed_at: overrides.completed_at ?? null,
    import_job_id: overrides.import_job_id ?? null,
    persona_files_committed: overrides.persona_files_committed ?? false,
    wow_fired: overrides.wow_fired ?? false,
    wow_pushed_at: overrides.wow_pushed_at ?? null,
    onboarding_handoff_emitted_at: overrides.onboarding_handoff_emitted_at ?? null,
    attempt_id: overrides.attempt_id ?? 'test-attempt',
  }
}

interface FakeEngine extends InterviewEngine {
  startCalls: StartInput[]
  advanceCalls: AdvanceInput[]
  startResult: StartResult
  advanceResult: AdvanceResult
  startThrows: Error | null
}

function makeFakeEngine(): FakeEngine {
  const startCalls: StartInput[] = []
  const advanceCalls: AdvanceInput[] = []
  const fakeState = makeFakeState()
  const startResult: StartResult = { prompt_id: 'pid-1', was_new: true, state: fakeState }
  const advanceResult: AdvanceResult = { outcome: 'advanced', state: fakeState }
  const eng = {
    startCalls,
    advanceCalls,
    startResult,
    advanceResult,
    startThrows: null,
    async start(input: StartInput): Promise<StartResult> {
      startCalls.push(input)
      if (eng.startThrows !== null) throw eng.startThrows
      return startResult
    },
    async advance(input: AdvanceInput): Promise<AdvanceResult> {
      advanceCalls.push(input)
      return advanceResult
    },
    // Methods unused by the bridge — stub for type compatibility.
    async acceptChoice() {
      throw new Error('not used in tests')
    },
    async tick(): Promise<void> {},
    async emitCurrentPhasePrompt(): Promise<AdvanceResult> {
      return advanceResult
    },
    // 2026-05-21 (Bug 2, v0.1.75) — pending-inbound marker. The chat-
    // bridge writes this BEFORE engine.advance so a racing reconnect
    // doesn't re-emit the active prompt over the user's typed reply.
    // No-op in this test harness — the unit tests for the gate itself
    // live in tests/integration/engine-reemit-pending-inbound-race-bug2.test.ts.
    async recordInboundReceived(): Promise<void> {},
  } as unknown as FakeEngine
  return eng
}

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

describe('buildWebChatBridge — validateStartToken', () => {
  test('returns null on empty / non-string token', async () => {
    const { verifying } = await makeKeyPair()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
    })
    expect(await bridge.validateStartToken({ start_token: '' })).toBeNull()
    expect(await bridge.validateStartToken({ start_token: 'not-a-jwt' })).toBeNull()
  })
  test('returns null on project_slug mismatch', async () => {
    const { signing, verifying } = await makeKeyPair()
    const minted = await issueStartToken({
      project_slug: 'bob',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
    })
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
    })
    expect(await bridge.validateStartToken({ start_token: minted.token })).toBeNull()
  })
  test('returns null when signup_via=telegram (web bridge rejects telegram-typed tokens)', async () => {
    const { signing, verifying } = await makeKeyPair()
    const minted = await issueStartToken({
      project_slug: 'alice',
      user_id: 'u-1',
      signup_via: 'telegram',
      signing_key: signing,
    })
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
    })
    expect(await bridge.validateStartToken({ start_token: minted.token })).toBeNull()
  })
  test('returns PendingChatClaim on a valid web-typed token', async () => {
    const { signing, verifying } = await makeKeyPair()
    const minted = await issueStartToken({
      project_slug: 'alice',
      user_id: 'u-42',
      signup_via: 'web',
      signing_key: signing,
    })
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
    })
    const claim = await bridge.validateStartToken({ start_token: minted.token })
    expect(claim).not.toBeNull()
    expect(claim?.project_slug).toBe('alice')
    expect(claim?.user_id).toBe('u-42')
    expect(claim?.jti).toBe(minted.jti)
  })
  test('does NOT claim the jti during validate (verify/claim split)', async () => {
    const { signing, verifying } = await makeKeyPair()
    const minted = await issueStartToken({
      project_slug: 'alice',
      user_id: 'u-7',
      signup_via: 'web',
      signing_key: signing,
    })
    const consumed = new InMemoryConsumedTokens()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: consumed,
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
    })
    await bridge.validateStartToken({ start_token: minted.token })
    // Calling validate twice still returns a claim — the jti is NOT yet
    // claimed (per Codex r1 P2 split — claim happens in startSession).
    const second = await bridge.validateStartToken({ start_token: minted.token })
    expect(second).not.toBeNull()
  })
})

describe('buildWebChatBridge — startSession (Codex Sprint 18 r1 P1: bootstrap-then-claim ordering)', () => {
  test('engine.start failure does NOT consume the jti — retry with same token still validates + bootstraps', async () => {
    const { signing, verifying } = await makeKeyPair()
    const minted = await issueStartToken({
      project_slug: 'alice',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
    })
    const consumed = new InMemoryConsumedTokens()
    const reg = new InMemoryWebChatSenderRegistry()
    const eng = makeFakeEngine()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: consumed,
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: reg,
    })

    // First attempt: engine.start throws (transient bootstrap failure).
    eng.startThrows = new Error('transient db lock')
    const claim1 = await bridge.validateStartToken({ start_token: minted.token })
    expect(claim1).not.toBeNull()
    let firstThrew: unknown = null
    try {
      await bridge.startSession({ claim: claim1!, send: () => {} })
    } catch (err) {
      firstThrew = err
    }
    expect(firstThrew).not.toBeNull()
    expect(eng.startCalls).toHaveLength(1)
    // Sender unregistered after the throw.
    expect(reg.send('web:u-1', { type: 'agent_message', body: 'x' })).toBe(false)

    // Second attempt: engine.start now succeeds (transient cleared).
    // Token jti is NOT yet consumed → validate still succeeds → claim
    // happens AFTER bootstrap so the token is finally burned.
    eng.startThrows = null
    const claim2 = await bridge.validateStartToken({ start_token: minted.token })
    expect(claim2).not.toBeNull()
    const ok = await bridge.startSession({ claim: claim2!, send: () => {} })
    expect(ok).toBe(true)
    expect(eng.startCalls).toHaveLength(2)

    // Third attempt: jti is now consumed; replay returns false.
    const claim3 = await bridge.validateStartToken({ start_token: minted.token })
    expect(claim3).not.toBeNull()
    expect(await bridge.startSession({ claim: claim3!, send: () => {} })).toBe(false)
  })

  test('atomically claims the jti AFTER engine.start succeeds, registers sender, calls engine.start', async () => {
    const { signing, verifying } = await makeKeyPair()
    const minted = await issueStartToken({
      project_slug: 'alice',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
    })
    const consumed = new InMemoryConsumedTokens()
    const reg = new InMemoryWebChatSenderRegistry()
    const eng = makeFakeEngine()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: consumed,
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: reg,
    })
    const claim = await bridge.validateStartToken({ start_token: minted.token })
    expect(claim).not.toBeNull()
    const sent: ChatOutbound[] = []
    const ok = await bridge.startSession({ claim: claim!, send: (e) => sent.push(e) })
    expect(ok).toBe(true)
    expect(eng.startCalls).toHaveLength(1)
    expect(eng.startCalls[0]?.project_slug).toBe('alice')
    expect(eng.startCalls[0]?.topic_id).toBe('web:u-1')
    expect(eng.startCalls[0]?.signup_via).toBe('web')
    expect(reg.send('web:u-1', { type: 'agent_message', body: 'ping' })).toBe(true)
  })

  test('returns false on jti replay — second startSession with same jti is denied', async () => {
    const { signing, verifying } = await makeKeyPair()
    const minted = await issueStartToken({
      project_slug: 'alice',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
    })
    const consumed = new InMemoryConsumedTokens()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: consumed,
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
    })
    const claim = await bridge.validateStartToken({ start_token: minted.token })
    expect(claim).not.toBeNull()
    expect(await bridge.startSession({ claim: claim!, send: () => {} })).toBe(true)
    // Re-validate (validate is idempotent — verify-only) then re-start.
    const claim2 = await bridge.validateStartToken({ start_token: minted.token })
    expect(claim2).not.toBeNull()
    expect(await bridge.startSession({ claim: claim2!, send: () => {} })).toBe(false)
  })
  test('engine.start failure unregisters the sender', async () => {
    const { signing, verifying } = await makeKeyPair()
    const minted = await issueStartToken({
      project_slug: 'alice',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
    })
    const reg = new InMemoryWebChatSenderRegistry()
    const eng = makeFakeEngine()
    eng.startThrows = new Error('boom')
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: reg,
    })
    const claim = await bridge.validateStartToken({ start_token: minted.token })
    let threw: unknown = null
    try {
      await bridge.startSession({ claim: claim!, send: () => {} })
    } catch (err) {
      threw = err
    }
    expect(threw).not.toBeNull()
    // Sender was unregistered after the throw — registry returns false.
    expect(reg.send('web:u-1', { type: 'agent_message', body: 'x' })).toBe(false)
  })
})

describe('buildWebChatBridge — handleInbound', () => {
  test('routes user_message to engine.advance with freeform_text', async () => {
    const { verifying } = await makeKeyPair()
    const eng = makeFakeEngine()
    const reg = new InMemoryWebChatSenderRegistry()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: reg,
    })
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: 'hello' },
      send: () => {},
    })
    expect(eng.advanceCalls).toHaveLength(1)
    expect(eng.advanceCalls[0]?.freeform_text).toBe('hello')
    expect(eng.advanceCalls[0]?.choice).toBeUndefined()
    expect(eng.advanceCalls[0]?.channel_kind).toBe('app-socket')
    expect(eng.advanceCalls[0]?.topic_id).toBe('web:u-1')
  })
  test('routes button_choice to engine.advance with ButtonChoice', async () => {
    const { verifying } = await makeKeyPair()
    const eng = makeFakeEngine()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: new InMemoryWebChatSenderRegistry(),
    })
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: {
        type: 'button_choice',
        prompt_id: '00000000-0000-4000-8000-000000000099',
        choice_value: 'continue',
        freeform_text: 'extra',
      },
      send: () => {},
    })
    expect(eng.advanceCalls).toHaveLength(1)
    expect(eng.advanceCalls[0]?.choice?.choice_value).toBe('continue')
    expect(eng.advanceCalls[0]?.choice?.freeform_text).toBe('extra')
    expect(eng.advanceCalls[0]?.choice?.channel_kind).toBe('app-socket')
  })

  // PR #331 Argus r4 BLOCKER (2026-05-29) — gateway-level FORBIDDEN_INBOUND_VALUES
  // reject. A crafted `button_choice` carrying a router-internal sentinel
  // (`__freeform__` / `__timeout__`) MUST be rejected at the bridge boundary
  // BEFORE forwarding to engine.advance — otherwise the prompt row's
  // `resolved_at` gets stamped by the inner buttonStore.resolve() and a
  // legitimate retap on the same prompt_id silently noops (was_new=false),
  // locking the user out for the prompt TTL. See r2/r3/r4 engine guards as
  // defense-in-depth; this is the canonical class-level fix.
  test('rejects button_choice with choice_value=__freeform__ at the gateway boundary (Argus r4 BLOCKER)', async () => {
    const { verifying } = await makeKeyPair()
    const eng = makeFakeEngine()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: new InMemoryWebChatSenderRegistry(),
    })
    const sent: ChatOutbound[] = []
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: {
        type: 'button_choice',
        prompt_id: '00000000-0000-4000-8000-000000000099',
        choice_value: '__freeform__',
        freeform_text: 'asdf',
      },
      send: (e) => sent.push(e),
    })
    // No engine forwarding — the reject fires before engine.advance.
    expect(eng.advanceCalls).toHaveLength(0)
    // Structured error envelope back to the client so the UI can
    // re-route (surface "type a reply" affordance).
    expect(sent).toHaveLength(1)
    const first = sent[0]
    if (first === undefined || first.type !== 'error') {
      throw new Error(`expected error envelope; got ${first?.type ?? 'nothing'}`)
    }
    expect(first.message).toMatch(/control/i)
  })

  test('rejects button_choice with choice_value=__timeout__ at the gateway boundary (Argus r4 BLOCKER)', async () => {
    const { verifying } = await makeKeyPair()
    const eng = makeFakeEngine()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: new InMemoryWebChatSenderRegistry(),
    })
    const sent: ChatOutbound[] = []
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: {
        type: 'button_choice',
        prompt_id: '00000000-0000-4000-8000-000000000099',
        choice_value: '__timeout__',
      },
      send: (e) => sent.push(e),
    })
    expect(eng.advanceCalls).toHaveLength(0)
    expect(sent).toHaveLength(1)
    const first = sent[0]
    if (first === undefined || first.type !== 'error') {
      throw new Error(`expected error envelope; got ${first?.type ?? 'nothing'}`)
    }
  })

  test('legit final-handoff button_choice (choice_value=final-mobile-app) still forwards to engine.advance', async () => {
    const { verifying } = await makeKeyPair()
    const eng = makeFakeEngine()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: new InMemoryWebChatSenderRegistry(),
    })
    const sent: ChatOutbound[] = []
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: {
        type: 'button_choice',
        prompt_id: '00000000-0000-4000-8000-000000000099',
        choice_value: 'final-mobile-app',
      },
      send: (e) => sent.push(e),
    })
    expect(eng.advanceCalls).toHaveLength(1)
    expect(eng.advanceCalls[0]?.choice?.choice_value).toBe('final-mobile-app')
    expect(businessEnvelopes(sent)).toHaveLength(0)
  })

  test('legit user_message with freeform_text still forwards to engine.advance (sentinel reject does NOT touch user_message path)', async () => {
    const { verifying } = await makeKeyPair()
    const eng = makeFakeEngine()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: new InMemoryWebChatSenderRegistry(),
    })
    const sent: ChatOutbound[] = []
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: 'hi' },
      send: (e) => sent.push(e),
    })
    expect(eng.advanceCalls).toHaveLength(1)
    expect(eng.advanceCalls[0]?.freeform_text).toBe('hi')
    expect(businessEnvelopes(sent)).toHaveLength(0)
  })

  test('closeSession unregisters the per-session sender (Codex Sprint 18 r1 P2)', async () => {
    const { signing, verifying } = await makeKeyPair()
    const minted = await issueStartToken({
      project_slug: 'alice',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
    })
    const reg = new InMemoryWebChatSenderRegistry()
    const eng = makeFakeEngine()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: reg,
    })
    const claim = await bridge.validateStartToken({ start_token: minted.token })
    expect(claim).not.toBeNull()
    const sendA = (): void => {}
    expect(await bridge.startSession({ claim: claim!, send: sendA })).toBe(true)
    // Sender is registered at this point.
    expect(reg.send('web:u-1', { type: 'agent_message', body: 'live' })).toBe(true)
    // Close the session — must pass the same send ref the bridge saw at
    // startSession (Argus Sprint 18 r1 BLOCKING — identity-aware).
    expect(bridge.closeSession).toBeDefined()
    await bridge.closeSession!({ project_slug: 'alice', user_id: 'u-1', send: sendA })
    // Sender is unregistered now — subsequent emits report no delivery.
    expect(reg.send('web:u-1', { type: 'agent_message', body: 'after-close' })).toBe(false)
  })

  test('Argus Sprint 18 r1 BLOCKING: old socket close-fire does NOT delete a newer reconnect sender', async () => {
    // Scenario: socket A opens, registers sender A. Socket A then
    // disconnects but its `close` event has not fired yet. Socket B
    // (reconnect for the SAME user_id, different start-token or fresh
    // page load) opens and re-registers with sender B. Now A's
    // close-fire reaches the bridge. Without identity-aware
    // unregister, A's close would delete the registry's `web:u-1`
    // entry — even though it currently points at B — and the live
    // socket B would silently lose all engine emits.
    const { signing, verifying } = await makeKeyPair()
    const mintedA = await issueStartToken({
      project_slug: 'alice',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
    })
    const reg = new InMemoryWebChatSenderRegistry()
    const eng = makeFakeEngine()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: reg,
    })
    const claimA = await bridge.validateStartToken({ start_token: mintedA.token })
    const sentA: ChatOutbound[] = []
    const sendA = (e: ChatOutbound): void => {
      sentA.push(e)
    }
    expect(await bridge.startSession({ claim: claimA!, send: sendA })).toBe(true)
    // Socket B reconnects (same user_id) before A's close fires. The
    // reconnect path is handleInbound — re-registers per Codex r5 P2.
    const sentB: ChatOutbound[] = []
    const sendB = (e: ChatOutbound): void => {
      sentB.push(e)
    }
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: 'hi from reconnect' },
      send: sendB,
    })
    // Now A's close-fire arrives — landing/server.ts threads A's send
    // ref through closeSession. Identity-aware unregister must NOT
    // delete the entry currently pointing at sendB.
    await bridge.closeSession!({ project_slug: 'alice', user_id: 'u-1', send: sendA })
    // Live emits still route to socket B.
    expect(reg.send('web:u-1', { type: 'agent_message', body: 'still alive' })).toBe(true)
    expect(businessEnvelopes(sentB)).toHaveLength(1)
    expect(businessEnvelopes(sentA)).toHaveLength(0)
  })

  test('Argus Sprint 18 r1 BLOCKING: concurrent-tap replay-loser does NOT delete winner registered last', async () => {
    // Race ordering pinned: tap B registers FIRST (so its register runs
    // before A's), tap A registers SECOND and overwrites the entry
    // with sendA. Tap A's claim resolves first → A wins. Tap B's
    // claim then throws → catch path runs unregister.
    //
    // Without identity-aware unregister: B's catch deletes the entry
    // (currently sendA) — the winner's socket loses routing and any
    // engine emits between this tick and A's next inbound vanish.
    //
    // With identity-aware unregister: B passes its own sendB ref;
    // entry == sendA != sendB → no-op → A's sender survives.
    const { signing, verifying } = await makeKeyPair()
    const minted = await issueStartToken({
      project_slug: 'alice',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
    })
    const consumed = new InMemoryConsumedTokens()
    const reg = new InMemoryWebChatSenderRegistry()

    // Build an engine whose `start()` returns a deferred so the test
    // controls the resolve order — pins which tap's claim races first.
    const startResolvers: Array<(v: StartResult) => void> = []
    const fakeState = makeFakeState()
    const startResult: StartResult = { prompt_id: 'pid-1', was_new: true, state: fakeState }
    const advanceResult: AdvanceResult = { outcome: 'advanced', state: fakeState }
    const startCalls: StartInput[] = []
    const eng = {
      startCalls,
      async start(input: StartInput): Promise<StartResult> {
        startCalls.push(input)
        return new Promise<StartResult>((resolve) => {
          startResolvers.push(resolve)
        })
      },
      async advance(): Promise<AdvanceResult> {
        return advanceResult
      },
      async acceptChoice(): Promise<AdvanceResult> {
        throw new Error('not used in this test')
      },
      async tick(): Promise<void> {},
      async emitCurrentPhasePrompt(): Promise<AdvanceResult> {
        return advanceResult
      },
    } as unknown as InterviewEngine

    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: consumed,
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: reg,
    })

    // Both taps validate the same minted token (verify-only is idempotent).
    const claimB = await bridge.validateStartToken({ start_token: minted.token })
    const claimA = await bridge.validateStartToken({ start_token: minted.token })
    expect(claimA).not.toBeNull()
    expect(claimB).not.toBeNull()

    const sentA: ChatOutbound[] = []
    const sendA = (e: ChatOutbound): void => {
      sentA.push(e)
    }
    const sentB: ChatOutbound[] = []
    const sendB = (e: ChatOutbound): void => {
      sentB.push(e)
    }

    // Trigger B's startSession FIRST (registers sendB, awaits engine.start).
    const bPromise = bridge.startSession({ claim: claimB!, send: sendB })
    // Yield so the synchronous prefix (register + first await) runs.
    await Promise.resolve()
    // Trigger A's startSession (registers sendA, overwrites entry = sendA).
    const aPromise = bridge.startSession({ claim: claimA!, send: sendA })
    await Promise.resolve()

    expect(startResolvers).toHaveLength(2)
    // Confirm registry currently holds sendA (the second register). Both
    // taps emitted an `agent_typing_start` before awaiting the deferred
    // engine.start, so filter to business envelopes for the routing check.
    expect(businessEnvelopes(sentA)).toHaveLength(0)
    expect(businessEnvelopes(sentB)).toHaveLength(0)
    reg.send('web:u-1', { type: 'agent_message', body: 'probe' })
    expect(businessEnvelopes(sentA)).toHaveLength(1)
    expect(businessEnvelopes(sentB)).toHaveLength(0)

    // Resolve A's engine.start first → A claims jti first → A wins.
    startResolvers[1]!(startResult)
    expect(await aPromise).toBe(true)

    // Resolve B's engine.start → B's claim throws (jti consumed) →
    // catch fires unregister(sendB). With identity-aware unregister
    // this is a no-op (entry == sendA != sendB).
    startResolvers[0]!(startResult)
    expect(await bPromise).toBe(false)

    // Winner survives: live emits still route to A.
    expect(reg.send('web:u-1', { type: 'agent_message', body: 'live' })).toBe(true)
    expect(businessEnvelopes(sentA)).toHaveLength(2) // probe + live
    expect(businessEnvelopes(sentB)).toHaveLength(0)
  })

  test('re-registers sender on every inbound (reconnect-safe)', async () => {
    const { verifying } = await makeKeyPair()
    const eng = makeFakeEngine()
    const reg = new InMemoryWebChatSenderRegistry()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: reg,
    })
    const first: ChatOutbound[] = []
    const second: ChatOutbound[] = []
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: 'a' },
      send: (e) => first.push(e),
    })
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: 'b' },
      send: (e) => second.push(e),
    })
    // After the second inbound, the registry's sender should be the
    // second handler — emit via registry confirms.
    reg.send('web:u-1', { type: 'agent_message', body: 'agent-reply' })
    expect(businessEnvelopes(first)).toHaveLength(0)
    expect(businessEnvelopes(second)).toHaveLength(1)
  })
})

describe('buildWebChatBridge — handleProjectTopicInbound cross-topic resolve guard (Argus r1 BLOCKER 1)', () => {
  // A project-topic-bound client must NOT be able to resolve a prompt
  // whose `topic_id` is the user's General topic (or another project's
  // topic). Without the peek-and-check guard added 2026-05-28, the
  // server resolved any prompt_id the client supplied — corrupting
  // onboarding state silently. These tests pin the guard in place.
  let tmp: string
  let db: ProjectDb
  let store: ButtonStore

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-cross-topic-resolve-'))
    db = ProjectDb.open(join(tmp, 'owner.db'))
    applyMigrations(db.raw())
    store = new ButtonStore({ db })
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('button_choice on project topic referencing a General-topic prompt is REJECTED and prompt stays unresolved', async () => {
    const { verifying } = await makeKeyPair()
    const generalTopic = webTopicId('u-1')
    const projectTopic = `${generalTopic}:project-a`

    // Seed an active prompt on the General topic.
    const generalPrompt = buildButtonPrompt({
      body: 'General onboarding question',
      options: [
        { label: 'A', body: 'Yes', value: 'yes' },
        { label: 'B', body: 'No', value: 'no' },
      ],
    })
    await store.emit(generalPrompt, { topic_id: generalTopic })

    const eng = makeFakeEngine()
    const reg = new InMemoryWebChatSenderRegistry()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: reg,
      buttonStore: store,
    })

    const sent: ChatOutbound[] = []
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      active_topic_id: projectTopic,
      event: {
        type: 'button_choice',
        // ATTACK: client tries to resolve the General prompt while
        // bound to the project-A topic.
        prompt_id: generalPrompt.prompt_id,
        choice_value: 'yes',
      },
      send: (e) => sent.push(e),
    })

    // The General prompt must remain unresolved.
    const peeked = await store.peek(generalPrompt.prompt_id)
    expect(peeked).not.toBeNull()
    expect(peeked!.resolved_at).toBeNull()
    expect(peeked!.resolution_value).toBeNull()
    expect(peeked!.topic_id).toBe(generalTopic)

    // The engine must NOT have been driven (project-topic inbound is
    // a stub that never invokes engine.advance).
    expect(eng.advanceCalls).toHaveLength(0)

    // Client must receive a structured `error` envelope so it can
    // re-route the user, not a silent acknowledgement.
    const errorEvent = sent.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
  })

  test('button_choice on project topic referencing the CORRECT project-topic prompt resolves normally', async () => {
    const { verifying } = await makeKeyPair()
    const generalTopic = webTopicId('u-1')
    const projectTopic = `${generalTopic}:project-a`

    // Seed the prompt on the project topic this time.
    const projectPrompt = buildButtonPrompt({
      body: 'Project seed prompt',
      options: [
        { label: 'A', body: 'Continue', value: 'continue' },
        { label: 'B', body: 'Pause', value: 'pause' },
      ],
    })
    await store.emit(projectPrompt, { topic_id: projectTopic })

    const eng = makeFakeEngine()
    const reg = new InMemoryWebChatSenderRegistry()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: reg,
      buttonStore: store,
    })

    const sent: ChatOutbound[] = []
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      active_topic_id: projectTopic,
      event: {
        type: 'button_choice',
        prompt_id: projectPrompt.prompt_id,
        choice_value: 'continue',
      },
      send: (e) => sent.push(e),
    })

    // Same-topic resolves through.
    const peeked = await store.peek(projectPrompt.prompt_id)
    expect(peeked).not.toBeNull()
    expect(peeked!.resolved_at).not.toBeNull()
    expect(peeked!.resolution_value).toBe('continue')

    // Client receives the stub agent acknowledgement (not an error).
    expect(sent.find((e) => e.type === 'error')).toBeUndefined()
    expect(sent.find((e) => e.type === 'agent_message')).toBeDefined()
  })

  test('button_choice on project topic referencing a different project topic is REJECTED', async () => {
    const { verifying } = await makeKeyPair()
    const generalTopic = webTopicId('u-1')
    const projectA = `${generalTopic}:project-a`
    const projectB = `${generalTopic}:project-b`

    // Prompt belongs to project-B.
    const promptB = buildButtonPrompt({
      body: 'Project B seed',
      options: [{ label: 'A', body: 'Continue', value: 'continue' }],
    })
    await store.emit(promptB, { topic_id: projectB })

    const eng = makeFakeEngine()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: new InMemoryWebChatSenderRegistry(),
      buttonStore: store,
    })

    const sent: ChatOutbound[] = []
    // Client is bound to project A but supplies project-B's prompt_id.
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      active_topic_id: projectA,
      event: {
        type: 'button_choice',
        prompt_id: promptB.prompt_id,
        choice_value: 'continue',
      },
      send: (e) => sent.push(e),
    })

    const peeked = await store.peek(promptB.prompt_id)
    expect(peeked!.resolved_at).toBeNull()
    expect(sent.find((e) => e.type === 'error')).toBeDefined()
  })
})

describe('buildWebChatBridge — handleProjectTopicInbound silent skip-for-now (ISSUES #69 Codex P3 follow-up)', () => {
  // PR #340 (ISSUES #69) added the `[B] Skip for now` button on the
  // onboarding-handoff no-match fallback. The brief calls this out as
  // a SILENT acknowledgement: the seed already asked "what's the
  // context?" and the user explicitly declined. The first cut of the
  // fix only suppressed visible duplication at the keyboard level —
  // Codex's P3 review caught that the gateway's
  // `handleProjectTopicInbound` still emitted its generic
  // "full project chat is coming online soon" stub on top of the
  // skip, contradicting the seed's promise. This block pins the
  // production behaviour: `skip-for-now` taps resolve the prompt
  // (so history surfaces it correctly on switch-back) but DO NOT
  // emit any agent_message on the wire. Every other project-topic
  // value still gets the stub until the per-project agent loop
  // replaces this branch.
  let tmp: string
  let db: ProjectDb
  let store: ButtonStore

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-skip-for-now-silent-'))
    db = ProjectDb.open(join(tmp, 'owner.db'))
    applyMigrations(db.raw())
    store = new ButtonStore({ db })
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('skip-for-now tap on a project topic resolves the seed and emits a single agent_ack envelope (no agent_message)', async () => {
    const { verifying } = await makeKeyPair()
    const generalTopic = webTopicId('u-1')
    const projectTopic = `${generalTopic}:no-match-project`

    // Mirror the on-disk shape `buildOnboardingHandoffHook.emitProjectSeeds`
    // writes for the no-match fallback path: two distinct options,
    // `allow_freeform: true`.
    const seed = buildButtonPrompt({
      body: "You added No-Match-Project to your projects but I don't have any history on it yet. What's the context?",
      options: [
        { label: 'A', body: 'Tell me what you know', value: 'tell-me-what-you-know' },
        { label: 'B', body: 'Skip for now', value: 'skip-for-now' },
      ],
      allow_freeform: true,
    })
    await store.emit(seed, { topic_id: projectTopic })

    const eng = makeFakeEngine()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: new InMemoryWebChatSenderRegistry(),
      buttonStore: store,
    })

    const sent: ChatOutbound[] = []
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      active_topic_id: projectTopic,
      event: {
        type: 'button_choice',
        prompt_id: seed.prompt_id,
        choice_value: 'skip-for-now',
      },
      send: (e) => sent.push(e),
    })

    // Resolve side-effect MUST run — the seed row is marked resolved
    // so the chat-history hydration surfaces it correctly on switch-
    // back (resolved rows always render; unresolved rows past their
    // TTL would be dropped).
    const peeked = await store.peek(seed.prompt_id)
    expect(peeked).not.toBeNull()
    expect(peeked!.resolved_at).not.toBeNull()
    expect(peeked!.resolution_value).toBe('skip-for-now')

    // Argus r1 BLOCKER 1 (2026-05-30) — EXACTLY one envelope on the
    // wire, and it must be the no-render `agent_ack`. No agent_message
    // body (the stub reply is silenced), no error (the resolve
    // succeeded), no second ack (idempotency).
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({ type: 'agent_ack', topic_id: projectTopic })
    expect(sent.filter((e) => e.type === 'agent_message')).toHaveLength(0)
    expect(sent.filter((e) => e.type === 'error')).toHaveLength(0)

    // Engine MUST NOT have been driven (project-topic inbound is a
    // stub; this assertion just protects against a future refactor
    // accidentally routing project-topic taps to engine.advance).
    expect(eng.advanceCalls).toHaveLength(0)
  })

  test('skip-for-now tap on an already-resolved seed still emits a single agent_ack (resolve no-ops / throws, no agent_message, no error)', async () => {
    // Argus r1 MINOR 3 (2026-05-30) — covers the edge case where the
    // user's tap arrives AFTER the seed row was resolved by a prior
    // path (double-click, network retry, switch-back re-tap on a
    // stale grid). Depending on the row state at the time of the
    // re-tap, `buttonStore.resolve` either returns `{ was_new: false }`
    // (current contract — idempotent on already-resolved) OR throws
    // (`expired`, `prompt_not_found` for hard-deleted rows). The
    // bridge's try/catch swallows the throw + the no-op path is a
    // bookkeeping no-op; in BOTH cases the code MUST fall through to
    // the silent-skip branch and ship exactly one `agent_ack`. Without
    // that guarantee the client's typing dots would either stick (no
    // ack on the throw path) or render a phantom error bubble (if the
    // bridge ever started surfacing the catch as an error envelope) —
    // both visible regressions on the silent-skip promise.
    const { verifying } = await makeKeyPair()
    const generalTopic = webTopicId('u-1')
    const projectTopic = `${generalTopic}:no-match-project`

    const seed = buildButtonPrompt({
      body: "You added No-Match-Project to your projects but I don't have any history on it yet. What's the context?",
      options: [
        { label: 'A', body: 'Tell me what you know', value: 'tell-me-what-you-know' },
        { label: 'B', body: 'Skip for now', value: 'skip-for-now' },
      ],
      allow_freeform: true,
    })
    await store.emit(seed, { topic_id: projectTopic })

    // Pre-resolve the seed so the in-test `bridge.handleInbound` call
    // hits the already-resolved error branch in `buttonStore.resolve`.
    await store.resolve({
      choice: {
        prompt_id: seed.prompt_id,
        choice_value: 'tell-me-what-you-know',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
    })

    const eng = makeFakeEngine()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: new InMemoryWebChatSenderRegistry(),
      buttonStore: store,
    })

    const sent: ChatOutbound[] = []
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      active_topic_id: projectTopic,
      event: {
        type: 'button_choice',
        prompt_id: seed.prompt_id,
        choice_value: 'skip-for-now',
      },
      send: (e) => sent.push(e),
    })

    // The pre-resolved value sticks (resolve is idempotent on the
    // happy path; the second resolve attempt threw and was swallowed),
    // so resolution_value stays as the FIRST choice's value.
    const peeked = await store.peek(seed.prompt_id)
    expect(peeked!.resolved_at).not.toBeNull()
    expect(peeked!.resolution_value).toBe('tell-me-what-you-know')

    // Wire shape is identical to the happy-path silent-skip: one
    // agent_ack, no agent_message, no error. The bridge's try/catch
    // around `resolve` MUST swallow the already-resolved throw and
    // fall through to the silent-skip return.
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({ type: 'agent_ack', topic_id: projectTopic })
    expect(sent.filter((e) => e.type === 'agent_message')).toHaveLength(0)
    expect(sent.filter((e) => e.type === 'error')).toHaveLength(0)

    expect(eng.advanceCalls).toHaveLength(0)
  })

  test('tell-me-what-you-know on the SAME no-match seed still emits the project-stub agent_message', async () => {
    const { verifying } = await makeKeyPair()
    const generalTopic = webTopicId('u-1')
    const projectTopic = `${generalTopic}:no-match-project`

    const seed = buildButtonPrompt({
      body: "You added No-Match-Project to your projects but I don't have any history on it yet. What's the context?",
      options: [
        { label: 'A', body: 'Tell me what you know', value: 'tell-me-what-you-know' },
        { label: 'B', body: 'Skip for now', value: 'skip-for-now' },
      ],
      allow_freeform: true,
    })
    await store.emit(seed, { topic_id: projectTopic })

    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
      buttonStore: store,
    })

    const sent: ChatOutbound[] = []
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      active_topic_id: projectTopic,
      event: {
        type: 'button_choice',
        prompt_id: seed.prompt_id,
        choice_value: 'tell-me-what-you-know',
      },
      send: (e) => sent.push(e),
    })

    // Resolve happened.
    const peeked = await store.peek(seed.prompt_id)
    expect(peeked!.resolved_at).not.toBeNull()
    expect(peeked!.resolution_value).toBe('tell-me-what-you-know')

    // And the stub reply DID ship — every project-topic button value
    // EXCEPT `skip-for-now` still gets the generic acknowledgement
    // until the per-project agent loop replaces this branch.
    const stub = sent.find((e) => e.type === 'agent_message')
    expect(stub).toBeDefined()
    expect((stub as { type: 'agent_message'; body: string }).body).toContain(
      'full project chat is coming online soon',
    )
  })
})

describe('buildWebChatBridge — resumeCookieSession (Argus r2 BLOCKER: cookie-resume project-seed re-emit)', () => {
  // The cookie-only WS open path (`pending_claim === null`) is the most
  // common entry for a returning user: refresh on a project topic, or
  // localStorage `active_topic_id` pointer to `web:<u>:<proj>` when the
  // `?start=` token has already been scrubbed. Before the r2 follow-up
  // fix, the bridge skipped the re-emit on this path entirely, so a
  // project topic with one unresolved `onboarding_handoff_seed` row
  // rendered blank on refresh (history hydration's unresolved-skip
  // drops it at chat.ts:1195).
  let tmp: string
  let db: ProjectDb
  let store: ButtonStore

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-resume-cookie-'))
    db = ProjectDb.open(join(tmp, 'owner.db'))
    applyMigrations(db.raw())
    store = new ButtonStore({ db })
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('cookie-resume on a project topic re-emits the active unresolved seed prompt', async () => {
    const { verifying } = await makeKeyPair()
    const generalTopic = webTopicId('u-1')
    const projectTopic = `${generalTopic}:project-alpha`

    // Seed the unresolved project-seed row.
    const seed = buildButtonPrompt({
      body: 'Welcome to project alpha — pick a starting move:',
      options: [
        { label: 'A', body: 'Continue setup', value: 'continue' },
        { label: 'B', body: 'Skip for now', value: 'skip' },
      ],
    })
    await store.emit(seed, { topic_id: projectTopic })

    const eng = makeFakeEngine()
    const reg = new InMemoryWebChatSenderRegistry()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: reg,
      buttonStore: store,
    })

    expect(bridge.resumeCookieSession).toBeDefined()

    const sent: ChatOutbound[] = []
    await bridge.resumeCookieSession!({
      project_slug: 'alice',
      user_id: 'u-1',
      active_topic_id: projectTopic,
      send: (e) => sent.push(e),
    })

    // The seed prompt must have been re-emitted on the wire so the
    // browser's `renderAgent` path renders it on hydration.
    const agentEvent = sent.find(
      (e) => e.type === 'agent_message' && e.prompt_id === seed.prompt_id,
    )
    expect(agentEvent).toBeDefined()
    expect(agentEvent!.type === 'agent_message' ? agentEvent!.body : '').toBe(
      'Welcome to project alpha — pick a starting move:',
    )

    // Engine MUST NOT have been driven (cookie resume is by definition
    // post-bootstrap — no `engine.start` on this path).
    expect(eng.startCalls).toHaveLength(0)
    expect(eng.advanceCalls).toHaveLength(0)

    // The sender registry must have an entry at the PROJECT topic so
    // subsequent engine emits route to this socket. We assert this by
    // confirming a freshly-emitted prompt at projectTopic reaches our
    // captured send lambda.
    const followUp = buildButtonPrompt({
      body: 'Next move?',
      options: [{ label: 'A', body: 'Continue', value: 'continue' }],
    })
    const beforeCount = sent.filter((e) => e.type === 'agent_message').length
    const delivered = reg.send(projectTopic, renderButtonPromptForWeb(followUp))
    expect(delivered).toBe(true)
    expect(
      sent.filter((e) => e.type === 'agent_message').length,
    ).toBe(beforeCount + 1)
  })

  test('cookie-resume on the General topic does NOT re-emit (engine drives General; only project topics need the hook)', async () => {
    const { verifying } = await makeKeyPair()
    const generalTopic = webTopicId('u-1')

    // An unresolved prompt on General is owned by the engine's own
    // re-emit path; the cookie-resume hook deliberately skips General
    // to avoid double-emit. Pin that behaviour.
    const generalPrompt = buildButtonPrompt({
      body: 'General onboarding question',
      options: [{ label: 'A', body: 'Continue', value: 'continue' }],
    })
    await store.emit(generalPrompt, { topic_id: generalTopic })

    const eng = makeFakeEngine()
    const reg = new InMemoryWebChatSenderRegistry()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: reg,
      buttonStore: store,
    })

    const sent: ChatOutbound[] = []
    await bridge.resumeCookieSession!({
      project_slug: 'alice',
      user_id: 'u-1',
      // No `active_topic_id` → defaults to General.
      send: (e) => sent.push(e),
    })

    // No re-emit on General (engine owns that path).
    expect(sent.filter((e) => e.type === 'agent_message')).toHaveLength(0)

    // But the sender MUST still register at General so engine emits
    // for subsequent inbound user events land here.
    const followUp = buildButtonPrompt({
      body: 'Next move?',
      options: [{ label: 'A', body: 'Continue', value: 'continue' }],
    })
    const delivered = reg.send(generalTopic, renderButtonPromptForWeb(followUp))
    expect(delivered).toBe(true)
    expect(sent.filter((e) => e.type === 'agent_message')).toHaveLength(1)
  })

  test('cookie-resume on a project topic with NO unresolved seed is a clean no-op (still registers the sender)', async () => {
    const { verifying } = await makeKeyPair()
    const generalTopic = webTopicId('u-1')
    const projectTopic = `${generalTopic}:project-beta`

    // No prompts seeded.
    const eng = makeFakeEngine()
    const reg = new InMemoryWebChatSenderRegistry()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: eng,
      registry: reg,
      buttonStore: store,
    })

    const sent: ChatOutbound[] = []
    await bridge.resumeCookieSession!({
      project_slug: 'alice',
      user_id: 'u-1',
      active_topic_id: projectTopic,
      send: (e) => sent.push(e),
    })

    // No prompt to re-emit; nothing on the wire.
    expect(sent).toHaveLength(0)

    // Sender still registered at project topic for future emits.
    const followUp = buildButtonPrompt({
      body: 'Hello',
      options: [{ label: 'A', body: 'OK', value: 'ok' }],
    })
    const delivered = reg.send(projectTopic, renderButtonPromptForWeb(followUp))
    expect(delivered).toBe(true)
    expect(sent).toHaveLength(1)
  })
})

describe('buildWebChatBridge — recovered-reply drain is General-only (Argus r6 BLOCKER: cross-topic misroute)', () => {
  // The recovered-reply store (#106) is keyed on the user's General
  // conversational channel (`web:<user_id>`). On a reconnect the live
  // `send` closure is registered for the socket's ACTIVE topic
  // (`wire_topic_id`), which may be a PROJECT topic (deep-link, persisted
  // localStorage pointer, refresh mid-project). Before the r6 fix, BOTH
  // live-emit entry points (`startSession`, `resumeCookieSession`) drained
  // General recovered rows through that project-bound `send` unconditionally:
  // the General reply rendered in the PROJECT chat AND was markDelivered
  // against General, so it never showed in General again — cross-topic bleed
  // + silent data loss, the exact bug class this PR exists to eliminate. The
  // fix gates each drain on `wire_topic_id === topic_id`, symmetric with the
  // `reEmitActiveSeedPromptIfAny` guard directly above each call site.
  //
  // No `buttonStore` is wired here on purpose: `reEmitActiveSeedPromptIfAny`
  // no-ops without one, so the only thing that could reach the project
  // socket's `send` is the (now-guarded) recovered-reply drain.

  function isRecoveredAgentMessage(e: ChatOutbound, body: string): boolean {
    return e.type === 'agent_message' && e.body === body
  }

  test('startSession landing on a PROJECT topic does NOT misroute General recovered replies; a later General reconnect delivers them', async () => {
    const { signing, verifying } = await makeKeyPair()
    const generalTopic = webTopicId('u-r6a')
    const projectTopic = `${generalTopic}:proj-x`
    const RECOVERED = 'recovered general answer (startSession)'

    // A crash dropped a General reply while the user was offline.
    const store = new InMemoryRecoveredReplyStore()
    store.persistUndelivered({ topic_id: generalTopic, turn_id: 'inc:1', text: RECOVERED, now: 1 })

    const reg = new InMemoryWebChatSenderRegistry()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: reg,
      recoveredReplyStore: store,
    })

    // Reconnect #1: lands on the PROJECT topic (wire_topic_id !== topic_id).
    const mintedProj = await issueStartToken({
      project_slug: 'alice',
      user_id: 'u-r6a',
      signup_via: 'web',
      signing_key: signing,
    })
    const claimProj = await bridge.validateStartToken({ start_token: mintedProj.token })
    const projSent: ChatOutbound[] = []
    expect(
      await bridge.startSession({
        claim: claimProj!,
        send: (e) => projSent.push(e),
        active_topic_id: projectTopic,
      }),
    ).toBe(true)

    // HALF 1 — the General recovered reply must NOT have rendered in the
    // project chat, and must NOT have been markDelivered (still pending).
    expect(projSent.some((e) => isRecoveredAgentMessage(e, RECOVERED))).toBe(false)
    expect(store.peekUndelivered(generalTopic)).toHaveLength(1)

    // Reconnect #2: lands on General (no active_topic_id → wire == topic).
    const mintedGen = await issueStartToken({
      project_slug: 'alice',
      user_id: 'u-r6a',
      signup_via: 'web',
      signing_key: signing,
    })
    const claimGen = await bridge.validateStartToken({ start_token: mintedGen.token })
    const genSent: ChatOutbound[] = []
    expect(await bridge.startSession({ claim: claimGen!, send: (e) => genSent.push(e) })).toBe(true)

    // HALF 2 — NOW it delivers, exactly once, and is consumed from the store.
    expect(genSent.filter((e) => isRecoveredAgentMessage(e, RECOVERED))).toHaveLength(1)
    expect(store.peekUndelivered(generalTopic)).toHaveLength(0)
  })

  test('resumeCookieSession on a PROJECT topic does NOT misroute General recovered replies; a General cookie-resume delivers them', async () => {
    const { verifying } = await makeKeyPair()
    const generalTopic = webTopicId('u-r6b')
    const projectTopic = `${generalTopic}:proj-y`
    const RECOVERED = 'recovered general answer (cookie-resume)'

    const store = new InMemoryRecoveredReplyStore()
    store.persistUndelivered({ topic_id: generalTopic, turn_id: 'inc:2', text: RECOVERED, now: 1 })

    const reg = new InMemoryWebChatSenderRegistry()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: reg,
      recoveredReplyStore: store,
    })

    // Cookie resume #1: PROJECT topic (the common returning-user entry).
    const projSent: ChatOutbound[] = []
    await bridge.resumeCookieSession!({
      project_slug: 'alice',
      user_id: 'u-r6b',
      active_topic_id: projectTopic,
      send: (e) => projSent.push(e),
    })
    expect(projSent.some((e) => isRecoveredAgentMessage(e, RECOVERED))).toBe(false)
    expect(store.peekUndelivered(generalTopic)).toHaveLength(1)

    // Cookie resume #2: General topic (no active_topic_id → wire == topic).
    const genSent: ChatOutbound[] = []
    await bridge.resumeCookieSession!({
      project_slug: 'alice',
      user_id: 'u-r6b',
      send: (e) => genSent.push(e),
    })
    expect(genSent.filter((e) => isRecoveredAgentMessage(e, RECOVERED))).toHaveLength(1)
    expect(store.peekUndelivered(generalTopic)).toHaveLength(0)
  })
})
