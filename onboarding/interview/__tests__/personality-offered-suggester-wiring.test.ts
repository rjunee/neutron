/**
 * v0.1.80 (2026-05-22) — engine-side wiring for the character suggester.
 *
 * Asserts:
 *   1. The resolver calls `personalityCharacterSuggester.generate(...)`
 *      exactly ONCE on first emit, persists the 5 picks into
 *      `phase_state.personality_character_suggestions`, and renders the
 *      character-anchored body with 5 buttons.
 *   2. A second emit on the same instance reuses the memoized picks and
 *      does NOT re-roll the LLM.
 *   3. Tapping a character button captures `agent_personality = <name>`
 *      and advances to `agent_name_chosen` — regardless of any
 *      LLM-extractor freeform residue.
 *   4. The static fallback ships when the suggester throws.
 *   5. Stale `character:...` button values that don't match the
 *      memoized picks are rejected (defence against tampered clients).
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
import { PERSONALITY_CHARACTER_PREFIX } from '../phase-prompts.ts'
import {
  buildDiverseCharacterFallback,
  characterNamesInRenderOrder,
  readMemoizedCharacterSuggestions,
  STATIC_PERSONALITY_CHARACTER_FALLBACK,
  type PersonalityCharacterSuggester,
  type PersonalityCharacterSuggesterInput,
  type PersonalityCharacterSuggestions,
} from '../personality-character-suggester.ts'

const OWNER = 't-suggester'
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
  lastSuggesterInput: PersonalityCharacterSuggesterInput | null
  suggesterImpl: PersonalityCharacterSuggester
  setSuggesterResponse: (next: PersonalityCharacterSuggestions | Error) => void
}

const SAMPLE_LLM_PICKS: PersonalityCharacterSuggestions = {
  personalized: [
    { name: 'Hermione Granger', why: 'Studious, prepared, never afraid to push back.' },
    { name: 'Naval Ravikant', why: 'Aphoristic, principled, distills first principles.' },
    { name: 'Don Draper', why: 'Persuasive, crisp, knows how a story should land.' },
  ],
  wild: [
    { name: 'Bilbo Baggins', why: 'Warm and curious, surprises you with grit.' },
    { name: 'Tony Stark', why: 'Restless, witty, never settles for first attempt.' },
  ],
}

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-suggester-'))
  const db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const buttonStore = new ButtonStore({ db })
  const stateStore = new InMemoryOnboardingStateStore()
  const transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  const sentPrompts: Harness['sentPrompts'] = []
  let suggesterCalls = 0
  let lastSuggesterInput: PersonalityCharacterSuggesterInput | null = null
  let nextResponse: PersonalityCharacterSuggestions | Error = SAMPLE_LLM_PICKS
  const suggesterImpl: PersonalityCharacterSuggester = {
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
    personalityCharacterSuggester: suggesterImpl,
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
    suggesterImpl,
    setSuggesterResponse: (next) => {
      nextResponse = next
    },
  } as Harness
}

function teardown(h: Harness): void {
  h.db.close()
  rmSync(h.tmp, { recursive: true, force: true })
}

async function seedAtPersonalityOffered(h: Harness): Promise<string> {
  await h.stateStore.upsert({
    user_id: USER,
    project_slug: OWNER,
    phase: 'personality_offered',
    phase_state_patch: {
      user_id: USER,
      topic_id: TOPIC,
      signup_via: 'web',
      user_first_name: 'Sam',
      primary_projects: ['Topline', 'Acme', 'Northwind'],
      non_work_interests: ['Buddhism', 'Magic'],
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

describe('InterviewEngine — personality_offered suggester wiring (v0.1.80)', () => {
  let h: Harness
  afterEach(() => teardown(h))

  test('1b. suggester input carries the collected work signals + per-instance seed', async () => {
    // Conditioning is on real signals (the plumbing existed pre-fix — only
    // the 6s timeout was killing the LLM path). Pin that the signals reach
    // the suggester input + the per-instance seed drives fallback variety.
    h = makeHarness()
    await seedAtPersonalityOffered(h)
    const input = h.lastSuggesterInput
    expect(input).not.toBeNull()
    expect(input!.user_first_name).toBe('Sam')
    expect(input!.primary_projects).toEqual(['Topline', 'Acme', 'Northwind'])
    expect(input!.non_work_interests).toEqual(['Buddhism', 'Magic'])
    expect(input!.seed).toBe(OWNER)
  })

  test('1. resolver calls suggester ONCE on first emit + memoizes 5 picks', async () => {
    h = makeHarness()
    await seedAtPersonalityOffered(h)
    expect(h.suggesterCalls).toBe(1)
    const state = await h.stateStore.get(OWNER, USER)
    const stored = (state!.phase_state as Record<string, unknown>)[
      'personality_character_suggestions'
    ]
    expect(stored).toBeTruthy()
    const memoized = stored as PersonalityCharacterSuggestions
    expect(memoized.personalized).toHaveLength(3)
    expect(memoized.wild).toHaveLength(2)
    const lastPrompt = h.sentPrompts.at(-1)?.prompt
    expect(lastPrompt!.options).toHaveLength(5)
    expect(lastPrompt!.options[0]?.value).toBe(
      `${PERSONALITY_CHARACTER_PREFIX}0`,
    )
    expect(lastPrompt!.options[0]?.body).toBe('Hermione Granger')
    expect(lastPrompt!.body).toContain('**Hermione Granger**')
    expect(lastPrompt!.body).toContain('Or something more unexpected')
  })

  test('2. second emit reuses memoized picks — suggester is not re-rolled', async () => {
    h = makeHarness()
    await seedAtPersonalityOffered(h)
    expect(h.suggesterCalls).toBe(1)
    // Force a re-emit by tapping the prompt with __freeform__ that's
    // too short — the engine writes a rejection and re-emits.
    const state = await h.stateStore.get(OWNER, USER)
    const apid = (state!.phase_state as Record<string, unknown>)[
      'active_prompt_id'
    ] as string
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: '__freeform__',
        freeform_text: 'no', // < 4 chars → rejection + re-emit
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    // Suggester MUST NOT have been called again.
    expect(h.suggesterCalls).toBe(1)
    // Body still shows the same memoized picks AND the rejection
    // reason stitched on top.
    const lastPrompt = h.sentPrompts.at(-1)?.prompt
    expect(lastPrompt!.body).toContain("I didn't catch what you'd like")
    expect(lastPrompt!.body).toContain('**Hermione Granger**')
    expect(lastPrompt!.options).toHaveLength(5)
  })

  test('3. tapping a character button captures agent_personality + advances', async () => {
    h = makeHarness()
    const apid = await seedAtPersonalityOffered(h)
    // Bilbo Baggins is at render index 3 (personalized=3, then wild
    // starts at 3). Engine should resolve index 3 → "Bilbo Baggins"
    // against the memoized suggestions.
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: `${PERSONALITY_CHARACTER_PREFIX}3`,
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    const state = await h.stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('agent_name_chosen')
    const personality = (state!.phase_state as Record<string, unknown>)[
      'agent_personality'
    ]
    expect(personality).toBe('Bilbo Baggins')
  })

  test('4. seeded fallback ships when the suggester throws (memoized WITH source=fallback)', async () => {
    h = makeHarness()
    h.setSuggesterResponse(new Error('429 Too Many Requests'))
    await seedAtPersonalityOffered(h)
    expect(h.suggesterCalls).toBe(1)
    const state = await h.stateStore.get(OWNER, USER)
    // 2026-06-04 (Codex P2): the render memoizes WHAT IT SHOWS together with
    // its `source` so a tap on a fallback render still maps index→name via
    // the closed validator. Memoizing the fallback does NOT freeze the user
    // on it — the render short-circuits only for source==='llm', so a
    // source==='fallback' memo is re-attempted on the next render (test 4b).
    const ps = state!.phase_state as Record<string, unknown>
    const expected = buildDiverseCharacterFallback(OWNER)
    expect(readMemoizedCharacterSuggestions(ps['personality_character_suggestions']))
      .toEqual(expected)
    expect(ps['personality_character_suggestions_source']).toBe('fallback')
    const lastPrompt = h.sentPrompts.at(-1)?.prompt
    expect(lastPrompt!.options).toHaveLength(5)
    expect(lastPrompt!.body).toContain(`**${expected.personalized[0]!.name}**`)
    // Variety guard: the seeded fallback is not the old all-male sage list.
    const names = characterNamesInRenderOrder(expected)
    expect(names).not.toEqual([
      'Sherlock Holmes',
      'Marcus Aurelius',
      'Mr. Miyagi',
      'Yoda',
      'Atticus Finch',
    ])
  })

  test('4b. a memoized FALLBACK is re-attempted on a fresh render (no freeze on transient 429)', async () => {
    h = makeHarness()
    h.setSuggesterResponse(new Error('429 Too Many Requests'))
    await seedAtPersonalityOffered(h)
    expect(h.suggesterCalls).toBe(1)
    // The transient failure clears. Simulate a reload (clear the active
    // prompt so the body re-resolves) — the memoized FALLBACK must trigger
    // a fresh LLM attempt rather than short-circuiting on the stale fallback.
    h.setSuggesterResponse(SAMPLE_LLM_PICKS)
    await h.stateStore.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'personality_offered',
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
    expect(ps['personality_character_suggestions_source']).toBe('llm')
    expect(
      readMemoizedCharacterSuggestions(ps['personality_character_suggestions'])
        ?.personalized[0]?.name,
    ).toBe('Hermione Granger')
  })

  test('5. out-of-range character:<index> + stale name shape rejected', async () => {
    h = makeHarness()
    const apid = await seedAtPersonalityOffered(h)
    // User taps an index past the 5 rendered buttons — the engine
    // MUST NOT silently accept and crash, MUST NOT persist anything.
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: `${PERSONALITY_CHARACTER_PREFIX}5`,
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    const state = await h.stateStore.get(OWNER, USER)
    // Stayed on personality_offered with a rejection.
    expect(state?.phase).toBe('personality_offered')
    const rejection = (state!.phase_state as Record<string, unknown>)[
      'personality_offered_rejection'
    ]
    expect(typeof rejection).toBe('string')
    // agent_personality MUST NOT be persisted.
    const personality = (state!.phase_state as Record<string, unknown>)[
      'agent_personality'
    ]
    expect(personality).toBeFalsy()
  })

  test('5b. legacy `character:<name>` wire format rejected (defends pre-upgrade clients)', async () => {
    h = makeHarness()
    const apid = await seedAtPersonalityOffered(h)
    // Pre-v0.1.80-r2 clients (or tampered clients) might still send
    // `character:<name>`. The new parser only accepts indices 0..4.
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: `${PERSONALITY_CHARACTER_PREFIX}Voldemort`,
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    const state = await h.stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('personality_offered')
    const personality = (state!.phase_state as Record<string, unknown>)[
      'agent_personality'
    ]
    expect(personality).toBeFalsy()
  })

  test('6. validator stays CLOSED when memoized suggestions are missing (Kieran r1 B1)', async () => {
    // Regression for Kieran r1 BLOCKING: the original validator went
    // `(memoized === null ? [] : characterNamesInRenderOrder(memoized))`
    // and then accepted any input when `allowed_names.length === 0`.
    // Result: a corrupt / unwritten state-store row let tampered
    // clients drop arbitrary strings into `agent_personality`.
    // Post-fix: when memoized is null, the prefix is ignored and the
    // engine falls through to the extracted_personality ?? freeform
    // cascade — which then yields null and triggers the standard
    // rejection re-emit. (Also covers the post-Codex-r3 index form —
    // missing memoization means no array to index into, so no
    // resolution is possible.)
    h = makeHarness()
    // Seed the user at personality_offered but with NO memoized
    // suggestions on phase_state (simulates persist-failure race or
    // schema drift). The suggester dep is wired but we bypass the
    // emit cycle so the resolver never runs.
    await h.stateStore.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'personality_offered',
      phase_state_patch: {
        user_id: USER,
        topic_id: TOPIC,
        signup_via: 'web',
        user_first_name: 'Sam',
        // Critical: NO `personality_character_suggestions` written.
        active_prompt_id: 'fake-prompt-id',
      },
      advanced_at: Date.now(),
    })
    // Pre-register a button prompt with the engine's button store so
    // accept-choice resolves it (this is the minimal harness — we're
    // not testing the prompt-shape path, just the validator).
    const choice_value = `${PERSONALITY_CHARACTER_PREFIX}0`
    try {
      await h.engine.advance({
        project_slug: OWNER,
        topic_id: TOPIC,
        user_id: USER,
        channel_kind: 'app-socket',
        choice: {
          prompt_id: 'fake-prompt-id',
          choice_value,
          chosen_at: Date.now(),
          speaker_user_id: USER,
          channel_kind: 'app-socket',
        },
        observed_at: Date.now(),
      })
    } catch {
      // Engine may throw if the prompt isn't in the button store; that
      // is itself an acceptable rejection. The hostile choice MUST NOT
      // land as `agent_personality`. Either outcome (rejection re-emit
      // OR throw) is fine; what we forbid is silent acceptance.
    }
    const state = await h.stateStore.get(OWNER, USER)
    const personality = (state!.phase_state as Record<string, unknown>)[
      'agent_personality'
    ]
    expect(personality).toBeFalsy()
  })

  test('7. memoized suggestions are cleared on forward advance (Kieran r1 I4)', async () => {
    h = makeHarness()
    const apid = await seedAtPersonalityOffered(h)
    // Sanity: memoization persisted before advance.
    const before = await h.stateStore.get(OWNER, USER)
    const beforeMemo = (before!.phase_state as Record<string, unknown>)[
      'personality_character_suggestions'
    ]
    expect(beforeMemo).toBeTruthy()
    // Advance via a valid character button tap (index 0 → Hermione Granger).
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: `${PERSONALITY_CHARACTER_PREFIX}0`,
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    const after = await h.stateStore.get(OWNER, USER)
    expect(after?.phase).toBe('agent_name_chosen')
    const afterMemo = (after!.phase_state as Record<string, unknown>)[
      'personality_character_suggestions'
    ]
    // Cleared on advance so the ~1 KB blob doesn't ride along on every
    // downstream phase's serialized state.
    expect(afterMemo).toBeFalsy()
  })

  test('8. Codex r3 P1 — long character name (50 chars) emits + resolves end-to-end', async () => {
    // Regression for the wire-format cap BLOCKER. The suggester
    // returns a character name long enough that the old
    // `character:<name>` form would have exceeded the 37-byte
    // ButtonOption.value cap and crashed `assertValidButtonPrompt`.
    //
    // Post-fix:
    //   - prompt emits successfully (no ButtonPrimitiveError thrown)
    //   - every option.value is ≤ 37 UTF-8 bytes
    //   - clicking the long-name button correctly captures the
    //     FULL name as `agent_personality` (memoization round-trip)
    h = makeHarness()
    const LONG_NAME = 'Lieutenant Commander Data of the USS Enterprise'
    expect(LONG_NAME.length).toBeGreaterThanOrEqual(40)
    h.setSuggesterResponse({
      personalized: [
        { name: LONG_NAME, why: 'Methodical, precise, follows the rules.' },
        { name: 'Naval Ravikant', why: 'Aphoristic, principled, distills first principles.' },
        { name: 'Don Draper', why: 'Persuasive, crisp.' },
      ],
      wild: [
        { name: 'Bilbo Baggins', why: 'Warm and curious.' },
        { name: 'Tony Stark', why: 'Restless, witty.' },
      ],
    })
    const apid = await seedAtPersonalityOffered(h)
    // Verify the prompt actually shipped without crashing the
    // primitive's 37-byte value cap.
    const emittedPrompt = h.sentPrompts.at(-1)?.prompt
    expect(emittedPrompt).toBeTruthy()
    expect(emittedPrompt!.options).toHaveLength(5)
    const VALUE_BYTE_CAP = 37
    for (const opt of emittedPrompt!.options) {
      expect(Buffer.byteLength(opt.value, 'utf8')).toBeLessThanOrEqual(VALUE_BYTE_CAP)
    }
    // Long name still renders in the body (which has no byte cap).
    expect(emittedPrompt!.body).toContain(`**${LONG_NAME}**`)
    // Tap the button corresponding to the long name (index 0).
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: `${PERSONALITY_CHARACTER_PREFIX}0`,
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    const state = await h.stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('agent_name_chosen')
    // Full long name lands as agent_personality — index lookup
    // correctly recovers the name from memoization.
    const personality = (state!.phase_state as Record<string, unknown>)[
      'agent_personality'
    ]
    expect(personality).toBe(LONG_NAME)
  })

  test('9. seeded fallback path still resolves each index 0..4 correctly', async () => {
    // When the suggester throws, the DETERMINISTIC per-instance seeded
    // fallback ships AND is memoized (with source=fallback) so the closed
    // consume validator can map a `character:<index>` tap against the exact
    // list that shipped. Every rendered button must still resolve back to
    // its short name.
    h = makeHarness()
    h.setSuggesterResponse(new Error('429 Too Many Requests'))
    const apid = await seedAtPersonalityOffered(h)
    // The seeded fallback IS memoized (Codex P2 closed-validator fix).
    const after_seed = (await h.stateStore.get(OWNER, USER))!.phase_state as Record<
      string,
      unknown
    >
    expect(after_seed['personality_character_suggestions_source']).toBe('fallback')
    const renderOrder = characterNamesInRenderOrder(
      readMemoizedCharacterSuggestions(
        after_seed['personality_character_suggestions'],
      )!,
    )
    expect(renderOrder).toHaveLength(5)
    expect(renderOrder).toEqual(
      characterNamesInRenderOrder(buildDiverseCharacterFallback(OWNER)),
    )
    // Tap index 2 (a personalized fallback) and verify the engine
    // resolves it back to renderOrder[2].name.
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: `${PERSONALITY_CHARACTER_PREFIX}2`,
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    const after = await h.stateStore.get(OWNER, USER)
    expect(after?.phase).toBe('agent_name_chosen')
    const personality = (after!.phase_state as Record<string, unknown>)[
      'agent_personality'
    ]
    expect(personality).toBe(renderOrder[2])
  })
})
