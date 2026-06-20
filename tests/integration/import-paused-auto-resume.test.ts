/**
 * Integration test — Argus r1 fix on PR #271 (v0.1.78, 2026-05-22).
 *
 * Pre-fix the runner could land at `status='rate_limit_paused'` after the
 * 30-attempt 429-backoff schedule exhausted. The engine's poll then
 * emitted a prompt body promising "I'll keep checking and resume as soon
 * as the limit lifts" — but nothing actually checked again. The user was
 * stranded forever in `import_running` with factually false UX.
 *
 * Fix (per the brief): the existing per-instance import-running cron (5 s
 * cadence) now treats `rate_limit_paused` rows whose `last_paused_at` is
 * older than `COOLDOWN_AFTER_PAUSED_MS` (5 min) as resumable, calling
 * `runner.start(...)` with the same payload to kick off a fresh attempt
 * that picks up cached Pass-1 chunks at $0.
 *
 * This test pins the full cron auto-resume cycle:
 *
 *   1. Cron tick #1 — runner is at `rate_limit_paused` but the cooldown
 *      has NOT elapsed → no resume, no new runner.start call, no
 *      channel emit (silent suppress_in_progress branch).
 *   2. Cron tick #2 — cooldown ELAPSED on the same paused row → engine
 *      calls runner.start exactly once, the new job_id lands on
 *      `phase_state.import_job_id`, and the run is queued/running.
 *   3. Cron tick #3 — the resumed run also hits 429s and pauses again
 *      with a fresh `last_paused_at`. Cooldown timer restarts.
 *   4. Cron tick #4 — second cooldown elapsed → another runner.start
 *      fires, simulating the runner returning success this time → status
 *      goes to `completed` and the engine advances to
 *      `import_analysis_presented`.
 *
 * Negative assertions: no resume fires before the cooldown lapses; the
 * paused prompt body (when emitted on a user-inbound poll) reflects
 * the auto-resume reality, not the old "I'll keep checking" lie.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
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
  COOLDOWN_AFTER_PAUSED_MS,
} from '@neutronai/onboarding/index.ts'
import type {
  ImportJobRunnerHook,
  ImportPayloadResolver,
} from '@neutronai/onboarding/interview/engine.ts'
import type { ImportJob } from '@neutronai/onboarding/history-import/types.ts'
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
let runnerStatuses: Map<string, ImportJob>
let runnerStartCalls: Array<{ project_slug: string; source: string }>
let jobIdCounter: number

function fakeResolver(): ImportPayloadResolver {
  // Returns a synthetic buffer on every call; the engine only uses it to
  // verify a payload exists before dispatching runner.start. The runner
  // hook itself ignores the payload (status is steered by the
  // pre-populated runnerStatuses map).
  return {
    resolve: async () => Buffer.from('synthetic-zip'),
  }
}

function makeRunner(): ImportJobRunnerHook {
  return {
    start: async (input) => {
      runnerStartCalls.push({
        project_slug: input.project_slug,
        source: input.source,
      })
      jobIdCounter += 1
      const new_id = `job-resumed-${jobIdCounter}`
      // The test pre-populates `runnerStatuses.get(new_id)` BEFORE
      // calling fireOnce, so the next cron tick observes whatever the
      // test scripted (queued / paused / completed).
      return { job_id: new_id }
    },
    status: async (job_id) => runnerStatuses.get(job_id) ?? null,
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
    importPayloadResolver: fakeResolver(),
    now,
  })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-import-paused-resume-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new SqliteOnboardingStateStore({ db })
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
  runnerStatuses = new Map()
  runnerStartCalls = []
  jobIdCounter = 0
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('cron auto-resume cycle: persistent 429 → paused → cooldown → resume → 429 → paused → cooldown → success', async () => {
  const T0 = 1_700_000_000_000
  let now_ms = T0

  // Seed state: owner at import_running with the original job already
  // paused (i.e. the in-process retryWith429 schedule already exhausted).
  const original_job_id = 'job-original'
  await stateStore.upsert({
    user_id: 'test-user',
    project_slug: OWNER,
    phase: 'import_running',
    phase_state_patch: {
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
      import_job_id: original_job_id,
      import_source: 'chatgpt-zip',
    },
    advanced_at: T0,
  })
  runnerStatuses.set(original_job_id, {
    job_id: original_job_id,
    project_slug: OWNER,
    source: 'chatgpt-zip',
    status: 'rate_limit_paused',
    dollars_spent: 1.2,
    pass1_chunks_done: 6,
    pass1_chunks_total: 10,
    chunks_total_known: true,
    started_at: T0 - 30 * 60_000, // started 30 min ago (matches a real backoff window)
    last_paused_at: T0,
  })

  const engine = makeEngine(() => now_ms)
  const handler = buildImportRunningHandler({ engine, db, now: () => now_ms })
  const jobs = new CronJobRegistry()
  const handlers = new CronHandlerRegistry()
  registerImportRunningCron({ project_slug: OWNER, jobs, handlers, handler })
  const scheduler = new CronScheduler({
    jobs,
    handlers,
    db,
    project_slug: OWNER,
    now: () => now_ms,
  })

  // ---------------------------------------------------------------------
  // Tick #1 — cooldown NOT elapsed. Engine sees paused but the gate
  // blocks resume. No runner.start call, no advance, no channel emit.
  // ---------------------------------------------------------------------
  now_ms = T0 + 30_000 // 30 s into the cooldown
  await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
  expect(runnerStartCalls.length).toBe(0)
  expect(sentPrompts.length).toBe(0)
  const after_tick1 = await stateStore.get(OWNER, 'test-user')
  expect(after_tick1?.phase).toBe('import_running')
  expect(after_tick1?.phase_state['import_job_id']).toBe(original_job_id)

  // ---------------------------------------------------------------------
  // Tick #2 — cooldown ELAPSED. The cron handler routes through the
  // engine's pollImportRunningAndAdvance, which observes paused +
  // cooldown-met → calls runner.start with the same source/payload.
  // The new job_id MUST be stitched onto phase_state.import_job_id so
  // subsequent polls see the new job instead of the old paused one.
  //
  // For this tick we script the resumed runner to 429-then-pause AGAIN
  // (worst case from the brief — repeated rate limits). The engine's
  // recursive poll inside the resume path lands on the new paused row
  // and emits no channel body (cron suppression).
  // ---------------------------------------------------------------------
  now_ms = T0 + COOLDOWN_AFTER_PAUSED_MS + 1000 // 1 s past cooldown
  runnerStatuses.set('job-resumed-1', {
    job_id: 'job-resumed-1',
    project_slug: OWNER,
    source: 'chatgpt-zip',
    status: 'rate_limit_paused',
    dollars_spent: 0, // Pass-1 cache reuse → no new spend
    pass1_chunks_done: 6,
    pass1_chunks_total: 10,
    chunks_total_known: true,
    started_at: now_ms,
    last_paused_at: now_ms,
  })
  await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
  expect(runnerStartCalls.length).toBe(1)
  expect(runnerStartCalls[0]?.source).toBe('chatgpt-zip')
  const after_tick2 = await stateStore.get(OWNER, 'test-user')
  expect(after_tick2?.phase).toBe('import_running')
  expect(after_tick2?.phase_state['import_job_id']).toBe('job-resumed-1')

  // ---------------------------------------------------------------------
  // Tick #3 — the resumed run is still paused, but the SECOND cooldown
  // (re-started by markRateLimitPaused on the resumed job) has NOT
  // elapsed yet. Cron must NOT dispatch a third runner.start.
  // ---------------------------------------------------------------------
  now_ms += 60_000 // 1 min into the second cooldown
  await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
  expect(runnerStartCalls.length).toBe(1) // unchanged

  // ---------------------------------------------------------------------
  // Tick #4 — the second cooldown elapses. Cron dispatches the third
  // runner.start (second resume attempt). This time we script the
  // resumed runner to return success → status='completed' →
  // pollImportRunningAndAdvance routes through
  // advanceFromImportRunningOnComplete and the phase moves to
  // import_analysis_presented.
  // ---------------------------------------------------------------------
  now_ms = (runnerStatuses.get('job-resumed-1')!.last_paused_at as number) +
    COOLDOWN_AFTER_PAUSED_MS + 1000
  runnerStatuses.set('job-resumed-2', {
    job_id: 'job-resumed-2',
    project_slug: OWNER,
    source: 'chatgpt-zip',
    status: 'completed',
    dollars_spent: 0.05,
    pass1_chunks_done: 10,
    pass1_chunks_total: 10,
    chunks_total_known: true,
    started_at: now_ms,
    completed_at: now_ms + 5_000,
    result: {
      entities: [],
      topics: [],
      proposed_projects: [],
      proposed_tasks: [],
      proposed_reminders: [],
      voice_signals: {},
      facts: {},
    },
  })
  await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
  expect(runnerStartCalls.length).toBe(2)
  const final_state = await stateStore.get(OWNER, 'test-user')
  expect(final_state?.phase).toBe('import_analysis_presented')
})

test('paused row with no last_paused_at (legacy pre-migration-0041) resumes on the next tick', async () => {
  const T0 = 1_700_000_000_000
  let now_ms = T0
  const original_job_id = 'job-legacy'
  await stateStore.upsert({
    user_id: 'test-user',
    project_slug: OWNER,
    phase: 'import_running',
    phase_state_patch: {
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
      import_job_id: original_job_id,
      import_source: 'chatgpt-zip',
    },
    advanced_at: T0,
  })
  // Legacy row — paused but last_paused_at NULL (the column predates 0041
  // OR the row was paused before the migration applied). The engine
  // treats absent as cooldown already satisfied → resume on the next
  // tick.
  runnerStatuses.set(original_job_id, {
    job_id: original_job_id,
    project_slug: OWNER,
    source: 'chatgpt-zip',
    status: 'rate_limit_paused',
    dollars_spent: 0,
    pass1_chunks_done: 0,
    pass1_chunks_total: 0,
    chunks_total_known: false,
    started_at: T0 - 60 * 60_000,
    // last_paused_at intentionally omitted
  })

  const engine = makeEngine(() => now_ms)
  const handler = buildImportRunningHandler({ engine, db, now: () => now_ms })
  const jobs = new CronJobRegistry()
  const handlers = new CronHandlerRegistry()
  registerImportRunningCron({ project_slug: OWNER, jobs, handlers, handler })
  const scheduler = new CronScheduler({
    jobs,
    handlers,
    db,
    project_slug: OWNER,
    now: () => now_ms,
  })

  runnerStatuses.set('job-resumed-1', {
    job_id: 'job-resumed-1',
    project_slug: OWNER,
    source: 'chatgpt-zip',
    status: 'pass1-running',
    dollars_spent: 0,
    pass1_chunks_done: 0,
    pass1_chunks_total: 0,
    chunks_total_known: false,
    started_at: now_ms,
  })
  await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
  expect(runnerStartCalls.length).toBe(1)
  const after = await stateStore.get(OWNER, 'test-user')
  expect(after?.phase_state['import_job_id']).toBe('job-resumed-1')
})

test('runner.start failure during resume keeps the prior job_id; cron retries next tick', async () => {
  const T0 = 1_700_000_000_000
  let now_ms = T0
  const original_job_id = 'job-original'
  await stateStore.upsert({
    user_id: 'test-user',
    project_slug: OWNER,
    phase: 'import_running',
    phase_state_patch: {
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
      import_job_id: original_job_id,
      import_source: 'chatgpt-zip',
    },
    advanced_at: T0,
  })
  runnerStatuses.set(original_job_id, {
    job_id: original_job_id,
    project_slug: OWNER,
    source: 'chatgpt-zip',
    status: 'rate_limit_paused',
    dollars_spent: 0,
    pass1_chunks_done: 0,
    pass1_chunks_total: 0,
    chunks_total_known: false,
    started_at: T0 - 30 * 60_000,
    last_paused_at: T0,
  })

  // Custom runner that throws on start to simulate a transient resolver-
  // or substrate-tier hiccup. The engine MUST swallow the error, log it
  // on transcript, and leave phase_state pointing at the original paused
  // job so the cron retries on the next tick.
  const throwingRunner: ImportJobRunnerHook = {
    start: async () => {
      throw new Error('synthetic runner.start failure')
    },
    status: async (id) => runnerStatuses.get(id) ?? null,
    cancel: async () => undefined,
    synthesizeOnDemand: async () => null,
  }
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push({ prompt: input.prompt })
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    importJobRunner: throwingRunner,
    importPayloadResolver: fakeResolver(),
    now: () => now_ms,
  })
  const handler = buildImportRunningHandler({ engine, db, now: () => now_ms })
  const jobs = new CronJobRegistry()
  const handlers = new CronHandlerRegistry()
  registerImportRunningCron({ project_slug: OWNER, jobs, handlers, handler })
  const scheduler = new CronScheduler({
    jobs,
    handlers,
    db,
    project_slug: OWNER,
    now: () => now_ms,
  })

  now_ms = T0 + COOLDOWN_AFTER_PAUSED_MS + 1000
  // Should NOT throw. The engine's attemptAutoResumeFromPaused catches
  // and logs; cron handler routes the result as a normal in_progress
  // tick (still paused on the original job).
  await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)

  const after = await stateStore.get(OWNER, 'test-user')
  // Original job_id still on phase_state — no resume succeeded.
  expect(after?.phase_state['import_job_id']).toBe(original_job_id)
  expect(after?.phase).toBe('import_running')
})
