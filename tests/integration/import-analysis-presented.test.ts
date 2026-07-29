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
 *
 * 2026-07-06 K11-pre re-anchor (K11a6): the body-shape + themes-regression
 * blocks previously reached `import_analysis_presented` by calling
 * the engine `start` drive (its start-path invokes the poll-and-advance). K11b
 * deletes `engine.start`/`engine.advance`, so those blocks are re-anchored
 * onto the SURVIVING import surface: seed `import_running` directly on the
 * state store (exactly what a prior turn / the upload handler leaves) and
 * drive the transition via `engine.pollImportRunningTick(...)` — the same
 * public method the import-running cron calls in production. The resulting
 * `import_running → import_analysis_presented` advance + emitted body is
 * byte-identical to the old start-path (both funnel through
 * `pollImportRunningAndAdvance`), so every body assertion is preserved.
 *
 * The corrections-capture + audit-routing + failure-reply blocks, which
 * drove the CONVERSATIONAL freeform path
 * (the engine `advance` drive → llmRouter.route →
 * dispatchRouterDecision → consumeImportAnalysisPresentedChoice`), pinned
 * the conversational drive that K11b deletes and that is already dead on
 * every live path (the live import-completion watcher consumes
 * `import_analysis_presented` with a plain `stateStore.upsert`; the freeform
 * reply routes to the live CC session, not the engine). They were relocated
 * verbatim to `import-analysis-presented-freeform-routing.test.ts`
 * (K11 execution plan §6 category C — dies with K11b1) so they keep pinning
 * that behavior against CURRENT code until the drive is removed.
 *
 * No dynamic-prompt substrate is wired — the dead `promptDriver`
 * extraction seam was removed in the 2026-06-21 onboarding-engine
 * consolidation, so the deterministic builder (which lives in
 * phase-prompts.ts) is now the SOLE body source. This is intentional:
 * the test pins the deterministic builder per the brief's "test against
 * the actual phase-prompts builder, not a mocked output" rule.
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

/**
 * Seed an `import_running` row exactly as a prior turn / the upload handler
 * leaves it, then complete the fake runner's job. The topic_id + signup_via
 * that `engine.start` used to stamp onto phase_state are seeded here so
 * `pollImportRunningTick` has the channel context it needs to advance
 * (mirrors the seeds in import-failed-routes-to-analysis-presented.test.ts).
 */
async function landAtImportRunning(opts: { import_result: ImportResult | null; import_failed?: boolean }): Promise<void> {
  const job_id = 'job-1'
  await stateStore.upsert({
    user_id: USER,
    owner_slug: OWNER,
    phase: 'import_running',
    phase_state_patch: {
      topic_id: TOPIC,
      signup_via: 'web',
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
      owner_slug: OWNER,
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
    owner_slug: OWNER,
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

/**
 * Drive the SURVIVING poll-and-advance: `pollImportRunningTick` is the public
 * method the import-running cron calls each tick. It reads the seeded
 * `import_running` row, polls the runner, and (on a `completed` job) advances
 * to `import_analysis_presented`, emitting the analysis body — the same path
 * `engine.start` used to funnel through.
 */
async function pollToAnalysisPresented(engine: InterviewEngine): Promise<void> {
  await engine.pollImportRunningTick({ owner_slug: OWNER, user_id: USER, observed_at: 2 })
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

    // Cron poll tick sees phase=import_running, polls the runner, and the
    // completed-status branch advances to import_analysis_presented and emits
    // the bullet body.
    await pollToAnalysisPresented(engine)

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

describe('import_analysis_presented — themes regression catch', () => {
  test('a body containing the Pass-2 result NEVER renders themes (Alex-lock 2026-05-15)', async () => {
    const engine = makeEngine()
    // Include a theme-shaped name in the projects array so a sloppy
    // builder edit might pattern-match and render it. The body
    // builder shows it as a project (verbatim) but MUST NOT emit a
    // "Themes" section header.
    const r = ryanShapeResult()
    await landAtImportRunning({ import_result: r })
    await pollToAnalysisPresented(engine)
    const last = sentPrompts[sentPrompts.length - 1]?.prompt
    expect(last).not.toBeUndefined()
    const body = last!.body
    expect(body).not.toMatch(/^Themes\b/m)
    expect(body).not.toMatch(/themes that recur/i)
  })
})
