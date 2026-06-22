/**
 * GAP1 — additive-confirm-merge engine test (Argus r1 "Important": the
 * additive-merge confirm path in `consumeProjectsProposedChoice` had NO
 * direct test, which is exactly why the union/removal bug slipped).
 *
 * This drives REAL `engine.advance` at `projects_proposed` through the
 * PROD-wired conversational router: a freeform reply is routed by
 * `dispatchRouterDecision`'s `advance` branch, which unions the router's
 * extracted `primary_projects` onto the seeded list (minus explicit
 * `removed_projects`) via `mergeAdvanceProjectsAdditively`, then confirms
 * via `consumeProjectsProposedChoice` (writing `primary_projects_confirmed`).
 * The router on a confirm/restate advance anchors to the proposed list and
 * returns a SHORTER `primary_projects` (dropping the user's net-new
 * additions) — the exact mechanism that shrank Sam's 7-project seed to 3.
 *
 * It pins all three branches of the brief's
 * "union(seeded, extracted) minus explicit removals" rule:
 *   1. A confirm whose extraction is SHORTER keeps the full seeded list
 *      (additive — never silently shrinks).
 *   2. A reply that explicitly names a removal (`removed_projects`) drops
 *      exactly that one and keeps the rest.
 *   3. A plain confirm that extracts nothing drops nothing.
 *
 * The promptDriver extraction seam was removed in the 2026-06-21 onboarding
 * consolidation; the router `state_delta` is now the single capture path, so
 * these tests drive it through the prod-functional router seam (stubRouter +
 * stubPlatform) instead of the deleted driver.
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

/** A REVIEW/CORRECTION confirm advance (the hybrid case where an `advance`
 *  carries a non-null `state_delta`). The router's extracted
 *  `primary_projects` ANCHORS to a SHORTER subset (the exact production
 *  shrink); a named removal arrives in `removed_projects`. The engine unions
 *  the adds onto the seeded list, subtracts removals, then confirms. */
function confirmDecision(
  freeform_text: string,
  extracted: ReadonlyArray<string>,
  removed?: ReadonlyArray<string>,
): RouterDecision {
  return {
    action: 'advance',
    confidence: 0.95,
    choice_value: null,
    freeform_text,
    response: null,
    state_delta:
      removed !== undefined
        ? { primary_projects: [...extracted], removed_projects: [...removed] }
        : { primary_projects: [...extracted] },
    reasoning: 'test: projects_proposed confirm advance, anchored extraction',
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

/** Seed state at projects_proposed with the 7-project list + emit the
 *  confirm prompt so a freeform reply resolves against a live allow_freeform
 *  button row. */
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
  text: string,
  observed_at: number,
): Promise<void> {
  // Drive the REAL freeform path: a typed reply with NO matching ButtonChoice,
  // so normalAdvance hits the `freeform` interaction-mode branch → consults the
  // llmRouter → dispatchRouterDecision (advance branch for a confirm/restate).
  await engine.advance({
    project_slug: 'casey',
    topic_id: 'topic-1',
    user_id: 'u-1',
    channel_kind: 'app-socket',
    freeform_text: text,
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
    // Router anchors to only [Topline, Northwind, Acme] for this reply —
    // dropping Buddhism + Biohacking, the exact 7→3 regression.
    const engine = makeEngine([
      confirmDecision(
        'go with Topline, Northwind, Acme, Buddhism and Biohacking',
        ['Topline', 'Northwind', 'Acme'],
      ),
    ])
    const _prompt_id = await seedAtProjectsProposed(engine)
    await confirmFreeform(
      engine,
      'go with Topline, Northwind, Acme, Buddhism and Biohacking',
      1_700_000_001_000,
    )
    const confirmed = await readConfirmed()
    // Union with the seeded 7 → all 7 survive (additive; never shrinks).
    expect(confirmed.length).toBe(7)
    for (const p of SEVEN) expect(confirmed).toContain(p)
  })

  test('an explicit removal drops exactly that one and keeps the rest', async () => {
    const engine = makeEngine([
      confirmDecision('looks good but drop Biohacking', [], ['Biohacking']),
    ])
    const _prompt_id = await seedAtProjectsProposed(engine)
    await confirmFreeform(engine, 'looks good but drop Biohacking', 1_700_000_001_000)
    const confirmed = await readConfirmed()
    expect(confirmed).not.toContain('Biohacking')
    // Every OTHER seeded project survives.
    for (const p of SEVEN.filter((p) => p !== 'Biohacking')) {
      expect(confirmed).toContain(p)
    }
    expect(confirmed.length).toBe(6)
  })

  test('a plain confirm that extracts nothing drops nothing', async () => {
    // A plain confirm carries no project delta at all (state_delta: null).
    const engine = makeEngine([
      {
        action: 'advance',
        confidence: 0.95,
        choice_value: null,
        freeform_text: 'looks good',
        response: null,
        state_delta: null,
        reasoning: 'test: plain confirm, no delta',
      },
    ])
    const _prompt_id = await seedAtProjectsProposed(engine)
    await confirmFreeform(engine, 'looks good', 1_700_000_001_000)
    const confirmed = await readConfirmed()
    expect(confirmed.length).toBe(7)
    for (const p of SEVEN) expect(confirmed).toContain(p)
  })
})
