/**
 * Integration test — P2 v2 § 12 risk-row (thin Pass-2 graceful degradation).
 *
 * Per docs/plans/P2-onboarding-v2.md § 12:
 *
 *   > "Pass-2 doesn't emit `confidence` / `inferred_interests` for users
 *   > with thin imports → Pass-2 output JSON missing the new fields →
 *   > The parser treats missing fields as empty arrays; analysis-
 *   > presentation gracefully shows no 'less sure' callout + no
 *   > 'Outside work' section. NO breakage.
 *   > **Test: tests/integration/import-thin-graceful.test.ts**."
 *
 * This file closes that spec row.
 *
 * It exercises two layers end-to-end:
 *
 *   PARSER layer (`onboarding/history-import/pass2-synthesis.ts`):
 *     - confidence_by_inference MISSING → result.confidence_by_inference === undefined
 *     - inferred_interests MISSING → result.inferred_interests === undefined
 *     - BOTH MISSING → parse still succeeds (no throw), entities/tasks/etc.
 *       all land from the aggregated Pass-1 fallback
 *
 *   ENGINE layer (`onboarding/interview/engine.ts:advanceFromImportRunningOnComplete`
 *   + `buildImportAnalysisPresentedPromptSpec` in `phase-prompts.ts`):
 *     - When confidence_by_inference is absent on the ImportResult, the
 *       analysis-presented body MUST NOT carry the "I'm less sure
 *       about …" callout (every bullet is uncalibrated, none drop below
 *       0.5; spec § 2.5 explicit rule — pre-v2 imports without
 *       confidence scores stay in the main bullets).
 *     - When inferred_interests is absent / empty, the body MUST NOT
 *       render the "Outside work, I noticed:" header (§ 2.3 — "omit
 *       section if none").
 *     - The engine still advances through `import_analysis_presented`
 *       and accepts the user's freeform reply. Whether the next phase
 *       is `personality_offered` or `work_interview_gap_fill` depends
 *       on whether `non_work_interests` was populated:
 *         - interests present → audit clean → personality_offered
 *         - interests absent → audit flags missing field → gap_fill
 *       In both cases the engine COMPLETES the turn without throwing —
 *       the user-visible flow degrades gracefully.
 *
 * NOTE — this test only verifies the existing graceful-degradation
 * behavior; the brief explicitly forbids engine changes here. If a
 * regression breaks the graceful path, that fix belongs in a separate
 * sprint and this test acts as the canary.
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
import {
  aggregatePass1,
  parsePass2Result,
} from '@neutronai/onboarding/history-import/pass2-synthesis.ts'
import type { Pass1ChunkResult } from '@neutronai/onboarding/history-import/types.ts'
import type {
  DrivenPhasePromptSpec,
  GeneratePromptInput,
} from '@neutronai/onboarding/interview/llm-prompt-driver.ts'

const OWNER = 'thin-import-test'
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
  // Forces every dynamic-prompt request to land at the deterministic
  // phase-prompts.ts builder (the body source we're pinning here).
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

// A non-trivial aggregated Pass-1 baseline shared across parser tests.
// The Pass-2 parser falls back to the aggregated shape when the LLM
// JSON is incomplete — without populated entities / tasks we couldn't
// tell whether the parser fell over cleanly or just produced an empty
// shell.
function buildAggregated() {
  const baseChunk: Pass1ChunkResult = {
    chunk_hash: 'h1',
    candidate_entities: [
      { name: 'Mira', kind: 'person', mention_count: 4 },
      { name: 'Caldera', kind: 'company', mention_count: 2 },
    ],
    candidate_topics: [
      { name: 'fragrance launch', summary: 'spring 2026 line' },
    ],
    candidate_tasks: [{ title: 'Order packaging samples' }],
    voice_signals: { tone: 'expansive', verbosity: 'medium' },
    dollars_billed: 0.04,
  }
  return aggregatePass1([baseChunk, { ...baseChunk, chunk_hash: 'h2' }])
}

async function landAtImportRunning(opts: { import_result: ImportResult }): Promise<void> {
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
  runnerResults.set(job_id, {
    job_id,
    project_slug: OWNER,
    source: 'chatgpt-zip',
    status: 'completed',
    dollars_spent: 0.8,
    pass1_chunks_done: 2,
    pass1_chunks_total: 2,
    started_at: Date.now(),
    result: opts.import_result,
    partial: false,
  } as ImportJob)
}

// A "thin" ImportResult shape — minimum required fields populated, the
// v2 optional fields deliberately absent. ≥3 projects + first name so
// the only audit gap is `non_work_interests`. We reuse this for the
// "no interests" engine scenarios and override per-test for the "no
// confidence but interests present" branch.
function thinResult(overrides: Partial<ImportResult> = {}): ImportResult {
  const base: ImportResult = {
    conversation_count: 12,
    entities: [
      { name: 'Mira', kind: 'person', mention_count: 4 },
      { name: 'Caldera', kind: 'company', mention_count: 2 },
    ],
    topics: [{ name: 'fragrance launch', recurrence_score: 1, recency_score: 0 }],
    proposed_projects: [
      { name: 'Caldera', rationale: 'Q3 launch', suggested_topics: [] },
      { name: 'Ledgerline', rationale: 'JV operations', suggested_topics: [] },
      { name: 'Childcare logistics', rationale: 'family ops', suggested_topics: [] },
    ],
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {},
    facts: {},
  }
  return { ...base, ...overrides }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'import-thin-graceful-'))
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

describe('parsePass2Result — graceful degradation when v2 optional fields are absent', () => {
  test('confidence_by_inference missing → result.confidence_by_inference is undefined; other fields parse normally', () => {
    const aggregated = buildAggregated()
    const raw = JSON.stringify({
      proposed_projects: [{ name: 'Caldera', rationale: 'fragrance brand' }],
      proposed_tasks: [{ title: 'Ship Q3 packaging' }],
      proposed_reminders: [],
      facts: { user_role: 'founder/CEO' },
      // intentionally no confidence_by_inference — inferred_interests still
      // present so we can isolate the "confidence absent" branch.
      inferred_interests: [{ name: 'climbing', basis: 'weekly mentions' }],
    })
    const result = parsePass2Result(raw, aggregated)

    expect(result.confidence_by_inference).toBeUndefined()
    // Sibling v2 field still parses.
    expect(result.inferred_interests).toBeDefined()
    expect(result.inferred_interests!.length).toBe(1)
    // Non-v2 surface unaffected.
    expect(result.proposed_projects.length).toBe(1)
    expect(result.proposed_tasks.length).toBe(1)
    expect(result.facts.user_role).toBe('founder/CEO')
  })

  test('inferred_interests missing → result.inferred_interests is undefined; other fields parse normally', () => {
    const aggregated = buildAggregated()
    const raw = JSON.stringify({
      proposed_projects: [{ name: 'Ledgerline', rationale: 'JV ops' }],
      proposed_tasks: [],
      proposed_reminders: [],
      // intentionally no inferred_interests
      confidence_by_inference: [{ field: 'project:Ledgerline', score: 0.86 }],
    })
    const result = parsePass2Result(raw, aggregated)

    expect(result.inferred_interests).toBeUndefined()
    // Sibling v2 field still parses.
    expect(result.confidence_by_inference).toBeDefined()
    expect(result.confidence_by_inference!.length).toBe(1)
    expect(result.proposed_projects.length).toBe(1)
  })

  test('both fields missing → parse still produces a valid ImportResult (no throw, both v2 fields undefined)', () => {
    const aggregated = buildAggregated()
    const raw = JSON.stringify({
      proposed_projects: [{ name: 'Caldera', rationale: 'fragrance brand' }],
      proposed_tasks: [{ title: 'Order samples' }],
      proposed_reminders: [],
      voice_signals: { tone: 'terse' },
      facts: { user_role: 'founder/CEO', companies: ['Caldera'] },
      // NO confidence_by_inference, NO inferred_interests.
    })

    let result: ImportResult | null = null
    expect(() => {
      result = parsePass2Result(raw, aggregated)
    }).not.toThrow()
    expect(result).not.toBeNull()

    expect(result!.confidence_by_inference).toBeUndefined()
    expect(result!.inferred_interests).toBeUndefined()
    // Required surface still intact — graceful degrade, not silent failure.
    expect(result!.proposed_projects.length).toBe(1)
    expect(result!.proposed_tasks.length).toBe(1)
    expect(result!.voice_signals.tone).toBe('terse')
    expect(result!.facts.companies).toEqual(['Caldera'])
    expect(result!.entities.length).toBeGreaterThan(0)
  })
})

describe('import_analysis_presented body — graceful degradation when v2 fields are absent', () => {
  test('no confidence + interests present → body has interests bullets and NO "I\'m less sure about" callout, engine advances to personality_offered (audit clean)', async () => {
    const engine = makeEngine()
    await landAtImportRunning({
      import_result: thinResult({
        inferred_interests: [
          { name: 'climbing', basis: 'weekly mentions' },
          { name: 'tea ceremony' },
        ],
        // confidence_by_inference deliberately absent.
      }),
    })

    await engine.start({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
    })

    const state = await stateStore.get(OWNER, USER)
    expect(state).not.toBeNull()
    expect(state!.phase).toBe('import_analysis_presented')

    const prompt = sentPrompts[sentPrompts.length - 1]?.prompt
    expect(prompt).not.toBeUndefined()
    const body = prompt!.body

    // Projects + interests still render verbatim.
    expect(body).toContain('Caldera')
    expect(body).toContain('Ledgerline')
    expect(body).toContain('Childcare logistics')
    expect(body).toContain('Outside work, I noticed:')
    expect(body).toContain('climbing')
    expect(body).toContain('tea ceremony')

    // GRACEFUL: no confidence scores → no "less sure" callout.
    expect(body).not.toContain("I'm less sure about")
    expect(body).not.toContain('less sure about')

    // Body still ends with the freeform closer.
    expect(body.trim().endsWith('Anything important I missed?')).toBe(true)

    // Engine advances cleanly on a freeform reply — interests are
    // present so the required-fields audit is clean and we go to
    // personality_offered per § 2.4.
    const choice: ButtonChoice = {
      prompt_id: prompt!.prompt_id,
      choice_value: '__freeform__',
      freeform_text: 'Looks right, nothing to add.',
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

    const after = await stateStore.get(OWNER, USER)
    expect(after).not.toBeNull()
    expect(after!.phase).toBe('personality_offered')
    const ps = after!.phase_state as Record<string, unknown>
    expect(ps['user_supplied_corrections']).toEqual(['Looks right, nothing to add.'])
  })

  test('confidence present + interests missing → body has NO "Outside work" section, engine advances to work_interview_gap_fill (interests audit miss)', async () => {
    const engine = makeEngine()
    await landAtImportRunning({
      import_result: thinResult({
        // inferred_interests deliberately absent.
        confidence_by_inference: [
          { field: 'project:Caldera', score: 0.87, basis: 'Q3 mentions' },
          { field: 'project:Ledgerline', score: 0.74 },
          { field: 'project:Childcare logistics', score: 0.69 },
        ],
      }),
    })

    await engine.start({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
    })

    const state = await stateStore.get(OWNER, USER)
    expect(state).not.toBeNull()
    expect(state!.phase).toBe('import_analysis_presented')

    // Engine did not seed non_work_interests because the import didn't
    // carry any.
    const ps = state!.phase_state as Record<string, unknown>
    expect(ps['non_work_interests']).toBeUndefined()
    // Projects DID seed (sanity check the audit will only flag interests).
    expect(Array.isArray(ps['primary_projects'])).toBe(true)
    expect((ps['primary_projects'] as string[]).length).toBe(3)

    const prompt = sentPrompts[sentPrompts.length - 1]?.prompt
    expect(prompt).not.toBeUndefined()
    const body = prompt!.body

    // GRACEFUL: no interests → no "Outside work" header / section.
    expect(body).not.toContain('Outside work')
    expect(body).not.toContain('Outside work, I noticed:')

    // Projects bullets still render.
    expect(body).toContain("Projects you're working on:")
    expect(body).toContain('Caldera')

    // All project scores ≥ 0.5 here, so the callout is also empty.
    expect(body).not.toContain("I'm less sure about")

    // Body ends with the freeform closer.
    expect(body.trim().endsWith('Anything important I missed?')).toBe(true)

    // Engine accepts the freeform reply and routes into gap_fill so
    // the missing interest field can be collected via S6's self-loop.
    const choice: ButtonChoice = {
      prompt_id: prompt!.prompt_id,
      choice_value: '__freeform__',
      freeform_text: 'Pretty close — I do also run trails on weekends.',
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

    const after = await stateStore.get(OWNER, USER)
    expect(after).not.toBeNull()
    expect(after!.phase).toBe('work_interview_gap_fill')
    const ps_after = after!.phase_state as Record<string, unknown>
    expect((ps_after['user_supplied_corrections'] as string[])).toContain(
      'Pretty close — I do also run trails on weekends.',
    )
  })

  test('both fields missing → body has NO "Outside work" section AND NO "less sure" callout, engine still advances + accepts user reply (no throw)', async () => {
    const engine = makeEngine()
    await landAtImportRunning({ import_result: thinResult() })

    await engine.start({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
    })

    const state = await stateStore.get(OWNER, USER)
    expect(state).not.toBeNull()
    // Engine advanced through import_running → import_analysis_presented
    // without throwing, even though the ImportResult had neither v2
    // field set.
    expect(state!.phase).toBe('import_analysis_presented')

    const prompt = sentPrompts[sentPrompts.length - 1]?.prompt
    expect(prompt).not.toBeUndefined()
    const body = prompt!.body

    // Projects still render (we have 3, the minimum for audit-clean
    // on that field), each name verbatim.
    expect(body).toContain("Projects you're working on:")
    expect(body).toContain('Caldera')
    expect(body).toContain('Ledgerline')
    expect(body).toContain('Childcare logistics')

    // GRACEFUL: both v2-only sections collapse out.
    expect(body).not.toContain('Outside work')
    expect(body).not.toContain("I'm less sure about")
    expect(body).not.toContain('less sure about')

    // Conversation-count anchor still lands ("Based on N conversations").
    // The thin result still carries `conversation_count`; the builder
    // surfaces it from `import_result`, NOT from the absent v2 fields.
    expect(body).toMatch(/Based on \d+ conversations/)

    // The body still ends with the freeform closer.
    expect(body.trim().endsWith('Anything important I missed?')).toBe(true)

    // Engine still accepts the user's reply and routes to gap_fill
    // (since non_work_interests is missing) — no throw, flow completes.
    const choice: ButtonChoice = {
      prompt_id: prompt!.prompt_id,
      choice_value: '__freeform__',
      freeform_text: 'That all checks out.',
      chosen_at: 2,
      speaker_user_id: USER,
      channel_kind: 'app-socket',
    }
    let advanceErr: unknown = null
    try {
      await engine.advance({
        project_slug: OWNER,
        topic_id: TOPIC,
        user_id: USER,
        channel_kind: 'app-socket',
        choice,
        observed_at: 2,
      })
    } catch (err) {
      advanceErr = err
    }
    expect(advanceErr).toBeNull()

    const after = await stateStore.get(OWNER, USER)
    expect(after).not.toBeNull()
    // Required-fields audit identifies non_work_interests as missing →
    // route to work_interview_gap_fill (engine spec § 2.4).
    expect(after!.phase).toBe('work_interview_gap_fill')
    const ps_after = after!.phase_state as Record<string, unknown>
    expect((ps_after['user_supplied_corrections'] as string[])).toContain(
      'That all checks out.',
    )
  })
})
