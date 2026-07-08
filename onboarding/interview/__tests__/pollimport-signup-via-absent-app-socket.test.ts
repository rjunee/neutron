/**
 * ND-A (2026-06-28) — `pollImportRunningTick` must NOT strand `import_running`
 * forever when `phase_state.signup_via` is absent.
 *
 * THE WEDGE this reproduces (docs/research/fullpipe-e2e-2026-06-28.md § Stage 3):
 * on the rearchitected Open Path-1 (freeform app-ws onboarding — no buttons),
 * onboarding never runs `engine.start`, so it never stamps `signup_via` into
 * phase_state. The old `pollImportRunningTick` guard HARD-REQUIRED
 * `signup_via ∈ {telegram,web}`; without it the 5s import-running cron returned
 * `missing_channel_context` on EVERY tick → the instance was stranded at
 * `import_running` forever → projects never registered, memory never
 * materialized. Injecting `signup_via='web'` in the E2E immediately unblocked
 * it, confirming the root cause.
 *
 * THE FIX (engine.ts `pollImportRunningTick`): in single-owner Open the channel
 * is ALWAYS the app-socket, so a missing/garbled `signup_via` must never strand
 * the user. The tick now only requires `topic_id` + `user_id`; `channel_kind`
 * already routes every non-`telegram` value (incl. absent / `web`) to
 * `app-socket`. An explicit `telegram` signup still routes to telegram.
 *
 * These tests seed `import_running` WITHOUT `signup_via` (topic_id + user_id
 * present) and prove the import now advances out of `import_running` instead of
 * stranding. They FAIL on the pre-fix engine (every tick → `missing_channel_context`).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import { InterviewEngine, type ImportJobRunnerHook } from '../engine.ts'
import type { ImportJob, ImportResult } from '../../history-import/types.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'

const MIN = 60_000
const OWNER = 't1'
const TOPIC = 'app:owner' // single-owner Open app-socket topic
const USER = 'owner'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

function buildEngine(importJobRunner: ImportJobRunnerHook): InterviewEngine {
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    importJobRunner,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
  })
}

function scriptedRunner(job: ImportJob): { runner: ImportJobRunnerHook; cancels: string[] } {
  const cancels: string[] = []
  const runner: ImportJobRunnerHook = {
    start: async () => ({ job_id: job.job_id }),
    status: async () => job,
    cancel: async (id) => {
      cancels.push(id)
    },
    synthesizeOnDemand: async () => null,
  }
  return { runner, cancels }
}

/** Seed `import_running` the way Open Path-1 does: topic_id + user_id present,
 *  but NO `signup_via` (the freeform app-ws drive never stamps it). */
async function seedImportRunningNoSignupVia(job_id: string, started_at: number): Promise<void> {
  await stateStore.upsert({
    user_id: USER,
    project_slug: OWNER,
    phase: 'import_running',
    phase_state_patch: {
      topic_id: TOPIC,
      user_id: USER,
      // signup_via intentionally ABSENT — reproduces the Open Path-1 wedge.
      import_job_id: job_id,
      import_source: 'claude-zip',
      import_running_sub_step: 'pass1',
    },
    advanced_at: started_at,
  })
}

const SAMPLE_RESULT: ImportResult = {
  entities: [{ name: 'Dana', kind: 'person', mention_count: 12 }],
  topics: [{ name: 'Neutron launch', recurrence_score: 0.9, recency_score: 0.8 }],
  proposed_projects: [
    { name: 'Neutron', rationale: 'mentioned constantly', suggested_topics: ['launch'] },
  ],
  proposed_tasks: [],
  proposed_reminders: [],
  voice_signals: { tone: 'terse' },
  facts: { user_role: 'founder' },
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-nda-signup-via-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
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

describe('pollImportRunningTick — signup_via absent must NOT strand (ND-A)', () => {
  test('an in-progress tick does NOT return missing_channel_context (topic_id present)', async () => {
    const T0 = 5_000_000_000_000
    const job: ImportJob = {
      job_id: 'job-nd-a-progress',
      project_slug: OWNER,
      source: 'claude-zip',
      status: 'pass1-running',
      dollars_spent: 0,
      pass1_chunks_done: 3,
      pass1_chunks_total: 8,
      chunks_total_known: true,
      started_at: T0,
    }
    const { runner, cancels } = scriptedRunner(job)
    const engine = buildEngine(runner)
    await seedImportRunningNoSignupVia('job-nd-a-progress', T0)

    const out = await engine.pollImportRunningTick({
      project_slug: OWNER,
      user_id: USER,
      observed_at: T0 + 5 * MIN,
    })

    // Pre-fix: this returned 'missing_channel_context' every tick → stranded.
    expect(out.outcome).not.toBe('missing_channel_context')
    expect(out.outcome).toBe('in_progress')
    expect(out.state?.phase).toBe('import_running')
    expect(cancels).toEqual([])
  })

  test('a completed import ADVANCES out of import_running (no longer strands)', async () => {
    const T0 = 6_000_000_000_000
    const job: ImportJob = {
      job_id: 'job-nd-a-complete',
      project_slug: OWNER,
      source: 'claude-zip',
      status: 'pass1-running',
      dollars_spent: 0,
      pass1_chunks_done: 4,
      pass1_chunks_total: 8,
      chunks_total_known: true,
      started_at: T0,
    }
    const { runner } = scriptedRunner(job)
    const engine = buildEngine(runner)
    await seedImportRunningNoSignupVia('job-nd-a-complete', T0)

    // A first tick while still reading — must advance the import, not strand.
    let out = await engine.pollImportRunningTick({
      project_slug: OWNER,
      user_id: USER,
      observed_at: T0 + 10 * MIN,
    })
    expect(out.outcome).not.toBe('missing_channel_context')
    expect(out.state?.phase).toBe('import_running')

    // Synthesis finishes → the tick advances OUT of import_running.
    job.status = 'completed'
    job.pass1_chunks_done = 8
    job.result = SAMPLE_RESULT
    out = await engine.pollImportRunningTick({
      project_slug: OWNER,
      user_id: USER,
      observed_at: T0 + 12 * MIN,
    })

    expect(out.outcome).toBe('advanced')
    expect(out.state?.phase).toBe('import_analysis_presented')
    expect(out.state?.phase).not.toBe('import_running')
    expect(out.state?.phase_state['import_failed']).toBe(false)
    expect(out.state?.phase_state['import_result']).not.toBeNull()
  })
})
