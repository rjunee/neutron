/**
 * v0.1.121 (2026-06-04) — legacy personality-suggestion buttons.
 *
 * When the character-suggester dep is unwired, the `personality_offered`
 * prompt renders the 3 static default suggestions as tappable
 * `personality:<index>` buttons (phase-prompts.ts:buildPersonalityOfferedPromptSpec
 * legacy path). The engine's `consumePersonalityOfferedChoice` resolves the
 * index against the SAME shared `DEFAULT_PERSONALITY_SUGGESTIONS` constant.
 *
 * This suite drives the engine WITHOUT a character suggester (so the
 * legacy path is the one emitted) and asserts a tap captures the resolved
 * phrase + advances, while a malformed index falls through to freeform.
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
import { DEFAULT_PERSONALITY_SUGGESTIONS } from '../phase-prompts.ts'

const OWNER = 't-legacy-personality'
const USER = 'u-1'
const TOPIC = `web:${USER}`

interface Harness {
  tmp: string
  db: ProjectDb
  stateStore: InMemoryOnboardingStateStore
  engine: InterviewEngine
  sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>
}

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-legacy-personality-'))
  const db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const buttonStore = new ButtonStore({ db })
  const stateStore = new InMemoryOnboardingStateStore()
  const transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  const sentPrompts: Harness['sentPrompts'] = []
  // NOTE: no personalityCharacterSuggester → the legacy builder path emits.
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
  })
  return { tmp, db, stateStore, engine, sentPrompts }
}

function teardown(h: Harness): void {
  h.db.close()
  rmSync(h.tmp, { recursive: true, force: true })
}

// Seed personality_offered WITH a rejection so the resolver emits the
// legacy index-button builder (the no-rejection first emit falls through
// to the static spec; the legacy dynamic builder is the rejection re-emit).
async function seedAtLegacyPersonality(h: Harness): Promise<string> {
  await h.stateStore.upsert({
    user_id: USER,
    project_slug: OWNER,
    phase: 'personality_offered',
    phase_state_patch: {
      user_id: USER,
      topic_id: TOPIC,
      signup_via: 'web',
      user_first_name: 'Sam',
      personality_offered_rejection: 'Tell me a little more about the style.',
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

describe('InterviewEngine — personality_offered legacy index-buttons (v0.1.121)', () => {
  let h: Harness
  afterEach(() => teardown(h))

  test('the legacy emit renders personality:<index> buttons', async () => {
    h = makeHarness()
    await seedAtLegacyPersonality(h)
    const prompt = h.sentPrompts.at(-1)?.prompt
    const values = prompt!.options.map((o) => o.value)
    expect(values).toEqual(['personality:0', 'personality:1', 'personality:2'])
  })

  test('tapping a legacy suggestion button captures the resolved phrase + advances', async () => {
    h = makeHarness()
    const apid = await seedAtLegacyPersonality(h)
    const res = await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: 'personality:1',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(res.outcome).toBe('advanced')
    const state = await h.stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('agent_name_chosen')
    expect(
      (state?.phase_state as Record<string, unknown>)['agent_personality'],
    ).toBe(DEFAULT_PERSONALITY_SUGGESTIONS[1])
  })

  test('a malformed/out-of-range index is NOT accepted (falls through to freeform cascade)', async () => {
    h = makeHarness()
    const apid = await seedAtLegacyPersonality(h)
    // `personality:9` is out of the 0..4 strict matcher → no resolution →
    // no freeform → rejection re-emit (stays at personality_offered).
    const res = await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: 'personality:9',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(res.outcome).toBe('reemitted_current')
    const state = await h.stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('personality_offered')
  })

  test('typing a custom personality still works (freeform regression)', async () => {
    h = makeHarness()
    const apid = await seedAtLegacyPersonality(h)
    const res = await h.engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: '__freeform__',
        freeform_text: 'A patient mentor who asks good questions',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })
    expect(res.outcome).toBe('advanced')
    const state = await h.stateStore.get(OWNER, USER)
    expect(state?.phase).toBe('agent_name_chosen')
    expect(
      (state?.phase_state as Record<string, unknown>)['agent_personality'],
    ).toBe('A patient mentor who asks good questions')
  })
})
