/**
 * Integration test — P2 v2 § 3.8 / S6 — work_interview_gap_fill self-loop.
 *
 * Walks the engine from `ai_substrate_offered` → `work_interview_gap_fill`
 * (via the no-import `neither` branch) and exercises the gap-fill
 * self-loop end-to-end:
 *
 *   1. Iteration-by-iteration extraction: each user reply extracts ≥1
 *      gap-fill field; arrays append (don't overwrite) across turns;
 *      the engine re-runs `auditRequiredFields()` after every reply.
 *   2. Audit-clean advance: when user_first_name + primary_projects (≥3)
 *      + non_work_interests (≥1) are all filled, the engine advances
 *      from `work_interview_gap_fill` → `personality_offered` and emits
 *      the next prompt.
 *   3. 5-iteration cap → phase=failed (NOT synthetic-placeholder
 *      advance). Per spec § 3.8 + § 12, when the cap fires with ≥1
 *      required field still missing the engine transitions to
 *      `phase='failed'` with `gap_fill_failure_reason =
 *      'gap_fill_cap_no_required_fields'` and `gap_fill_failure_missing
 *      = [...]`. The legacy "synthesize primary_projects=['work']"
 *      trapdoor is explicitly NOT taken.
 *
 * No real LLM is wired — the test's `promptDriver` stub returns a
 * deterministic `extracted_fields` payload based on the user's reply
 * (pattern matching on the reply text). This mirrors what a Haiku call
 * would do without binding the test to a model.
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
import type {
  DrivenPhasePromptSpec,
  ExtractedFields,
  GeneratePromptInput,
} from '@neutronai/onboarding/interview/llm-prompt-driver.ts'

const OWNER = 'mira'
const TOPIC = 'topic-1'
const USER = 'u-1'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-s6-gap-fill-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
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
 * Spec-conformant driver stub. Pattern-matches the most recent user
 * reply and emits the structured `extracted_fields` shape the real LLM
 * would emit. Other phases collapse to the static-fallback path.
 */
function makeGapFillDriver(): (input: GeneratePromptInput) => Promise<DrivenPhasePromptSpec> {
  return async (input) => {
    if (input.phase !== 'work_interview_gap_fill') {
      return {
        phase: input.phase,
        body: 'fallback',
        options: [],
        allow_freeform: true,
        next_phase_on_default: input.phase,
        is_fallback: true,
      }
    }
    const lastUser = [...input.transcript_so_far].reverse().find((t) => t.role === 'user')
    const reply = (lastUser?.body ?? '').toLowerCase()
    const extracted: ExtractedFields = {}
    if (reply.includes('halo launch')) {
      extracted.primary_projects = ['Halo launch']
    } else if (reply.includes('caldera and a book')) {
      extracted.primary_projects = ['Caldera', 'book project']
    } else if (reply.includes('climb')) {
      extracted.non_work_interests = [{ name: 'climbing', cadence_hint: 'weekly' }]
    }
    // Vary the body per turn so the engine's idempotency seed doesn't
    // collapse re-emits onto the same button_prompts row (a real LLM
    // would naturally produce a different question each turn; the
    // pattern-matching stub needs to mimic that variance so the next
    // user reply lands on a fresh prompt_id). `gap_fill_iteration_count`
    // is monotonically incremented by the engine handler — perfect for
    // body-variance seeding.
    const iteration = typeof input.phase_state['gap_fill_iteration_count'] === 'number'
      ? (input.phase_state['gap_fill_iteration_count'] as number)
      : 0
    const spec: DrivenPhasePromptSpec = {
      phase: input.phase,
      body: `gap-fill question turn ${iteration} reply=${reply.slice(0, 60)}`,
      options: [],
      allow_freeform: true,
      next_phase_on_default: input.phase,
      is_fallback: false,
    }
    if (Object.keys(extracted).length > 0) spec.extracted_fields = extracted
    return spec
  }
}

/**
 * No-op driver — used by the cap-hit test. Every reply yields zero
 * extraction so the audit never clears and we cap-hit at iteration 5.
 */
function makeUncooperativeDriver(): (
  input: GeneratePromptInput,
) => Promise<DrivenPhasePromptSpec> {
  return async (input) => {
    if (input.phase !== 'work_interview_gap_fill') {
      return {
        phase: input.phase,
        body: 'fallback',
        options: [],
        allow_freeform: true,
        next_phase_on_default: input.phase,
        is_fallback: true,
      }
    }
    // Vary the body per turn so each re-emit creates a fresh prompt_id
    // — same reason as `makeGapFillDriver` above. Use
    // `phase_state.gap_fill_iteration_count` (monotonic) so the body
    // changes even after readRecentTurns(6) saturates.
    const iteration = typeof input.phase_state['gap_fill_iteration_count'] === 'number'
      ? (input.phase_state['gap_fill_iteration_count'] as number)
      : 0
    const lastUser = [...input.transcript_so_far].reverse().find((t) => t.role === 'user')
    const reply = (lastUser?.body ?? '').slice(0, 40)
    return {
      phase: input.phase,
      body: `gap-fill question turn ${iteration} reply=${reply}`,
      options: [],
      allow_freeform: true,
      next_phase_on_default: input.phase,
      is_fallback: false,
    }
  }
}

function makeEngine(
  driver: (input: GeneratePromptInput) => Promise<DrivenPhasePromptSpec>,
): InterviewEngine {
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push({ prompt: input.prompt })
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    promptDriver: driver,
  })
}

async function lastPromptId(): Promise<string> {
  const sent = sentPrompts[sentPrompts.length - 1]
  if (sent === undefined) throw new Error('no prompt has been sent yet')
  return sent.prompt.prompt_id
}

async function advanceFreeform(
  engine: InterviewEngine,
  text: string,
  observed_at: number,
): Promise<void> {
  const prompt_id = await lastPromptId()
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

async function landAtGapFill(
  engine: InterviewEngine,
  observed_at: number,
): Promise<number> {
  // signup → user_first_name capture.
  await engine.start({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    signup_via: 'web',
  })
  let t = observed_at
  t += 1_000
  await advanceFreeform(engine, 'Mira', t)
  // ai_substrate_offered → neither (no-import branch).
  t += 1_000
  const prompt_id = await lastPromptId()
  await engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'app-socket',
    choice: {
      prompt_id,
      choice_value: 'neither',
      chosen_at: t,
      speaker_user_id: USER,
      channel_kind: 'app-socket',
    },
    observed_at: t,
  })
  const state = await stateStore.get(OWNER, USER)
  expect(state!.phase).toBe('work_interview_gap_fill')
  return t
}

describe('S6 work_interview_gap_fill — iterates until required fields filled', () => {
  test('no-import branch: 3-turn walk fills primary_projects + non_work_interests then advances to personality_offered', async () => {
    const engine = makeEngine(makeGapFillDriver())
    let t = await landAtGapFill(engine, 1_700_000_000_000)

    // Iteration 1 — user mentions ONE project. Audit still needs ≥3
    // projects + ≥1 interest → stay on gap_fill.
    t += 1_000
    await advanceFreeform(engine, "I'm working on Halo launch", t)
    let state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('work_interview_gap_fill')
    let ps = state!.phase_state as Record<string, unknown>
    expect(ps['primary_projects']).toEqual(['Halo launch'])
    expect(ps['gap_fill_iteration_count']).toBe(1)

    // Iteration 2 — user mentions TWO more projects. After merge:
    // primary_projects=['Halo launch','Caldera','book project']
    // (audit clears). non_work_interests still missing → stay.
    t += 1_000
    await advanceFreeform(engine, 'Also Caldera and a book', t)
    state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('work_interview_gap_fill')
    ps = state!.phase_state as Record<string, unknown>
    expect(ps['primary_projects']).toEqual([
      'Halo launch',
      'Caldera',
      'book project',
    ])
    expect(ps['gap_fill_iteration_count']).toBe(2)

    // Iteration 3 — user mentions a non-work interest. After merge:
    // non_work_interests=[{name:'climbing',cadence_hint:'weekly'}]
    // (audit clears all three required-for-gap-fill fields). Engine
    // advances to personality_offered.
    t += 1_000
    await advanceFreeform(engine, 'Outside work I climb a lot', t)
    state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('personality_offered')
    ps = state!.phase_state as Record<string, unknown>
    expect(ps['non_work_interests']).toEqual([
      { name: 'climbing', cadence_hint: 'weekly' },
    ])
    // The iteration counter persists on the upsert that advanced us.
    expect(ps['gap_fill_iteration_count']).toBe(3)
  })

  test('user_first_name set at signup is preserved across gap_fill iterations (no overwrite)', async () => {
    const engine = makeEngine(makeGapFillDriver())
    let t = await landAtGapFill(engine, 1_700_000_000_000)
    let state = await stateStore.get(OWNER, USER)
    expect(state!.phase_state['user_first_name']).toBe('Mira')

    // Walk the full happy path. The user's first name must survive
    // intact — the LLM driver's gap-fill turn does NOT touch
    // user_first_name and the engine merge must not erase it.
    t += 1_000
    await advanceFreeform(engine, "I'm working on Halo launch", t)
    t += 1_000
    await advanceFreeform(engine, 'Also Caldera and a book', t)
    t += 1_000
    await advanceFreeform(engine, 'Outside work I climb a lot', t)
    state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('personality_offered')
    expect(state!.phase_state['user_first_name']).toBe('Mira')
  })
})

describe('S6 work_interview_gap_fill — fallback / idempotency hardening (Codex r1 P1)', () => {
  test('duplicate webhook delivery is a no-op (does not bump iteration counter or advance state)', async () => {
    const engine = makeEngine(makeGapFillDriver())
    let t = await landAtGapFill(engine, 1_700_000_000_000)

    // Reply once — this consumes the gap-fill choice and bumps the
    // counter to 1.
    t += 1_000
    await advanceFreeform(engine, "I'm working on Halo launch", t)
    let state = await stateStore.get(OWNER, USER)
    expect(state!.phase_state['gap_fill_iteration_count']).toBe(1)
    expect(state!.phase).toBe('work_interview_gap_fill')

    // Re-deliver the SAME choice (same prompt_id) — the engine should
    // treat this as a duplicate callback (was_new=false), keep state
    // untouched, and NOT bump the iteration counter.
    // We can't reuse `lastPromptId()` (it's already advanced); instead
    // we replay the previously-resolved prompt_id directly.
    const all_prompts = sentPrompts.map((p) => p.prompt)
    const gap_fill_prompt_id = all_prompts.find((p) => p.body.startsWith('gap-fill question turn'))!.prompt_id
    const duplicate: ButtonChoice = {
      prompt_id: gap_fill_prompt_id,
      choice_value: '__freeform__',
      freeform_text: "I'm working on Halo launch",
      chosen_at: t + 100,
      speaker_user_id: USER,
      channel_kind: 'app-socket',
    }
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: duplicate,
      observed_at: t + 100,
    })
    state = await stateStore.get(OWNER, USER)
    // Counter still 1 — duplicate didn't bump.
    expect(state!.phase_state['gap_fill_iteration_count']).toBe(1)
    expect(state!.phase).toBe('work_interview_gap_fill')
  })

  test('LLM driver unwired → first gap-fill reply advances to personality_offered (no cap-fail strand)', async () => {
    // Engine with NO promptDriver. Drive the owner straight to
    // work_interview_gap_fill via direct state injection (the no-import
    // branch needs neither a driver nor an LLM for the upstream phases,
    // but the cleanest setup is to seed phase=work_interview_gap_fill
    // and replay the gap-fill turn).
    const engine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push({ prompt: input.prompt })
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
      // promptDriver: undefined — simulates an owner whose LLM
      // substrate is unwired (the failure mode Codex r1 P1 flagged).
    })
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'work_interview_gap_fill',
      phase_state_patch: {
        user_first_name: 'Mira',
        signup_via: 'web',
      },
      advanced_at: 1,
    })
    // Drive the engine to emit the current phase's prompt so we can
    // resolve it.
    await engine.emitCurrentPhasePrompt({
      user_id: USER,
      project_slug: OWNER,
      topic_id: TOPIC,
      observed_at: 1_000,
    })
    expect(sentPrompts.length).toBeGreaterThan(0)

    // The user replies — without an LLM the engine cannot extract,
    // but it must NOT trap the user. It advances via the static
    // spec's next_phase_on_default → personality_offered.
    const prompt_id = await lastPromptId()
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice: {
        prompt_id,
        choice_value: '__freeform__',
        freeform_text: 'I work on a bunch of stuff',
        chosen_at: 2_000,
        speaker_user_id: USER,
        channel_kind: 'app-socket',
      },
      observed_at: 2_000,
    })
    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('personality_offered')
    // No iteration counter set — we took the fallback path, not the
    // loop path.
    expect(state!.phase_state['gap_fill_iteration_count']).toBeUndefined()
  })
})

describe('S6 work_interview_gap_fill — 5-iteration cap → phase=failed', () => {
  test('5 uncooperative replies → engine transitions to phase=failed with reason + missing fields (NO synthetic placeholder)', async () => {
    const engine = makeEngine(makeUncooperativeDriver())
    let t = await landAtGapFill(engine, 1_700_000_000_000)

    // Replies 1-4 — each extracts nothing, audit stays dirty, engine
    // stays on gap_fill and bumps the iteration counter.
    const skipReplies = ['skip', 'idk', 'next', 'no']
    for (const reply of skipReplies) {
      t += 1_000
      await advanceFreeform(engine, reply, t)
      const mid = await stateStore.get(OWNER, USER)
      expect(mid!.phase).toBe('work_interview_gap_fill')
    }
    let state = await stateStore.get(OWNER, USER)
    expect(state!.phase_state['gap_fill_iteration_count']).toBe(4)
    expect(state!.phase).toBe('work_interview_gap_fill')

    // Reply 5 — cap fires. Engine transitions to phase=failed with the
    // structured failure reason. NO synthetic-placeholder advance to
    // personality_offered (per spec § 3.8 trapdoor fix).
    t += 1_000
    await advanceFreeform(engine, 'still nothing', t)
    state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('failed')
    const ps = state!.phase_state as Record<string, unknown>
    expect(ps['gap_fill_iteration_count']).toBe(5)
    expect(ps['gap_fill_failure_reason']).toBe('gap_fill_cap_no_required_fields')
    expect(ps['gap_fill_failure_missing']).toEqual([
      'primary_projects',
      'non_work_interests',
    ])
    // Audit didn't synthesize placeholder data — primary_projects /
    // non_work_interests are still missing on phase_state.
    expect(ps['primary_projects']).toBeUndefined()
    expect(ps['non_work_interests']).toBeUndefined()
  })
})
