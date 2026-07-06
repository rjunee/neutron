// DIES WITH K11b1 — pins the router state_delta allow-key guard (engine.ts ROUTER_AMEND_ALLOWED_KEYS / whitelistRouterStateDelta), deleted wholesale in K11b1 per D-K11-6
/**
 * phase_state router-amend WHITELIST contract.
 *
 * WHITELIST (engine.ts `ROUTER_AMEND_ALLOWED_KEYS` /
 *   `ROUTER_AMEND_SUBSTRATE_VALUES` via `whitelistRouterStateDelta`):
 *   the LLM router's `amend` `state_delta` may only write the
 *   user-visible required fields + a small allow-list; bookkeeping
 *   columns (`created_at`, `owner_id`, `active_prompt_id`, …) MUST be
 *   dropped before they reach `stateStore.upsert`.
 *
 * This is a LIVE security boundary at current HEAD — the guard is still
 * exported and applied (engine.ts). It is deleted WHOLESALE inside K11b1
 * alongside the interview engine's conversational drive
 * (`dispatchRouterDecision` / `whitelistRouterStateDelta`); this file is
 * co-deleted in the same K11b1 PR. Until then it keeps the boundary
 * covered — a mutant that widens the allow-list (e.g. adds `phase`) or
 * lets a bookkeeping key through must fail here.
 *
 * It legitimately drives the REAL whitelist through `engine.advance` (no
 * mocks past the seam; only the LLM router decision is stubbed) — the
 * `engine.advance` usage below is EXPECTED and dies with K11b1.
 *
 * Split out of `phase-state-contract.test.ts` in K11a6-rem so the
 * retained `phase_state` MERGE contract could re-anchor onto the
 * `stateStore.upsert` seam (zero `engine.advance`) while this half stays
 * intact until its guard is deleted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import {
  InterviewEngine,
  ROUTER_AMEND_ALLOWED_KEYS,
  ROUTER_AMEND_SUBSTRATE_VALUES,
} from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import type { RouterDecision } from '../llm-router.ts'
import {
  stubRouter,
  stubPlatform,
} from '@neutronai/onboarding/interview/__tests__/interview-testkit.ts'

// ---------------------------------------------------------------------------
// Router-amend WHITELIST contract.
// ---------------------------------------------------------------------------

describe('phase_state WHITELIST contract — ROUTER_AMEND_ALLOWED_KEYS', () => {
  test('the allow-list is exactly the user-visible required fields + the documented extras', () => {
    // Pins the canonical surface so a D9 split (or an accidental widening)
    // that adds a bookkeeping key to the router allow-list trips this test.
    expect([...ROUTER_AMEND_ALLOWED_KEYS].sort()).toEqual(
      [
        'agent_name',
        'agent_personality',
        'ai_substrate_available',
        'ai_substrate_used',
        'auxiliary_facts',
        'non_work_interests',
        'primary_projects',
        'user_first_name',
      ].sort(),
    )
  })

  test('the substrate-value allow-list is exactly {chatgpt, claude}', () => {
    expect([...ROUTER_AMEND_SUBSTRATE_VALUES].sort()).toEqual(['chatgpt', 'claude'])
  })

  // Drive the REAL whitelist through engine.advance (no mocks past the seam;
  // only the LLM router decision is stubbed). Mirrors the production amend
  // path: a router `amend` on signup that carries a valid `user_first_name`
  // auto-advances and merges the WHITELISTED key, while bookkeeping keys in
  // the same state_delta are dropped before stateStore.upsert.
  let tmp: string
  let db: ProjectDb
  let stateStore: InMemoryOnboardingStateStore
  let transcript: TranscriptWriter
  let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

  const OWNER = 't1'
  const TOPIC = 'topic-1'
  const USER = 'u-1'
  const NOW_MS = Date.now()

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-phase-state-wl-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
    stateStore = new InMemoryOnboardingStateStore()
    transcript = new TranscriptWriter({ path: join(tmp, 'persona', 't.jsonl') })
    sentPrompts = []
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function buildEngine(decisions: RouterDecision[]): InterviewEngine {
    const { router } = stubRouter(decisions)
    return new InterviewEngine({
      buttonStore: new ButtonStore({ db }),
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push(input)
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
      llmRouter: router,
      platform: stubPlatform('all'),
    })
  }

  async function reachSignupAndEmit(engine: InterviewEngine): Promise<void> {
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'signup',
      phase_state_patch: { topic_id: TOPIC, user_id: USER, signup_via: 'web' },
      advanced_at: NOW_MS,
    })
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: NOW_MS,
    })
    sentPrompts.length = 0
  }

  test('whitelisted keys land in phase_state; bookkeeping keys are dropped before upsert', async () => {
    const originalWarn = console.warn
    const warns: string[] = []
    console.warn = (...args: unknown[]) => {
      warns.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
    }
    try {
      const engine = buildEngine([
        {
          action: 'amend',
          confidence: 0.92,
          choice_value: null,
          freeform_text: null,
          response: 'Got it.',
          state_delta: {
            // ALLOWED
            user_first_name: 'Doe',
            auxiliary_facts: { call_me: 'Doe' },
            // REJECTED — bookkeeping / identity / control columns
            created_at: '1970-01-01T00:00:00Z',
            owner_id: 'attacker',
            active_prompt_id: 'attacker-prompt',
            phase: 'completed',
          } as unknown as Record<string, unknown>,
          reasoning: 'contract test',
        },
      ])
      await reachSignupAndEmit(engine)
      const out = await engine.advance({
        project_slug: OWNER,
        topic_id: TOPIC,
        user_id: USER,
        channel_kind: 'app-socket',
        observed_at: NOW_MS,
        freeform_text: 'I want it to call me Doe',
      })
      const phase_state = (out.state?.phase_state ?? {}) as Record<string, unknown>
      // Whitelisted keys survived the merge.
      expect(phase_state['user_first_name']).toBe('Doe')
      expect(phase_state['auxiliary_facts']).toEqual({ call_me: 'Doe' })
      // Bookkeeping keys were dropped by whitelistRouterStateDelta.
      expect(phase_state['created_at']).toBeUndefined()
      expect(phase_state['owner_id']).toBeUndefined()
      expect(phase_state['active_prompt_id']).not.toBe('attacker-prompt')
      // The rejection is logged, naming each dropped key.
      const warnLine = warns.find((w) => w.includes('rejected non-whitelisted keys'))
      expect(warnLine).toBeDefined()
      expect(warnLine).toContain('created_at')
      expect(warnLine).toContain('owner_id')
      expect(warnLine).toContain('active_prompt_id')
      expect(warnLine).toContain('phase')
    } finally {
      console.warn = originalWarn
    }
  })
})
