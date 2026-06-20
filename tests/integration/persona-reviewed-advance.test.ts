/**
 * P2-onboarding-v2 § 3.14 — persona_reviewed [A] Looks-good
 * advances to `max_oauth_offered`.
 *
 * Bug captured: `advanceFromPersonaReviewed` previously hardcoded
 * `next_phase = 'slug_chosen'` (a v1 holdover from PR #97 — slug used to
 * follow persona-review). The v2 phase reorder moved slug_chosen EARLIER
 * (before projects_proposed), so the post-persona advance must land at
 * `max_oauth_offered`. The bug never tripped in production because no
 * end-to-end walk had reached persona_reviewed past the import flow.
 *
 * The pre-existing `v2-phase-walk.test.ts` walks without a
 * `personaComposer` hook, so the LOOKS_GOOD tap fell through to the
 * static-spec resolver and landed on `max_oauth_offered` by accident,
 * masking the bug in the dedicated handler. This test wires a real
 * composer so the dispatch hits `advanceFromPersonaReviewed` directly.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import { InterviewEngine } from '@neutronai/onboarding/interview/engine.ts'
import { InMemoryOnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'
import { PersonaComposer } from '@neutronai/onboarding/persona-gen/compose.ts'
import { deterministicCringe, type CringeChecker } from '@neutronai/onboarding/persona-gen/cringe-check.ts'
import { ArchetypeLibrary } from '@neutronai/onboarding/archetypes/library.ts'

const ARCHETYPE_DATA_DIR = join(import.meta.dir, '..', '..', 'onboarding', 'archetypes', 'data')

const OWNER = 'mira'
const USER = 'u-1'
const TOPIC = `web:${USER}`

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>
let engine: InterviewEngine

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-persona-advance-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
  // P2 v2 § 0 #9 + § 7.1 — archetypes lives on PersonaComposer.
  const archetypes = new ArchetypeLibrary({
    dataDir: ARCHETYPE_DATA_DIR,
    cacheDir: join(tmp, 'arch-cache'),
  })
  const composer = new PersonaComposer({
    cringeChecker: permissiveCringeChecker(),
    ownerHomeFor: (slug: string): string => join(tmp, slug, 'persona'),
    archetypes,
  })
  engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    personaComposer: composer,
  })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function permissiveCringeChecker(): CringeChecker {
  return {
    threshold: 9999,
    async check({ content }): Promise<{ flags: number; reasons: string[] }> {
      return deterministicCringe(content)
    },
  }
}

const V2_PHASE_STATE = {
  user_id: USER,
  topic_id: TOPIC,
  signup_via: 'web',
  user_first_name: 'Mira',
  agent_name: 'Sage',
  agent_personality: 'a warm thinking-partner with a sharp edge',
  primary_projects: [
    'Caldera (fragrance brand)',
    'Hera concept (perfume #1)',
  ],
  non_work_interests: [{ name: 'yoga' }, { name: 'rare-book hunting' }],
  work_themes: ['fragrance product development'],
  companies: ['Caldera (founder + creative director)'],
  inner_circle: ['Jordan (husband)', 'Lily (daughter)'],
} as const

async function seedProjectsProposed(): Promise<string> {
  await stateStore.upsert({
    user_id: USER,
    project_slug: OWNER,
    phase: 'projects_proposed',
    phase_state_patch: { ...V2_PHASE_STATE },
    advanced_at: Date.now(),
  })
  await engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    observed_at: Date.now(),
  })
  const state = await stateStore.get(OWNER, USER)
  const apid = (state?.phase_state as Record<string, unknown>)['active_prompt_id']
  if (typeof apid !== 'string') {
    throw new Error('seed: projects_proposed prompt did not stamp active_prompt_id')
  }
  return apid
}

describe('P2-onboarding-v2 § 3.14 — persona_reviewed LOOKS_GOOD routing', () => {
  test('Looks-good tap with real composer advances to max_oauth_offered (NOT slug_chosen)', async () => {
    const projects_prompt_id = await seedProjectsProposed()
    // Auto-advance via projects_proposed → persona_synthesizing → persona_reviewed.
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: projects_prompt_id,
        choice_value: 'auto',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })

    const seedAtReviewed = await stateStore.get(OWNER, USER)
    expect(seedAtReviewed!.phase).toBe('persona_reviewed')

    const reviewPrompt = sentPrompts.at(-1)!.prompt
    expect(reviewPrompt).toBeTruthy()

    // The bug: pre-fix, this advance routed to `slug_chosen`. Post-fix,
    // it routes to `max_oauth_offered` per § 3.14 line 1041.
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: reviewPrompt.prompt_id,
        choice_value: 'looks_good',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })

    const after = await stateStore.get(OWNER, USER)
    expect(after!.phase).toBe('max_oauth_offered')
    expect(after!.phase_state['persona_files_committed']).toBe(true)
  })
})
