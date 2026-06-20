/**
 * Chat-bridge topic_switch handler (2026-05-29 in-place sprint).
 *
 * Verifies the production `buildWebChatBridge` handler:
 *   1. Accepts a valid `topic_switch` event and rebinds the registry
 *      sender from the OLD topic to the NEW topic (the engine emit
 *      routing keys on the active sender).
 *   2. Rejects malformed / cross-user topic_ids with an error
 *      envelope.
 *   3. Cross-user topic_id (different user_id prefix) is rejected (no
 *      scope leak).
 *   4. Engine emit after the switch routes to the new wire_topic_id
 *      (verifies the sender registry transitioned correctly).
 *   5. updateActiveTopicId callback fires with the new id so the
 *      WebSocket-server's per-socket state stays in sync.
 *
 * Mirrors the test fixture shape from `chat-bridge.test.ts` (FakeEngine,
 * jose key pair, InMemoryWebChatSenderRegistry).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPair, type KeyLike } from 'jose'
import {
  buildWebChatBridge,
  InMemoryWebChatSenderRegistry,
} from '../chat-bridge.ts'
import {
  InMemoryConsumedTokens,
  verifyStartToken,
  claimStartTokenJti,
  type StartTokenSigningKey,
  type StartTokenVerificationKey,
} from '@neutronai/runtime/__tests__/start-token-testkit.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import { buildButtonPrompt } from '../../../channels/button-primitive.ts'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import type { ChatOutbound } from '../../../landing/server.ts'
import type {
  AdvanceInput,
  AdvanceResult,
  InterviewEngine,
  StartInput,
  StartResult,
} from '../../../onboarding/interview/engine.ts'
import type { OnboardingState } from '../../../onboarding/interview/state-store.ts'

async function makeKeyPair(): Promise<{ verifying: StartTokenVerificationKey }> {
  const { publicKey } = await generateKeyPair('EdDSA', { extractable: true })
  return {
    verifying: { kid: 'kid-test', publicKey: publicKey as KeyLike },
  }
}

function makeResolveKey(verifying: StartTokenVerificationKey): (kid: string) => Promise<KeyLike | null> {
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
    attempt_id: 'a-1',
  }
}

function makeFakeEngine(): InterviewEngine {
  const s = fakeState()
  const startResult: StartResult = { prompt_id: 'pid-1', was_new: true, state: s }
  const advanceResult: AdvanceResult = { outcome: 'advanced', state: s }
  return {
    async start(_: StartInput): Promise<StartResult> {
      return startResult
    },
    async advance(_: AdvanceInput): Promise<AdvanceResult> {
      return advanceResult
    },
    async recordInboundReceived(): Promise<void> {},
    async tick(): Promise<void> {},
    async emitCurrentPhasePrompt(): Promise<AdvanceResult> {
      return advanceResult
    },
  } as unknown as InterviewEngine
}

async function makeBridge(
  reg = new InMemoryWebChatSenderRegistry(),
  buttonStore?: ButtonStore,
) {
  const { verifying } = await makeKeyPair()
  return {
    bridge: buildWebChatBridge({
      expected_project_slug: 'alice',
      resolveKey: makeResolveKey(verifying),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: reg,
      ...(buttonStore !== undefined ? { buttonStore } : {}),
    }),
    reg,
  }
}

describe('chat-bridge topic_switch (2026-05-29 in-place sprint)', () => {
  test('1. valid topic_switch from web:<user_id> to web:<user_id>:<project_id> rebinds the registry', async () => {
    const { bridge, reg } = await makeBridge()
    const oldSent: ChatOutbound[] = []
    const newRegistered: ChatOutbound[] = []
    const send = (e: ChatOutbound): void => {
      if (e.type === 'topic_switched') newRegistered.push(e)
      else oldSent.push(e)
    }
    // Pre-register at the OLD topic to simulate the prior bind from
    // startSession / handleInbound on General.
    reg.register('web:u-1', send)
    let activeTopicId: string | undefined = 'web:u-1'
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'topic_switch', new_topic_id: 'web:u-1:topline' },
      send,
      active_topic_id: activeTopicId,
      updateActiveTopicId: (id) => {
        activeTopicId = id
      },
    })
    // Ack envelope landed.
    expect(newRegistered).toHaveLength(1)
    expect(newRegistered[0]!.type).toBe('topic_switched')
    if (newRegistered[0]!.type === 'topic_switched') {
      expect(newRegistered[0]!.topic_id).toBe('web:u-1:topline')
    }
    // Active topic id updated.
    expect(activeTopicId).toBe('web:u-1:topline')
    // OLD topic no longer has a sender.
    expect(reg.has('web:u-1')).toBe(false)
    // NEW topic does.
    expect(reg.has('web:u-1:topline')).toBe(true)
  })

  test('2. invalid topic_id (not under the user prefix) -> error envelope + no rebind', async () => {
    const { bridge, reg } = await makeBridge()
    const sent: ChatOutbound[] = []
    const send = (e: ChatOutbound): void => {
      sent.push(e)
    }
    reg.register('web:u-1', send)
    let activeTopicId: string | undefined = 'web:u-1'
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'topic_switch', new_topic_id: 'web:other-user:topline' },
      send,
      active_topic_id: activeTopicId,
      updateActiveTopicId: (id) => {
        activeTopicId = id
      },
    })
    // Error envelope back to client.
    expect(sent).toHaveLength(1)
    expect(sent[0]!.type).toBe('error')
    // Active topic id unchanged.
    expect(activeTopicId).toBe('web:u-1')
    // OLD topic STILL has a sender; no rebind happened.
    expect(reg.has('web:u-1')).toBe(true)
  })

  test('3. cross-user topic_id with NO web: prefix (random string) is rejected', async () => {
    const { bridge, reg } = await makeBridge()
    const sent: ChatOutbound[] = []
    const send = (e: ChatOutbound): void => {
      sent.push(e)
    }
    reg.register('web:u-1', send)
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'topic_switch', new_topic_id: 'tg:12345:67890' },
      send,
      active_topic_id: 'web:u-1',
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.type).toBe('error')
    expect(reg.has('web:u-1')).toBe(true)
    expect(reg.has('tg:12345:67890')).toBe(false)
  })

  test('4. after a successful switch, registry.send delivers via the NEW topic_id', async () => {
    const { bridge, reg } = await makeBridge()
    const collected: ChatOutbound[] = []
    const send = (e: ChatOutbound): void => {
      collected.push(e)
    }
    reg.register('web:u-1', send)
    let activeTopicId: string | undefined = 'web:u-1'
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'topic_switch', new_topic_id: 'web:u-1:topline' },
      send,
      active_topic_id: activeTopicId,
      updateActiveTopicId: (id) => {
        activeTopicId = id
      },
    })
    // The bridge sent the topic_switched ack -- drop it so the next
    // assertion sees the engine emit clean.
    collected.length = 0
    // Send via the OLD topic_id -- should NOT deliver (no sender).
    expect(reg.send('web:u-1', { type: 'agent_message', body: 'old' })).toBe(false)
    // Send via the NEW topic_id -- SHOULD deliver.
    expect(reg.send('web:u-1:topline', { type: 'agent_message', body: 'new' })).toBe(true)
    expect(collected).toHaveLength(1)
    expect(collected[0]!.type).toBe('agent_message')
    if (collected[0]!.type === 'agent_message') {
      expect(collected[0]!.body).toBe('new')
    }
  })

  test('6. topic_switch to a project topic with an unresolved seed re-emits the seed as agent_message', async () => {
    // r2 BLOCKER fix — emitProjectSeeds writes one button_prompts row
    // per project at `web:<user>:<project_id>`. Pre-r2 the bridge
    // rebound the registry on topic_switch but never lifted that row
    // onto the wire; the project topic rendered blank. Verify the
    // bridge re-emits the seed as a live `agent_message` so the
    // client's renderAgent path paints the buttons.
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-chat-bridge-seed-reemit-'))
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    try {
      applyMigrations(db.raw())
      const store = new ButtonStore({ db })
      const generalTopic = 'web:u-1'
      const projectTopic = `${generalTopic}:topline`
      // Seed an unresolved row at the project topic, the same shape
      // the production `buildOnboardingHandoffHook` writes.
      const seed = buildButtonPrompt({
        body: 'I have Topline on file from your imports.\n\nWant me to triage the threads?',
        options: [
          { label: 'A', body: 'Triage the threads', value: 'show-context' },
          { label: 'B', body: 'Tell me what you know', value: 'tell-me-what-you-know' },
          { label: 'C', body: 'Not now', value: 'not-now' },
        ],
        allow_freeform: true,
        idempotency: {
          project_slug: 'alice',
          topic_id: projectTopic,
          seed: 'onboarding_handoff_seed',
        },
      })
      await store.emit(seed, { topic_id: projectTopic })

      const { bridge, reg } = await makeBridge(undefined, store)
      const sent: ChatOutbound[] = []
      const send = (e: ChatOutbound): void => {
        sent.push(e)
      }
      reg.register(generalTopic, send)
      let activeTopicId: string | undefined = generalTopic
      await bridge.handleInbound({
        project_slug: 'alice',
        user_id: 'u-1',
        event: { type: 'topic_switch', new_topic_id: projectTopic },
        send,
        active_topic_id: activeTopicId,
        updateActiveTopicId: (id) => {
          activeTopicId = id
        },
      })

      // Two envelopes: the seed re-emit FIRST (so the client renders
      // it into the just-cleared #log), then the topic_switched ack
      // SECOND (which resolves the switch Promise and triggers
      // history hydration).
      expect(sent.length).toBeGreaterThanOrEqual(2)
      const agentIdx = sent.findIndex((e) => e.type === 'agent_message')
      const ackIdx = sent.findIndex((e) => e.type === 'topic_switched')
      expect(agentIdx).toBeGreaterThanOrEqual(0)
      expect(ackIdx).toBeGreaterThan(agentIdx)
      const agentMsg = sent[agentIdx]
      if (agentMsg !== undefined && agentMsg.type === 'agent_message') {
        expect(agentMsg.prompt_id).toBe(seed.prompt_id)
        expect(agentMsg.body).toContain('Topline')
        expect(agentMsg.options).toBeDefined()
        expect(agentMsg.options?.length).toBe(3)
        expect(agentMsg.allow_freeform).toBe(true)
      } else {
        throw new Error('expected agent_message envelope')
      }
    } finally {
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('7. topic_switch to a project topic with a RESOLVED row does NOT re-emit', async () => {
    // Once the seed is resolved, switching back to the topic must
    // NOT re-fire the active-prompt envelope (would duplicate as a
    // bubble above whatever follow-up the per-project agent emits).
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-chat-bridge-seed-resolved-'))
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    try {
      applyMigrations(db.raw())
      const store = new ButtonStore({ db })
      const generalTopic = 'web:u-1'
      const projectTopic = `${generalTopic}:topline`
      const seed = buildButtonPrompt({
        body: 'Resolved seed',
        options: [
          { label: 'A', body: 'A', value: 'a' },
          { label: 'B', body: 'B', value: 'b' },
        ],
      })
      await store.emit(seed, { topic_id: projectTopic })
      // Resolve the row — mirrors a prior tap on the seed.
      await store.resolve({
        choice: {
          prompt_id: seed.prompt_id,
          choice_value: 'a',
          chosen_at: Date.now(),
          speaker_user_id: 'u-1',
          channel_kind: 'app-socket',
        },
      })

      const { bridge, reg } = await makeBridge(undefined, store)
      const sent: ChatOutbound[] = []
      const send = (e: ChatOutbound): void => {
        sent.push(e)
      }
      reg.register(generalTopic, send)
      await bridge.handleInbound({
        project_slug: 'alice',
        user_id: 'u-1',
        event: { type: 'topic_switch', new_topic_id: projectTopic },
        send,
        active_topic_id: generalTopic,
      })

      // Only the topic_switched ack — no agent_message because the
      // latest row is resolved.
      const agentEnvelopes = sent.filter((e) => e.type === 'agent_message')
      expect(agentEnvelopes).toHaveLength(0)
      const ack = sent.find((e) => e.type === 'topic_switched')
      expect(ack).toBeDefined()
    } finally {
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('8. topic_switch with no buttonStore wired is a clean no-op (no re-emit, ack still fires)', async () => {
    // Open self-hoster path / legacy test composer: omitting
    // `buttonStore` in BuildWebChatBridgeOptions must not break the
    // switch path. Ack still ships; no agent_message is fabricated.
    const { bridge, reg } = await makeBridge()
    const sent: ChatOutbound[] = []
    const send = (e: ChatOutbound): void => {
      sent.push(e)
    }
    reg.register('web:u-1', send)
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'topic_switch', new_topic_id: 'web:u-1:topline' },
      send,
      active_topic_id: 'web:u-1',
    })
    expect(sent.find((e) => e.type === 'agent_message')).toBeUndefined()
    expect(sent.find((e) => e.type === 'topic_switched')).toBeDefined()
  })

  test('5. switching to the same topic is a no-op ack (idempotent client retry)', async () => {
    const { bridge, reg } = await makeBridge()
    const sent: ChatOutbound[] = []
    const send = (e: ChatOutbound): void => {
      sent.push(e)
    }
    reg.register('web:u-1:topline', send)
    let activeTopicId: string | undefined = 'web:u-1:topline'
    await bridge.handleInbound({
      project_slug: 'alice',
      user_id: 'u-1',
      event: { type: 'topic_switch', new_topic_id: 'web:u-1:topline' },
      send,
      active_topic_id: activeTopicId,
      updateActiveTopicId: (id) => {
        activeTopicId = id
      },
    })
    // Ack still fires (so the client's pending-switch resolver
    // doesn't dangle).
    expect(sent).toHaveLength(1)
    expect(sent[0]!.type).toBe('topic_switched')
    // No registry churn.
    expect(reg.has('web:u-1:topline')).toBe(true)
  })
})
