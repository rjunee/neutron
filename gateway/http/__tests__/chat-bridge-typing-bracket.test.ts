/**
 * ISSUES #115 — reproduce-first guarantee that the typing indicator is
 * DETERMINISTIC, not intermittent.
 *
 * Root cause of the live-signup intermittency: the typing indicator was
 * client-optimistic only (dots on a visible user send, cleared on the
 * first `agent_message`). Turns the user did NOT trigger with a send
 * (proactively-emitted phase prompts) and the gaps between messages on
 * multi-`agent_message` turns showed nothing — so the indicator appeared
 * after SOME replies and not others.
 *
 * The fix makes the gateway server-authoritative: it brackets EVERY
 * `engine.advance` (handleInbound) and `engine.start` (startSession) with
 * `agent_typing_start` (before) + `agent_typing_end` (after, in a
 * `finally`). These tests drive MULTIPLE consecutive turns and assert the
 * bracket fires on EVERY one (not a fraction), in the right order, and
 * never gets skipped — even when the turn throws or the socket write
 * fails.
 */
import { describe, expect, test } from 'bun:test'
import { generateKeyPair, type KeyLike } from 'jose'
import {
  buildWebChatBridge,
  InMemoryWebChatSenderRegistry,
} from '../chat-bridge.ts'
import {
  InMemoryConsumedTokens,
  issueStartToken,
  verifyStartToken,
  claimStartTokenJti,
  type StartTokenSigningKey,
  type StartTokenVerificationKey,
} from '@neutronai/runtime/__tests__/start-token-testkit.ts'
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

function makeResolveKey(
  verifying: StartTokenVerificationKey,
): (kid: string) => Promise<KeyLike | null> {
  return async (kid) => (kid === verifying.kid ? verifying.publicKey : null)
}

function fakeState(): OnboardingState {
  return {
    project_slug: 'alice',
    user_id: 'u-1',
    phase: 'signup',
    phase_state: {},
    started_at: 0,
    last_advanced_at: 0,
    completed_at: null,
    import_job_id: null,
    persona_files_committed: false,
    wow_fired: false,
    wow_pushed_at: null,
    onboarding_handoff_emitted_at: null,
    attempt_id: 'test-attempt',
  }
}

/**
 * Fake engine that records an interleave marker into `events` whenever
 * `start` / `advance` run. The test's `send` callback pushes the outbound
 * envelope `type` into the SAME array, so the resulting sequence proves
 * ordering: a correct bracket reads `agent_typing_start`, then the engine
 * marker, then `agent_typing_end`.
 */
function makeFakeEngine(events: string[], opts: { advanceThrows?: boolean } = {}): InterviewEngine {
  const state = fakeState()
  const startResult: StartResult = { prompt_id: 'pid-1', was_new: true, state }
  const advanceResult: AdvanceResult = { outcome: 'advanced', state }
  return {
    async start(_input: StartInput): Promise<StartResult> {
      events.push('engine.start')
      return startResult
    },
    async advance(_input: AdvanceInput): Promise<AdvanceResult> {
      events.push('engine.advance')
      if (opts.advanceThrows === true) throw new Error('boom in advance')
      return advanceResult
    },
    async acceptChoice() {
      throw new Error('not used')
    },
    async tick(): Promise<void> {},
    async emitCurrentPhasePrompt(): Promise<AdvanceResult> {
      return advanceResult
    },
    async recordInboundReceived(): Promise<void> {},
  } as unknown as InterviewEngine
}

function makeBridge(events: string[], opts: { advanceThrows?: boolean } = {}) {
  return (async () => {
    const { signing, verifying } = await makeKeyPair()
    const bridge = buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(events, opts),
      registry: new InMemoryWebChatSenderRegistry(),
    })
    return { bridge, signing }
  })()
}

describe('ISSUES #115 — handleInbound brackets EVERY turn with typing start/end', () => {
  test('drives multiple consecutive turns; typing fires on EVERY one (not a fraction)', async () => {
    const events: string[] = []
    const { bridge } = await makeBridge(events)
    const sent: ChatOutbound[] = []
    const send = (e: ChatOutbound): void => {
      sent.push(e)
      events.push(e.type)
    }

    // Three consecutive turns: a button tap, a freeform reply, another tap.
    // None of these is the "opening" turn — exactly the path the prior
    // optimistic model under-covered.
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: {
        type: 'button_choice',
        prompt_id: '00000000-0000-4000-8000-000000000001',
        choice_value: 'continue',
      },
      send,
    })
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: 'my answer' },
      send,
    })
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: {
        type: 'button_choice',
        prompt_id: '00000000-0000-4000-8000-000000000002',
        choice_value: 'next',
      },
      send,
    })

    const starts = sent.filter((e) => e.type === 'agent_typing_start')
    const ends = sent.filter((e) => e.type === 'agent_typing_end')
    // EVERY turn (3) emitted exactly one start AND one end — deterministic,
    // not "some turns".
    expect(starts).toHaveLength(3)
    expect(ends).toHaveLength(3)
    // Per-turn ordering: start BEFORE the engine runs, end AFTER. Repeated
    // cleanly for all three turns.
    expect(events).toEqual([
      'agent_typing_start', 'engine.advance', 'agent_typing_end',
      'agent_typing_start', 'engine.advance', 'agent_typing_end',
      'agent_typing_start', 'engine.advance', 'agent_typing_end',
    ])
  })

  test('end-bracket still fires when engine.advance throws (finally)', async () => {
    const events: string[] = []
    const { bridge } = await makeBridge(events, { advanceThrows: true })
    const sent: ChatOutbound[] = []
    const send = (e: ChatOutbound): void => {
      sent.push(e)
      events.push(e.type)
    }
    let threw: unknown = null
    try {
      await bridge.handleInbound({
        project_slug: 'alice',
        user_id: 'u-1',
        event: { type: 'user_message', body: 'x' },
        send,
      })
    } catch (err) {
      threw = err
    }
    expect(threw).not.toBeNull()
    // The throw propagates, but the bracket is balanced: start + end both
    // fired, so the client's ref-count never strands the dots.
    expect(events).toEqual(['agent_typing_start', 'engine.advance', 'agent_typing_end'])
  })

  test('a throwing send (closed socket) does NOT abort the turn', async () => {
    const events: string[] = []
    const { bridge } = await makeBridge(events)
    // Socket-closed: every send throws (mirrors landing/server.ts rejecting
    // a write to a dead WS). The turn must still reach engine.advance.
    const send = (): void => {
      throw new Error('socket closed')
    }
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: 'x' },
      send,
    })
    // engine.advance ran despite both typing-bracket sends throwing —
    // emitTypingBracket swallows send failures.
    expect(events).toContain('engine.advance')
  })
})

describe('ISSUES #115 — startSession brackets the opening turn', () => {
  test('emits typing_start before engine.start and typing_end after', async () => {
    const events: string[] = []
    const { bridge, signing } = await makeBridge(events)
    const minted = await issueStartToken({
      project_slug: 'alice',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
    })
    const claim = await bridge.validateStartToken({ start_token: minted.token })
    expect(claim).not.toBeNull()
    const send = (e: ChatOutbound): void => {
      events.push(e.type)
    }
    const ok = await bridge.startSession({ claim: claim!, send })
    expect(ok).toBe(true)
    // The opening-turn bracket wraps engine.start, so the very first turn
    // (which the user never triggers with a send) shows the indicator too.
    const startIdx = events.indexOf('agent_typing_start')
    const engineIdx = events.indexOf('engine.start')
    const endIdx = events.indexOf('agent_typing_end')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(engineIdx).toBeGreaterThan(startIdx)
    expect(endIdx).toBeGreaterThan(engineIdx)
  })
})
