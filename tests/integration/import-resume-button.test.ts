/**
 * 2026-05-25 — resume_import button surface integration test.
 *
 * Sprint Part G.4 — covers the engine's resume-button affordance:
 *
 *   1. When the failed-import advance fires AND the readiness probe
 *      returns true, the `import_analysis_presented` body MUST
 *      include the `resume_import` option.
 *   2. When the probe returns false (e.g. ZIP missing) the option
 *      is NOT included.
 *   3. Tapping the option dispatches the runner via
 *      `attemptAutoResumeFromPaused` and flips the phase back to
 *      import_running with the new job_id stitched in.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import {
  InterviewEngine,
  SqliteOnboardingStateStore,
  TranscriptWriter,
  buildImportRunningHandler,
  registerImportRunningCron,
} from '@neutronai/onboarding/index.ts'
import { IMPORT_RESUME_CHOICE_VALUE } from '@neutronai/onboarding/interview/phase-prompts.ts'
import type {
  ImportJobRunnerHook,
  ImportPayloadResolver,
  ImportResumeReadinessProbe,
} from '@neutronai/onboarding/interview/engine.ts'
import type { ImportJob } from '@neutronai/onboarding/history-import/types.ts'
import type {
  ButtonChoice,
  ButtonPrompt,
} from '@neutronai/channels/button-primitive.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import { CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import { CronScheduler } from '@neutronai/cron/scheduler.ts'

const OWNER = 'alice'
const TOPIC = 'web:u-alice'
const USER = 'u-alice'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: SqliteOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ prompt: ButtonPrompt }>
let runnerResults: Map<string, ImportJob>
let runnerStartCalls: number
let nextRunnerJobId: string
let probeIsResumable: boolean

function makeRunner(): ImportJobRunnerHook {
  return {
    start: async () => {
      runnerStartCalls += 1
      // Seed the new runner result so the post-resume cron sees it.
      runnerResults.set(nextRunnerJobId, {
        job_id: nextRunnerJobId,
        project_slug: OWNER,
        source: 'chatgpt-zip',
        status: 'pass1-running',
        dollars_spent: 0,
        pass1_chunks_done: 0,
        pass1_chunks_total: 50,
        chunks_total_known: true,
        started_at: 1_700_000_000_000,
      } as ImportJob)
      return { job_id: nextRunnerJobId }
    },
    status: async (job_id: string) => runnerResults.get(job_id) ?? null,
    cancel: async () => undefined,
    synthesizeOnDemand: async () => null,
  }
}

function makePayloadResolver(): ImportPayloadResolver {
  return {
    resolve: async () => Buffer.from('fake-zip'),
  }
}

let probeCalls: Array<{
  project_slug: string
  user_id: string
  source: string
  job_id: string
}> = []
function makeProbe(): ImportResumeReadinessProbe {
  return {
    isResumable: async (input) => {
      probeCalls.push({ ...input })
      return probeIsResumable
    },
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
    importPayloadResolver: makePayloadResolver(),
    importResumeReadiness: makeProbe(),
    now,
  })
}

async function seedFailedAndFireCron(
  engine: InterviewEngine,
  observed_at: number,
  prior_job_id: string,
): Promise<void> {
  runnerResults.set(prior_job_id, {
    job_id: prior_job_id,
    project_slug: OWNER,
    source: 'chatgpt-zip',
    status: 'failed',
    dollars_spent: 0.8,
    pass1_chunks_done: 4,
    pass1_chunks_total: 4,
    chunks_total_known: true,
    started_at: observed_at - 90_000,
    error_code: 'substrate_error',
    error_message: 'Anthropic 429 exhausted',
  } as ImportJob)

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
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-resume-button-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new SqliteOnboardingStateStore({ db })
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
  runnerResults = new Map()
  runnerStartCalls = 0
  nextRunnerJobId = 'job-resumed'
  probeIsResumable = true
  probeCalls = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('resume_import button surface', () => {
  test('failed analysis-presented with probe=true emits resume_import option', async () => {
    const T0 = 1_700_000_000_000
    const PRIOR = 'job-old'
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        user_first_name: 'owner',
        import_job_id: PRIOR,
        import_source: 'chatgpt-zip',
      },
      advanced_at: T0,
    })

    const engine = makeEngine(() => T0 + 30_000)
    await seedFailedAndFireCron(engine, T0 + 30_000, PRIOR)

    const advanced = await stateStore.get(OWNER, USER)
    expect(advanced!.phase).toBe('import_analysis_presented')
    expect(advanced!.phase_state['last_import_job_id']).toBe(PRIOR)

    const prompt = sentPrompts[sentPrompts.length - 1]?.prompt
    expect(prompt).not.toBeUndefined()
    expect(probeCalls).toHaveLength(1)
    expect(probeCalls[0]?.job_id).toBe(PRIOR)
    const resumeOption = prompt!.options.find(
      (o) => o.value === IMPORT_RESUME_CHOICE_VALUE,
    )
    expect(resumeOption).not.toBeUndefined()
    // 2026-06-18 relabel: retry-the-scan affordance (was "Resume analysis").
    expect(resumeOption?.label).toBe('Continue scanning the export')
  })

  test('failed analysis-presented with probe=false does NOT emit resume_import', async () => {
    const T0 = 1_700_000_000_000
    const PRIOR = 'job-old'
    probeIsResumable = false
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        user_first_name: 'owner',
        import_job_id: PRIOR,
        import_source: 'chatgpt-zip',
      },
      advanced_at: T0,
    })

    const engine = makeEngine(() => T0 + 30_000)
    await seedFailedAndFireCron(engine, T0 + 30_000, PRIOR)

    const prompt = sentPrompts[sentPrompts.length - 1]?.prompt
    expect(prompt).not.toBeUndefined()
    const resumeOption = prompt!.options.find(
      (o) => o.value === IMPORT_RESUME_CHOICE_VALUE,
    )
    expect(resumeOption).toBeUndefined()
  })

  test('tapping resume_import dispatches runner and flips phase back to import_running', async () => {
    const T0 = 1_700_000_000_000
    const PRIOR = 'job-old'
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        user_first_name: 'owner',
        import_job_id: PRIOR,
        import_source: 'chatgpt-zip',
      },
      advanced_at: T0,
    })

    const engine = makeEngine(() => T0 + 30_000)
    await seedFailedAndFireCron(engine, T0 + 30_000, PRIOR)

    const prompt = sentPrompts[sentPrompts.length - 1]?.prompt
    expect(prompt).not.toBeUndefined()

    const choice: ButtonChoice = {
      prompt_id: prompt!.prompt_id,
      choice_value: IMPORT_RESUME_CHOICE_VALUE,
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

    expect(runnerStartCalls).toBe(1)
    const after = await stateStore.get(OWNER, USER)
    expect(after).not.toBeNull()
    expect(after!.phase).toBe('import_running')
    expect(after!.phase_state['import_job_id']).toBe(nextRunnerJobId)
  })
})
