/**
 * GO-LIVE #5 (2026-06-20, owner live-dogfood) — "ignore <project>" must
 * genuinely exclude that project from materialization.
 *
 * THE BUG: at `projects_proposed` the owner replied "ignore real estate
 * investing". The model acknowledged it conversationally but did NOT populate
 * `state_delta.removed_projects` (the router prompt only enumerated
 * "drop/cut/skip"), so the additive union re-added the project and it was
 * materialized anyway.
 *
 * THE FIX has two halves:
 *   1. llm-router.ts — "ignore"/"exclude"/"leave out"/… are now first-class
 *      removal verbs that MUST populate `removed_projects`.
 *   2. honest copy — the projects_proposed prompt + FAQ tell the user the
 *      removal phrasings that work and that projects are editable later.
 *
 * This test pins the PLUMBING guarantee end-to-end: GIVEN an "ignore X" reply
 * the (corrected) extractor turns into `removed_projects: ['Real Estate
 * Investing']`, the engine's `consumeProjectsProposedChoice` union-minus-
 * removals path drops EXACTLY that project from the confirmed/materialized
 * set and keeps the rest. Mirrors gap1-additive-confirm-merge's harness.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonChoice, ButtonPrompt } from '../../../channels/button-primitive.ts'
import { InterviewEngine } from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import { PROJECTS_PROPOSED_CONFIRM } from '../phase-prompts.ts'
import type { DrivenPhasePromptSpec, GeneratePromptInput } from '../llm-prompt-driver.ts'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

const PROPOSED = [
  'Topline',
  'Northwind',
  'Acme',
  'Real Estate Investing',
  'Biohacking',
]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-ignore-removal-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * Driver mimicking the CORRECTED production LLM router: a reply naming a
 * removal verb ("ignore"/"exclude"/"leave out"/"drop"/"skip"/"don't set up")
 * against a proposed project populates `removed_projects`. Matches a single
 * proposed title case-insensitively.
 */
function makeDriver(): (input: GeneratePromptInput) => Promise<DrivenPhasePromptSpec> {
  const REMOVAL_VERBS = ['ignore', 'exclude', 'leave out', 'drop', 'skip', "don't set up", 'remove']
  return async (input) => {
    const spec: DrivenPhasePromptSpec = {
      phase: input.phase,
      body: 'fallback',
      options: [{ label: 'A', body: 'Good to go', value: PROJECTS_PROPOSED_CONFIRM }],
      allow_freeform: true,
      next_phase_on_default: input.phase,
      is_fallback: false,
    }
    if (input.phase === 'projects_proposed') {
      const lastUser = [...input.transcript_so_far].reverse().find((t) => t.role === 'user')
      const reply = (lastUser?.body ?? '').toLowerCase()
      const removed: string[] = []
      if (REMOVAL_VERBS.some((v) => reply.includes(v))) {
        for (const p of PROPOSED) {
          if (reply.includes(p.toLowerCase())) removed.push(p)
        }
      }
      if (removed.length > 0) {
        spec.extracted_fields = { removed_projects: removed }
      } else {
        spec.is_fallback = true
      }
      return spec
    }
    spec.is_fallback = true
    return spec
  }
}

function makeEngine(): InterviewEngine {
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    promptDriver: makeDriver(),
  })
}

async function seedAtProjectsProposed(engine: InterviewEngine): Promise<string> {
  await stateStore.upsert({
    project_slug: 'casey',
    user_id: 'u-1',
    phase: 'projects_proposed',
    phase_state_patch: { primary_projects: [...PROPOSED] },
    advanced_at: 1_700_000_000_000,
  })
  await engine.emitCurrentPhasePrompt({
    project_slug: 'casey',
    user_id: 'u-1',
    topic_id: 'topic-1',
    observed_at: 1_700_000_000_500,
  })
  const sent = sentPrompts[sentPrompts.length - 1]
  if (sent === undefined) throw new Error('no projects_proposed prompt emitted')
  return sent.prompt.prompt_id
}

async function confirmFreeform(
  engine: InterviewEngine,
  prompt_id: string,
  text: string,
): Promise<void> {
  const choice: ButtonChoice = {
    prompt_id,
    choice_value: '__freeform__',
    freeform_text: text,
    chosen_at: 1_700_000_001_000,
    speaker_user_id: 'u-1',
    channel_kind: 'app-socket',
  }
  await engine.advance({
    project_slug: 'casey',
    topic_id: 'topic-1',
    user_id: 'u-1',
    channel_kind: 'app-socket',
    choice,
    observed_at: 1_700_000_001_000,
  })
}

async function readConfirmed(): Promise<ReadonlyArray<string>> {
  const s = await stateStore.get('casey', 'u-1')
  const v = s?.phase_state['primary_projects_confirmed']
  return Array.isArray(v) ? (v as string[]) : []
}

describe('GO-LIVE #5 — an ignored project is genuinely NOT materialized', () => {
  test('"ignore real estate investing" removes exactly that project, keeps the rest', async () => {
    const engine = makeEngine()
    const prompt_id = await seedAtProjectsProposed(engine)
    await confirmFreeform(engine, prompt_id, 'these look good but ignore real estate investing')
    const confirmed = await readConfirmed()
    // The acknowledged ignore is HONORED — the project is gone from the
    // materialized set (pre-fix: it was union-re-added and created anyway).
    expect(confirmed).not.toContain('Real Estate Investing')
    // Every other proposed project survives.
    for (const p of PROPOSED.filter((p) => p !== 'Real Estate Investing')) {
      expect(confirmed).toContain(p)
    }
    expect(confirmed.length).toBe(PROPOSED.length - 1)
  })

  test('"leave out biohacking and ship it" is also honored as a removal', async () => {
    const engine = makeEngine()
    const prompt_id = await seedAtProjectsProposed(engine)
    await confirmFreeform(engine, prompt_id, 'leave out biohacking and ship it')
    const confirmed = await readConfirmed()
    expect(confirmed).not.toContain('Biohacking')
    expect(confirmed).toContain('Real Estate Investing')
    expect(confirmed.length).toBe(PROPOSED.length - 1)
  })

  test('a plain confirm with no removal verb keeps the full proposed list', async () => {
    const engine = makeEngine()
    const prompt_id = await seedAtProjectsProposed(engine)
    await confirmFreeform(engine, prompt_id, 'these all look great, go ahead')
    const confirmed = await readConfirmed()
    expect(confirmed.length).toBe(PROPOSED.length)
    for (const p of PROPOSED) expect(confirmed).toContain(p)
  })
})
