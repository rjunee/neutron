/**
 * Integration test — S12 (2026-05-16) — import-running cron-tick.
 *
 * Per docs/plans/P2-onboarding-v2.md § 3.4 + § S5: `import_running` is a
 * transit phase that advances to `import_analysis_presented` when the
 * `ImportJobRunner` reaches `completed`. The original wiring polled
 * once inside `notifyImportUpload`, leaving the engine stranded at
 * `import_running` after Pass-1+Pass-2 finished. This test pins the
 * cron-tick fix: a per-instance cron that polls every 15 s and advances
 * the phase the moment the runner's status flips to `completed`.
 *
 * Assertions:
 *   1. The cron handler IS registered against the SHARED CronJobRegistry
 *      / CronHandlerRegistry via `registerImportRunningCron` (wire
 *      regression — caught the original "no periodic poll" bug).
 *   2. While `ImportJobRunner.status` returns `pass1-running`, a cron
 *      fire does NOT advance the phase AND does NOT emit a new prompt
 *      to the channel (silent in-progress poll).
 *   3. When `ImportJobRunner.status` flips to `completed` with an
 *      `ImportResult`, the next cron fire advances the engine to
 *      `import_analysis_presented` AND persists
 *      `phase_state.import_result`.
 *   4. The cron `skip_if_running` semantics + name follow the per-instance
 *      job-naming contract (`onboarding-import-running-<slug>`).
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
  SqliteOnboardingStateStore,
  TranscriptWriter,
  buildImportRunningHandler,
  registerImportRunningCron,
  ONBOARDING_IMPORT_RUNNING_HANDLER_NAME,
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

function makeRunner(): ImportJobRunnerHook {
  return {
    start: async () => ({ job_id: 'unused' }),
    status: async (job_id: string) => runnerResults.get(job_id) ?? null,
    cancel: async () => undefined,
    synthesizeOnDemand: async () => null,
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

function completedResult(): ImportResult {
  return {
    conversation_count: 42,
    entities: [],
    topics: [],
    proposed_projects: [
      { name: 'Ledgerline Hospitality', rationale: 'JV ops', suggested_topics: [] },
      { name: 'Caldera', rationale: 'fragrance brand', suggested_topics: [] },
      { name: 'Childcare', rationale: 'family ops', suggested_topics: [] },
    ],
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {},
    facts: {},
    inferred_interests: [{ name: 'contemplative practice', basis: 'CC training' }],
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-import-running-cron-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new SqliteOnboardingStateStore({ db })
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

describe('import-running cron-tick (S12)', () => {
  // Assertion #1 — Wire regression. `registerImportRunningCron` adds the
  // handler under the canonical name to the SHARED registry instances,
  // and the cron job def names follow the per-instance prefix.
  test('registerImportRunningCron wires handler + job to the SHARED registries', () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    const engine = makeEngine(() => 1_700_000_000_000)
    const handler = buildImportRunningHandler({ engine, db, now: () => 1_700_000_000_000 })
    registerImportRunningCron({
      project_slug: OWNER,
      jobs,
      handlers,
      handler,
    })
    // Job name follows the per-instance prefix.
    expect(jobs.get(`onboarding-import-running-${OWNER}`)).toBeDefined()
    // Handler name is the canonical constant.
    expect(handlers.get(ONBOARDING_IMPORT_RUNNING_HANDLER_NAME)).toBeDefined()
    // The job's handler field points at the canonical handler name —
    // CronScheduler resolves via this mapping at fire time.
    const job = jobs.get(`onboarding-import-running-${OWNER}`)!
    expect(job.handler).toBe(ONBOARDING_IMPORT_RUNNING_HANDLER_NAME)
    expect(job.skip_if_running).toBe(true)
  })

  // Assertion #2 — silent in-progress poll. While the runner is still
  // running, cron fires must NOT advance phase AND must NOT spam the
  // channel with re-emitted status bodies.
  test('cron fire is a silent no-op while runner.status is pass1-running', async () => {
    const T0 = 1_700_000_000_000
    // Seed state at import_running with the runner reporting in-progress.
    const job_id = 'job-in-flight'
    await stateStore.upsert({
      user_id: 'test-user',
      project_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        import_job_id: job_id,
        import_source: 'chatgpt-zip',
      },
      advanced_at: T0,
    })
    runnerResults.set(job_id, {
      job_id,
      project_slug: OWNER,
      source: 'chatgpt-zip',
      status: 'pass1-running',
      dollars_spent: 0.4,
      pass1_chunks_done: 2,
      pass1_chunks_total: 8,
      chunks_total_known: false,
      started_at: T0 - 30_000,
    })

    const engine = makeEngine(() => T0 + 15_000)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 + 15_000 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ project_slug: OWNER, jobs, handlers, handler })

    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      owner_slug: OWNER,
      now: () => T0 + 15_000,
    })

    const r = await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
    // Skipped — no terminal status hit.
    expect(r.status).toBe('skipped')
    expect(r.detail ?? '').toContain('in_progress=1')
    // Critical: zero channel sends during a silent poll.
    expect(sentPrompts.length).toBe(0)
    // Phase unchanged.
    const after = await stateStore.get(OWNER, 'test-user')
    expect(after?.phase).toBe('import_running')
  })

  // Assertion #3 — completed status drives the advance. This is THE
  // bug fix: after Pass-1+Pass-2 lands `status=completed`, the next
  // cron fire MUST advance the engine to `import_analysis_presented`
  // and persist `import_result` to phase_state. Pre-S12 nothing polled
  // again so the engine stranded forever.
  test('cron fire advances to import_analysis_presented when runner reports completed', async () => {
    const T0 = 1_700_000_000_000
    const job_id = 'job-finishes'
    await stateStore.upsert({
      user_id: 'test-user',
      project_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        import_job_id: job_id,
        import_source: 'chatgpt-zip',
      },
      advanced_at: T0,
    })

    const engine = makeEngine(() => T0 + 30_000)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 + 30_000 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ project_slug: OWNER, jobs, handlers, handler })

    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      owner_slug: OWNER,
      now: () => T0 + 30_000,
    })

    // Tick #1 — runner still running. Silent skip.
    runnerResults.set(job_id, {
      job_id,
      project_slug: OWNER,
      source: 'chatgpt-zip',
      status: 'pass1-running',
      dollars_spent: 0.1,
      pass1_chunks_done: 1,
      pass1_chunks_total: 4,
      chunks_total_known: false,
      started_at: T0 - 5_000,
    })
    const r1 = await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
    expect(r1.status).toBe('skipped')
    expect(sentPrompts.length).toBe(0)
    const between = await stateStore.get(OWNER, 'test-user')
    expect(between?.phase).toBe('import_running')

    // Tick #2 — runner finishes between ticks. Now the cron must
    // detect `completed` and route through pollImportRunningAndAdvance
    // which calls advanceFromImportRunningOnComplete → phase moves to
    // `import_analysis_presented` + `import_result` lands on
    // phase_state.
    runnerResults.set(job_id, {
      job_id,
      project_slug: OWNER,
      source: 'chatgpt-zip',
      status: 'completed',
      dollars_spent: 1.2,
      pass1_chunks_done: 4,
      pass1_chunks_total: 4,
      chunks_total_known: false,
      started_at: T0 - 5_000,
      completed_at: T0 + 20_000,
      result: completedResult(),
    })
    const r2 = await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
    expect(r2.status).toBe('ok')
    expect(r2.detail ?? '').toContain('advanced=1')

    const after = await stateStore.get(OWNER, 'test-user')
    expect(after).not.toBeNull()
    expect(after!.phase).toBe('import_analysis_presented')
    // The advance tail persists the result for the analysis-presented
    // body builder + downstream wow-moment dispatcher to consume.
    expect(after!.phase_state['import_result']).toBeDefined()
    expect(after!.phase_state['import_partial']).toBe(false)
    // primary_projects + non_work_interests get seeded verbatim from
    // the import result.
    expect(after!.phase_state['primary_projects']).toEqual([
      'Ledgerline Hospitality',
      'Caldera',
      'Childcare',
    ])
    const interests = after!.phase_state['non_work_interests'] as Array<{ name: string }>
    expect(Array.isArray(interests)).toBe(true)
    expect(interests[0]?.name).toBe('contemplative practice')
  })

  // Assertion #4 — phase=archetype_picked (or any non-import_running
  // phase) is invisible to the cron's SQL filter even when the row
  // exists. Guards against false-positive polls after a concurrent
  // advance.
  test('cron fire is a no-op when phase has already advanced past import_running', async () => {
    const T0 = 1_700_000_000_000
    await stateStore.upsert({
      user_id: 'test-user',
      project_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        import_job_id: 'job-x',
        import_source: 'chatgpt-zip',
      },
      advanced_at: T0,
    })
    // Now advance past import_running (simulates the user inbound
    // race winning over the cron tick).
    await stateStore.upsert({
      user_id: 'test-user',
      project_slug: OWNER,
      phase: 'import_analysis_presented',
      phase_state_patch: {},
      advanced_at: T0 + 5_000,
    })

    const engine = makeEngine(() => T0 + 10_000)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 + 10_000 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ project_slug: OWNER, jobs, handlers, handler })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      owner_slug: OWNER,
      now: () => T0 + 10_000,
    })

    const r = await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
    expect(r.status).toBe('skipped')
    expect(r.detail ?? '').toContain('no_in_flight_imports')
    expect(sentPrompts.length).toBe(0)
  })
})
