/**
 * GAP1 LIVE-PATH — additive project merge on the REAL import-review path
 * (Argus r2 BLOCKER, onboarding-wow-handoff-fix r3, 2026-06-09).
 *
 * The r1 GAP1 fix wired the additive `union(seeded, extracted) minus
 * removals` merge into `consumeProjectsProposedChoice` — but that handler
 * is BYPASSED on the live import flow (`projects_proposed` is auto-collapsed
 * by `autoConfirmProjectsProposedAndAdvance`), AND its merge is drain-based
 * (`drainPendingExtractedFieldsRaw`) which is prod-DEAD: production wires
 * `phaseSpecResolver` (which by contract "cannot produce extracted_fields"),
 * NOT `promptDriver`, so `pendingExtractedFields` is never populated.
 *
 * The PROD-wired capture path on `import_analysis_presented` is the
 * `llmRouter` `state_delta`. On a confirm/restate *advance* ("go with A, B,
 * C, D, E") the router's extracted `primary_projects` anchors to the
 * proposed list and returns a SHORTER set, dropping the user's net-new
 * additions; `consumeChoice → whitelistRouterStateDelta` then plain-
 * OVERWRITES the seeded list with it — Sam's 2026-06-09 signup seeded 7
 * projects and shelled 3.
 *
 * These tests drive the ACTUAL live path — a freeform reply at
 * `import_analysis_presented` through the REAL
 * `engine.advance → llmRouter.route → dispatchRouterDecision → consumeChoice
 *  → consumeImportAnalysisPresentedChoice` chain (NOT
 * `consumeProjectsProposedChoice`, NOT a SQL-stub to `projects_proposed`) —
 * and assert the seeded additions SURVIVE in `primary_projects`. That field
 * is the prod source of truth for project shells:
 * `autoConfirmProjectsProposedAndAdvance` (engine.ts ~7741) copies
 * `primary_projects` → `primary_projects_confirmed` (~7820), and the wow
 * action `03-project-shells.ts` builds one shell per confirmed project —
 * so preserving the full list HERE is what gets ALL selected projects shells.
 *
 * The engine is wired WITHOUT a `promptDriver` (mirroring production) so the
 * fix is proven on the prod-functional router path, not the dead drain.
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

const OWNER = 't1'
const USER = 'u-1'
const TOPIC = 'topic-1'

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
  tmp = mkdtempSync(join(tmpdir(), 'neutron-gap1-live-'))
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

/** A REVIEW/CORRECTION advance decision whose extracted `primary_projects`
 *  is SHORTER than the seeded list — the exact production anchoring that
 *  shrank Sam's 7 → 3. */
function advanceDecision(
  freeform_text: string,
  shorter: ReadonlyArray<string>,
): RouterDecision {
  return {
    action: 'advance',
    confidence: 0.95,
    choice_value: null,
    freeform_text,
    response: null,
    state_delta: { primary_projects: [...shorter] },
    reasoning: 'test: confirm advance, anchored shorter extraction',
  }
}

/** An explicit-removal amend decision — the router emits the remaining
 *  projects (dropping the named one). The amend branch keeps the plain
 *  overwrite so the removal is honored. */
function amendDropDecision(
  freeform_text: string,
  remaining: ReadonlyArray<string>,
): RouterDecision {
  return {
    action: 'amend',
    confidence: 0.95,
    choice_value: null,
    freeform_text,
    response: null,
    state_delta: { primary_projects: [...remaining] },
    reasoning: 'test: explicit removal amend',
  }
}

/** A REVIEW-COMPLETING REMOVAL routed as an ADVANCE — the realistic "drop X,
 *  the rest are good, go ahead" flow. The router classifies this as `advance`
 *  (it completes the review) and carries the dropped name in `removed_projects`
 *  (per llm-router.ts § REVIEW-completing REMOVALS). It MAY also restate the
 *  kept `primary_projects` (anchored to the proposed list) — the engine
 *  subtracts removals from the `(prior ∪ adds)` union regardless. Without the
 *  r4 fix the additive union re-adds the dropped project from the seeded prior
 *  and it gets a shell. */
function advanceWithRemovalDecision(
  freeform_text: string,
  kept: ReadonlyArray<string>,
  removed: ReadonlyArray<string>,
): RouterDecision {
  return {
    action: 'advance',
    confidence: 0.95,
    choice_value: null,
    freeform_text,
    response: null,
    state_delta: { primary_projects: [...kept], removed_projects: [...removed] },
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
    // NB no `promptDriver` — mirrors production (the drain path is dead).
    llmRouter: router,
    platform: stubPlatform('all'),
  })
}

/** Seed state at import_analysis_presented with the 7-project list + emit
 *  the (static) review prompt so the freeform reply resolves against a live
 *  allow_freeform button row, exactly as the live web client would. */
async function seedAtImportAnalysisPresented(
  engine: InterviewEngine,
): Promise<string> {
  await stateStore.upsert({
    project_slug: OWNER,
    user_id: USER,
    phase: 'import_analysis_presented',
    phase_state_patch: {
      primary_projects: [...SEVEN],
      // A non-empty import_result keeps the downstream audit / collapse
      // paths on the real branches (proposed_projects mirrors the seed).
      import_result: {
        proposed_projects: SEVEN.map((name) => ({ name })),
        non_work_interests: [],
      },
    },
    advanced_at: 1_700_000_000_000,
  })
  await engine.emitCurrentPhasePrompt({
    project_slug: OWNER,
    user_id: USER,
    topic_id: TOPIC,
    observed_at: 1_700_000_000_500,
  })
  const sent = sentPrompts[sentPrompts.length - 1]
  if (sent === undefined) {
    throw new Error('no import_analysis_presented prompt emitted')
  }
  return sent.prompt.prompt_id
}

async function replyFreeform(
  engine: InterviewEngine,
  _prompt_id: string,
  text: string,
  observed_at: number,
): Promise<void> {
  // Drive the REAL freeform path: a typed reply with NO matching
  // ButtonChoice, so normalAdvance hits the `freeform` interaction-mode
  // branch → consults the llmRouter → dispatchRouterDecision. Passing a
  // synthetic `__freeform__` choice would short-circuit to consumeChoice
  // and bypass the router (the live channel never sees a choice here).
  await engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    freeform_text: text,
    observed_at,
  })
}

async function readPrimaryProjects(): Promise<ReadonlyArray<string>> {
  const s = await stateStore.get(OWNER, USER)
  const v = s?.phase_state['primary_projects']
  return Array.isArray(v) ? (v as string[]) : []
}

describe('GAP1 live import-analysis additive merge (router advance path)', () => {
  test('a confirm advance whose extraction is SHORTER keeps the full seeded list (no silent shrink → all shells)', async () => {
    // Reproduce-first: the router returns only [Topline, Northwind, Acme]
    // for this confirm — dropping Buddhism + Biohacking (the 7→3 regression).
    const engine = makeEngine([
      advanceDecision('go with Topline, Northwind, Acme, Buddhism and Biohacking', [
        'Topline',
        'Northwind',
        'Acme',
      ]),
    ])
    const prompt_id = await seedAtImportAnalysisPresented(engine)
    await replyFreeform(
      engine,
      prompt_id,
      'go with Topline, Northwind, Acme, Buddhism and Biohacking',
      1_700_000_001_000,
    )
    const primary = await readPrimaryProjects()
    // Union with the seeded 7 → all 7 survive → all 7 get shells downstream.
    expect(primary.length).toBe(7)
    for (const p of SEVEN) expect(primary).toContain(p)
  })

  test('an explicit-removal amend ("drop Biohacking") still drops exactly that one (overwrite preserved)', async () => {
    const remaining = SEVEN.filter((p) => p !== 'Biohacking')
    const engine = makeEngine([
      amendDropDecision('looks good but drop Biohacking', remaining),
    ])
    const prompt_id = await seedAtImportAnalysisPresented(engine)
    await replyFreeform(
      engine,
      prompt_id,
      'looks good but drop Biohacking',
      1_700_000_001_000,
    )
    const primary = await readPrimaryProjects()
    expect(primary).not.toContain('Biohacking')
    for (const p of remaining) expect(primary).toContain(p)
    expect(primary.length).toBe(6)
  })

  test('a review-completing REMOVAL routed as ADVANCE drops exactly the named project (no silent re-add → no shell) — Argus r3 BLOCKER', async () => {
    // Realistic flow the r3 additive-union regressed: "drop Biohacking, the
    // rest are good, go ahead" routes as an ADVANCE (it completes the review),
    // carrying removed_projects=['Biohacking']. The router restates the kept 6
    // (anchored to the proposed list). WITHOUT the r4 fix the additive union
    // re-adds Biohacking from the seeded prior-7 and it would get a shell.
    const kept = SEVEN.filter((p) => p !== 'Biohacking')
    const engine = makeEngine([
      advanceWithRemovalDecision(
        'looks great, just drop Biohacking and go ahead',
        kept,
        ['Biohacking'],
      ),
    ])
    const prompt_id = await seedAtImportAnalysisPresented(engine)
    await replyFreeform(
      engine,
      prompt_id,
      'looks great, just drop Biohacking and go ahead',
      1_700_000_001_000,
    )
    const primary = await readPrimaryProjects()
    // The dropped project must NOT survive (would otherwise get a shell).
    expect(primary).not.toContain('Biohacking')
    // The kept 6 all survive.
    for (const p of kept) expect(primary).toContain(p)
    expect(primary.length).toBe(6)
    // The transient signal must NOT persist into phase_state.
    const s = await stateStore.get(OWNER, USER)
    expect(s?.phase_state['removed_projects']).toBeUndefined()
  })

  test('an advance that ADDS net-new freeform projects (no removal) still keeps them all — no regression', async () => {
    // The r3 additive behaviour must survive: a confirm whose extraction adds
    // a net-new project the seed did not have keeps the full union.
    const engine = makeEngine([
      advanceWithRemovalDecision(
        'all good, also add Marathon Training',
        [...SEVEN, 'Marathon Training'],
        [],
      ),
    ])
    const prompt_id = await seedAtImportAnalysisPresented(engine)
    await replyFreeform(
      engine,
      prompt_id,
      'all good, also add Marathon Training',
      1_700_000_001_000,
    )
    const primary = await readPrimaryProjects()
    expect(primary.length).toBe(8)
    for (const p of SEVEN) expect(primary).toContain(p)
    expect(primary).toContain('Marathon Training')
  })

  test('a plain confirm carrying no project delta drops nothing', async () => {
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
    const prompt_id = await seedAtImportAnalysisPresented(engine)
    await replyFreeform(engine, prompt_id, 'looks good', 1_700_000_001_000)
    const primary = await readPrimaryProjects()
    expect(primary.length).toBe(7)
    for (const p of SEVEN) expect(primary).toContain(p)
  })
})
