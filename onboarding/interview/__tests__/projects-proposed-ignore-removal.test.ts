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
 * the (corrected) router emits `removed_projects: ['Real Estate Investing']`
 * in its `state_delta`, the engine's `consumeProjectsProposedChoice` union-
 * minus-removals path (`mergeAdvanceProjectsAdditively`) drops EXACTLY that
 * project from the confirmed/materialized set and keeps the rest.
 *
 * The promptDriver extraction seam was removed in the 2026-06-21 onboarding
 * consolidation; the router `state_delta` is now the single capture path, so
 * this drives the prod-functional router seam (stubRouter + stubPlatform) —
 * scripting one REVIEW-completing `advance` decision per reply that carries
 * the `removed_projects` the corrected router now produces.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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
import type { RouterDecision } from '../llm-router.ts'
import {
  stubRouter,
  stubPlatform,
} from '@neutronai/onboarding/interview/__tests__/interview-testkit.ts'

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

/** A REVIEW-completing REMOVAL routed as an ADVANCE — the corrected router
 *  classifies "ignore X" / "leave out X" as a removal and carries the dropped
 *  name(s) in `removed_projects` (per llm-router.ts § REVIEW-completing
 *  REMOVALS). It MAY also restate the kept `primary_projects` (anchored to the
 *  proposed list) — the engine subtracts removals from the `(prior ∪ adds)`
 *  union regardless. The engine then confirms via consumeProjectsProposedChoice
 *  (writing `primary_projects_confirmed`). */
function removalDecision(
  freeform_text: string,
  removed: ReadonlyArray<string>,
  kept?: ReadonlyArray<string>,
): RouterDecision {
  return {
    action: 'advance',
    confidence: 0.95,
    choice_value: null,
    freeform_text,
    response: null,
    state_delta:
      kept !== undefined
        ? { primary_projects: [...kept], removed_projects: [...removed] }
        : { removed_projects: [...removed] },
    reasoning: 'test: review-completing removal routed as advance',
  }
}

function makeEngine(decisions: ReadonlyArray<RouterDecision>): InterviewEngine {
  const { router } = stubRouter(decisions)
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    // NB no `promptDriver` (removed 2026-06-21) — the router state_delta is
    // the single capture path. `platform: 'all'` flips the conversational
    // router ON for projects_proposed so the freeform reply routes through it.
    llmRouter: router,
    platform: stubPlatform('all'),
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
  text: string,
): Promise<void> {
  // Drive the REAL freeform path: a typed reply with NO matching ButtonChoice,
  // so normalAdvance hits the `freeform` interaction-mode branch → consults the
  // llmRouter → dispatchRouterDecision (advance branch for a review-completing
  // removal).
  await engine.advance({
    project_slug: 'casey',
    topic_id: 'topic-1',
    user_id: 'u-1',
    channel_kind: 'app-socket',
    freeform_text: text,
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
    const engine = makeEngine([
      removalDecision('these look good but ignore real estate investing', [
        'Real Estate Investing',
      ]),
    ])
    const _prompt_id = await seedAtProjectsProposed(engine)
    await confirmFreeform(engine, 'these look good but ignore real estate investing')
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
    const engine = makeEngine([
      removalDecision('leave out biohacking and ship it', ['Biohacking']),
    ])
    const _prompt_id = await seedAtProjectsProposed(engine)
    await confirmFreeform(engine, 'leave out biohacking and ship it')
    const confirmed = await readConfirmed()
    expect(confirmed).not.toContain('Biohacking')
    expect(confirmed).toContain('Real Estate Investing')
    expect(confirmed.length).toBe(PROPOSED.length - 1)
  })

  test('a plain confirm with no removal verb keeps the full proposed list', async () => {
    // A plain confirm carries no project delta at all (state_delta: null).
    const engine = makeEngine([
      {
        action: 'advance',
        confidence: 0.95,
        choice_value: null,
        freeform_text: 'these all look great, go ahead',
        response: null,
        state_delta: null,
        reasoning: 'test: plain confirm, no delta',
      },
    ])
    const _prompt_id = await seedAtProjectsProposed(engine)
    await confirmFreeform(engine, 'these all look great, go ahead')
    const confirmed = await readConfirmed()
    expect(confirmed.length).toBe(PROPOSED.length)
    for (const p of PROPOSED) expect(confirmed).toContain(p)
  })
})
