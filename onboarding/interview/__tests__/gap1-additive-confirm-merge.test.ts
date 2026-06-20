/**
 * GAP1 — additive-confirm-merge engine test (Argus r1 "Important": the
 * additive-merge confirm path in `consumeProjectsProposedChoice` had NO
 * direct test, which is exactly why the union/removal bug slipped).
 *
 * This drives REAL `engine.advance` through `consumeProjectsProposedChoice`
 * with a mock LLM driver that mimics the production extraction behavior:
 * on a "go with A, B, C, …" confirm reply the driver anchors to the
 * proposed list and returns a SHORTER `primary_projects` (dropping the
 * user's net-new additions) — the exact mechanism that shrank Sam's
 * 7-project seed to 3.
 *
 * It pins all three branches of the brief's
 * "union(seeded, extracted) minus explicit removals" rule:
 *   1. A confirm whose extraction is SHORTER keeps the full seeded list
 *      (additive — never silently shrinks).
 *   2. A reply that explicitly names a removal (`removed_projects`) drops
 *      exactly that one and keeps the rest.
 *   3. A plain confirm that extracts nothing drops nothing.
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
import type {
  DrivenPhasePromptSpec,
  GeneratePromptInput,
} from '../llm-prompt-driver.ts'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

const SEVEN = [
  'Topline',
  'Northwind',
  'Acme Studio',
  'Acme',
  'Info Product Playbooks',
  'Buddhism',
  'Biohacking',
]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-gap1-merge-'))
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
 * Driver that, at `projects_proposed`, reads the latest user reply and
 * stages extracted_fields the way the production LLM driver would:
 *   - "go with …"      → a SHORTER primary_projects (anchored to proposals).
 *   - "drop Biohacking" → removed_projects: ['Biohacking'].
 *   - anything else     → is_fallback (nothing extracted; a plain confirm).
 */
function makeDriver(): (input: GeneratePromptInput) => Promise<DrivenPhasePromptSpec> {
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
      const extracted: NonNullable<DrivenPhasePromptSpec['extracted_fields']> = {}
      if (reply.includes('go with')) {
        // The LLM anchors to the proposed list and returns a SHORTER set,
        // dropping the user's net-new additions (Buddhism, Biohacking).
        extracted.primary_projects = ['Topline', 'Northwind', 'Acme']
      }
      if (reply.includes('drop biohacking')) {
        extracted.removed_projects = ['Biohacking']
      }
      if (Object.keys(extracted).length > 0) {
        spec.extracted_fields = extracted
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

/** Seed state at projects_proposed with the 7-project list + emit the
 *  confirm prompt so a tap resolves against a live button row. */
async function seedAtProjectsProposed(engine: InterviewEngine): Promise<string> {
  await stateStore.upsert({
    project_slug: 'casey',
    user_id: 'u-1',
    phase: 'projects_proposed',
    phase_state_patch: { primary_projects: [...SEVEN] },
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
  observed_at: number,
): Promise<void> {
  const choice: ButtonChoice = {
    prompt_id,
    choice_value: '__freeform__',
    freeform_text: text,
    chosen_at: observed_at,
    speaker_user_id: 'u-1',
    channel_kind: 'app-socket',
  }
  await engine.advance({
    project_slug: 'casey',
    topic_id: 'topic-1',
    user_id: 'u-1',
    channel_kind: 'app-socket',
    choice,
    observed_at,
  })
}

async function readConfirmed(): Promise<ReadonlyArray<string>> {
  const s = await stateStore.get('casey', 'u-1')
  const v = s?.phase_state['primary_projects_confirmed']
  return Array.isArray(v) ? (v as string[]) : []
}

describe('GAP1 — consumeProjectsProposedChoice additive merge (union minus removals)', () => {
  test('a confirm whose extraction is SHORTER keeps the full seeded list (no silent shrink)', async () => {
    const engine = makeEngine()
    const prompt_id = await seedAtProjectsProposed(engine)
    // Driver will return only [Topline, Northwind, Acme] for this reply —
    // dropping Buddhism + Biohacking, the exact 7→3 regression.
    await confirmFreeform(
      engine,
      prompt_id,
      'go with Topline, Northwind, Acme, Buddhism and Biohacking',
      1_700_000_001_000,
    )
    const confirmed = await readConfirmed()
    // Union with the seeded 7 → all 7 survive (additive; never shrinks).
    expect(confirmed.length).toBe(7)
    for (const p of SEVEN) expect(confirmed).toContain(p)
  })

  test('an explicit removal drops exactly that one and keeps the rest', async () => {
    const engine = makeEngine()
    const prompt_id = await seedAtProjectsProposed(engine)
    await confirmFreeform(
      engine,
      prompt_id,
      'looks good but drop Biohacking',
      1_700_000_001_000,
    )
    const confirmed = await readConfirmed()
    expect(confirmed).not.toContain('Biohacking')
    // Every OTHER seeded project survives.
    for (const p of SEVEN.filter((p) => p !== 'Biohacking')) {
      expect(confirmed).toContain(p)
    }
    expect(confirmed.length).toBe(6)
  })

  test('a plain confirm that extracts nothing drops nothing', async () => {
    const engine = makeEngine()
    const prompt_id = await seedAtProjectsProposed(engine)
    await confirmFreeform(engine, prompt_id, 'looks good', 1_700_000_001_000)
    const confirmed = await readConfirmed()
    expect(confirmed.length).toBe(7)
    for (const p of SEVEN) expect(confirmed).toContain(p)
  })
})
