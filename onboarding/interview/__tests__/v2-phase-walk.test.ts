/**
 * P2 v2 — phase-machine walk regression test.
 *
 * Spec: docs/plans/P2-onboarding-v2.md § 2.8 (LEGAL_TRANSITIONS table) +
 * § 3 (per-phase contracts). The brief calls for an end-to-end walk via
 * REAL `engine.advance` calls (no SQL stubs of intermediate phases) so
 * any future shortcut that bypasses a v2 phase regresses noisily.
 *
 * The walk covers the no-import branch (ai_substrate_offered = neither
 * → work_interview_gap_fill → personality_offered → ...). This is the
 * shortest legal v2 chain that exercises every user-visible phase + the
 * auto-skipped persona_synthesizing transit; the import-branch tail
 * (ai_substrate_offered → import_upload_pending → import_running →
 * import_analysis_presented) lands a dedicated integration test in S4
 * once the upload endpoint is wired.
 *
 * The static STATIC_PHASE_SPECS bodies drive the prompts (no LLM
 * substrate). Button taps + simple freeform advance on the static
 * fallback path with NO router consulted (`stubPlatform([])` →
 * `shouldConsultRouter` false on every freeform phase). The ONE step that
 * needs real extraction — `work_interview_gap_fill`, where the user
 * volunteers their project list + interests in a single reply — is served
 * by a scripted `llmRouter` decision: an `advance` carrying the projects +
 * interests as a `state_delta`, which the gap-fill best-effort extractor
 * reads to populate `primary_projects` / `non_work_interests` so the audit
 * gate clears in one turn (the "user volunteers multiple required fields
 * at once" case from spec § 3.8).
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
import type { RouterDecision } from '../llm-router.ts'
import { stubRouter, stubPlatform } from './interview-testkit.ts'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-v2-walk-'))
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
 * The single scripted `llmRouter` decision the walk needs — the gap-fill
 * extraction turn. `work_interview_gap_fill` is the one free-text phase
 * where the user volunteers multiple required fields at once (primary
 * projects + non-work interests). The engine's gap-fill best-effort
 * extractor reads `primary_projects` / `non_work_interests` off the
 * router's `state_delta` (the REVIEW/CORRECTION hybrid-advance shape) so
 * the required-fields audit clears in one turn and the engine advances to
 * `personality_offered` — exactly the spec § 3.8 case.
 *
 * Every OTHER freeform reply (signup name, personality, agent name) takes
 * the static `__freeform__` fall-through (the router is NOT consulted for
 * them: `stubPlatform([])` → `shouldConsultRouter` is false everywhere),
 * so this is the ONLY router decision the queue must supply.
 */
function gapFillDecision(): RouterDecision {
  return {
    action: 'advance',
    confidence: 0.97,
    choice_value: null,
    freeform_text:
      'Building a fragrance brand and a hotel group. Outside work: yoga and family time.',
    response: null,
    state_delta: {
      primary_projects: ['fragrance brand', 'hotel group', 'CC course'],
      non_work_interests: [{ name: 'yoga' }, { name: 'family time' }],
    },
    reasoning: 'User volunteered project list + interests in one reply.',
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
    // Single extraction seam: the gap-fill turn pulls projects + interests
    // off this scripted decision. `stubPlatform([])` keeps every other
    // freeform phase on the static fall-through (router not consulted), so
    // the queue holds exactly one decision.
    llmRouter: stubRouter([gapFillDecision()]).router,
    platform: stubPlatform([]),
  })
}

async function lastPromptId(): Promise<string> {
  const sent = sentPrompts[sentPrompts.length - 1]
  if (sent === undefined) throw new Error('no prompt has been sent yet')
  return sent.prompt.prompt_id
}

async function advanceFreeform(
  engine: InterviewEngine,
  project_slug: string,
  text: string,
  observed_at: number,
): Promise<void> {
  const prompt_id = await lastPromptId()
  const choice: ButtonChoice = {
    prompt_id,
    choice_value: '__freeform__',
    freeform_text: text,
    chosen_at: observed_at,
    speaker_user_id: 'u-1',
    channel_kind: 'app-socket',
  }
  await engine.advance({
    project_slug,
    topic_id: 'topic-1',
    user_id: 'u-1',
    channel_kind: 'app-socket',
    choice,
    observed_at,
  })
}

async function advanceButton(
  engine: InterviewEngine,
  project_slug: string,
  choice_value: string,
  observed_at: number,
): Promise<void> {
  const prompt_id = await lastPromptId()
  const choice: ButtonChoice = {
    prompt_id,
    choice_value,
    chosen_at: observed_at,
    speaker_user_id: 'u-1',
    channel_kind: 'app-socket',
  }
  await engine.advance({
    project_slug,
    topic_id: 'topic-1',
    user_id: 'u-1',
    channel_kind: 'app-socket',
    choice,
    observed_at,
  })
}

// NOTE (K11a6-rem2, 2026-07-06): the two table-invariant describe blocks
// that used to live here ("P2 v2 — LEGAL_TRANSITIONS table" +
// "P2 v2 — AUTO_SKIP_PHASES set") were SPLIT into the retained survivor
// `phase-transition-table.test.ts` (pure table imports, zero engine
// calls). Only the engine-WALK block below remains here — it drives the
// K11b1-dying `engine.start` / `advance` and co-deletes with them.

describe('P2 v2 — engine.advance walks every spec\'d phase', () => {
  test('import-branch fork — chatgpt tap lands at import_upload_pending (NOT direct runner-start)', async () => {
    // P2 v2 § 3.4 → § 3.5: picking chatgpt/claude/both at
    // ai_substrate_offered must route through import_upload_pending so
    // the user sees download instructions on the chat surface.
    // Regression catch for the Codex r1 P1 finding (v2 import branch
    // bypassed import_upload_pending entirely).
    const engine = makeEngine()
    const project_slug = 'casey'
    let observed_at = 1_700_000_000_000

    await engine.start({
      project_slug,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Casey', observed_at)
    let state = await stateStore.get(project_slug, 'u-1')
    expect(state!.phase).toBe('ai_substrate_offered')

    observed_at += 1_000
    await advanceButton(engine, project_slug, 'chatgpt', observed_at)
    state = await stateStore.get(project_slug, 'u-1')
    expect(state!.phase).toBe('import_upload_pending')
    expect(state!.phase_state['ai_substrate_used']).toBe('chatgpt')

    // The download-instruction body is the verbatim ChatGPT block per
    // § 6.4 — pin a couple of stable substrings.
    const lastPrompt = sentPrompts[sentPrompts.length - 1]!.prompt
    expect(lastPrompt.body).toContain('chatgpt.com')
    expect(lastPrompt.body).toContain('Export data')
  })

  test('no-import branch reaches completed via real engine.advance calls', async () => {
    const engine = makeEngine()
    const project_slug = 'casey'
    let observed_at = 1_700_000_000_000

    // start() emits the signup prompt + walks through identity_oauth +
    // instance_provisioned (both auto-skip).
    await engine.start({
      project_slug,
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    let state = await stateStore.get(project_slug, 'u-1')
    expect(state).not.toBeNull()
    // Walker may stop at signup (the first user-visible phase) — the
    // auto-skip set covers identity_oauth + instance_provisioned +
    // persona_synthesizing only.
    expect(state!.phase).toBe('signup')

    // signup → free-text reply with the user's first name. No router is
    // consulted (signup not in the conversational set), so consumeChoice
    // routes through STATIC_PHASE_SPECS['signup'].next_phase_on_default
    // which is instance_provisioned (auto-skipped) → ai_substrate_offered.
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Casey', observed_at)
    state = await stateStore.get(project_slug, 'u-1')
    expect(state!.phase).toBe('ai_substrate_offered')

    // ai_substrate_offered → tap "neither" → routes to
    // work_interview_gap_fill via next_phase_overrides.
    observed_at += 1_000
    await advanceButton(engine, project_slug, 'neither', observed_at)
    state = await stateStore.get(project_slug, 'u-1')
    expect(state!.phase).toBe('work_interview_gap_fill')

    // work_interview_gap_fill → freeform reply. The skeleton advances
    // to personality_offered after one turn (S5 wires the LLM self-loop).
    observed_at += 1_000
    await advanceFreeform(
      engine,
      project_slug,
      'Building a fragrance brand and a hotel group. Outside work: yoga and family time.',
      observed_at,
    )
    state = await stateStore.get(project_slug, 'u-1')
    expect(state!.phase).toBe('personality_offered')

    // personality_offered → freeform reply. Routes to agent_name_chosen.
    observed_at += 1_000
    await advanceFreeform(
      engine,
      project_slug,
      'A warm thinking-partner with a strategist edge.',
      observed_at,
    )
    state = await stateStore.get(project_slug, 'u-1')
    expect(state!.phase).toBe('agent_name_chosen')

    // agent_name_chosen → freeform reply. Routes to slug_chosen.
    // Regression catch for the Codex r1 P1 finding: the typed name must
    // be persisted on `phase_state.agent_name` so the slug picker +
    // downstream personaSync.recordAgentName(...) use the v2-chosen
    // name (not the user_first_name from signup).
    observed_at += 1_000
    await advanceFreeform(engine, project_slug, 'Sage', observed_at)
    state = await stateStore.get(project_slug, 'u-1')
    expect(state!.phase).toBe('slug_chosen')
    expect(state!.phase_state['agent_name']).toBe('Sage')

    // slug_chosen → skip-slug (no slug-picker hook wired in this test).
    // Gate-collapse (#93): projects_proposed is no longer an interactive
    // gate — `advanceFromSlugChosen` auto-confirms the already-reviewed
    // project list inline (writing primary_projects_confirmed[]) and
    // advances THROUGH projects_proposed → persona_synthesizing →
    // persona_reviewed in one step. The redundant "Good to go" approval
    // (Sam's 2026-06-05 double-approval complaint) is gone.
    observed_at += 1_000
    await advanceButton(engine, project_slug, 'skip-slug', observed_at)
    state = await stateStore.get(project_slug, 'u-1')
    expect(state!.phase).toBe('persona_reviewed')
    // The reviewed project list (from gap-fill extraction) was confirmed
    // without a second gate — shells are built from this in the wow-moment.
    expect(state!.phase_state['primary_projects_confirmed']).toEqual([
      'fragrance brand',
      'hotel group',
      'CC course',
    ])

    // persona_reviewed → "looks_good" tap. Routes to max_oauth_offered.
    observed_at += 1_000
    await advanceButton(engine, project_slug, 'looks_good', observed_at)
    state = await stateStore.get(project_slug, 'u-1')
    expect(state!.phase).toBe('max_oauth_offered')

    // max_oauth_offered → skip. Routes to wow_fired.
    // Without a wow dispatcher hook, the engine stays at wow_fired
    // (the dispatcher is the only way to advance to completed; that
    // path is exercised in wow-fired.test.ts).
    observed_at += 1_000
    await advanceButton(engine, project_slug, 'skip', observed_at)
    state = await stateStore.get(project_slug, 'u-1')
    expect(state!.phase).toBe('wow_fired')
  })
})
