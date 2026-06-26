/**
 * Connect group-chat engagement mode — WIRING test (spec §2/§4).
 *
 * Exercises the LIVE routing seam (`handleProjectTopicInbound` →
 * `runProjectAgentTurn`) end-to-end through the real `buildWebChatBridge`, not
 * the pure gate in isolation (that's `connect/__tests__/agent-engagement.test.ts`).
 * The contract under test:
 *
 *   - `all_messages` (default): EVERY project-topic post triggers an agent turn.
 *   - `tag_gated` + no `@neutron` mention: the message PERSISTS to the shared
 *     transcript (a button-row resolve) but triggers NO agent turn and shows NO
 *     typing indicator — only a no-render `agent_ack` clears the dots.
 *   - `tag_gated` + `@neutron` question: an INLINE agent turn (no delegation).
 *   - `tag_gated` + `@neutron` TASK with the delegate hook wired: hands the task
 *     to the agent-dispatch family (the hook) and does NOT run an inline turn.
 *   - reader unwired (Open box / legacy): behaves as `all_messages`.
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
import type { AgentEngagementMode } from '../../../connect/agent-engagement.ts'

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

function makeNoopEngine(state: OnboardingState): InterviewEngine {
  const startResult: StartResult = { prompt_id: 'pid-1', was_new: false, state }
  return {
    async start(_i: StartInput): Promise<StartResult> {
      return startResult
    },
    async advance(_i: AdvanceInput): Promise<AdvanceResult> {
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

/**
 * Minimal ButtonStore double — records the user-turn persistence. Stateful: the
 * single prior row starts UNRESOLVED and flips resolved on the first stamp, so
 * a second consecutive gated message finds no open row and must fall through to
 * `persistInertUserTurn` (the consecutive-message durability path).
 */
function makeFakeButtonStore() {
  const resolves: Array<{ prompt_id: string; choice_value: string; freeform_text?: string }> = []
  const inertUserTurns: Array<{ text: string; speaker_user_id: string }> = []
  let priorResolved = false
  const store = {
    async listHistoryByTopic(_i: unknown) {
      return { turns: [{ prompt_id: 'pid-prior', resolved: priorResolved }] }
    },
    async resolve(input: { choice: { prompt_id: string; choice_value: string; freeform_text?: string } }) {
      priorResolved = true
      resolves.push({
        prompt_id: input.choice.prompt_id,
        choice_value: input.choice.choice_value,
        ...(input.choice.freeform_text !== undefined
          ? { freeform_text: input.choice.freeform_text }
          : {}),
      })
      return { ok: true }
    },
    async persistInertUserTurn(input: { text: string; speaker_user_id: string }) {
      inertUserTurns.push({ text: input.text, speaker_user_id: input.speaker_user_id })
      return { prompt_id: `pid-inert-${inertUserTurns.length}` }
    },
  }
  return { store, resolves, inertUserTurns }
}

interface HarnessOpts {
  mode?: AgentEngagementMode
  wireReader?: boolean
  wireDelegate?: boolean
}

async function makeHarness(opts: HarnessOpts = {}) {
  const sent: ChatOutbound[] = []
  const turns: LiveAgentTurnRequest[] = []
  const delegations: Array<{ project_id: string; task: string; kind: string }> = []
  const state = completedState()

  const stateStore = new InMemoryOnboardingStateStore({ now: () => 1_000 })
  await stateStore.upsert({
    project_slug: state.project_slug,
    user_id: state.user_id,
    phase: state.phase,
    phase_state_patch: state.phase_state,
  })

  const { publicKey } = await generateKeyPair('EdDSA', { extractable: true })
  const verifying: StartTokenVerificationKey = {
    kid: 'kid-test',
    publicKey: publicKey as KeyLike,
  }
  const { store: buttonStore, resolves, inertUserTurns } = makeFakeButtonStore()

  const bridge = buildWebChatBridge({
    expected_project_slug: 'alice',
    resolveKey: async (kid) => (kid === verifying.kid ? verifying.publicKey : null),
    consumedTokens: new InMemoryConsumedTokens(),
    verifyStartToken,
    claimStartTokenJti,
    engine: makeNoopEngine(state),
    registry: new InMemoryWebChatSenderRegistry(),
    onboardingStateStore: stateStore,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buttonStore: buttonStore as any,
    liveAgentTurn: async (input: LiveAgentTurnRequest) => {
      turns.push(input)
      input.send({ type: 'agent_message', body: `echo: ${input.user_text}` })
    },
    ...(opts.wireReader === false
      ? {}
      : {
          resolveEngagementMode: async (_project_id: string): Promise<AgentEngagementMode> =>
            opts.mode ?? 'all_messages',
        }),
    ...(opts.wireDelegate
      ? {
          delegateDispatch: async (d: {
            project_id: string
            task: string
            kind: 'research' | 'review' | 'adhoc'
          }) => {
            delegations.push({ project_id: d.project_id, task: d.task, kind: d.kind })
          },
        }
      : {}),
  })

  const send = (e: ChatOutbound): void => {
    sent.push(e)
  }
  const post = (body: string) =>
    bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'user_message', body },
      send,
      active_topic_id: 'web:u-1:projx',
    })

  return { sent, turns, delegations, resolves, inertUserTurns, post }
}

const types = (sent: ChatOutbound[]) => sent.map((e) => e.type)

describe('engagement mode — all_messages (default)', () => {
  test('every project-topic post triggers an agent turn (no mention needed)', async () => {
    const h = await makeHarness({ mode: 'all_messages' })
    await h.post('team, where are we on the launch?')
    expect(h.turns).toHaveLength(1)
    expect(h.turns[0]!.user_text).toBe('team, where are we on the launch?')
    expect(h.turns[0]!.project_id).toBe('projx')
    expect(types(h.sent)).toContain('agent_message')
  })

  test('reader unwired falls back to all_messages (Open box / legacy)', async () => {
    const h = await makeHarness({ wireReader: false })
    await h.post('no reader wired here')
    expect(h.turns).toHaveLength(1)
  })
})

describe('engagement mode — tag_gated', () => {
  test('non-mention post PERSISTS to transcript but triggers NO agent turn', async () => {
    const h = await makeHarness({ mode: 'tag_gated' })
    await h.post('just chatting with the team about lunch')
    // No agent turn…
    expect(h.turns).toHaveLength(0)
    // …no typing indicator…
    expect(types(h.sent)).not.toContain('agent_typing_start')
    // …no agent reply, only a no-render ack to clear optimistic dots…
    expect(types(h.sent)).not.toContain('agent_message')
    expect(types(h.sent)).toContain('agent_ack')
    // …but the message DID persist to the shared transcript.
    expect(h.resolves).toHaveLength(1)
    expect(h.resolves[0]!.choice_value).toBe('__freeform__')
    expect(h.resolves[0]!.freeform_text).toBe('just chatting with the team about lunch')
  })

  test('CONSECUTIVE non-mention posts each persist (no dropped transcript message)', async () => {
    // Codex review 2026-06-26: after the first quiet message resolves the prior
    // unresolved row, the second has no open row to attach to — it MUST persist
    // as its own durable inert user turn, not silently vanish from history.
    const h = await makeHarness({ mode: 'tag_gated' })
    await h.post('first quiet message')
    await h.post('second quiet message')
    await h.post('third quiet message')
    expect(h.turns).toHaveLength(0)
    // First stamped onto the prior unresolved agent prompt…
    expect(h.resolves).toHaveLength(1)
    expect(h.resolves[0]!.freeform_text).toBe('first quiet message')
    // …the next two persisted as standalone durable user turns.
    expect(h.inertUserTurns.map((t) => t.text)).toEqual([
      'second quiet message',
      'third quiet message',
    ])
  })

  test('@neutron question triggers an INLINE agent turn', async () => {
    const h = await makeHarness({ mode: 'tag_gated' })
    await h.post('@neutron what is the launch status?')
    expect(h.turns).toHaveLength(1)
    expect(h.turns[0]!.user_text).toBe('@neutron what is the launch status?')
    expect(h.delegations).toHaveLength(0)
    expect(types(h.sent)).toContain('agent_message')
  })

  test('@neutron TASK with delegate hook wired hands off to agent-dispatch (no inline turn)', async () => {
    const h = await makeHarness({ mode: 'tag_gated', wireDelegate: true })
    await h.post('@neutron research the competitor pricing and report back')
    // Delegated, not answered inline…
    expect(h.turns).toHaveLength(0)
    expect(h.delegations).toHaveLength(1)
    expect(h.delegations[0]!.project_id).toBe('projx')
    expect(h.delegations[0]!.kind).toBe('research')
    expect(h.delegations[0]!.task).toBe('research the competitor pricing and report back')
    // …the requester's turn persisted + an inline ack bubble was sent.
    expect(h.resolves).toHaveLength(1)
    const reply = h.sent.find((e) => e.type === 'agent_message') as { body: string } | undefined
    expect(reply?.body).toContain('background')
  })

  test('@neutron TASK with NO delegate hook wired falls back to an inline turn', async () => {
    const h = await makeHarness({ mode: 'tag_gated', wireDelegate: false })
    await h.post('@neutron build the export pipeline')
    expect(h.turns).toHaveLength(1)
    expect(h.delegations).toHaveLength(0)
  })
})
