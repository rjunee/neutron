/**
 * P2 v2 S8 — persona_synthesizing reads v2 phase_state end-to-end.
 *
 * Drives the engine through `projects_proposed` → `persona_synthesizing`
 * (auto-skip transit phase) → `persona_reviewed` with a real
 * `PersonaComposer` instance wired in. Seeds v2 phase_state directly
 * onto the state store at `projects_proposed`, then walks via real
 * `engine.advance` calls so the persona-gen pipeline fires under the
 * same code path production hits.
 *
 * Asserts:
 *   1. SOUL.md / USER.md / priority-map.md content carries the v2
 *      phase_state: `agent_personality` phrase, `primary_projects`,
 *      `non_work_interests`, `inner_circle`, `companies`.
 *   2. The canonical H1 headers (`# SOUL.md` / `# USER.md` /
 *      `# priority-map.md`) are preserved in the on-storage draft and
 *      on-disk files (internal consumers depend on them).
 *   3. The `persona_reviewed` body uses friendly section titles per
 *      T11 stripPersonaFileH1 — no `# SOUL.md` / `# USER.md` /
 *      `# priority-map.md` leaks at the user-facing render boundary.
 *   4. The Looks-good tap commits the draft to disk under
 *      `<owner_home>/persona/`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  tmp = mkdtempSync(join(tmpdir(), 'neutron-persona-v2-flow-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
  // P2 v2 § 0 #9 + § 7.1 — the archetype library lives on
  // `PersonaComposer`, not the engine, so curated-mention lookups
  // happen at synthesis time.
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
  // Threshold high enough that the fixture's clean text never trips a
  // regen loop. The cringe regen loop itself is exercised in
  // persona-cringe-regen.test.ts; this integration walks the happy path.
  return {
    threshold: 9999,
    async check({ content }): Promise<{ flags: number; reasons: string[] }> {
      return deterministicCringe(content)
    },
  }
}

const MIRA_V2_PHASE_STATE = {
  user_id: USER,
  topic_id: TOPIC,
  signup_via: 'web',
  user_first_name: 'Mira',
  agent_name: 'Sage',
  agent_personality: 'a warm thinking-partner with a sharp edge',
  primary_projects: [
    'Caldera (fragrance brand)',
    'Hera concept (perfume #1)',
    'Wholesale-distribution playbook',
  ],
  non_work_interests: [
    { name: 'yoga' },
    { name: 'mixing playlists for the family' },
    { name: 'rare-book hunting' },
  ],
  work_themes: ['fragrance product development', 'Caldera brand voice'],
  companies: ['Caldera (founder + creative director)'],
  inner_circle: ['Jordan (husband)', 'Lily (daughter)', 'Sam (perfumer)'],
} as const

async function seedProjectsProposed(): Promise<string> {
  await stateStore.upsert({
    user_id: USER,
    project_slug: OWNER,
    phase: 'projects_proposed',
    phase_state_patch: { ...MIRA_V2_PHASE_STATE },
    advanced_at: Date.now(),
  })
  // First advance (no choice) emits the projects_proposed prompt and
  // stamps `active_prompt_id` onto phase_state.
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

describe('P2 v2 S8 — persona_synthesizing consumes v2 phase_state', () => {
  test('SOUL/USER/priority-map drafts carry v2 collected_data + canonical H1s', async () => {
    const prompt_id = await seedProjectsProposed()
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'auto',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })

    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('persona_reviewed')

    const draftJson = state!.phase_state['persona_draft'] as
      | Record<string, unknown>
      | undefined
    expect(draftJson).toBeDefined()
    const soul = String(draftJson!['soul_md'] ?? '')
    const user = String(draftJson!['user_md'] ?? '')
    const map = String(draftJson!['priority_map_md'] ?? '')

    // Canonical H1s preserved on storage (downstream consumers depend
    // on them; T11's stripPersonaFileH1 peels them off at the
    // user-facing render boundary only).
    expect(soul.startsWith('# SOUL.md')).toBe(true)
    expect(user.startsWith('# USER.md')).toBe(true)
    expect(map.startsWith('# priority-map.md')).toBe(true)

    // SOUL.md: agent name + personality phrase + primary_projects +
    // non_work_interests + inner_circle.
    expect(soul).toContain('You are Sage')
    expect(soul).toContain('Mira')
    expect(soul).toContain('a warm thinking-partner with a sharp edge')
    expect(soul).toContain('Caldera (fragrance brand)')
    expect(soul).toContain('yoga')
    expect(soul).toContain('Jordan (husband)')

    // USER.md: Companies / Key Projects / Outside Interests / Inner Circle.
    expect(user).toContain('## Companies')
    expect(user).toContain('Caldera (founder + creative director)')
    expect(user).toContain('## Key Projects')
    expect(user).toContain('Caldera (fragrance brand)')
    expect(user).toContain('## Outside Interests')
    expect(user).toContain('yoga')
    expect(user).toContain('## Inner Circle')
    expect(user).toContain('Sam (perfumer)')

    // priority-map.md: Programs ← primary_projects, ### Work themes ←
    // work_themes, People Priority ← inner_circle.
    expect(map).toContain('## Programs')
    expect(map).toContain('Caldera (fragrance brand)')
    expect(map).toContain('### Work themes')
    expect(map).toContain('fragrance product development')
    expect(map).toContain('## People Priority')
    expect(map).toContain('Jordan (husband)')
  })

  test('persona_reviewed body renders a conversational summary (v0.1.80) — no raw .md leak', async () => {
    // v0.1.80 (2026-05-22) — `persona_reviewed` shows a 3-4 sentence
    // plain-English summary, NOT the raw SOUL.md / USER.md /
    // priority-map.md excerpts. The legacy "Voice + style" / "About you"
    // / "What matters" sectioning is GONE. Filenames must still never
    // leak.
    const prompt_id = await seedProjectsProposed()
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: 'auto',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })

    const lastPrompt = sentPrompts.at(-1)?.prompt
    expect(lastPrompt).toBeTruthy()
    // Summary opener is the deterministic `staticPersonaSummary` prefix
    // (no LLM summarizer is wired in this harness).
    expect(lastPrompt!.body).toContain("Here's how I'll work with you")
    expect(lastPrompt!.body).toContain('Sound right')
    // Raw-excerpt sectioning is GONE.
    expect(lastPrompt!.body).not.toContain('**Voice + style**')
    expect(lastPrompt!.body).not.toContain('**About you**')
    expect(lastPrompt!.body).not.toContain('**What matters**')
    // Canonical persona filenames must never leak.
    expect(lastPrompt!.body).not.toContain('# SOUL.md')
    expect(lastPrompt!.body).not.toContain('# USER.md')
    expect(lastPrompt!.body).not.toContain('# priority-map.md')
    // Gate-collapse (#93, 2026-06-05) — single "Looks good" CTA; freeform
    // typing is the tweak path (the "Tweak one line" / "Restart" buttons
    // were removed per Alex).
    const buttons = lastPrompt!.options.map((o) => o.body)
    expect(buttons).toEqual(['Looks good'])
  })

  test('agent_personality with a curated archetype mention lands a curated blend (Codex r1 P1 — library must be threaded)', async () => {
    // Regression catch for the Codex r1 P1 finding: buildComposeInput
    // must forward the engine's `archetypes` dep into
    // composeFromFreeText(...) so curated archetype mentions resolve to
    // the curated voice fragments. Without the threading, every v2
    // onboarding falls into the free-text branch even when the user
    // explicitly names "Sherlock" / "Gandalf" / "Marcus Aurelius".
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'projects_proposed',
      phase_state_patch: {
        ...MIRA_V2_PHASE_STATE,
        agent_personality: 'a Sherlock-style sharp investigator who pushes back',
      },
      advanced_at: Date.now(),
    })
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      observed_at: Date.now(),
    })
    const seedState = await stateStore.get(OWNER, USER)
    const apid = (seedState?.phase_state as Record<string, unknown>)['active_prompt_id']
    if (typeof apid !== 'string') {
      throw new Error('curated-blend test seed: missing active_prompt_id')
    }
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id: apid,
        choice_value: 'auto',
        chosen_at: Date.now(),
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: Date.now(),
    })

    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('persona_reviewed')
    const draftJson = state!.phase_state['persona_draft'] as
      | Record<string, unknown>
      | undefined
    const soul = String(draftJson!['soul_md'] ?? '')
    // Curated Sherlock fragments land in the Archetypal Blend section.
    // The curated voice_md is hand-tuned and contains "Sherlock" as a
    // section subheading + voice descriptors that the free-text fallback
    // would never emit.
    expect(soul).toContain('Sherlock')
    expect(soul).toContain('### Sherlock')
  })

  test('Looks-good tap commits the three persona files to disk', async () => {
    const projects_prompt_id = await seedProjectsProposed()
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
    // At persona_reviewed — tap Looks-good. The handler commits the
    // draft to disk + advances to max_oauth_offered.
    const reviewPrompt = sentPrompts.at(-1)!.prompt
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

    const home = join(tmp, OWNER, 'persona')
    const soulOnDisk = readFileSync(join(home, 'SOUL.md'), 'utf8')
    const userOnDisk = readFileSync(join(home, 'USER.md'), 'utf8')
    const mapOnDisk = readFileSync(join(home, 'priority-map.md'), 'utf8')

    expect(soulOnDisk.startsWith('# SOUL.md')).toBe(true)
    expect(soulOnDisk).toContain('You are Sage')
    expect(soulOnDisk).toContain('a warm thinking-partner with a sharp edge')

    expect(userOnDisk.startsWith('# USER.md')).toBe(true)
    expect(userOnDisk).toContain('## Companies')
    expect(userOnDisk).toContain('Caldera (founder + creative director)')
    expect(userOnDisk).toContain('## Outside Interests')

    expect(mapOnDisk.startsWith('# priority-map.md')).toBe(true)
    expect(mapOnDisk).toContain('## Programs')
    expect(mapOnDisk).toContain('Caldera (fragrance brand)')
    expect(mapOnDisk).toContain('## People Priority')
  })
})
