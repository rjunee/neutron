/**
 * ⚠️ DIES WITH K11b1 — conversational-drive pin (K11 execution plan §6, list C).
 *
 * This file pins the CONVERSATIONAL freeform-reply routing out of
 * `import_analysis_presented`:
 *   `engine.advance({ freeform_text }) → llmRouter.route →
 *    dispatchRouterDecision → consumeImportAnalysisPresentedChoice`
 * — the corrections-capture + required-fields-audit routing to
 * `personality_offered` / `work_interview_gap_fill`.
 *
 * That drive is DEAD on every live path (audit 2026-07-05 §2): in production
 * the live import-completion watcher consumes `import_analysis_presented` with
 * a plain `stateStore.upsert` to `work_interview_gap_fill`, and a user's
 * freeform reply routes to the live CC session, NOT the engine. K11b1 deletes
 * `engine.advance` / `dispatchRouterDecision` / `shouldConsultRouter` / the
 * llm-router stack, at which point this file is deleted IN THE SAME PR (the
 * conversational-drive-pin rule — do not re-anchor, do not save).
 *
 * It was split out of `import-analysis-presented.test.ts` by K11-pre (K11a6)
 * so the SURVIVING body-shape + themes assertions could re-anchor onto
 * `pollImportRunningTick` and stay green after K11b, while these drive
 * assertions keep exercising the router path against CURRENT code until the
 * drive is removed. Every assertion below is verbatim from the pre-split file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import {
  InterviewEngine,
  type ImportJobRunnerHook,
  type ImportPayloadResolver,
} from '@neutronai/onboarding/interview/engine.ts'
import type { ImportJob, ImportResult } from '@neutronai/onboarding/history-import/types.ts'
import { InMemoryOnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'
import type { RouterDecision } from '@neutronai/onboarding/interview/llm-router.ts'
import { stubRouter, stubPlatform } from './m2-walkthrough-test-helpers.ts'

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

/** A REVIEW-completing freeform reply decision. `import_analysis_presented`
 *  is a REVIEW/CORRECTION phase, so the router classifies a corrections
 *  reply as `advance` carrying a non-null `state_delta` (the one case where
 *  an advance carries a delta — see llm-router.ts § REVIEW/CORRECTION). The
 *  engine records `freeform_text` into `user_supplied_corrections[]` and
 *  applies the whitelisted delta before auditing + routing. */
function reviewAdvance(
  freeform_text: string,
  state_delta: RouterDecision['state_delta'] = null,
): RouterDecision {
  return {
    action: 'advance',
    confidence: 0.95,
    choice_value: null,
    freeform_text,
    response: null,
    state_delta,
    reasoning: 'test: review-completing corrections reply',
  }
}

function makeEngine(decisions: ReadonlyArray<RouterDecision> = []): InterviewEngine {
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
    // Freeform extraction at this REVIEW phase flows ONLY through the
    // llmRouter (the single extraction seam; the dead promptDriver was
    // removed). stubPlatform('all') flips the conversational flag on so
    // the router is consulted for the freeform reply.
    llmRouter: stubRouter(decisions).router,
    platform: stubPlatform('all'),
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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'import-analysis-presented-drive-'))
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

describe('import_analysis_presented — corrections capture + audit-aware routing', () => {
  test('Alex-shape: user reply lands in user_supplied_corrections[] and engine advances to personality_offered (audit clean)', async () => {
    // The user replies freeform: "Sound Ceremony is right — and add
    // Halo, that's the supplement brand." The router classifies this
    // review-completing reply as an `advance` carrying the verbatim text
    // + a (non-null) state_delta restating + adding the projects.
    const reply =
      "Sound Ceremony is right, and add Halo - that's the supplement brand we're launching mid-2026"
    const engine = makeEngine([
      reviewAdvance(reply, {
        primary_projects: [
          'Ledgerline Hospitality',
          'Caldera',
          'A book about contemplative awakening',
          'Sound Ceremony course',
          'Halo',
        ],
        removed_projects: [],
      }),
    ])
    await landAtImportRunning({ import_result: ryanShapeResult() })
    await engine.start({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
    })

    // Drive the REAL freeform path: a typed reply with NO matching
    // ButtonChoice routes through the llmRouter (the live web client
    // never synthesises a `__freeform__` choice here — that would
    // short-circuit the router).
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: reply,
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
    const reply = 'Nope, you got the gist'
    // A "no corrections" review-completing reply still routes as an
    // advance; the delta restates the seeded projects (no interests, so
    // the audit still flags non_work_interests as missing → gap_fill).
    const engine = makeEngine([
      reviewAdvance(reply, {
        primary_projects: ['Caldera', 'Ledgerline', 'Childcare'],
        removed_projects: [],
      }),
    ])
    await landAtImportRunning({ import_result: thinResult() })
    await engine.start({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
    })

    expect((await stateStore.get(OWNER, USER))!.phase).toBe('import_analysis_presented')

    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: reply,
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
    // User reply routes to work_interview_gap_fill regardless of audit
    // (audit fails anyway since primary_projects / non_work_interests
    // were never populated — the failure path never seeds them, and the
    // router's partial delta here still leaves non_work_interests
    // missing). Wire the router decision BEFORE start() so the freeform
    // reply below resolves through it.
    const reply =
      "I'm working on a hotel acquisition and a supplement brand. Outside work I climb."
    const engine = makeEngine([reviewAdvance(reply, null)])
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

    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      freeform_text: reply,
      observed_at: 2,
    })
    const state = await stateStore.get(OWNER, USER)
    expect(state!.phase).toBe('work_interview_gap_fill')
  })
})
