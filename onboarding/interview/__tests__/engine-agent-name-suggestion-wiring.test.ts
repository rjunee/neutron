/**
 * 2026-05-27 — engine-side wiring for the agent-name suggester.
 *
 * Mirrors `personality-offered-suggester-wiring.test.ts` exactly. Asserts:
 *   1. The resolver calls `agentNameSuggester.generate(...)` exactly ONCE
 *      on first emit, persists picks into `phase_state.agent_name_suggestions`,
 *      and renders the names as tappable buttons (v0.1.121).
 *   2. A second emit on the same instance reuses the memoized picks and
 *      does NOT re-roll the LLM.
 *   3. Seeded fallback ships when the suggester throws — memoized WITH
 *      source='fallback' (Argus r1 BLOCKER 2 — mirrors the character path)
 *      so a tap still maps against the rendered list, NOT frozen.
 *   3b. A memoized FALLBACK (source!='llm') re-rolls on a fresh render
 *      instead of freezing — the BLOCKER 2 fix.
 *   3c. A LEGACY provenance-less memo (picks but no `…_source` field, as
 *      persisted by pre-patch code) re-rolls instead of freezing forever.
 *   4. A rejection-bearing state still routes through the suggester so
 *      the user sees BOTH the rejection reason AND the name buttons.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import { InterviewEngine } from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import {
  buildDiverseAgentNameFallback,
  readMemoizedAgentNameSuggestions,
  STATIC_AGENT_NAME_FALLBACK,
  type AgentNameSuggester,
  type AgentNameSuggesterInput,
  type AgentNameSuggestions,
} from '../agent-name-suggester.ts'

const OWNER = 't-name-suggester'
const USER = 'u-1'
const TOPIC = `web:${USER}`

interface Harness {
  tmp: string
  db: ProjectDb
  stateStore: InMemoryOnboardingStateStore
  buttonStore: ButtonStore
  transcript: TranscriptWriter
  engine: InterviewEngine
  sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>
  suggesterCalls: number
  lastSuggesterInput: AgentNameSuggesterInput | null
  setSuggesterResponse: (next: AgentNameSuggestions | Error) => void
}

const SAMPLE_LLM_PICKS: AgentNameSuggestions = {
  picks: [
    { name: 'Atlas', tagline: 'Calm and clear, carries weight without strain.' },
    { name: 'Vera', tagline: 'Truthful and grounded, names what is true.' },
    { name: 'Iris', tagline: 'Sees patterns others miss.' },
    { name: 'Orin', tagline: 'Patient and steady, finds the next move.' },
  ],
}

function makeHarness(opts: { withSuggester: boolean } = { withSuggester: true }): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-name-suggester-'))
  const db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const buttonStore = new ButtonStore({ db })
  const stateStore = new InMemoryOnboardingStateStore()
  const transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  const sentPrompts: Harness['sentPrompts'] = []
  let suggesterCalls = 0
  let lastSuggesterInput: AgentNameSuggesterInput | null = null
  let nextResponse: AgentNameSuggestions | Error = SAMPLE_LLM_PICKS
  const suggesterImpl: AgentNameSuggester = {
    async generate(input) {
      suggesterCalls += 1
      lastSuggesterInput = input
      if (nextResponse instanceof Error) throw nextResponse
      return { suggestions: nextResponse, source: 'llm' }
    },
  }
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    ...(opts.withSuggester ? { agentNameSuggester: suggesterImpl } : {}),
  })
  return {
    tmp,
    db,
    stateStore,
    buttonStore,
    transcript,
    engine,
    sentPrompts,
    get suggesterCalls() {
      return suggesterCalls
    },
    get lastSuggesterInput() {
      return lastSuggesterInput
    },
    setSuggesterResponse: (next) => {
      nextResponse = next
    },
  } as Harness
}

function teardown(h: Harness): void {
  h.db.close()
  rmSync(h.tmp, { recursive: true, force: true })
}

async function seedAtAgentNameChosen(h: Harness): Promise<string> {
  await h.stateStore.upsert({
    user_id: USER,
    project_slug: OWNER,
    phase: 'agent_name_chosen',
    phase_state_patch: {
      user_id: USER,
      topic_id: TOPIC,
      signup_via: 'web',
      user_first_name: 'Sam',
      primary_projects: ['Topline', 'Acme', 'Northwind'],
      non_work_interests: ['Buddhism', 'Magic'],
      agent_personality: 'Paul Graham',
      archetypes: ['analytical-founder'],
    },
    advanced_at: Date.now(),
  })
  await h.engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    observed_at: Date.now(),
  })
  const state = await h.stateStore.get(OWNER, USER)
  const apid = (state?.phase_state as Record<string, unknown>)['active_prompt_id']
  if (typeof apid !== 'string') throw new Error('seed: missing active_prompt_id')
  return apid
}

describe('InterviewEngine — agent_name_chosen suggester wiring (2026-05-27)', () => {
  let h: Harness
  afterEach(() => teardown(h))

  test('1. resolver calls suggester ONCE on first emit + memoizes picks', async () => {
    h = makeHarness()
    await seedAtAgentNameChosen(h)
    expect(h.suggesterCalls).toBe(1)
    const state = await h.stateStore.get(OWNER, USER)
    const stored = (state!.phase_state as Record<string, unknown>)[
      'agent_name_suggestions'
    ]
    expect(stored).toBeTruthy()
    const memoized = stored as AgentNameSuggestions
    expect(memoized.picks).toHaveLength(4)
    expect(memoized.picks[0]?.name).toBe('Atlas')
    const lastPrompt = h.sentPrompts.at(-1)?.prompt
    // v0.1.121 — the suggested names render as TAPPABLE buttons (value =
    // bare canonical name), not body-text bullets. Freeform stays on.
    const values = lastPrompt!.options.map((o) => o.value)
    expect(values).toContain('Atlas')
    expect(values).toContain('Vera')
    expect(lastPrompt!.options.length).toBeGreaterThanOrEqual(2)
    expect(lastPrompt!.allow_freeform).toBe(true)
    expect(lastPrompt!.body).toContain('Tap a name that fits')
    expect(lastPrompt!.body).toContain('type your own')
  })

  test('1b. suggester input carries the chosen personality + work signals + per-project seed', async () => {
    // Sam 2026-06-04: agent names must be conditioned on the SAME signals
    // as characters PLUS the selected personality. Prove every signal
    // reaches the suggester input (the plumbing exists — the bug was the
    // 6s timeout, not the wiring).
    h = makeHarness()
    await seedAtAgentNameChosen(h)
    const input = h.lastSuggesterInput
    expect(input).not.toBeNull()
    expect(input!.agent_personality).toBe('Paul Graham')
    expect(input!.primary_projects).toEqual(['Topline', 'Acme', 'Northwind'])
    expect(input!.non_work_interests).toEqual(['Buddhism', 'Magic'])
    expect(input!.user_first_name).toBe('Sam')
    // Per-instance seed drives the deterministic fallback variety.
    expect(input!.seed).toBe(OWNER)
  })

  test('2. second emit reuses memoized picks — suggester is not re-rolled', async () => {
    h = makeHarness()
    await seedAtAgentNameChosen(h)
    expect(h.suggesterCalls).toBe(1)
    // Force a re-emit by re-advancing without a choice — the engine
    // re-resolves the body off the memoized state.
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: Date.now(),
    })
    expect(h.suggesterCalls).toBe(1)
    const lastPrompt = h.sentPrompts.at(-1)?.prompt
    expect(lastPrompt!.options.map((o) => o.value)).toContain('Atlas')
  })

  test('3. seeded fallback ships when the suggester throws (memoized WITH source=fallback)', async () => {
    h = makeHarness()
    h.setSuggesterResponse(new Error('429 Too Many Requests'))
    await seedAtAgentNameChosen(h)
    // The suggester is invoked at least once (pre-compute + render dedupe
    // share one in-flight promise).
    expect(h.suggesterCalls).toBeGreaterThanOrEqual(1)
    const state = await h.stateStore.get(OWNER, USER)
    // Argus r1 BLOCKER 2 (mirrors the character path): the render memoizes
    // WHAT IT SHOWS together with its `source` so a tap on a fallback render
    // still maps name→pick against the exact list that shipped. Memoizing the
    // fallback does NOT freeze the user on it — the fast path short-circuits
    // only for source==='llm', so a source==='fallback' memo is re-attempted
    // on the next render (test 3b).
    const ps = state!.phase_state as Record<string, unknown>
    const expected = buildDiverseAgentNameFallback(OWNER)
    expect(readMemoizedAgentNameSuggestions(ps['agent_name_suggestions'])).toEqual(
      expected,
    )
    expect(ps['agent_name_suggestions_source']).toBe('fallback')
    // The body still renders the DETERMINISTIC per-instance seeded fallback.
    const expectedNames = expected.picks.map((p) => p.name)
    const lastPrompt = h.sentPrompts.at(-1)?.prompt
    const values = lastPrompt!.options.map((o) => o.value)
    for (const name of expectedNames) expect(values).toContain(name)
  })

  test('3b. a memoized FALLBACK re-rolls on a fresh render (no freeze on transient 429)', async () => {
    h = makeHarness()
    h.setSuggesterResponse(new Error('429 Too Many Requests'))
    await seedAtAgentNameChosen(h)
    expect(h.suggesterCalls).toBe(1)
    // The transient failure clears. Simulate a reload (clear the active
    // prompt so the body re-resolves) — the memoized FALLBACK must trigger a
    // fresh LLM attempt rather than short-circuiting on the stale fallback.
    h.setSuggesterResponse(SAMPLE_LLM_PICKS)
    await h.stateStore.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'agent_name_chosen',
      phase_state_patch: { active_prompt_id: null },
      advanced_at: Date.now(),
    })
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: Date.now(),
    })
    expect(h.suggesterCalls).toBe(2)
    const state = await h.stateStore.get(OWNER, USER)
    const ps = state!.phase_state as Record<string, unknown>
    expect(ps['agent_name_suggestions_source']).toBe('llm')
    expect(
      readMemoizedAgentNameSuggestions(ps['agent_name_suggestions'])?.picks[0]
        ?.name,
    ).toBe('Atlas')
  })

  test('3c. a LEGACY provenance-less memo (no source field) re-rolls, never freezes', async () => {
    // The exact latent-freeze trap BLOCKER 2 targets: pre-patch code persisted
    // `agent_name_suggestions` (Sage/Vera/Orin timeout-fallback) with NO
    // `…_source` field. The fast path must NOT treat a source-less memo as
    // final — it must re-roll until the real LLM lands.
    h = makeHarness()
    await h.stateStore.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'agent_name_chosen',
      phase_state_patch: {
        user_id: USER,
        topic_id: TOPIC,
        signup_via: 'web',
        user_first_name: 'Sam',
        primary_projects: ['Topline'],
        agent_personality: 'Paul Graham',
        // Legacy memo: picks present, NO `agent_name_suggestions_source`.
        agent_name_suggestions: STATIC_AGENT_NAME_FALLBACK,
      },
      advanced_at: Date.now(),
    })
    h.setSuggesterResponse(SAMPLE_LLM_PICKS)
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: Date.now(),
    })
    // The source-less memo did NOT freeze the user — the LLM was re-rolled.
    expect(h.suggesterCalls).toBe(1)
    const state = await h.stateStore.get(OWNER, USER)
    const ps = state!.phase_state as Record<string, unknown>
    expect(ps['agent_name_suggestions_source']).toBe('llm')
    expect(
      readMemoizedAgentNameSuggestions(ps['agent_name_suggestions'])?.picks[0]
        ?.name,
    ).toBe('Atlas')
    // The stale Sage/Vera/Orin list is NOT what shipped.
    const lastPrompt = h.sentPrompts.at(-1)?.prompt
    const values = lastPrompt!.options.map((o) => o.value)
    expect(values).toContain('Atlas')
    expect(values).not.toContain('Sage')
  })

  test('3d. an llm-source memo is reused, not re-rolled', async () => {
    // The other half of the source guard: a memo tagged source==='llm' is
    // final and must short-circuit (no second LLM call).
    h = makeHarness()
    await h.stateStore.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'agent_name_chosen',
      phase_state_patch: {
        user_id: USER,
        topic_id: TOPIC,
        signup_via: 'web',
        user_first_name: 'Sam',
        primary_projects: ['Topline'],
        agent_personality: 'Paul Graham',
        agent_name_suggestions: SAMPLE_LLM_PICKS,
        agent_name_suggestions_source: 'llm',
      },
      advanced_at: Date.now(),
    })
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: Date.now(),
    })
    // Short-circuit: the memo is final, suggester not called at all.
    expect(h.suggesterCalls).toBe(0)
    const lastPrompt = h.sentPrompts.at(-1)?.prompt
    expect(lastPrompt!.options.map((o) => o.value)).toContain('Atlas')
  })

  test('4. rejection-bearing state still routes through the suggester', async () => {
    h = makeHarness()
    const apid = await seedAtAgentNameChosen(h)
    // User submits an invalid name ("X" = too short). The engine's
    // consumeAgentNameChosenChoice handler writes a rejection AND
    // re-emits. The re-emit's body should fold BOTH the rejection
    // reason AND the memoized picks together.
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: '__freeform__',
        freeform_text: 'X',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    const lastPrompt = h.sentPrompts.at(-1)?.prompt
    // The rejection reason is prepended (per stitchRejection).
    expect(lastPrompt!.body).toContain('at least 2 characters')
    expect(lastPrompt!.options.map((o) => o.value)).toContain('Atlas')
    // Suggester is not called a second time — picks are memoized.
    expect(h.suggesterCalls).toBe(1)
  })

  test('5. without the suggester dep, no memoization happens — static spec ships unmodified', async () => {
    h = makeHarness({ withSuggester: false })
    await seedAtAgentNameChosen(h)
    expect(h.suggesterCalls).toBe(0)
    const state = await h.stateStore.get(OWNER, USER)
    const stored = (state!.phase_state as Record<string, unknown>)[
      'agent_name_suggestions'
    ]
    expect(stored).toBeUndefined()
    // Static fallback path — body still carries the default bullets.
    const lastPrompt = h.sentPrompts.at(-1)?.prompt
    expect(lastPrompt!.body).toContain('- Sage — ')
  })

  test('6. tapping a suggested name button captures the name and advances to slug_chosen', async () => {
    h = makeHarness()
    const apid = await seedAtAgentNameChosen(h)
    // Tap the "Atlas" button — choice_value is the bare name, no freeform.
    const res = await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: 'Atlas',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(res.outcome).toBe('advanced')
    const state = await h.stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('slug_chosen')
    expect((state?.phase_state as Record<string, unknown>)['agent_name']).toBe(
      'Atlas',
    )
  })

  test('7. typing a custom name still works (freeform regression — r6 canonical validator)', async () => {
    h = makeHarness()
    const apid = await seedAtAgentNameChosen(h)
    const res = await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: '__freeform__',
        freeform_text: 'Mimir',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(res.outcome).toBe('advanced')
    const state = await h.stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('slug_chosen')
    expect((state?.phase_state as Record<string, unknown>)['agent_name']).toBe(
      'Mimir',
    )
  })
})
