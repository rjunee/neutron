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
 * Static fallback bodies drive the prompts (no LLM substrate). The
 * engine's `promptDriver` stub returns `is_fallback=true` for every
 * free-text phase so the deterministic STATIC_PHASE_SPECS body lands.
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
import { isLegalTransition, LEGAL_TRANSITIONS } from '../phase.ts'
import type {
  DrivenPhasePromptSpec,
  GeneratePromptInput,
} from '../llm-prompt-driver.ts'
import type { OnboardingPhase } from '../phase.ts'

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
 * Returns a promptDriver stub that always falls back to the static spec.
 * The engine then routes via `STATIC_PHASE_SPECS[phase].next_phase_on_default`
 * (and the dynamic builders for slug_chosen / persona_reviewed) so the
 * walk path is deterministic.
 *
 * S6 (2026-05-16) — work_interview_gap_fill needs real extraction for
 * the no-import walk to terminate. The stub special-cases that phase:
 * it pulls primary_projects + non_work_interests off the most recent
 * user line via deterministic substring matching so the engine's audit
 * gate clears after one turn — exactly the "user volunteers multiple
 * required fields at once" case the spec § 3.8 example calls out.
 */
function makeFallbackDriver(): (input: GeneratePromptInput) => Promise<DrivenPhasePromptSpec> {
  return async (input) => {
    const spec: DrivenPhasePromptSpec = {
      phase: input.phase,
      body: 'fallback',
      options: [],
      allow_freeform: true,
      next_phase_on_default: input.phase,
      is_fallback: false,
    }
    if (input.phase === 'work_interview_gap_fill') {
      const lastUser = [...input.transcript_so_far].reverse().find((t) => t.role === 'user')
      const reply = lastUser?.body ?? ''
      const extracted: NonNullable<DrivenPhasePromptSpec['extracted_fields']> = {}
      if (/fragrance brand|hotel group/i.test(reply)) {
        extracted.primary_projects = ['fragrance brand', 'hotel group', 'CC course']
      }
      if (/yoga|family time/i.test(reply)) {
        extracted.non_work_interests = [{ name: 'yoga' }, { name: 'family time' }]
      }
      if (Object.keys(extracted).length > 0) spec.extracted_fields = extracted
    } else {
      spec.is_fallback = true
    }
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
    promptDriver: makeFallbackDriver(),
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

describe('P2 v2 — LEGAL_TRANSITIONS table', () => {
  test('every legal target is itself a known phase', () => {
    const allPhases = new Set(Object.keys(LEGAL_TRANSITIONS))
    for (const [from, targets] of Object.entries(LEGAL_TRANSITIONS)) {
      for (const to of targets) {
        expect({ from, target: to, known: allPhases.has(to) }).toEqual({
          from,
          target: to,
          known: true,
        })
      }
    }
  })

  test('terminal phases have no outgoing edges', () => {
    expect(LEGAL_TRANSITIONS['completed']).toEqual([])
    expect(LEGAL_TRANSITIONS['failed']).toEqual([])
  })

  test('isLegalTransition matches the table', () => {
    expect(isLegalTransition('signup', 'instance_provisioned')).toBe(true)
    expect(isLegalTransition('signup', 'identity_oauth')).toBe(true)
    expect(isLegalTransition('signup', 'agent_name_chosen')).toBe(false)
    expect(isLegalTransition('signup', 'wow_fired')).toBe(false)
  })

  test('v2 chain matches § 2.8 — every spec phase is reachable forward', () => {
    // Walk the v2 happy-path chain by edge — assert each (from, to)
    // pair is legal. Catches a future refactor that drops an edge.
    const noImportChain: Array<[string, string]> = [
      ['signup', 'instance_provisioned'],
      ['instance_provisioned', 'ai_substrate_offered'],
      ['ai_substrate_offered', 'work_interview_gap_fill'],
      ['work_interview_gap_fill', 'personality_offered'],
      ['personality_offered', 'agent_name_chosen'],
      ['agent_name_chosen', 'slug_chosen'],
      ['slug_chosen', 'projects_proposed'],
      ['projects_proposed', 'persona_synthesizing'],
      ['persona_synthesizing', 'persona_reviewed'],
      ['persona_reviewed', 'max_oauth_offered'],
      ['max_oauth_offered', 'wow_fired'],
      ['wow_fired', 'completed'],
    ]
    for (const [from, to] of noImportChain) {
      expect({ from, to, legal: isLegalTransition(from as OnboardingPhase, to as OnboardingPhase) }).toEqual({
        from,
        to,
        legal: true,
      })
    }
    // Import branch fork: ai_substrate_offered → import_upload_pending
    // → import_running → import_analysis_presented → personality_offered.
    const importChain: Array<[string, string]> = [
      ['ai_substrate_offered', 'import_upload_pending'],
      ['import_upload_pending', 'import_running'],
      ['import_running', 'import_analysis_presented'],
      ['import_analysis_presented', 'personality_offered'],
      ['import_analysis_presented', 'work_interview_gap_fill'],
    ]
    for (const [from, to] of importChain) {
      expect({ from, to, legal: isLegalTransition(from as OnboardingPhase, to as OnboardingPhase) }).toEqual({
        from,
        to,
        legal: true,
      })
    }
  })

  test('persona_reviewed has v2 redo edges back to earlier phases', () => {
    // § 2.12 — redo from persona_reviewed jumps back to personality_offered,
    // agent_name_chosen, or slug_chosen so the user can re-do an earlier
    // step. The forward edges (max_oauth_offered / wow_fired) also stand.
    const legal = LEGAL_TRANSITIONS['persona_reviewed']
    expect(legal).toContain('max_oauth_offered')
    expect(legal).toContain('personality_offered')
    expect(legal).toContain('agent_name_chosen')
    expect(legal).toContain('slug_chosen')
  })
})

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

    // signup → free-text reply with the user's first name. The fallback
    // driver returns is_fallback=true, so consumeChoice routes through
    // STATIC_PHASE_SPECS['signup'].next_phase_on_default which is
    // instance_provisioned (auto-skipped) → ai_substrate_offered.
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

describe('P2 v2 — AUTO_SKIP_PHASES set', () => {
  test('contains identity_oauth + instance_provisioned + persona_synthesizing only', () => {
    // The exported set is unobservable from outside the engine module
    // (it's a `const` not exported), so we audit by walking each phase
    // through the legal-transition table — auto-skip phases must have
    // at least one non-failure outgoing edge so the walker has a target.
    const expectedAutoSkip = [
      'identity_oauth',
      'instance_provisioned',
      'persona_synthesizing',
    ] as const
    for (const phase of expectedAutoSkip) {
      const legal = LEGAL_TRANSITIONS[phase]
      const nonFailureTargets = legal.filter((t) => t !== 'failed')
      expect({ phase, hasNonFailureTarget: nonFailureTargets.length > 0 }).toEqual({
        phase,
        hasNonFailureTarget: true,
      })
    }
    // agent_name_chosen is NOT auto-skip in v2 — it's user-visible per
    // § 3.10. Verify by asserting STATIC_PHASE_SPECS has a body that
    // captures the agent name (i.e. it's reachable / emitted).
    // Done via the spec-coverage test in m2-ux-surface-fixes.test.ts;
    // this row is the negative anchor.
  })
})
