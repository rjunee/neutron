/**
 * Integration test — 2026-05-25 (import-pipeline-resilience sprint,
 * Parts A+B+C); updated 2026-06-18 (import-timeout-progress-aware sprint).
 *
 * Pins the hard-timeout backstop on `import_running`:
 *
 *   - `computeImportHardTimeoutMs` budget is `chunks_total * 5_000ms * 2`
 *     with a 30-min floor + 4-hour ceiling (the floor is the MINIMUM, so a
 *     small chunk_total whose raw budget is under 30 min is clamped UP).
 *     A 919-chunk job gets ~150 min; the raw per-chunk budget only exceeds
 *     the floor past ~180 chunks.
 *   - The firing CONDITION is now PROGRESS-AWARE (`evaluateImportTimeout`),
 *     not a flat wall-clock cap: the deadline RESETS on forward progress,
 *     a young job (under the 30-min floor) is never guillotined, and the
 *     timeout fires only after a no-forward-progress window past the floor
 *     (read vs consolidate window) or the 4h ceiling.
 *   - When the timeout DOES fire AND Pass-1 progress >= 25%, the engine
 *     calls `runner.synthesizeOnDemand` to produce a partial result
 *     and advances with `import_partial=true`.
 *   - When Pass-1 progress is below 25%, the engine declares
 *     `import_failed=true` (no partial synthesis attempt).
 *   - In both branches the engine calls `runner.cancel(job_id)` so
 *     the orphan runner stops burning money (Bug B regression
 *     coverage — pre-sprint the cancel never fired).
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
  computeImportHardTimeoutMs,
  IMPORT_PARTIAL_THRESHOLD,
  IMPORT_RUNNING_HARD_TIMEOUT_MS,
  IMPORT_RUNNING_HARD_TIMEOUT_CEILING_MS,
  InterviewEngine,
  SqliteOnboardingStateStore,
  TranscriptWriter,
  buildImportRunningHandler,
  registerImportRunningCron,
} from '@neutronai/onboarding/index.ts'
import type { ImportJobRunnerHook } from '@neutronai/onboarding/interview/engine.ts'
import type { ImportJob, ImportResult } from '@neutronai/onboarding/history-import/types.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import { CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import { CronScheduler } from '@neutronai/cron/scheduler.ts'

const OWNER = 'alice'
const TOPIC = 'chat-1'
const USER = 'u-alice'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: SqliteOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ prompt: ButtonPrompt }>
let runnerResults: Map<string, ImportJob>
let cancelled: string[]
let synthesizeOnDemandReturn: ImportResult | null

function makeRunner(): ImportJobRunnerHook {
  return {
    start: async () => ({ job_id: 'unused' }),
    status: async (job_id: string) => runnerResults.get(job_id) ?? null,
    cancel: async (job_id: string) => {
      cancelled.push(job_id)
    },
    synthesizeOnDemand: async () => synthesizeOnDemandReturn,
  }
}

function makeEngine(now: () => number): InterviewEngine {
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push({ prompt: input.prompt })
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    importJobRunner: makeRunner(),
    now,
  })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-hard-timeout-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new SqliteOnboardingStateStore({ db })
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
  runnerResults = new Map()
  cancelled = []
  synthesizeOnDemandReturn = null
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('computeImportHardTimeoutMs (Part A)', () => {
  test('chunks_total=0 → 15-min floor', () => {
    expect(computeImportHardTimeoutMs({ pass1_chunks_total: 0 })).toBe(
      IMPORT_RUNNING_HARD_TIMEOUT_MS,
    )
  })

  test('chunks_total=100 → 16.7-min raw budget clamped UP to the 30-min floor', () => {
    // 100 * 5000 * 2 = 1_000_000 ms (~16.7 min) is BELOW the 30-min floor
    // (IMPORT_RUNNING_HARD_TIMEOUT_MS), so the floor — the minimum total
    // runtime — wins via max(budget, floor). The raw per-chunk budget only
    // exceeds the floor past ~180 chunks (180 * 10_000 = 1.8M = 30 min).
    expect(computeImportHardTimeoutMs({ pass1_chunks_total: 100 })).toBe(
      IMPORT_RUNNING_HARD_TIMEOUT_MS,
    )
  })

  test('chunks_total=919 → 919 * 5000 * 2 = 9_190_000 ms (~153 min) — owner 2026-05-25 case', () => {
    expect(computeImportHardTimeoutMs({ pass1_chunks_total: 919 })).toBe(9_190_000)
  })

  test('chunks_total too large → caps at 4-hour ceiling', () => {
    expect(computeImportHardTimeoutMs({ pass1_chunks_total: 100_000 })).toBe(
      IMPORT_RUNNING_HARD_TIMEOUT_CEILING_MS,
    )
  })

  test('budget never drops below the 15-min floor for small but >0 chunks', () => {
    expect(computeImportHardTimeoutMs({ pass1_chunks_total: 10 })).toBe(
      IMPORT_RUNNING_HARD_TIMEOUT_MS,
    )
  })
})

describe('engine hard-timeout backstop (Parts B+C)', () => {
  test('progress >= 25% → import_partial=true, calls synthesizeOnDemand, calls cancel', async () => {
    const T0 = 1_700_000_000_000
    const job_id = 'job-partial-eligible'

    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        user_first_name: 'owner',
        import_job_id: job_id,
        import_source: 'chatgpt-zip',
        // Progress-aware anchor (import-timeout-progress-aware sprint):
        // a prior poll recorded the job at 50/100 chunks and stamped the
        // anchor at T0. Seeding marks EQUAL to the current job state means
        // this tick observes NO forward progress, so the anchor is NOT
        // reset and the no-forward-progress window can elapse.
        import_progress_anchor_at: T0,
        import_progress_mark: 50,
        import_progress_status_mark: 'pass1-running',
        import_progress_dollars_mark: 1.5,
      },
      advanced_at: T0,
    })

    // Job stalled at 50/100 chunks (Pass-1 READ phase, 50% > 25% threshold)
    // with NO forward progress since the T0 anchor.
    runnerResults.set(job_id, {
      job_id,
      project_slug: OWNER,
      source: 'chatgpt-zip',
      status: 'pass1-running',
      dollars_spent: 1.5,
      pass1_chunks_done: 50,
      pass1_chunks_total: 100,
      chunks_total_known: true,
      started_at: T0,
    } as ImportJob)

    // Partial synthesis returns a real result so the engine takes the
    // partial branch (not the failed branch).
    synthesizeOnDemandReturn = {
      entities: [],
      topics: [],
      proposed_projects: [{ name: 'Recovered Project', rationale: '', suggested_topics: [] }],
      proposed_tasks: [],
      proposed_reminders: [],
      voice_signals: {},
      facts: {},
      inferred_interests: [],
    }

    // Fire the tick 35 min in: past the 30-min floor AND past the read
    // no-progress window (5 min) measured from the T0 anchor, so the
    // progress-aware timeout deterministically fires (reason=no_progress).
    const observed_at = T0 + 35 * 60_000
    const engine = makeEngine(() => observed_at)
    const handler = buildImportRunningHandler({
      engine,
      db,
      now: () => observed_at,
    })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ project_slug: OWNER, jobs, handlers, handler })

    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: OWNER,
      now: () => observed_at,
    })

    const r = await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
    expect(r.status).toBe('ok')

    // Cancel fired BEFORE the advance, per Part B.
    expect(cancelled).toEqual([job_id])

    const advanced = await stateStore.get(OWNER, USER)
    expect(advanced).not.toBeNull()
    expect(advanced!.phase).toBe('import_analysis_presented')
    // Part C: partial=true, NOT failed
    expect(advanced!.phase_state['import_partial']).toBe(true)
    expect(advanced!.phase_state['import_failed']).toBe(false)
    expect(advanced!.phase_state['import_result']).not.toBeNull()
    // Part G.2: the timed-out job_id is preserved as last_import_job_id
    expect(advanced!.phase_state['last_import_job_id']).toBe(job_id)

    // Prompt body uses the partial-prefix framing (builder branch
    // confirmed wired pre-sprint per AS_BUILT S14).
    const prompt = sentPrompts[sentPrompts.length - 1]?.prompt
    expect(prompt).not.toBeUndefined()
    expect(prompt!.body).toContain('only got partway through')
  })

  test('progress < 25% → import_failed=true, skips synthesis, still calls cancel', async () => {
    const T0 = 1_700_000_000_000
    const job_id = 'job-under-threshold'

    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        user_first_name: 'owner',
        import_job_id: job_id,
        import_source: 'chatgpt-zip',
        // Progress-aware anchor: a prior poll recorded the job at 2/100
        // chunks and stamped the anchor at T0. Marks EQUAL the current job
        // state → this tick observes NO forward progress → anchor not reset.
        import_progress_anchor_at: T0,
        import_progress_mark: 2,
        import_progress_status_mark: 'pass1-running',
        import_progress_dollars_mark: 0.05,
      },
      advanced_at: T0,
    })

    // Job stalled at 2/100 chunks (Pass-1 READ phase, 2% < 25% threshold)
    // with NO forward progress since the T0 anchor.
    runnerResults.set(job_id, {
      job_id,
      project_slug: OWNER,
      source: 'chatgpt-zip',
      status: 'pass1-running',
      dollars_spent: 0.05,
      pass1_chunks_done: 2,
      pass1_chunks_total: 100,
      chunks_total_known: true,
      started_at: T0,
    } as ImportJob)

    // If the engine wrongly took the partial branch this stub would
    // fire and the test would crash — leaving null asserts the engine
    // correctly skipped the synthesis call.
    synthesizeOnDemandReturn = null

    // 35 min in: past the 30-min floor AND past the read no-progress window
    // (5 min) from the T0 anchor → progress-aware timeout fires.
    const observed_at = T0 + 35 * 60_000
    const engine = makeEngine(() => observed_at)
    const handler = buildImportRunningHandler({
      engine,
      db,
      now: () => observed_at,
    })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ project_slug: OWNER, jobs, handlers, handler })

    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: OWNER,
      now: () => observed_at,
    })

    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)

    // Part B: cancel STILL fires even when no partial result.
    expect(cancelled).toEqual([job_id])
    const advanced = await stateStore.get(OWNER, USER)
    expect(advanced!.phase).toBe('import_analysis_presented')
    expect(advanced!.phase_state['import_failed']).toBe(true)
    expect(advanced!.phase_state['import_partial']).toBe(false)
    expect(advanced!.phase_state['import_result']).toBeNull()
    expect(advanced!.phase_state['import_failure_reason']).toContain('timed out')
  })

  test('threshold constant === 25%', () => {
    expect(IMPORT_PARTIAL_THRESHOLD).toBe(0.25)
  })

  test('budget honored — at 14 min on a 919-chunk job the engine does NOT advance', async () => {
    const T0 = 1_700_000_000_000
    const job_id = 'job-919'

    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        user_first_name: 'owner',
        import_job_id: job_id,
        import_source: 'chatgpt-zip',
      },
      advanced_at: T0,
    })

    // 919 chunks → ~153-min budget. Job has been running 14 min only.
    runnerResults.set(job_id, {
      job_id,
      project_slug: OWNER,
      source: 'chatgpt-zip',
      status: 'pass1-running',
      dollars_spent: 0.27,
      pass1_chunks_done: 413,
      pass1_chunks_total: 919,
      chunks_total_known: true,
      started_at: T0,
    } as ImportJob)

    const observed_at = T0 + 14 * 60_000
    const engine = makeEngine(() => observed_at)
    const handler = buildImportRunningHandler({
      engine,
      db,
      now: () => observed_at,
    })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ project_slug: OWNER, jobs, handlers, handler })

    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: OWNER,
      now: () => observed_at,
    })

    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)

    // Pre-sprint this would have fired the 15-min hard timeout. With
    // the dynamic budget the engine stays in import_running.
    expect(cancelled).toEqual([])
    const after = await stateStore.get(OWNER, USER)
    expect(after!.phase).toBe('import_running')
  })
})
