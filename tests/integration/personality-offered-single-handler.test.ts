/**
 * P2 v2 § 0 locked decision #9 + § 3.9 + § 4.1 + § 7.1 — `personality_offered`
 * is a free-text, single-handler phase. Curated archetype blending
 * happens later at synthesis time inside `PersonaComposer.compose`.
 *
 * This file pins down the post-clean-kill contract:
 *
 *   1. The engine captures the typed string verbatim on
 *      `phase_state.agent_personality` AND mirrors it to
 *      the owner record's `agent_personality` via `personaSync.recordAgentPersonality`.
 *      Curated archetype names ("Sherlock Holmes meets Marcus Aurelius")
 *      land the STRING UNMUTATED — the engine no longer rewrites the
 *      reply into a `BlendedArchetype` display label.
 *
 *   2. A prose reply that mentions no curated archetype names ALSO
 *      lands verbatim and advances to `agent_name_chosen`.
 *
 *   3. `PersonaComposer.compose` derives the BlendedArchetype from
 *      `signals.agent_personality` at synthesis time:
 *        - prose-only reply → free-text blend; SOUL.md carries the
 *          prose phrase in the archetypal section.
 *        - curated-name reply → curated blend; SOUL.md carries the
 *          curated voice fragments ("Sherlock" / "Marcus Aurelius").
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ButtonChoice, ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import { InterviewEngine } from '@neutronai/onboarding/interview/engine.ts'
import { InMemoryOnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'
import { PersonaComposer } from '@neutronai/onboarding/persona-gen/compose.ts'
import {
  deterministicCringe,
  type CringeChecker,
} from '@neutronai/onboarding/persona-gen/cringe-check.ts'
import { ArchetypeLibrary } from '@neutronai/onboarding/archetypes/library.ts'
import type { PersonaSyncHook } from '@neutronai/onboarding/interview/engine.ts'

const ARCHETYPE_DATA_DIR = join(
  import.meta.dir,
  '..',
  '..',
  'onboarding',
  'archetypes',
  'data',
)

const OWNER = 'mira'
const USER = 'u-1'
const TOPIC = `web:${USER}`

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ prompt: ButtonPrompt }>
let recordedPersonality: Array<string | null>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-personality-offered-clean-kill-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
  recordedPersonality = []
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

function makePersonaSyncRecorder(): PersonaSyncHook {
  return {
    async recordAgentName(): Promise<void> {
      /* no-op for this fixture */
    },
    async recordUserFirstName(): Promise<void> {
      /* no-op for this fixture */
    },
    async recordAgentPersonality(input): Promise<void> {
      recordedPersonality.push(input.agent_personality)
    },
  }
}

function makeEngine(): InterviewEngine {
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push({ prompt: input.prompt })
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    personaSync: makePersonaSyncRecorder(),
  })
}

async function seedAtPersonalityOffered(observed_at: number): Promise<string> {
  await stateStore.upsert({
    user_id: USER,
    project_slug: OWNER,
    phase: 'personality_offered',
    phase_state_patch: {
      user_first_name: 'Mira',
      primary_projects: ['Caldera', 'Ledgerline'],
      non_work_interests: [{ name: 'yoga' }],
    },
    advanced_at: observed_at,
  })
  const engine = makeEngine()
  await engine.start({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    signup_via: 'web',
  })
  const sent = sentPrompts[sentPrompts.length - 1]
  if (sent === undefined) throw new Error('seed-at-personality: no prompt emitted on start')
  return sent.prompt.prompt_id
}

async function replyFreeform(prompt_id: string, text: string, observed_at: number): Promise<void> {
  const engine = makeEngine()
  const choice: ButtonChoice = {
    prompt_id,
    choice_value: '__freeform__',
    freeform_text: text,
    chosen_at: observed_at,
    speaker_user_id: USER,
    channel_kind: 'app-socket',
  }
  await engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    choice,
    observed_at,
  })
}

describe('P2 v2 § 3.9 — personality_offered is a single-handler, string-only phase', () => {
  test('prose reply captures verbatim → advances to agent_name_chosen', async () => {
    const t0 = 1_700_000_000_000
    const prompt_id = await seedAtPersonalityOffered(t0)

    const reply = 'a warm collaborator who explains the why'
    await replyFreeform(prompt_id, reply, t0 + 1_000)

    const state = await stateStore.get(OWNER, USER)
    expect(state).not.toBeNull()
    expect(state!.phase).toBe('agent_name_chosen')
    // String preserved verbatim — engine MUST NOT mutate into a
    // BlendedArchetype display label.
    expect(state!.phase_state['agent_personality']).toBe(reply)
    // Dual-storage contract per § 4.1: the owner record's agent_personality must
    // be set via `personaSync.recordAgentPersonality`.
    expect(recordedPersonality).toContain(reply)
    // No legacy archetype_blend write — phase_state.archetype_blend
    // stays absent because the engine no longer composes one.
    expect(state!.phase_state['archetype_blend']).toBeUndefined()
  })

  test('archetype-name reply captures string verbatim (NOT mutated into a blend)', async () => {
    const t0 = 1_700_000_000_000
    const prompt_id = await seedAtPersonalityOffered(t0)

    const reply = 'Sherlock Holmes meets Marcus Aurelius'
    await replyFreeform(prompt_id, reply, t0 + 1_000)

    const state = await stateStore.get(OWNER, USER)
    expect(state).not.toBeNull()
    expect(state!.phase).toBe('agent_name_chosen')
    // Critical: the typed string lands UNMUTATED. Pre-clean-kill, this
    // value would have been overwritten with the curated display label
    // ("Marcus Aurelius / Sherlock Holmes") and the user's literal
    // phrase would have been lost.
    expect(state!.phase_state['agent_personality']).toBe(reply)
    expect(recordedPersonality).toContain(reply)
    // No legacy archetype_blend write.
    expect(state!.phase_state['archetype_blend']).toBeUndefined()
  })

  test('synthetic __timeout__ sentinel does NOT mutate state or write rejection', async () => {
    // Codex r1 P2 catch: pre-clean-kill the deleted archetype handler
    // short-circuited NON_ADVANCING_CHOICE_VALUES (`__timeout__` /
    // `__cancel__`). The renamed v2 handler MUST preserve that
    // contract — otherwise a timeout event lands as a "too short" reply
    // and the user sees a confusing retry prompt instead of just
    // staying on phase.
    const t0 = 1_700_000_000_000
    const prompt_id = await seedAtPersonalityOffered(t0)

    const engine = makeEngine()
    const choice: ButtonChoice = {
      prompt_id,
      choice_value: '__timeout__',
      chosen_at: t0 + 1_000,
      speaker_user_id: USER,
      channel_kind: 'app-socket',
    }
    const result = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice,
      observed_at: t0 + 1_000,
    })

    expect(result.outcome).toBe('no_active_prompt')
    const state = await stateStore.get(OWNER, USER)
    expect(state).not.toBeNull()
    expect(state!.phase).toBe('personality_offered')
    expect(state!.phase_state['agent_personality']).toBeUndefined()
    expect(state!.phase_state['personality_offered_rejection']).toBeUndefined()
    expect(recordedPersonality).toHaveLength(0)
  })

  test('synthetic __cancel__ sentinel does NOT mutate state or write rejection', async () => {
    const t0 = 1_700_000_000_000
    const prompt_id = await seedAtPersonalityOffered(t0)

    const engine = makeEngine()
    const choice: ButtonChoice = {
      prompt_id,
      choice_value: '__cancel__',
      chosen_at: t0 + 1_000,
      speaker_user_id: USER,
      channel_kind: 'app-socket',
    }
    const result = await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice,
      observed_at: t0 + 1_000,
    })

    expect(result.outcome).toBe('no_active_prompt')
    const state = await stateStore.get(OWNER, USER)
    expect(state).not.toBeNull()
    expect(state!.phase).toBe('personality_offered')
    expect(state!.phase_state['agent_personality']).toBeUndefined()
    expect(state!.phase_state['personality_offered_rejection']).toBeUndefined()
  })

  test('under-4-char reply stays on personality_offered + sets rejection', async () => {
    const t0 = 1_700_000_000_000
    const prompt_id = await seedAtPersonalityOffered(t0)

    await replyFreeform(prompt_id, 'hi', t0 + 1_000)

    const state = await stateStore.get(OWNER, USER)
    expect(state).not.toBeNull()
    expect(state!.phase).toBe('personality_offered')
    expect(typeof state!.phase_state['personality_offered_rejection']).toBe('string')
    // No spurious agent_personality write on the rejection path.
    expect(state!.phase_state['agent_personality']).toBeUndefined()
    expect(recordedPersonality).toHaveLength(0)
  })
})

describe('P2 v2 § 7.1 — PersonaComposer.compose derives blend at synthesis time', () => {
  test('curated archetype names in agent_personality land curated voice fragments in SOUL.md', async () => {
    const archetypes = new ArchetypeLibrary({
      dataDir: ARCHETYPE_DATA_DIR,
      cacheDir: join(tmp, 'arch-cache'),
    })
    const composer = new PersonaComposer({
      cringeChecker: permissiveCringeChecker(),
      ownerHomeFor: (slug: string): string => join(tmp, slug, 'persona'),
      archetypes,
    })

    const draft = await composer.compose({
      project_slug: OWNER,
      signals: {
        display_name: 'Sage',
        user_first_name: 'Mira',
        agent_name: 'Sage',
        agent_personality: 'Sherlock Holmes meets Marcus Aurelius',
      },
      user_facts: {
        display_name: 'Mira',
      },
      priority_map: { programs: [] },
    })

    // Curated voice fragments threaded into SOUL.md — these phrases come
    // from `onboarding/archetypes/data/sherlock-holmes.md` and
    // `marcus-aurelius.md`, NOT from the user's reply.
    expect(draft.soul_md).toContain('Sherlock Holmes')
    expect(draft.soul_md).toContain('Marcus Aurelius')
  })

  test('prose reply with no curated mention lands a free-text blend with phrase preserved', async () => {
    const archetypes = new ArchetypeLibrary({
      dataDir: ARCHETYPE_DATA_DIR,
      cacheDir: join(tmp, 'arch-cache-2'),
    })
    const composer = new PersonaComposer({
      cringeChecker: permissiveCringeChecker(),
      ownerHomeFor: (slug: string): string => join(tmp, slug, 'persona'),
      archetypes,
    })

    const personality = 'a warm collaborator who explains the why'
    const draft = await composer.compose({
      project_slug: OWNER,
      signals: {
        display_name: 'Sage',
        user_first_name: 'Mira',
        agent_name: 'Sage',
        agent_personality: personality,
      },
      user_facts: {
        display_name: 'Mira',
      },
      priority_map: { programs: [] },
    })

    // Free-text blend → the prose phrase itself is the archetypal voice.
    expect(draft.soul_md).toContain(personality)
  })

  test('compose works without a library wired (free-text-only fallback)', async () => {
    const composer = new PersonaComposer({
      cringeChecker: permissiveCringeChecker(),
      ownerHomeFor: (slug: string): string => join(tmp, slug, 'persona'),
    })

    const personality = 'Sherlock Holmes meets Marcus Aurelius'
    const draft = await composer.compose({
      project_slug: OWNER,
      signals: {
        display_name: 'Sage',
        user_first_name: 'Mira',
        agent_name: 'Sage',
        agent_personality: personality,
      },
      user_facts: { display_name: 'Mira' },
      priority_map: { programs: [] },
    })

    // Without `deps.archetypes`, the composer falls back to a pure
    // free-text blend — the phrase is preserved verbatim, no curated
    // voice fragments are pulled in. This is the "library skipped"
    // fixture path (production always wires the library).
    expect(draft.soul_md).toContain(personality)
  })

  test('compose falls back to a "balanced" free-text blend when agent_personality is missing', async () => {
    const composer = new PersonaComposer({
      cringeChecker: permissiveCringeChecker(),
      ownerHomeFor: (slug: string): string => join(tmp, slug, 'persona'),
    })

    const draft = await composer.compose({
      project_slug: OWNER,
      signals: {
        display_name: 'Sage',
        user_first_name: 'Mira',
        agent_name: 'Sage',
        // no agent_personality
      },
      user_facts: { display_name: 'Mira' },
      priority_map: { programs: [] },
    })

    // Pre-existing pre-stashed blend would short-circuit, and missing
    // personality lands the free-text "balanced" blend (spec § 3.9
    // edge case: 'User says "I don\'t know — you decide"').
    expect(draft.soul_md.length).toBeGreaterThan(0)
    expect(draft.status).toBe('draft')
  })
})
