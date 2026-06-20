/**
 * ISSUES #204 — reproduce-first: post-onboarding chat is a dead-end.
 *
 * THE BUG (verified on prod, spec
 * docs/plans/post-onboarding-experience-spec-2026-06-10.md § ITEM 1):
 * after onboarding reaches `phase==completed`, `handleInbound` routes
 * every `user_message` into `engine.advance()`, whose completed-phase
 * handler (`handleFinalHandoffOnCompleted`, engine.ts) returns
 * `noop_terminal` for arbitrary chat — the user's text is appended to
 * the transcript and NOTHING is emitted. Typing in General (or any
 * project topic) after onboarding produces no reply, forever.
 *
 * THE FIX (this sprint): a live-agent-turn seam on the chat bridge.
 * When the owner's onboarding row is `phase==completed` AND no final-
 * handoff prompt is pending (`phase_state.final_handoff_active !== true`),
 * a `user_message` routes to `opts.liveAgentTurn` (the CC-substrate
 * instance agent) instead of the engine's terminal no-op. Project-topic
 * inbound swaps its hardcoded "coming online soon" stub for the same
 * runner, passing the parsed project_id.
 *
 * These tests are the RED reproduction: on pre-fix main the bridge
 * ignores the `liveAgentTurn` / `onboardingStateStore` opts (they do not
 * exist), every turn lands in the fake engine's noop_terminal, no agent
 * reply is emitted, and the assertions below fail.
 */
import { describe, expect, test } from 'bun:test'
import { generateKeyPair, type KeyLike } from 'jose'
import {
  buildWebChatBridge,
  InMemoryWebChatSenderRegistry,
  type LiveAgentTurnRequest,
} from '../chat-bridge.ts'
import {
  InMemoryConsumedTokens,
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
import {
  InMemoryOnboardingStateStore,
  type OnboardingState,
} from '../../../onboarding/interview/state-store.ts'

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

function completedState(over: Partial<OnboardingState> = {}): OnboardingState {
  return {
    project_slug: 'alice',
    user_id: 'u-1',
    phase: 'completed',
    phase_state: {},
    started_at: 0,
    last_advanced_at: 0,
    completed_at: 1,
    import_job_id: null,
    persona_files_committed: true,
    wow_fired: true,
    wow_pushed_at: null,
    onboarding_handoff_emitted_at: 1,
    attempt_id: 'test-attempt',
    ...over,
  }
}

/**
 * Fake engine that replicates the REAL completed-phase behaviour: a
 * freeform `user_message` at `phase==completed` lands in
 * `handleFinalHandoffOnCompleted`'s `choice_value === null` branch and
 * returns `{ outcome: 'noop_terminal' }` WITHOUT emitting anything on the
 * socket (engine.ts noop_terminal). That silence IS the prod bug.
 */
function makeNoopTerminalEngine(events: string[], state: OnboardingState): InterviewEngine {
  const startResult: StartResult = { prompt_id: 'pid-1', was_new: false, state }
  return {
    async start(_input: StartInput): Promise<StartResult> {
      events.push('engine.start')
      return startResult
    },
    async advance(_input: AdvanceInput): Promise<AdvanceResult> {
      events.push('engine.advance')
      // Mirrors engine.ts handleFinalHandoffOnCompleted: transcript
      // append only, NO send, no prompt emit.
      return { outcome: 'noop_terminal', state } as AdvanceResult
    },
    async acceptChoice() {
      throw new Error('not used')
    },
    async tick(): Promise<void> {},
    async emitCurrentPhasePrompt(): Promise<AdvanceResult> {
      return { outcome: 'noop_terminal', state } as AdvanceResult
    },
    async recordInboundReceived(): Promise<void> {},
  } as unknown as InterviewEngine
}

async function makeHarness(opts: {
  state?: OnboardingState | null
  withRunner?: boolean
  runnerImpl?: (input: LiveAgentTurnRequest) => Promise<void>
}) {
  const events: string[] = []
  const sent: ChatOutbound[] = []
  const turns: LiveAgentTurnRequest[] = []
  const state = opts.state === undefined ? completedState() : opts.state
  const stateStore = new InMemoryOnboardingStateStore({ now: () => 1_000 })
  if (state !== null) {
    await stateStore.upsert({
      project_slug: state.project_slug,
      user_id: state.user_id,
      phase: state.phase,
      phase_state_patch: state.phase_state,
    })
  }
  const { verifying } = await makeKeyPair()
  const runner =
    opts.runnerImpl ??
    (async (input: LiveAgentTurnRequest): Promise<void> => {
      turns.push(input)
      events.push('live_agent_turn')
      // A real runner streams + persists; the contract the bridge cares
      // about is "a reply envelope reaches the socket".
      input.send({ type: 'agent_message', body: `echo: ${input.user_text}` })
    })
  const bridge = buildWebChatBridge({
    expected_project_slug: 'alice',
    resolveKey: makeResolveKey(verifying),
    consumedTokens: new InMemoryConsumedTokens(),
    verifyStartToken,
    claimStartTokenJti,
    engine: makeNoopTerminalEngine(events, state ?? completedState()),
    registry: new InMemoryWebChatSenderRegistry(),
    onboardingStateStore: stateStore,
    ...(opts.withRunner === false
      ? {}
      : {
          liveAgentTurn: async (input: LiveAgentTurnRequest) => {
            await runner(input)
          },
        }),
  })
  const send = (e: ChatOutbound): void => {
    sent.push(e)
    events.push(e.type)
  }
  return { bridge, events, sent, turns, send, stateStore }
}

describe('ISSUES #204 — completed-phase user_message routes to the live agent (General)', () => {
  test('RED repro: typed chat at phase==completed produces an agent reply, not the noop_terminal silence', async () => {
    const { bridge, events, sent, turns, send } = await makeHarness({})
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: 'what projects do I have?' },
      send,
    })
    // The live-agent runner was invoked with the typed text…
    expect(turns).toHaveLength(1)
    expect(turns[0]!.project_slug).toBe('alice')
    expect(turns[0]!.user_id).toBe('u-1')
    expect(turns[0]!.topic_id).toBe('web:u-1')
    expect(turns[0]!.project_id).toBeUndefined()
    expect(turns[0]!.user_text).toBe('what projects do I have?')
    // …an agent reply envelope reached the socket (pre-fix: NOTHING is
    // emitted — this is the prod dead-end assertion)…
    const replies = sent.filter((e) => e.type === 'agent_message')
    expect(replies).toHaveLength(1)
    expect((replies[0] as { body: string }).body).toContain('what projects do I have?')
    // …the onboarding engine's terminal no-op was NOT driven…
    expect(events).not.toContain('engine.advance')
    // …and the turn was typing-bracketed (server-deterministic indicator).
    expect(events.indexOf('agent_typing_start')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('agent_typing_end')).toBeGreaterThan(events.indexOf('live_agent_turn'))
  })

  // 2026-06-20 GO-LIVE P0 (owner live-dogfood): the prior design gated a
  // TYPED General message behind `final_handoff_active !== true` so the wow
  // handoff prompt could consume typed keyword replies. But an owner who
  // finishes onboarding and never taps the handoff "Done" leaves the flag
  // stuck `true` forever — every typed General message then dead-ends in the
  // engine's noop_terminal and General goes SILENT (the P0). General now
  // mirrors project topics: a typed message at phase==completed reaches the
  // live agent EVEN with a pending final handoff. The wow buttons still work
  // because a button_choice TAP bypasses this user_message gate (next test).
  test('GO-LIVE P0: typed General chat reaches the live agent even with a pending final handoff (was: dead silence)', async () => {
    const { bridge, events, sent, turns, send } = await makeHarness({
      state: completedState({ phase_state: { final_handoff_active: true } }),
    })
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: 'what did we set up for the miami house?' },
      send,
    })
    // The live-agent runner ran (pre-fix: turns is empty, engine.advance
    // drives the noop_terminal, NOTHING is emitted — General is dead).
    expect(turns).toHaveLength(1)
    expect(turns[0]!.topic_id).toBe('web:u-1')
    expect(turns[0]!.user_text).toBe('what did we set up for the miami house?')
    const replies = sent.filter((e) => e.type === 'agent_message')
    expect(replies).toHaveLength(1)
    // The onboarding engine's terminal no-op was NOT driven.
    expect(events).not.toContain('engine.advance')
  })

  test('GO-LIVE P0: a button_choice TAP on the pending wow handoff STILL routes to the engine (buttons unchanged)', async () => {
    const { bridge, events, turns, send } = await makeHarness({
      state: completedState({
        phase_state: { final_handoff_active: true, active_prompt_id: 'pid-handoff' },
      }),
    })
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: {
        type: 'button_choice',
        prompt_id: 'pid-handoff',
        choice_value: 'final_handoff_telegram_bind',
      },
      send,
    })
    // Taps are NOT live-agent turns — they drive the engine's handoff handler.
    expect(turns).toHaveLength(0)
    expect(events).toContain('engine.advance')
  })

  test('mid-onboarding phases keep the engine path untouched', async () => {
    const { bridge, events, turns, send } = await makeHarness({
      state: completedState({ phase: 'projects_proposed', completed_at: null }),
    })
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: 'rename project A to B' },
      send,
    })
    expect(turns).toHaveLength(0)
    expect(events).toContain('engine.advance')
  })

  test('no onboarding row at all keeps the engine path (fresh instance)', async () => {
    const { bridge, events, turns, send } = await makeHarness({ state: null })
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: 'hello?' },
      send,
    })
    expect(turns).toHaveLength(0)
    expect(events).toContain('engine.advance')
  })

  test('runner not wired (Open box without LLM creds) falls back to the engine path, never throws', async () => {
    const { bridge, events, turns, send } = await makeHarness({ withRunner: false })
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: 'anyone there?' },
      send,
    })
    expect(turns).toHaveLength(0)
    expect(events).toContain('engine.advance')
  })

  test('a throwing runner still closes the typing bracket and surfaces a failure bubble', async () => {
    const { bridge, events, sent, send } = await makeHarness({
      runnerImpl: async () => {
        throw new Error('substrate exploded')
      },
    })
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: 'x' },
      send,
    })
    // Bracket balanced even on throw…
    expect(events.filter((e) => e === 'agent_typing_start')).toHaveLength(1)
    expect(events.filter((e) => e === 'agent_typing_end')).toHaveLength(1)
    // …and the user is never met with silence again: a failure bubble ships.
    const replies = sent.filter((e) => e.type === 'agent_message')
    expect(replies).toHaveLength(1)
  })
})

describe('ISSUES #204 — project-topic user_message replaces the stub with the live agent', () => {
  test('RED repro: typed chat on web:<uid>:<project> at phase==completed reaches the runner with project_id', async () => {
    const { bridge, sent, turns, send } = await makeHarness({})
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      active_topic_id: 'web:u-1:minas-tirith',
      event: { type: 'user_message', body: 'status of this project?' },
      send,
    })
    expect(turns).toHaveLength(1)
    expect(turns[0]!.topic_id).toBe('web:u-1:minas-tirith')
    expect(turns[0]!.project_id).toBe('minas-tirith')
    // The hardcoded "full project chat is coming online soon" stub must
    // NOT ship — the agent reply replaces it.
    const bodies = sent
      .filter((e) => e.type === 'agent_message')
      .map((e) => (e as { body: string }).body)
    expect(bodies.some((b) => b.includes('coming online soon'))).toBe(false)
    expect(bodies.some((b) => b.includes('status of this project?'))).toBe(true)
  })

  test('project-topic typed chat MID-onboarding keeps the stub (agent not yet eligible)', async () => {
    const { bridge, sent, turns, send } = await makeHarness({
      state: completedState({ phase: 'wow_fired', completed_at: null }),
    })
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      active_topic_id: 'web:u-1:minas-tirith',
      event: { type: 'user_message', body: 'hello' },
      send,
    })
    expect(turns).toHaveLength(0)
    const bodies = sent
      .filter((e) => e.type === 'agent_message')
      .map((e) => (e as { body: string }).body)
    expect(bodies.some((b) => b.includes('coming online soon'))).toBe(true)
  })
})
