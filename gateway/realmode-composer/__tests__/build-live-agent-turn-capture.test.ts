/**
 * BUG 1/2 (2026-06-30, Ryan live test) — the runner side of the deterministic
 * button-backed answer capture in `build-live-agent-turn.ts`.
 *
 * Asserts:
 *   1. `captureRequiredAnswer` runs at turn-START — BEFORE the step-guard
 *      grounding (`onboardingContext`) reads phase_state — so a settled field is
 *      visible to the same turn and never re-asked (BUG 1).
 *   2. When capture returns `finalized: true` (the answer settled the LAST
 *      required field + finalize fired), the runner SUPPRESSES its own wrap-up:
 *      no substrate dispatch, no agent_message — the deterministic finalize
 *      closing is the ONE closing (BUG 2).
 *   3. `finalized: false` runs the turn normally (dispatch happens).
 *   4. The synthetic seed turn never triggers capture (no answer to capture).
 *
 * Stubbed substrate (no real `claude` spawn); REAL ButtonStore over a migrated
 * project.db so the user-turn persistence path runs the gateway's own SQL.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ChatOutbound } from '../../../landing/server.ts'
import type { Event } from '../../../runtime/events.ts'
import type { AgentSpec, Substrate } from '../../../runtime/substrate.ts'
import type { SessionHandle } from '../../../runtime/session-handle.ts'
import { buildLiveAgentTurn, type LiveAgentOnboardingSeam } from '../build-live-agent-turn.ts'
import type { LiveAgentTurnRequest } from '../../http/chat-bridge.ts'

let tmp: string
let db: ProjectDb
let store: ButtonStore
let now = 1_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-lat-cap-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  now = 1_000_000
  store = new ButtonStore({ db, now: () => now })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeStubSubstrate(reply: string, specs: AgentSpec[]): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield { kind: 'token', text: reply }
        yield {
          kind: 'completion',
          usage: { input_tokens: 1, output_tokens: 1 },
          substrate_instance_id: 'stub',
        }
      })()
      return {
        events,
        async respondToTool(): Promise<void> {
          throw new Error('not used')
        },
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

interface SeamProbe {
  seam: LiveAgentOnboardingSeam
  order: string[]
  captureCalls: Array<{ user_text: string; prior_agent_text: string | null }>
}

function makeSeam(opts: { finalized: boolean }): SeamProbe {
  const order: string[] = []
  const captureCalls: Array<{ user_text: string; prior_agent_text: string | null }> = []
  const seam: LiveAgentOnboardingSeam = {
    isActive: async (): Promise<boolean> => true,
    systemPreamble: (): string => '<onboarding>preamble</onboarding>',
    uploadAffordance: (): { source: 'chatgpt' | 'claude' } | null => null,
    onboardingContext: async (): Promise<string | null> => {
      order.push('context')
      return '<onboarding_required_steps>guard</onboarding_required_steps>'
    },
    captureRequiredAnswer: async (input): Promise<{ finalized: boolean }> => {
      order.push('capture')
      captureCalls.push({ user_text: input.user_text, prior_agent_text: input.prior_agent_text })
      return { finalized: opts.finalized }
    },
    onTurnComplete: (): void => {},
  }
  return { seam, order, captureCalls }
}

function makeRunner(reply: string, seam: LiveAgentOnboardingSeam, specs: AgentSpec[]) {
  return buildLiveAgentTurn({
    substrate: makeStubSubstrate(reply, specs),
    personaLoader: { load: async (): Promise<string> => '' },
    buttonStore: store,
    onboarding: seam,
    project_slug: 'alice',
    owner_home: tmp,
    model: 'test-model',
    now: () => now,
  })
}

function makeTurn(sent: ChatOutbound[], over?: Partial<LiveAgentTurnRequest>): LiveAgentTurnRequest {
  return {
    project_slug: 'alice',
    user_id: 'u-1',
    topic_id: 'app:u-1',
    user_text: 'Agamotto',
    send: (e) => sent.push(e),
    observed_at: now,
    ...over,
  }
}

describe('build-live-agent-turn — deterministic capture (BUG 1)', () => {
  test('capture runs BEFORE the step-guard grounding reads phase_state', async () => {
    const specs: AgentSpec[] = []
    const probe = makeSeam({ finalized: false })
    const run = makeRunner('Great choice.', probe.seam, specs)
    await run(makeTurn([]))
    // The answer must be captured/persisted before the guard is rebuilt, else
    // the guard re-injects the just-answered step (the re-ask bug).
    expect(probe.order).toEqual(['capture', 'context'])
    expect(probe.captureCalls).toHaveLength(1)
    expect(probe.captureCalls[0]!.user_text).toBe('Agamotto')
  })

  test('finalized:false runs the turn normally (substrate dispatched)', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const probe = makeSeam({ finalized: false })
    const run = makeRunner('Great choice.', probe.seam, specs)
    const result = await run(makeTurn(sent))
    expect(result.outcome).toBe('replied')
    expect(specs).toHaveLength(1) // dispatched
    expect(sent.some((e) => e.type === 'agent_message')).toBe(true)
  })
})

describe('build-live-agent-turn — wrap-up suppression on finalize (BUG 2)', () => {
  test('finalized:true suppresses the live wrap-up — no dispatch, no agent_message', async () => {
    const specs: AgentSpec[] = []
    const sent: ChatOutbound[] = []
    const probe = makeSeam({ finalized: true })
    const run = makeRunner('We are all set! Your projects are in the left rail.', probe.seam, specs)
    const result = await run(makeTurn(sent))
    expect(result.outcome).toBe('replied')
    expect(result.reply_prompt_id).toBeNull()
    // The whole point: the agent's own closing turn is suppressed so the
    // deterministic finalize closing is the ONLY closing.
    expect(specs).toHaveLength(0) // NOT dispatched
    expect(sent.filter((e) => e.type === 'agent_message')).toHaveLength(0)
    // The guard grounding is never even built — we short-circuited before it.
    expect(probe.order).toEqual(['capture'])
  })

  test('the settling answer is still persisted as the user bubble', async () => {
    const sent: ChatOutbound[] = []
    const probe = makeSeam({ finalized: true })
    // Seed a prior agent row so the user turn has something to resolve onto.
    const run = makeRunner('irrelevant', probe.seam, [])
    await run(makeTurn(sent, { user_text: 'Agamotto' }))
    // An inert user-turn row was persisted for the settling answer (history keeps
    // the owner's final message even though the agent turn was suppressed).
    const { turns } = await store.listHistoryByTopic({
      topic_id: 'app:u-1',
      before: now + 1,
      before_prompt_id: null,
      limit: 20,
      now: now + 1,
    })
    const texts = turns
      .map((t) => t.resolution_text)
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
    expect(texts.some((t) => t.includes('Agamotto'))).toBe(true)
  })
})

describe('build-live-agent-turn — seed turn never captures', () => {
  test('a synthetic seed turn does not call captureRequiredAnswer', async () => {
    const specs: AgentSpec[] = []
    const probe = makeSeam({ finalized: false })
    const run = makeRunner('Hey, welcome in! What should I call you?', probe.seam, specs)
    await run(makeTurn([], { seed_turn: true, user_text: '(system: greet them)' }))
    expect(probe.captureCalls).toHaveLength(0)
    expect(specs).toHaveLength(1) // seed still dispatches the opener
  })
})
