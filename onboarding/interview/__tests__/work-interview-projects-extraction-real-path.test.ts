/**
 * ISSUES #323 — onboarding DROPS an explicitly-stated project list then re-asks
 * at the end ("I didn't pin down concrete projects").
 *
 * REAL-PATH reproduction (NOT a `promptDriver` stub, NOT a SQL-stub past the
 * extraction phase). The engine is wired EXACTLY as production wires it:
 *
 *   - the REAL `buildLlmRouter` (not `stubRouter`) over a `FixtureAnthropicClient`
 *     that returns a realistic raw-model JSON envelope, so the router's own
 *     prompt construction + `parseRouterDecision` run for real;
 *   - `platform: stubPlatform([])` → `getOnboardingConversational() === false`,
 *     mirroring a fresh Open install where `NEUTRON_ONBOARDING_CONVERSATIONAL`
 *     is UNSET (the install never sets it);
 *   - NO `promptDriver` — production wires `phaseSpecResolver` + `llmRouter`,
 *     never `promptDriver`, so the gap-fill `extracted_fields` drain is dead.
 *
 * Why a mocked LLM is faithful here: the fixture's envelope mirrors the shape a
 * real Haiku/Sonnet classifier emits for the work-interview answer (an `advance`
 * carrying `freeform_text` + a hybrid `state_delta.primary_projects`), exactly
 * the `advance_examples` shape the gap-fill knowledge pack prompts for
 * ("Topline, Northwind, Beacon, CC" → projects list → free-text advance). We do
 * NOT stub the router decision object; the router parses the raw envelope.
 *
 * ROOT CAUSE this pins: with the conversational flag off, `shouldConsultRouter`
 * gated the router OFF for `work_interview_gap_fill`, so the freeform answer fell
 * to `consumeWorkInterviewGapFillChoice`'s driver-unwired branch →
 * `fallbackGapFillToStaticAdvance(input, observed_at, {})` → advance with an
 * EMPTY patch → the project list was silently discarded → `primary_projects`
 * empty → `autoConfirmProjectsProposedAndAdvance` zero-state guard re-emits the
 * "I didn't pin down concrete projects" prompt.
 *
 * RED before the fix (projects dropped, zero-state prompt fires); GREEN after
 * (the router is consulted for this extraction-critical phase regardless of the
 * flag, the 5 projects land in `primary_projects` → `primary_projects_confirmed`,
 * and no zero-state prompt fires).
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
import { buildLlmRouter } from '../llm-router.ts'
import { FixtureAnthropicClient } from '../fixture-anthropic-client.ts'
import { stubPlatform } from './interview-testkit.ts'

const OWNER = 't1'
const USER = 'u-1'
const TOPIC = 'topic-1'

// The exact answer Ryan gave on the real fresh onboarding (ISSUES #323).
const WORK_ANSWER =
  'Running three companies: Tabs, Pristine and Amascence. Side project Neutron ' +
  '(open source agent harness), side project Robobuddha, and meditation.'

const STATED_PROJECTS = ['Tabs', 'Pristine', 'Amascence', 'Neutron', 'Robobuddha']

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-323-'))
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
 * A realistic raw-model envelope for the work-interview answer: an `advance`
 * (the reply IS the answer to "what are you working on?") that ALSO records the
 * extracted facts via a hybrid `state_delta` — the `advance_examples` shape the
 * gap-fill knowledge pack prompts for. The `FixtureAnthropicClient` matches on a
 * distinctive token from the user's answer ("Amascence") so it never collides
 * with the pack's own in-prompt examples (Topline / Northwind / …).
 */
function workAnswerFixtureClient(): FixtureAnthropicClient {
  const envelope = JSON.stringify({
    action: 'advance',
    confidence: 0.96,
    choice_value: null,
    freeform_text: WORK_ANSWER,
    response: null,
    state_delta: {
      primary_projects: [...STATED_PROJECTS],
      non_work_interests: ['meditation'],
    },
    reasoning:
      'User answered the work-interview question by naming three companies and two side projects plus a non-work interest.',
  })
  return new FixtureAnthropicClient({
    fixturesDir: '<in-memory>',
    fixtures: [
      {
        call_id: 'router-work-interview-projects',
        match: { user_contains: ['Amascence'] },
        response: { content: [{ type: 'text', text: envelope }] },
      },
    ],
  })
}

/**
 * Production-faithful engine: real router over the fixture client, conversational
 * flag OFF (`stubPlatform([])`), NO promptDriver. This is the wiring a default
 * Open install runs with.
 */
function makeEngine(): InterviewEngine {
  const llmRouter = buildLlmRouter({ anthropicClient: workAnswerFixtureClient() })
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    // NB: no `promptDriver` and no `phaseSpecResolver` — exactly the gap that
    // left `work_interview_gap_fill` with no extraction seam when the router is
    // gated off. The router below is the ONLY extraction path.
    llmRouter,
    // Conversational flag OFF — the fresh-Open-install default.
    platform: stubPlatform([]),
  })
}

function lastPrompt(): ButtonPrompt {
  const sent = sentPrompts[sentPrompts.length - 1]
  if (sent === undefined) throw new Error('no prompt has been sent yet')
  return sent.prompt
}

/** Drive the REAL web freeform path: a typed reply with NO matching ButtonChoice
 *  so `advance` hits the freeform interaction-mode branch → `shouldConsultRouter`. */
async function replyFreeform(
  engine: InterviewEngine,
  text: string,
  observed_at: number,
): Promise<void> {
  await engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    freeform_text: text,
    observed_at,
  })
}

async function tapButton(
  engine: InterviewEngine,
  choice_value: string,
  observed_at: number,
): Promise<void> {
  const choice: ButtonChoice = {
    prompt_id: lastPrompt().prompt_id,
    choice_value,
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

async function readState() {
  const s = await stateStore.get(OWNER, USER)
  if (s === null) throw new Error('no onboarding state')
  return s
}

describe('ISSUES #323 — work-interview project extraction on the real prod path', () => {
  test('the freeform answer at work_interview_gap_fill populates primary_projects (router consulted despite conversational flag off)', async () => {
    const engine = makeEngine()
    let observed_at = 1_700_000_000_000

    // Seed at the gap-fill phase with the name already captured, then emit the
    // (static) gap-fill prompt so the freeform reply resolves against a live
    // allow_freeform row — exactly the live web shape after the no-import fork.
    await stateStore.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'work_interview_gap_fill',
      phase_state_patch: { user_first_name: 'Ryan', signup_via: 'web' },
      advanced_at: observed_at,
    })
    await engine.emitCurrentPhasePrompt({
      project_slug: OWNER,
      user_id: USER,
      topic_id: TOPIC,
      observed_at: observed_at + 1,
    })

    observed_at += 1_000
    await replyFreeform(engine, WORK_ANSWER, observed_at)

    const state = await readState()
    const primary = (state.phase_state['primary_projects'] as string[] | undefined) ?? []
    // RED before fix: primary === [] (the answer was dropped by the static
    // fallback). GREEN after fix: all five stated projects extracted.
    for (const p of STATED_PROJECTS) {
      expect(primary).toContain(p)
    }
    // The hybrid advance also recorded the non-work interest.
    const interests = JSON.stringify(state.phase_state['non_work_interests'] ?? [])
    expect(interests.toLowerCase()).toContain('meditation')
    // And it advanced past the gap-fill phase (the reply answered the question).
    expect(state.phase).toBe('personality_offered')
  })

  test('full no-import walk reaches the project-shell collapse WITHOUT the "didn\'t pin down" zero-state', async () => {
    const engine = makeEngine()
    let observed_at = 1_700_000_000_000

    // signup → name (static advance; router not consulted off-flag for signup).
    await engine.start({ project_slug: OWNER, topic_id: TOPIC, user_id: USER, signup_via: 'web' })
    expect((await readState()).phase).toBe('signup')
    observed_at += 1_000
    await replyFreeform(engine, 'Ryan', observed_at)
    expect((await readState()).phase).toBe('ai_substrate_offered')

    // no-import fork → work_interview_gap_fill.
    observed_at += 1_000
    await tapButton(engine, 'neither', observed_at)
    expect((await readState()).phase).toBe('work_interview_gap_fill')

    // The explicit project list — the turn that was being dropped.
    observed_at += 1_000
    await replyFreeform(engine, WORK_ANSWER, observed_at)
    let state = await readState()
    expect(state.phase).toBe('personality_offered')
    const primary = (state.phase_state['primary_projects'] as string[] | undefined) ?? []
    for (const p of STATED_PROJECTS) expect(primary).toContain(p)

    // personality → agent name → slug (static freeform advances; off-flag).
    observed_at += 1_000
    await replyFreeform(engine, 'A warm strategist who pushes back', observed_at)
    expect((await readState()).phase).toBe('agent_name_chosen')

    observed_at += 1_000
    await replyFreeform(engine, 'Orin', observed_at)
    expect((await readState()).phase).toBe('slug_chosen')

    // skip-slug collapses through projects_proposed. With a populated
    // primary_projects the auto-confirm copies it → primary_projects_confirmed
    // and advances; an EMPTY list (the bug) would instead re-emit the
    // zero-state "I didn't pin down concrete projects" prompt and park here.
    observed_at += 1_000
    await tapButton(engine, 'skip-slug', observed_at)
    state = await readState()

    expect(state.phase).not.toBe('projects_proposed')
    const confirmed =
      (state.phase_state['primary_projects_confirmed'] as string[] | undefined) ?? []
    for (const p of STATED_PROJECTS) expect(confirmed).toContain(p)

    // No emitted prompt anywhere in the flow used the zero-state copy.
    const allBodies = sentPrompts.map((s) => s.prompt.body).join('\n---\n')
    expect(allBodies).not.toContain("I didn't pin down concrete projects")
  })
})
