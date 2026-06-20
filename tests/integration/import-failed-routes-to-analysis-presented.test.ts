/**
 * Integration test — S14 (2026-05-17) — failed-import routes to
 * `import_analysis_presented` with graceful framing.
 *
 * Per docs/plans/P2-onboarding-v2.md § 3.6:
 *   ImportJob.status === 'failed' → advance to import_analysis_presented
 *   with import_failed=true + a graceful "Couldn't analyze the export,
 *   but no big deal — let's just talk it through" framing. Falls
 *   through into work_interview_gap_fill on the user's first reply.
 *
 * Pre-S14 the engine emitted retry/skip buttons on `import_running` for
 * a failed runner status — stranding the live walkthrough whenever
 * Opus rate-limited Pass-2 (Bug C from S13's brief).
 *
 * This test pins:
 *   1. When the cron tick observes `runner.status === 'failed'`, the
 *      engine advances `import_running → import_analysis_presented`.
 *   2. The emitted body uses the graceful failure framing (no retry
 *      buttons, no fabricated bullets) and is free-text only.
 *   3. The user's first reply on that body routes to
 *      `work_interview_gap_fill` (audit reports primary_projects +
 *      non_work_interests missing — there's no import_result to seed).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ButtonPrompt, ButtonChoice } from '@neutronai/channels/button-primitive.ts'
import {
  InterviewEngine,
  SqliteOnboardingStateStore,
  TranscriptWriter,
  buildImportRunningHandler,
  registerImportRunningCron,
} from '@neutronai/onboarding/index.ts'
import type { ImportJobRunnerHook } from '@neutronai/onboarding/interview/engine.ts'
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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-import-failed-routing-'))
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

describe('failed-import → import_analysis_presented (S14)', () => {
  test('cron fire on runner.status=failed advances phase, emits graceful free-text body, user reply routes to work_interview_gap_fill', async () => {
    const T0 = 1_700_000_000_000
    const job_id = 'job-failed-rate-limited'

    // Seed state at import_running — first name present so the body
    // builder's name-prefix branch fires, mirroring the live walkthrough
    // shape (signup captures user_first_name before import).
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

    // Runner reports `failed` with an error_message that mirrors the
    // real-world Pass-2 rate-limit case (S13 retry-on-429 exhausted all
    // 4 attempts → job marked failed).
    runnerResults.set(job_id, {
      job_id,
      project_slug: OWNER,
      source: 'chatgpt-zip',
      status: 'failed',
      dollars_spent: 0.8,
      pass1_chunks_done: 4,
      pass1_chunks_total: 4,
      started_at: T0 - 90_000,
      error_code: 'substrate_error',
      error_message: 'Anthropic 429 — 4 retries exhausted',
    } as ImportJob)

    const engine = makeEngine(() => T0 + 30_000)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 + 30_000 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ project_slug: OWNER, jobs, handlers, handler })

    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: OWNER,
      now: () => T0 + 30_000,
    })

    // S14 — cron tick MUST advance the engine when runner reports
    // `failed`. Pre-S14 this stranded at import_running with retry
    // buttons.
    const r = await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
    expect(r.status).toBe('ok')
    expect(r.detail ?? '').toContain('advanced=1')

    const advanced = await stateStore.get(OWNER, USER)
    expect(advanced).not.toBeNull()
    expect(advanced!.phase).toBe('import_analysis_presented')

    // Phase-state stamps the failure so the analysis-presented body
    // builder takes the graceful-failure branch + downstream code can
    // distinguish "no import_result because import failed" from "no
    // import_result because user skipped".
    expect(advanced!.phase_state['import_failed']).toBe(true)
    expect(advanced!.phase_state['import_result']).toBeNull()
    expect(advanced!.phase_state['import_failure_reason']).toBe(
      'Anthropic 429 — 4 retries exhausted',
    )

    // The emitted prompt is the graceful failure body — verbatim
    // framing per § 3.6: "couldn't analyze … let's just talk it
    // through" + the warmth-up name prefix.
    const prompt = sentPrompts[sentPrompts.length - 1]?.prompt
    expect(prompt).not.toBeUndefined()
    const body = prompt!.body
    expect(body).toContain("couldn't analyze")
    expect(body).toContain('owner')
    expect(body).toContain("we'll just talk it through")

    // Honesty calibration (§ 2.3) — the failure body MUST NOT fabricate
    // import bullets or pretend the analysis succeeded.
    expect(body).not.toContain("Projects you're working on:")
    expect(body).not.toContain('Outside work, I noticed:')
    expect(body).not.toMatch(/Based on \d+ conversations/)

    // No buttons — free-text only. The retry/skip button UX was retired
    // with S14; the user replies with whatever they're working on and
    // the gap-fill phase takes over.
    expect(prompt!.options).toEqual([])
    expect(prompt!.allow_freeform).toBe(true)

    // User replies freeform. The audit will find primary_projects +
    // non_work_interests missing (no import seeded them) so the engine
    // routes to work_interview_gap_fill per § 2.4.
    const choice: ButtonChoice = {
      prompt_id: prompt!.prompt_id,
      choice_value: '__freeform__',
      freeform_text: "I'm working on a startup",
      chosen_at: T0 + 60_000,
      speaker_user_id: USER,
      channel_kind: 'app-socket',
    }
    await engine.advance({
      project_slug: OWNER,
      topic_id: TOPIC,
      user_id: USER,
      channel_kind: 'app-socket',
      choice,
      observed_at: T0 + 60_000,
    })

    const after = await stateStore.get(OWNER, USER)
    expect(after).not.toBeNull()
    expect(after!.phase).toBe('work_interview_gap_fill')

    // The reply lands in user_supplied_corrections so the gap-fill LLM
    // driver has the user's verbatim words on its first turn.
    const corrections = after!.phase_state['user_supplied_corrections'] as string[]
    expect(Array.isArray(corrections)).toBe(true)
    expect(corrections).toContain("I'm working on a startup")
  })

  test('cron fire on runner.status=cancelled advances phase to import_analysis_presented (no illegal_transition throw)', async () => {
    // 2026-05-27 — pre-fix the `cancelled` branch in
    // pollImportRunningAndAdvance routed through
    // advanceFromAiSubstrateOffered, whose target
    // `work_interview_gap_fill` is NOT a legal transition from
    // `import_running`. Every 5 s the cron tick threw
    // `illegal_transition` and the user was stranded with the chat
    // disconnected. Post-fix `cancelled` mirrors the `failed` branch
    // and lands the user on `import_analysis_presented` with the
    // graceful failure framing.
    const T0 = 1_700_000_000_000
    const job_id = 'job-cancelled-by-runner'

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

    runnerResults.set(job_id, {
      job_id,
      project_slug: OWNER,
      source: 'chatgpt-zip',
      status: 'cancelled',
      dollars_spent: 0.12,
      pass1_chunks_done: 2,
      pass1_chunks_total: 7,
      started_at: T0 - 60_000,
      error_code: 'cancelled',
      error_message: 'cancelled by operator',
    } as ImportJob)

    const engine = makeEngine(() => T0 + 30_000)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 + 30_000 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ project_slug: OWNER, jobs, handlers, handler })

    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: OWNER,
      now: () => T0 + 30_000,
    })

    const r = await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
    expect(r.status).toBe('ok')
    expect(r.detail ?? '').toContain('advanced=1')

    const advanced = await stateStore.get(OWNER, USER)
    expect(advanced).not.toBeNull()
    expect(advanced!.phase).toBe('import_analysis_presented')
    expect(advanced!.phase_state['import_failed']).toBe(true)
    expect(advanced!.phase_state['import_result']).toBeNull()
    expect(advanced!.phase_state['import_failure_reason']).toBe(
      'cancelled by operator',
    )
  })

  test('runner.status=cancelled with no error_message falls back to error_code', async () => {
    const T0 = 1_700_000_000_000
    const job_id = 'job-bare-cancel'

    await stateStore.upsert({
      user_id: USER,
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
      status: 'cancelled',
      dollars_spent: 0,
      pass1_chunks_done: 0,
      pass1_chunks_total: 1,
      started_at: T0 - 1_000,
      error_code: 'cancelled',
    } as ImportJob)

    const engine = makeEngine(() => T0 + 15_000)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 + 15_000 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ project_slug: OWNER, jobs, handlers, handler })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: OWNER,
      now: () => T0 + 15_000,
    })

    const r = await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
    expect(r.status).toBe('ok')

    const after = await stateStore.get(OWNER, USER)
    expect(after!.phase).toBe('import_analysis_presented')
    expect(after!.phase_state['import_failed']).toBe(true)
    expect(after!.phase_state['import_failure_reason']).toBe('cancelled')
  })

  test('runner.status=cancelled with no error_message and no error_code falls back to "cancelled"', async () => {
    const T0 = 1_700_000_000_000
    const job_id = 'job-bare-cancel-2'

    await stateStore.upsert({
      user_id: USER,
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
      status: 'cancelled',
      dollars_spent: 0,
      pass1_chunks_done: 0,
      pass1_chunks_total: 1,
      started_at: T0 - 1_000,
    } as ImportJob)

    const engine = makeEngine(() => T0 + 15_000)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 + 15_000 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ project_slug: OWNER, jobs, handlers, handler })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: OWNER,
      now: () => T0 + 15_000,
    })

    const r = await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
    expect(r.status).toBe('ok')

    const after = await stateStore.get(OWNER, USER)
    expect(after!.phase).toBe('import_analysis_presented')
    expect(after!.phase_state['import_failed']).toBe(true)
    expect(after!.phase_state['import_failure_reason']).toBe('cancelled')
  })

  test('runner.status=failed advances even when error_message is missing (falls back to error_code, then "unknown")', async () => {
    const T0 = 1_700_000_000_000
    const job_id = 'job-bare-failure'

    await stateStore.upsert({
      user_id: USER,
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
      status: 'failed',
      dollars_spent: 0,
      pass1_chunks_done: 0,
      pass1_chunks_total: 1,
      started_at: T0 - 1_000,
      error_code: 'substrate_error',
    } as ImportJob)

    const engine = makeEngine(() => T0 + 15_000)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 + 15_000 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ project_slug: OWNER, jobs, handlers, handler })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      project_slug: OWNER,
      now: () => T0 + 15_000,
    })

    const r = await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
    expect(r.status).toBe('ok')

    const after = await stateStore.get(OWNER, USER)
    expect(after!.phase).toBe('import_analysis_presented')
    expect(after!.phase_state['import_failed']).toBe(true)
    expect(after!.phase_state['import_failure_reason']).toBe('substrate_error')
  })
})
