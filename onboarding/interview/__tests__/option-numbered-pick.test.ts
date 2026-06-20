/**
 * Item 3 (2026-06-19, owner live-dogfood) — numbered option-pick.
 *
 * The owner typed "3" to pick the 3rd suggested character and got
 * "I didn't catch what you'd like" → then a DIFFERENT option set, because a
 * bare number is freeform text (len 1 < 4) that failed the ≥4-char advance
 * gate. These tests lock the fix:
 *   - `parseBareOptionNumber` recognizes a number-only reply and rejects
 *     replies that carry other content.
 *   - Typing "3" on the personality step resolves to the SAME memoized
 *     character a tap on `character:2` would, and advances.
 *   - Typing "2" on the name step resolves to the SAME memoized name a tap
 *     on that button would, and advances.
 *   - A bare number with NO memoized set falls through to the normal
 *     rejection (never silently accepted).
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
import { parseBareOptionNumber } from '../engine-internals.ts'
import {
  characterNamesInRenderOrder,
  type PersonalityCharacterSuggester,
  type PersonalityCharacterSuggestions,
} from '../personality-character-suggester.ts'
import type {
  AgentNameSuggester,
  AgentNameSuggestions,
} from '../agent-name-suggester.ts'

const OWNER = 't-numbered'
const USER = 'u-1'
const TOPIC = `web:${USER}`

const CHARACTER_PICKS: PersonalityCharacterSuggestions = {
  personalized: [
    { name: 'Hermione Granger', why: 'Studious, prepared, pushes back.' },
    { name: 'Naval Ravikant', why: 'Aphoristic, principled.' },
    { name: 'Don Draper', why: 'Persuasive, crisp.' },
  ],
  wild: [
    { name: 'Bilbo Baggins', why: 'Warm and curious.' },
    { name: 'Tony Stark', why: 'Restless, witty.' },
  ],
}

const NAME_PICKS: AgentNameSuggestions = {
  picks: [
    { name: 'Sage', tagline: 'Calm and grounded.' },
    { name: 'Vera', tagline: 'Direct and honest.' },
    { name: 'Orin', tagline: 'Curious and steady.' },
  ],
}

interface Harness {
  tmp: string
  db: ProjectDb
  stateStore: InMemoryOnboardingStateStore
  engine: InterviewEngine
  sentPrompts: Array<{ prompt: ButtonPrompt }>
}

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-numbered-'))
  const db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const buttonStore = new ButtonStore({ db })
  const stateStore = new InMemoryOnboardingStateStore()
  const transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  const sentPrompts: Harness['sentPrompts'] = []
  const characterSuggester: PersonalityCharacterSuggester = {
    async generate() {
      return { suggestions: CHARACTER_PICKS, source: 'llm' }
    },
  }
  const nameSuggester: AgentNameSuggester = {
    async generate() {
      return { suggestions: NAME_PICKS, source: 'llm' }
    },
  }
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push({ prompt: input.prompt })
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    personalityCharacterSuggester: characterSuggester,
    agentNameSuggester: nameSuggester,
  })
  return { tmp, db, stateStore, engine, sentPrompts }
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
      primary_projects: ['Topline'],
      non_work_interests: ['Magic'],
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

describe('parseBareOptionNumber', () => {
  test('parses number-only replies (with common decorations)', () => {
    expect(parseBareOptionNumber('3')).toBe(3)
    expect(parseBareOptionNumber(' 3 ')).toBe(3)
    expect(parseBareOptionNumber('#3')).toBe(3)
    expect(parseBareOptionNumber('3.')).toBe(3)
    expect(parseBareOptionNumber('3)')).toBe(3)
    expect(parseBareOptionNumber('option 2')).toBe(2)
    expect(parseBareOptionNumber('number 1')).toBe(1)
    expect(parseBareOptionNumber('no. 4')).toBe(4)
  })

  test('rejects replies carrying other content (real descriptions / names)', () => {
    expect(parseBareOptionNumber('3 parts sarcasm, 1 part warmth')).toBeNull()
    expect(parseBareOptionNumber('Iris')).toBeNull()
    expect(parseBareOptionNumber('a dry-witted friend')).toBeNull()
    expect(parseBareOptionNumber('')).toBeNull()
    expect(parseBareOptionNumber('0')).toBeNull()
    expect(parseBareOptionNumber('100')).toBeNull()
  })
})

describe('numbered pick — personality_offered', () => {
  let h: Harness
  afterEach(() => teardown(h))

  test('typing "3" resolves the SAME option as tapping character:2', async () => {
    h = makeHarness()
    const apid = await seedAtPersonalityOffered(h)
    const renderOrder = characterNamesInRenderOrder(CHARACTER_PICKS)
    // render order index 2 == "Don Draper" == typed "3" (1-based).
    expect(renderOrder[2]).toBe('Don Draper')
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: '__freeform__',
        freeform_text: '3',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    const state = await h.stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('agent_name_chosen')
    expect(
      (state!.phase_state as Record<string, unknown>)['agent_personality'],
    ).toBe('Don Draper')
  })

  test('a bare number with NO memoized set falls through to rejection', async () => {
    h = makeHarness()
    // Seed WITHOUT running the emit cycle, so no suggestions are memoized,
    // but register a real prompt so the choice resolves.
    const apid = await seedAtPersonalityOffered(h)
    // Wipe the memoized suggestions to simulate the no-memo case.
    await h.stateStore.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'personality_offered',
      phase_state_patch: { personality_character_suggestions: null },
      advanced_at: Date.now(),
    })
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: '__freeform__',
        freeform_text: '3',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    const state = await h.stateStore.get(OWNER, USER)
    // "3" is too short + no memo to resolve → stays + rejection.
    expect(state?.phase).toBe('personality_offered')
    expect(
      (state!.phase_state as Record<string, unknown>)['agent_personality'],
    ).toBeFalsy()
  })
})

describe('numbered pick — agent_name_chosen', () => {
  let h: Harness
  afterEach(() => teardown(h))

  test('typing "2" resolves the SAME name as tapping that button', async () => {
    h = makeHarness()
    // Drive personality first so the engine advances into agent_name_chosen
    // and memoizes the name suggestions.
    const apid = await seedAtPersonalityOffered(h)
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: '__freeform__',
        freeform_text: 'a calm grounded thinking partner',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    let state = await h.stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('agent_name_chosen')
    const nameApid = (state!.phase_state as Record<string, unknown>)[
      'active_prompt_id'
    ]
    expect(typeof nameApid).toBe('string')
    await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: nameApid as string,
        choice_value: '__freeform__',
        freeform_text: '2',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    state = await h.stateStore.get(OWNER, USER)
    // "2" (1-based) → picks[1].name == "Vera".
    expect(
      (state!.phase_state as Record<string, unknown>)['agent_name'],
    ).toBe('Vera')
  })
})
