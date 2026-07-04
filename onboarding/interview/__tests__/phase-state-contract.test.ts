/**
 * phase_state JSON contract — whitelist + merge semantics (K4a verifier
 * amendment).
 *
 * The shared `phase_state` JSON object is written by ~113 test files and read
 * across the whole onboarding engine, yet its two load-bearing invariants were
 * pinned by NO focused test:
 *
 *   MERGE  (state-store.ts / sqlite-state-store.ts `upsert`): every upsert
 *          SHALLOW-merges `phase_state_patch` over the existing `phase_state`
 *          — patch keys override, unlisted keys are preserved, and a `null`
 *          value in the patch is STORED as null (this is how the engine
 *          CLEARS `active_prompt_id`). Both the in-memory and the SQLite
 *          (JSON-column) stores MUST agree so the engine can swap them.
 *
 *   WHITELIST (engine.ts `ROUTER_AMEND_ALLOWED_KEYS` /
 *          `ROUTER_AMEND_SUBSTRATE_VALUES` via `whitelistRouterStateDelta`):
 *          the LLM router's `amend` `state_delta` may only write the
 *          user-visible required fields + a small allow-list; bookkeeping
 *          columns (`created_at`, `owner_id`, `active_prompt_id`, …) MUST be
 *          dropped before they reach `stateStore.upsert`.
 *
 * This suite pins both BEFORE the later D9 engine splits move the code. It
 * drives the REAL merge (both real stores — no mocks past the store seam) and
 * the REAL whitelist (through `engine.advance` — the LLM is the only stubbed
 * seam; `whitelistRouterStateDelta` runs for real).
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
import {
  InMemoryOnboardingStateStore,
  type OnboardingStateStore,
} from '../state-store.ts'
import { SqliteOnboardingStateStore } from '../sqlite-state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import type { RouterDecision } from '../llm-router.ts'
import {
  stubRouter,
  stubPlatform,
} from '@neutronai/onboarding/interview/__tests__/interview-testkit.ts'

// ---------------------------------------------------------------------------
// Part A — store MERGE contract (both real stores).
// ---------------------------------------------------------------------------

describe('phase_state MERGE contract — both stores agree', () => {
  let tmp: string
  let db: ProjectDb
  let inMemory: InMemoryOnboardingStateStore
  let sqlite: SqliteOnboardingStateStore

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'neutron-phase-state-'))
    db = ProjectDb.open(join(tmp, 'project.db'))
    applyMigrations(db.raw())
    inMemory = new InMemoryOnboardingStateStore()
    sqlite = new SqliteOnboardingStateStore({ db })
  })

  afterEach(() => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function eachStore(): ReadonlyArray<[string, OnboardingStateStore]> {
    return [
      ['in-memory', inMemory],
      ['sqlite', sqlite],
    ]
  }

  test('first upsert (no existing row) → phase_state === the patch', async () => {
    for (const [label, store] of eachStore()) {
      const out = await store.upsert({
        project_slug: `p-${label}`,
        user_id: 'u-1',
        phase: 'signup',
        phase_state_patch: { a: 1, b: 'x' },
        advanced_at: 1_000,
      })
      expect(out.phase_state, label).toEqual({ a: 1, b: 'x' })
    }
  })

  test('a patch SHALLOW-merges: patch keys override, unlisted keys are preserved', async () => {
    for (const [label, store] of eachStore()) {
      await store.upsert({
        project_slug: `p-${label}`,
        user_id: 'u-1',
        phase: 'signup',
        phase_state_patch: { keep: 'me', override: 'old' },
        advanced_at: 1_000,
      })
      const out = await store.upsert({
        project_slug: `p-${label}`,
        user_id: 'u-1',
        phase: 'signup',
        phase_state_patch: { override: 'new', added: true },
        advanced_at: 2_000,
      })
      expect(out.phase_state, label).toEqual({
        keep: 'me',
        override: 'new',
        added: true,
      })
    }
  })

  test('a null value in the patch is STORED as null (the active_prompt_id CLEAR contract) and does not drop sibling keys', async () => {
    for (const [label, store] of eachStore()) {
      await store.upsert({
        project_slug: `p-${label}`,
        user_id: 'u-1',
        phase: 'signup',
        phase_state_patch: { active_prompt_id: 'prompt-1', sibling: 'kept' },
        advanced_at: 1_000,
      })
      const out = await store.upsert({
        project_slug: `p-${label}`,
        user_id: 'u-1',
        phase: 'signup',
        phase_state_patch: { active_prompt_id: null },
        advanced_at: 2_000,
      })
      // The key survives with an explicit null (NOT deleted) so the engine's
      // duplicate-start guard reads it as "no in-flight prompt".
      expect('active_prompt_id' in out.phase_state, label).toBe(true)
      expect(out.phase_state['active_prompt_id'], label).toBeNull()
      // The unrelated key is untouched.
      expect(out.phase_state['sibling'], label).toBe('kept')
    }
  })

  test('sqlite JSON column round-trips nested objects + arrays with fidelity', async () => {
    const nested = {
      auxiliary_facts: { likes: ['climbing', 'coffee'], meta: { tier: 2 } },
      primary_projects: ['Northwind', 'Acme'],
    }
    await sqlite.upsert({
      project_slug: 'p-json',
      user_id: 'u-1',
      phase: 'signup',
      phase_state_patch: nested,
      advanced_at: 1_000,
    })
    // Read back through a FRESH store instance so the value comes off disk
    // via JSON.parse, not an in-process cache.
    const fresh = new SqliteOnboardingStateStore({ db })
    const got = await fresh.get('p-json', 'u-1')
    expect(got?.phase_state['auxiliary_facts']).toEqual(nested.auxiliary_facts)
    expect(got?.phase_state['primary_projects']).toEqual(nested.primary_projects)
  })

  test('the two stores produce byte-identical merged phase_state for the same patch sequence', async () => {
    const sequence: ReadonlyArray<Record<string, unknown>> = [
      { user_first_name: 'Sam', active_prompt_id: 'p1' },
      { primary_projects: ['A', 'B'], active_prompt_id: null },
      { user_first_name: 'Sam Doe', extra: { nested: true } },
    ]
    for (let i = 0; i < sequence.length; i += 1) {
      await inMemory.upsert({
        project_slug: 'parity',
        user_id: 'u-1',
        phase: 'signup',
        phase_state_patch: sequence[i]!,
        advanced_at: 1_000 + i,
      })
      await sqlite.upsert({
        project_slug: 'parity',
        user_id: 'u-1',
        phase: 'signup',
        phase_state_patch: sequence[i]!,
        advanced_at: 1_000 + i,
      })
    }
    const a = await inMemory.get('parity', 'u-1')
    const b = await sqlite.get('parity', 'u-1')
    expect(a?.phase_state).toEqual(b?.phase_state ?? {})
  })
})

// ---------------------------------------------------------------------------
// Part B — router-amend WHITELIST contract.
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
