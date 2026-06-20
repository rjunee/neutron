/**
 * Chat-bridge seed re-emit race tests (ISSUES #70).
 *
 * Verifies the topic-identity guard on `reEmitActiveSeedPromptIfAny`:
 * when the user rapidly switches A → B (or A → B → A), the slow DB
 * round-trip in topic A's re-emit MUST NOT paint A's seed into B's
 * just-cleared `#log`. The bridge re-reads ws.data.active_topic_id
 * (via the `getActiveTopicId` callback) right before `send(...)` and
 * drops the emit (logging `event=seed_reemit_superseded`) on mismatch.
 *
 * Mirrors the client-side `pendingTopicSwitchDestination` ack guard
 * introduced for the same rapid-switch shape in PR #338 r4.
 *
 * Race mechanic: a thin wrapper over the real `ButtonStore.get` gates
 * the FIRST call for seedA.prompt_id on a one-shot Promise. While that
 * call is suspended, additional `handleInbound` topic_switch calls
 * land on the same socket; each updates the local `activeTopicId`
 * cell. When the gate releases, the helper re-checks the cell via the
 * injected callback and drops the emit if the user has moved on.
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

async function makeBridge(buttonStore?: ButtonStore) {
  const { verifying } = await makeKeyPair()
  const reg = new InMemoryWebChatSenderRegistry()
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

/**
 * Yield once to the event loop so suspended async work can advance one
 * await-step. Used to ensure handleInbound calls reach the helper's
 * gated `buttonStore.get` before the next call is dispatched.
 */
async function yieldEventLoop(): Promise<void> {
  // setImmediate yields past the entire microtask queue + lets bun's
  // internal IO pump (the sqlite Promise-resolution scheduling) drain.
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

/**
 * Manual capture of `console.info` + `console.warn` lines.
 * `spyOn(console, 'info')` silently misses entries that fire inside
 * async resumptions (observed on Bun 1.3.9 — the spy returns no
 * mock.calls even though the line appears in stdout). A direct
 * property override on the global `console` object captures every
 * call deterministically and restores cleanly via the returned
 * `restore()` handle.
 *
 * The supersede-drop log uses `console.warn` (ops greps this on UI
 * complaints) and the emit / topic_switch_ok logs use `console.info`,
 * so the helper captures both into a single combined `lines` array
 * for filter-by-substring assertions.
 */
function captureConsoleInfo(): { lines: string[]; restore: () => void } {
  const originalInfo = console.info
  const originalWarn = console.warn
  const lines: string[] = []
  console.info = (...args: unknown[]): void => {
    if (typeof args[0] === 'string') {
      lines.push(args[0])
    }
    originalInfo(...args)
  }
  console.warn = (...args: unknown[]): void => {
    if (typeof args[0] === 'string') {
      lines.push(args[0])
    }
    originalWarn(...args)
  }
  return {
    lines,
    restore: () => {
      console.info = originalInfo
      console.warn = originalWarn
    },
  }
}

describe('chat-bridge seed re-emit topic-identity guard (ISSUES #70)', () => {
  let tmp: string
  let db: ProjectDb
  let store: ButtonStore

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-chat-bridge-seed-reemit-race-'))
    db = ProjectDb.open(join(tmp, 'owner.db'))
    applyMigrations(db.raw())
    store = new ButtonStore({ db })
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('1. baseline: single switch → seed re-emits normally (no superseded log)', async () => {
    const generalTopic = 'web:u-1'
    const projectTopic = `${generalTopic}:topline`
    const seed = buildButtonPrompt({
      body: 'Topline seed body.',
      options: [
        { label: 'A', body: 'A', value: 'a' },
        { label: 'B', body: 'B', value: 'b' },
      ],
    })
    await store.emit(seed, { topic_id: projectTopic })

    const { bridge, reg } = await makeBridge(store)
    const sent: ChatOutbound[] = []
    const send = (e: ChatOutbound): void => {
      sent.push(e)
    }
    reg.register(generalTopic, send)
    let activeTopicId: string | undefined = generalTopic

    const capture = captureConsoleInfo()
    try {
      await bridge.handleInbound({
        project_slug: 'alice',
        user_id: 'u-1',
        event: { type: 'topic_switch', new_topic_id: projectTopic },
        send,
        active_topic_id: activeTopicId,
        updateActiveTopicId: (id) => {
          activeTopicId = id
        },
        getActiveTopicId: () => activeTopicId,
      })
    } finally {
      capture.restore()
    }

    // Seed re-emit lands first, then the ack.
    const agentMsgs = sent.filter((e) => e.type === 'agent_message')
    expect(agentMsgs).toHaveLength(1)
    const agent = agentMsgs[0]
    if (agent !== undefined && agent.type === 'agent_message') {
      expect(agent.prompt_id).toBe(seed.prompt_id)
    } else {
      throw new Error('expected one agent_message')
    }
    const ack = sent.find((e) => e.type === 'topic_switched')
    expect(ack).toBeDefined()
    if (ack !== undefined && ack.type === 'topic_switched') {
      expect(ack.topic_id).toBe(projectTopic)
    }

    // No superseded log on the baseline path.
    const supersededLines = capture.lines.filter((l) =>
      l.includes('event=seed_reemit_superseded'),
    )
    expect(supersededLines).toHaveLength(0)
  })

  test('2. rapid double switch A → B: A’s seed re-emit is dropped (event=seed_reemit_superseded), B emits cleanly', async () => {
    const generalTopic = 'web:u-1'
    const projectA = `${generalTopic}:topline`
    const projectB = `${generalTopic}:northwind`
    const seedA = buildButtonPrompt({
      body: 'Topline seed body.',
      options: [
        { label: 'A', body: 'A', value: 'a' },
        { label: 'B', body: 'B', value: 'b' },
      ],
    })
    const seedB = buildButtonPrompt({
      body: 'Northwind seed body.',
      options: [
        { label: 'A', body: 'A', value: 'a' },
        { label: 'B', body: 'B', value: 'b' },
      ],
    })
    await store.emit(seedA, { topic_id: projectA })
    await store.emit(seedB, { topic_id: projectB })

    // Gate seedA's `get` on a one-shot Promise so the FIRST get(seedA)
    // suspends until we manually release. Subsequent calls (e.g. on a
    // theoretical re-visit, not exercised in this case) bypass.
    let gateUsed = false
    let releaseGate!: () => void
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const realGet = store.get.bind(store)
    ;(store as { get: (prompt_id: string, now: number) => Promise<unknown> }).get = async (
      prompt_id: string,
      now: number,
    ) => {
      if (prompt_id === seedA.prompt_id && !gateUsed) {
        gateUsed = true
        await gatePromise
      }
      return realGet(prompt_id, now)
    }

    const { bridge, reg } = await makeBridge(store)
    const sent: ChatOutbound[] = []
    const send = (e: ChatOutbound): void => {
      sent.push(e)
    }
    reg.register(generalTopic, send)
    let activeTopicId: string | undefined = generalTopic

    const capture = captureConsoleInfo()
    try {
      // Fire A's switch — synchronously reaches the gated get(seedA).
      const promiseA = bridge.handleInbound({
        project_slug: 'alice',
        user_id: 'u-1',
        event: { type: 'topic_switch', new_topic_id: projectA },
        send,
        active_topic_id: activeTopicId,
        updateActiveTopicId: (id) => {
          activeTopicId = id
        },
        getActiveTopicId: () => activeTopicId,
      })
      // Yield so A's helper hits the gated get(seedA).
      await yieldEventLoop()
      expect(activeTopicId).toBe(projectA)

      // Fire B's switch while A is gated. B's helper is not gated and
      // emits seedB before yielding back to the gated A.
      const promiseB = bridge.handleInbound({
        project_slug: 'alice',
        user_id: 'u-1',
        event: { type: 'topic_switch', new_topic_id: projectB },
        send,
        active_topic_id: activeTopicId,
        updateActiveTopicId: (id) => {
          activeTopicId = id
        },
        getActiveTopicId: () => activeTopicId,
      })
      await yieldEventLoop()
      // Wait for B's full pipeline to drain (emit seedB + ack).
      await promiseB
      expect(activeTopicId).toBe(projectB)

      // Now release A's gate. A's helper re-reads getActiveTopicId()
      // and sees projectB ≠ projectA → drops the emit + logs
      // event=seed_reemit_superseded. A's ack still fires.
      releaseGate()
      await promiseA
    } finally {
      ;(store as { get: typeof realGet }).get = realGet
      capture.restore()
    }

    // B's seed re-emitted exactly once; A's seed never reached the wire.
    const agentMsgs = sent.filter((e) => e.type === 'agent_message')
    expect(agentMsgs).toHaveLength(1)
    const agent = agentMsgs[0]
    if (agent !== undefined && agent.type === 'agent_message') {
      expect(agent.prompt_id).toBe(seedB.prompt_id)
    } else {
      throw new Error('expected exactly one agent_message (for seedB)')
    }

    // Both acks still fire — the ack is independent of seed re-emit.
    const acks = sent.filter((e) => e.type === 'topic_switched')
    expect(acks).toHaveLength(2)

    // Drop log emitted with the exact event=seed_reemit_superseded
    // payload + requested/actual carrying the right topic ids.
    const supersededLines = capture.lines.filter((l) =>
      l.includes('event=seed_reemit_superseded'),
    )
    expect(supersededLines).toHaveLength(1)
    const line = supersededLines[0]!
    expect(line).toContain(`requested=${projectA}`)
    expect(line).toContain(`actual=${projectB}`)
    expect(line).toContain(`prompt=${seedA.prompt_id}`)
  })

  test('3. triple switch A → B → A: A’s seed re-emits cleanly on the return visit; only B is superseded', async () => {
    const generalTopic = 'web:u-1'
    const projectA = `${generalTopic}:topline`
    const projectB = `${generalTopic}:northwind`
    const seedA = buildButtonPrompt({
      body: 'Topline seed body.',
      options: [
        { label: 'A', body: 'A', value: 'a' },
        { label: 'B', body: 'B', value: 'b' },
      ],
    })
    const seedB = buildButtonPrompt({
      body: 'Northwind seed body.',
      options: [
        { label: 'A', body: 'A', value: 'a' },
        { label: 'B', body: 'B', value: 'b' },
      ],
    })
    await store.emit(seedA, { topic_id: projectA })
    await store.emit(seedB, { topic_id: projectB })

    // One-shot gate on the FIRST get(seedA). The SECOND call to
    // get(seedA) — fired by the user's return-visit handleInbound —
    // bypasses the gate so the second visit's helper emits cleanly
    // even while the first visit's helper is still suspended.
    let gateUsed = false
    let releaseGate!: () => void
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const realGet = store.get.bind(store)
    ;(store as { get: (prompt_id: string, now: number) => Promise<unknown> }).get = async (
      prompt_id: string,
      now: number,
    ) => {
      if (prompt_id === seedA.prompt_id && !gateUsed) {
        gateUsed = true
        await gatePromise
      }
      return realGet(prompt_id, now)
    }

    const { bridge, reg } = await makeBridge(store)
    const sent: ChatOutbound[] = []
    const send = (e: ChatOutbound): void => {
      sent.push(e)
    }
    reg.register(generalTopic, send)
    let activeTopicId: string | undefined = generalTopic

    const capture = captureConsoleInfo()
    try {
      // Switch 1: A.
      const promiseA1 = bridge.handleInbound({
        project_slug: 'alice',
        user_id: 'u-1',
        event: { type: 'topic_switch', new_topic_id: projectA },
        send,
        active_topic_id: activeTopicId,
        updateActiveTopicId: (id) => {
          activeTopicId = id
        },
        getActiveTopicId: () => activeTopicId,
      })
      await yieldEventLoop()

      // Switch 2: B (lands while A1 is gated).
      const promiseB = bridge.handleInbound({
        project_slug: 'alice',
        user_id: 'u-1',
        event: { type: 'topic_switch', new_topic_id: projectB },
        send,
        active_topic_id: activeTopicId,
        updateActiveTopicId: (id) => {
          activeTopicId = id
        },
        getActiveTopicId: () => activeTopicId,
      })
      await yieldEventLoop()

      // Switch 3: A (return-visit, lands while A1 is still gated).
      const promiseA2 = bridge.handleInbound({
        project_slug: 'alice',
        user_id: 'u-1',
        event: { type: 'topic_switch', new_topic_id: projectA },
        send,
        active_topic_id: activeTopicId,
        updateActiveTopicId: (id) => {
          activeTopicId = id
        },
        getActiveTopicId: () => activeTopicId,
      })
      // Drain B + A2 (the return-visit). A2's helper is not gated and
      // its emit-time getActiveTopicId() === projectA matches the
      // requested topic, so A's seed re-emits cleanly.
      await promiseB
      await promiseA2
      expect(activeTopicId).toBe(projectA)

      // Release A1's gate. A1's helper re-reads getActiveTopicId() and
      // sees projectA — which is what it requested. Whether A1 also
      // emits is implementation-detail (the snapshot at emit time
      // matches); either way the user ends up on A with A's seed
      // visible. Hard assertion: A's seed appears in sent[] at least
      // once because the supersede guard didn't permanently kill it.
      releaseGate()
      await promiseA1
    } finally {
      ;(store as { get: typeof realGet }).get = realGet
      capture.restore()
    }

    // A's seed re-emitted at least once — the return-visit's helper
    // (and/or A1's helper after the gate releases) found
    // activeTopicId === projectA at emit-time check and emitted
    // cleanly. The client dedups by prompt_id on its end.
    const agentMsgsForA = sent.filter(
      (e) => e.type === 'agent_message' && e.prompt_id === seedA.prompt_id,
    )
    expect(agentMsgsForA.length).toBeGreaterThanOrEqual(1)

    // Three acks total (one per switch). Acks are independent of seed
    // re-emit, so every switch acks regardless of guard outcome.
    const acks = sent.filter((e) => e.type === 'topic_switched')
    expect(acks).toHaveLength(3)
    const ackTopics = acks
      .map((e) => (e.type === 'topic_switched' ? e.topic_id : null))
      .filter((id): id is string => id !== null)
    expect(ackTopics).toContain(projectA)
    expect(ackTopics).toContain(projectB)
  })
})
