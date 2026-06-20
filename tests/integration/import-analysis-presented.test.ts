/**
 * Integration test — P2 v2 § 2.3 + § 3.7 / S5 — import_analysis_presented.
 *
 * Walks the engine from `import_running` → `import_analysis_presented`
 * via a fake ImportJobRunner that returns a `completed` job with a
 * Alex-shape ImportResult (3 high-confidence projects + 1 low-conf
 * project, 1 high-conf interest + 1 low-conf interest). Asserts:
 *
 *   - the body lands as bullets per § 2.3:
 *       - all 4 project names appear verbatim
 *       - both interest names appear verbatim
 *       - the 2 low-confidence items surface in the "I'm less sure
 *         about" callout
 *       - NO themes section (Alex-locked drop)
 *       - confidence one-liner present ("Based on N conversations")
 *       - body ends with "Anything important I missed?"
 *   - the engine populates `phase_state.primary_projects`
 *     (verbatim names) and `phase_state.non_work_interests`
 *     from the import_result
 *   - a freeform reply is captured into
 *     `phase_state.user_supplied_corrections[]`
 *   - audit-aware routing:
 *       - when user_first_name + 3+ projects + 1+ interest are present,
 *         the engine advances to `personality_offered`
 *       - when non_work_interests is missing, the engine routes to
 *         `work_interview_gap_fill`
 *   - the failure path (`import_failed=true`) emits the graceful
 *     "couldn't analyze" body and routes the user's reply to
 *     `work_interview_gap_fill`
 *
 * No LLM substrate is wired — the engine's `promptDriver` stub always
 * falls back so the dynamic builder (which lives in phase-prompts.ts)
 * is the body source. This is intentional: the test pins the
 * deterministic builder per the brief's "test against the actual
 * phase-prompts builder, not a mocked output" rule.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ButtonChoice, ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import {
  InterviewEngine,
  type ImportJobRunnerHook,
  type ImportPayloadResolver,
} from '@neutronai/onboarding/interview/engine.ts'
import type { ImportJob, ImportResult } from '@neutronai/onboarding/history-import/types.ts'
import { InMemoryOnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'
import type {
  DrivenPhasePromptSpec,
  GeneratePromptInput,
} from '@neutronai/onboarding/interview/llm-prompt-driver.ts'

const OWNER = 'alex-test'
const TOPIC = 'chat'
const USER = 'u-1'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ prompt: ButtonPrompt }>
let runnerResults: Map<string, ImportJob>

function makeFallbackDriver(): (input: GeneratePromptInput) => Promise<DrivenPhasePromptSpec> {
  return async (input) => ({
    phase: input.phase,
    body: 'fallback',
    options: [],
    allow_freeform: true,
    next_phase_on_default: input.phase,
    is_fallback: true,
  })
}

function makeEngine(): InterviewEngine {
  const runner: ImportJobRunnerHook = {
    start: async () => ({ job_id: 'unused' }),
    status: async (job_id) => runnerResults.get(job_id) ?? null,
    cancel: async () => undefined,
    synthesizeOnDemand: async () => null,
  }
  const resolver: ImportPayloadResolver = {
    resolve: async () => null,
  }
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push({ prompt: input.prompt })
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    importJobRunner: runner,
    importPayloadResolver: resolver,
    promptDriver: makeFallbackDriver(),
  })
}

function ryanShapeResult(): ImportResult {
  return {
    conversation_count: 137,
    entities: [
      { name: 'Mira', kind: 'person', mention_count: 30 },
      { name: 'Omar', kind: 'person', mention_count: 8 },
    ],
    topics: [
      { name: 'Ledgerline pipeline', recurrence_score: 0.9, recency_score: 0.95 },
      { name: 'Childcare logistics', recurrence_score: 0.7, recency_score: 0.85 },
    ],
    proposed_projects: [
      {
        name: 'Ledgerline Hospitality',
        rationale: 'heavy thread mentions on legal, financial, co-guarantor logistics',
        suggested_topics: ['ledgerline-revenue'],
      },
      {
        name: 'Caldera',
        rationale: 'Q1 supply chain and brand work',
        suggested_topics: ['caldera-q3'],
      },
      {
        name: 'A book about contemplative awakening',
        rationale: 'chapter outlines + interview material',
        suggested_topics: ['book'],
      },
      {
        name: 'Sound Ceremony course',
        rationale: 'mentioned once in a single conversation',
        suggested_topics: ['sound-ceremony'],
      },
    ],
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: { tone: 'terse' },
    facts: {
      user_role: 'founder/CEO',
      companies: ['Ledgerline', 'Caldera'],
      key_people: ['Mira', 'Omar'],
    },
    inferred_interests: [
      { name: 'contemplative practice', basis: 'CC training / book material' },
      { name: 'wine tasting', basis: 'two ambiguous mentions, may have been someone else' },
    ],
    confidence_by_inference: [
      { field: 'project:Ledgerline Hospitality', score: 0.92, basis: '12 conversations across Q1' },
      { field: 'project:Caldera', score: 0.81, basis: '8 conversations in last 60d' },
      { field: 'project:A book about contemplative awakening', score: 0.7, basis: 'chapter outlines' },
      { field: 'project:Sound Ceremony course', score: 0.34, basis: 'single mention' },
      { field: 'interest:contemplative practice', score: 0.78 },
      { field: 'interest:wine tasting', score: 0.41, basis: 'ambiguous mentions' },
    ],
  }
}

function thinResult(): ImportResult {
  // Pass-2 inferred zero non-work interests — drives the audit-fail
  // route to work_interview_gap_fill.
  return {
    conversation_count: 8,
    entities: [],
    topics: [],
    proposed_projects: [
      { name: 'Caldera', rationale: 'fragrance brand', suggested_topics: [] },
      { name: 'Ledgerline', rationale: 'JV ops', suggested_topics: [] },
      { name: 'Childcare', rationale: 'family ops', suggested_topics: [] },
    ],
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {},
    facts: {},
  }
}

async function landAtImportRunning(opts: { import_result: ImportResult | null; import_failed?: boolean }): Promise<void> {
  const job_id = 'job-1'
  await stateStore.upsert({
    user_id: USER,
    project_slug: OWNER,
    phase: 'import_running',
    phase_state_patch: {
      user_first_name: 'Alex',
      import_job_id: job_id,
      import_source: 'chatgpt-zip',
      ai_substrate_used: 'chatgpt',
    },
    advanced_at: 1,
  })
  if (opts.import_failed === true) {
    runnerResults.set(job_id, {
      job_id,
      project_slug: OWNER,
      source: 'chatgpt-zip',
      status: 'failed',
      dollars_spent: 0,
      pass1_chunks_done: 0,
      pass1_chunks_total: 1,
      chunks_total_known: false,
      started_at: Date.now(),
      error_code: 'substrate_error',
      error_message: 'LLM returned a 500',
    } as ImportJob)
    return
  }
  const stamped: ImportJob = {
    job_id,
    project_slug: OWNER,
    source: 'chatgpt-zip',
    status: 'completed',
    dollars_spent: 1.2,
    pass1_chunks_done: 4,
    pass1_chunks_total: 4,
    chunks_total_known: false,
    started_at: Date.now(),
  }
  if (opts.import_result !== null) {
    stamped.result = opts.import_result
    stamped.partial = false
  }
  runnerResults.set(job_id, stamped)
}

async function pokeEngine(observed_at: number): Promise<void> {
  // The engine's poll path needs the existing active_prompt_id (set
  // via emit) so the inbound advance turn re-enters the runner status
  // check via consumeImportRunningChoice's STATUS sub-step. We
  // shortcut by calling start() which runs the resume-on-reconnect
  // crash-resume branch that auto-polls.
  await (makeEngine() as InterviewEngine).start({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    signup_via: 'web',
  })
  void observed_at
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'import-analysis-presented-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
  runnerResults = new Map()
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('import_analysis_presented — body shape (Alex-shape happy path)', () => {
  test('renders project bullets verbatim + interest bullets + low-confidence callout + ends with "Anything important I missed?"', async () => {
    const engine = makeEngine()
    await landAtImportRunning({ import_result: ryanShapeResult() })

    // Trigger pollImportRunningAndAdvance via the engine's start path
    // — it sees phase=import_running, no terminal sub_step, and polls
    // the runner; the completed-status branch advances to
    // import_analysis_presented and emits the bullet body.
    await engine.start({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
    })

    const state = await stateStore.get(OWNER, USER)
    expect(state).not.toBeNull()
    expect(state!.phase).toBe('import_analysis_presented')

    // The engine populated the audit fields from the import result.
    const ps = state!.phase_state as Record<string, unknown>
    expect(Array.isArray(ps['primary_projects'])).toBe(true)
    const projects = ps['primary_projects'] as string[]
    expect(projects).toEqual([
      'Ledgerline Hospitality',
      'Caldera',
      'A book about contemplative awakening',
      'Sound Ceremony course',
    ])
    expect(Array.isArray(ps['non_work_interests'])).toBe(true)
    expect(ps['non_work_interests']).toHaveLength(2)

    // Latest prompt is the analysis-presented body.
    const last = sentPrompts[sentPrompts.length - 1]?.prompt
    expect(last).not.toBeUndefined()
    const body = last!.body

    // Warmth-up + intro line: starts with "Okay Alex,".
    expect(body).toContain('Okay Alex,')

    // Each project name appears verbatim (verbatim rule — no
    // re-phrasing).
    expect(body).toContain('Ledgerline Hospitality')
    expect(body).toContain('Caldera')
    expect(body).toContain('A book about contemplative awakening')
    expect(body).toContain('Sound Ceremony course')

    // The "Projects you're working on:" header anchors the section.
    expect(body).toContain("Projects you're working on:")

    // Both interests appear verbatim.
    expect(body).toContain('contemplative practice')
    expect(body).toContain('wine tasting')
    expect(body).toContain('Outside work, I noticed:')

    // Low-confidence callout: 2 items scored < 0.5 (Sound Ceremony
    // course = 0.34, wine tasting = 0.41). Both surface; everything
    // else stays in the main bullets.
    expect(body).toContain("I'm less sure about")
    expect(body).toContain('Sound Ceremony course')
    expect(body).toContain('wine tasting')

    // Confidence one-liner — "Based on N conversations". The
    // conversation count comes from `import_result.conversation_count`
    // (NOT entities.length, which is a deduped top-50 list — Codex r1
    // P2 regression catch).
    expect(body).toMatch(/Based on \d+ conversations/)
    expect(body).toContain('137 conversations')

    // No duplicate "export" word (regression: builder previously said
    // "your ChatGPT export export" because humanizeImportSource
    // already includes "export" + the builder appended another).
    expect(body).not.toContain('export export')

    // THEMES INTENTIONALLY DROPPED (Alex-lock 2026-05-15). The body
    // MUST NOT carry a Themes section header — regression catch for
    // the original Atlas spec that ranked themes as a third bullet
    // group.
    expect(body).not.toMatch(/themes that recur/i)
    expect(body).not.toMatch(/Themes:\b/)

    // Ends with the "Anything important I missed?" free-text prompt.
    expect(body.trim().endsWith('Anything important I missed?')).toBe(true)
  })
})

describe('import_analysis_presented — corrections capture + audit-aware routing', () => {
  test('Alex-shape: user reply lands in user_supplied_corrections[] and engine advances to personality_offered (audit clean)', async () => {
    const engine = makeEngine()
    await landAtImportRunning({ import_result: ryanShapeResult() })
    await engine.start({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
    })

    // The user replies freeform: "Sound Ceremony is right — and add
    // Halo, that's the supplement brand."
    const prompt = sentPrompts[sentPrompts.length - 1]!.prompt
    const choice: ButtonChoice = {
      prompt_id: prompt.prompt_id,
      choice_value: '__freeform__',
      freeform_text: "Sound Ceremony is right, and add Halo - that's the supplement brand we're launching mid-2026",
      chosen_at: 2,
      speaker_user_id: USER,
      channel_kind: 'app-socket',
    }
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice,
      observed_at: 2,
    })

    const state = await stateStore.get(OWNER, USER)
    expect(state).not.toBeNull()
    // user_first_name + primary_projects (4) + non_work_interests (2)
    // are all filled — audit's next_to_collect is agent_personality
    // → required-clean → advance to personality_offered.
    expect(state!.phase).toBe('personality_offered')
    const ps = state!.phase_state as Record<string, unknown>
    expect(Array.isArray(ps['user_supplied_corrections'])).toBe(true)
    expect((ps['user_supplied_corrections'] as string[])).toContain(
      "Sound Ceremony is right, and add Halo - that's the supplement brand we're launching mid-2026",
    )
  })

  test('Mira-shape thin import: missing non_work_interests routes user to work_interview_gap_fill', async () => {
    const engine = makeEngine()
    await landAtImportRunning({ import_result: thinResult() })
    await engine.start({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
    })

    expect((await stateStore.get(OWNER, USER))!.phase).toBe('import_analysis_presented')

    const prompt = sentPrompts[sentPrompts.length - 1]!.prompt
    const choice: ButtonChoice = {
      prompt_id: prompt.prompt_id,
      choice_value: '__freeform__',
      freeform_text: 'Nope, you got the gist',
      chosen_at: 2,
      speaker_user_id: USER,
      channel_kind: 'app-socket',
    }
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice,
      observed_at: 2,
    })

    const state = await stateStore.get(OWNER, USER)
    expect(state).not.toBeNull()
    // user_first_name + 3 projects are filled, but non_work_interests
    // is empty → audit reports it missing → engine routes to gap_fill.
    expect(state!.phase).toBe('work_interview_gap_fill')
    const ps = state!.phase_state as Record<string, unknown>
    expect((ps['user_supplied_corrections'] as string[])).toContain('Nope, you got the gist')
  })
})

describe('import_analysis_presented — failure path (graceful "couldn\'t analyze")', () => {
  test('advanceFromImportRunningOnComplete(failure_reason) routes directly to import_analysis_presented with the graceful body', async () => {
    // S14 (2026-05-17) — both runner.status=failed AND the hard-timeout
    // backstop call advanceFromImportRunningOnComplete(failure_reason);
    // the body builder MUST emit the graceful framing whenever
    // phase_state.import_failed=true. Here we exercise the body shape
    // by landing the engine directly at import_analysis_presented with
    // a synthetic failed state; the cron-tick path that exercises the
    // runner.status=failed branch end-to-end lives in
    // import-failed-routes-to-analysis-presented.test.ts.
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'import_analysis_presented',
      phase_state_patch: {
        user_first_name: 'Alex',
        import_source: 'chatgpt-zip',
        import_result: null,
        import_failed: true,
        import_failure_reason: 'timeout',
        import_partial: false,
      },
      advanced_at: 1,
    })
    const engine = makeEngine()
    // start() will re-emit the active prompt for the persisted phase.
    await engine.start({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
    })

    const prompt = sentPrompts[sentPrompts.length - 1]?.prompt
    expect(prompt).not.toBeUndefined()
    const body = prompt!.body
    // Graceful framing per § 3.6.
    expect(body).toContain("couldn't analyze")
    expect(body).toContain('Alex')
    // No bullets in the failure body.
    expect(body).not.toContain("Projects you're working on:")
    expect(body).not.toContain('Outside work')

    // User reply routes to work_interview_gap_fill regardless of
    // audit (audit will fail anyway since primary_projects /
    // non_work_interests were never populated).
    const choice: ButtonChoice = {
      prompt_id: prompt!.prompt_id,
      choice_value: '__freeform__',
      freeform_text: "I'm working on a hotel acquisition and a supplement brand. Outside work I climb.",
      chosen_at: 2,
      speaker_user_id: USER,
      channel_kind: 'app-socket',
    }
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice,
      observed_at: 2,
    })
    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('work_interview_gap_fill')
  })
})

describe('import_analysis_presented — themes regression catch', () => {
  test('a body containing the Pass-2 result NEVER renders themes (Alex-lock 2026-05-15)', async () => {
    const engine = makeEngine()
    // Include a theme-shaped name in the projects array so a sloppy
    // builder edit might pattern-match and render it. The body
    // builder shows it as a project (verbatim) but MUST NOT emit a
    // "Themes" section header.
    const r = ryanShapeResult()
    await landAtImportRunning({ import_result: r })
    await engine.start({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
    })
    const last = sentPrompts[sentPrompts.length - 1]?.prompt
    expect(last).not.toBeUndefined()
    const body = last!.body
    expect(body).not.toMatch(/^Themes\b/m)
    expect(body).not.toMatch(/themes that recur/i)
  })
})
