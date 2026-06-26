/**
 * Parity gap #2 (Cores→Open) — the web-chat pre-dispatch chat-command filter.
 *
 * The Open web chat (landing-stack → chat-bridge) had NO slash-command
 * interception (only the Expo `createAppWsSurface` did), so `/cal` / `/email`
 * fell through to the LLM. This test pins the new seam: when the bridge holds a
 * `chatCommandFilter` and a typed message is claimed, the bridge ships the Core's
 * reply as an `agent_message` and SHORT-CIRCUITS both the live-agent turn AND the
 * onboarding engine. A null match (plain prose) flows to the agent unchanged.
 */
import { describe, expect, test } from 'bun:test'
import { generateKeyPair, type KeyLike } from 'jose'
import {
  buildWebChatBridge,
  InMemoryWebChatSenderRegistry,
  type LiveAgentTurnRequest,
} from '../chat-bridge.ts'
import type { ChatCommandFilter } from '../app-ws-surface.ts'
import {
  InMemoryConsumedTokens,
  verifyStartToken,
  claimStartTokenJti,
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

async function makeResolveKey(): Promise<(kid: string) => Promise<KeyLike | null>> {
  const { publicKey } = await generateKeyPair('EdDSA', { extractable: true })
  const verifying: StartTokenVerificationKey = { kid: 'kid-test', publicKey: publicKey as KeyLike }
  return async (kid) => (kid === verifying.kid ? verifying.publicKey : null)
}

function completedState(): OnboardingState {
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
  }
}

function makeNoopTerminalEngine(events: string[], state: OnboardingState): InterviewEngine {
  const startResult: StartResult = { prompt_id: 'pid-1', was_new: false, state }
  return {
    async start(_input: StartInput): Promise<StartResult> {
      return startResult
    },
    async advance(_input: AdvanceInput): Promise<AdvanceResult> {
      events.push('engine.advance')
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

async function makeHarness(filter: ChatCommandFilter | undefined) {
  const events: string[] = []
  const sent: ChatOutbound[] = []
  const turns: LiveAgentTurnRequest[] = []
  const filterCalls: Array<{ body: string; project_id?: string; channel_topic_id: string }> = []
  const state = completedState()
  const stateStore = new InMemoryOnboardingStateStore({ now: () => 1_000 })
  await stateStore.upsert({
    project_slug: state.project_slug,
    user_id: state.user_id,
    phase: state.phase,
    phase_state_patch: state.phase_state,
  })
  const bridge = buildWebChatBridge({
    expected_project_slug: 'alice',
    resolveKey: await makeResolveKey(),
    consumedTokens: new InMemoryConsumedTokens(),
    verifyStartToken,
    claimStartTokenJti,
    engine: makeNoopTerminalEngine(events, state),
    registry: new InMemoryWebChatSenderRegistry(),
    onboardingStateStore: stateStore,
    liveAgentTurn: async (input: LiveAgentTurnRequest) => {
      turns.push(input)
      events.push('live_agent_turn')
      input.send({ type: 'agent_message', body: `agent: ${input.user_text}` })
    },
    ...(filter !== undefined ? { chatCommandFilter: filter } : {}),
  })
  const send = (e: ChatOutbound): void => {
    sent.push(e)
    events.push(e.type)
  }
  return { bridge, events, sent, turns, filterCalls, send }
}

/** A fake free-Core chain: claims `/cal …` (records the call), null otherwise. */
function calOnlyFilter(
  record: Array<{ body: string; project_id?: string; channel_topic_id: string }>,
): ChatCommandFilter {
  return {
    async match(input) {
      record.push({
        body: input.body,
        channel_topic_id: input.channel_topic_id,
        ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
      })
      if (!input.body.trimStart().startsWith('/cal')) return null
      return { text: `cal-core: ${input.body}` }
    },
  }
}

describe('parity gap #2 — web-chat chat-command filter short-circuits the agent', () => {
  test('a claimed /cal message ships the Core reply and skips the live agent + engine', async () => {
    const record: Array<{ body: string; project_id?: string; channel_topic_id: string }> = []
    const { bridge, events, sent, turns, send } = await makeHarness(calOnlyFilter(record))
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: '/cal help' },
      send,
    })
    // The Core reply reached the socket…
    const replies = sent.filter((e) => e.type === 'agent_message') as Array<{ body: string }>
    expect(replies).toHaveLength(1)
    expect(replies[0]!.body).toBe('cal-core: /cal help')
    // …the filter saw the General topic, no project_id…
    expect(record).toHaveLength(1)
    expect(record[0]!.channel_topic_id).toBe('web:u-1')
    expect(record[0]!.project_id).toBeUndefined()
    // …and NEITHER the live-agent turn NOR the engine ran.
    expect(turns).toHaveLength(0)
    expect(events).not.toContain('live_agent_turn')
    expect(events).not.toContain('engine.advance')
  })

  test('a null match (plain prose) falls through to the live agent unchanged', async () => {
    const record: Array<{ body: string; project_id?: string; channel_topic_id: string }> = []
    const { bridge, turns, sent, send } = await makeHarness(calOnlyFilter(record))
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: 'what is on my calendar?' },
      send,
    })
    // Filter was consulted but did not claim…
    expect(record).toHaveLength(1)
    // …so the live-agent runner handled the turn.
    expect(turns).toHaveLength(1)
    expect(turns[0]!.user_text).toBe('what is on my calendar?')
    const replies = sent.filter((e) => e.type === 'agent_message') as Array<{ body: string }>
    expect(replies[0]!.body).toBe('agent: what is on my calendar?')
  })

  test('a project-topic /cal parses project_id from web:<uid>:<project>', async () => {
    const record: Array<{ body: string; project_id?: string; channel_topic_id: string }> = []
    const { bridge, turns, send } = await makeHarness(calOnlyFilter(record))
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      active_topic_id: 'web:u-1:minas-tirith',
      event: { type: 'user_message', body: '/cal next' },
      send,
    })
    expect(record).toHaveLength(1)
    expect(record[0]!.channel_topic_id).toBe('web:u-1:minas-tirith')
    expect(record[0]!.project_id).toBe('minas-tirith')
    expect(turns).toHaveLength(0)
  })

  test('a throwing filter never blocks the chat path — falls through to the agent', async () => {
    const throwing: ChatCommandFilter = {
      async match() {
        throw new Error('filter exploded')
      },
    }
    const { bridge, turns, sent, send } = await makeHarness(throwing)
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: '/cal help' },
      send,
    })
    // The throw was swallowed; the turn degraded to the normal agent dispatch.
    expect(turns).toHaveLength(1)
    const replies = sent.filter((e) => e.type === 'agent_message')
    expect(replies).toHaveLength(1)
  })

  test('no filter wired (Core-less box) leaves the chat path unchanged', async () => {
    const { bridge, turns, send } = await makeHarness(undefined)
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body: '/cal help' },
      send,
    })
    // With no filter, /cal is just text → the live agent handles it.
    expect(turns).toHaveLength(1)
    expect(turns[0]!.user_text).toBe('/cal help')
  })
})
