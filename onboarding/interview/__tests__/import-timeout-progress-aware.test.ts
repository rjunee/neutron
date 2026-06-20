/**
 * import-timeout-progress-aware (2026-06-18) — the job-level import
 * hard-timeout must be PROGRESS-AWARE, not a flat wall-clock cap.
 *
 * LIVE OWNER FAILURE this reproduces (job=synth-a278944c96c78860):
 * the PR #98 synthesis liveness fix stopped per-turn false-wedges, so the
 * owner's real Claude export read ALL 8 chunks to pass1_pct=100% — but the
 * flat 15-min `IMPORT_RUNNING_HARD_TIMEOUT_MS` then guillotined the job the
 * instant it entered the consolidate pass, BEFORE the user-model was
 * written (`import timed out after 15 minutes` failure card). The
 * single-session synthesis runner stays at `status='pass1-running'` through
 * consolidate (it never sets `pass2-running`) and bills $0 on Max-OAuth, so
 * the consolidate turn emits NO engine-observable progress — exactly the
 * gap the flat cap killed.
 *
 * The fix:
 *   - `evaluateImportTimeout` resets the deadline on forward progress
 *     (chunk advance / status change / dollars rise); the Pass-1 READ phase
 *     gets a short no-progress window, the silent CONSOLIDATE phase a
 *     generous one. A 4h ceiling backstops a true livelock; a 30-min floor
 *     never guillotines a young job.
 *   - `pollImportRunningAndAdvance` tracks the progress anchor in
 *     phase_state and resets it on every forward-progress tick.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import {
  evaluateImportTimeout,
  IMPORT_CONSOLIDATE_NO_PROGRESS_WINDOW_MS,
  IMPORT_NO_PROGRESS_WINDOW_MS,
  IMPORT_RUNNING_HARD_TIMEOUT_CEILING_MS,
  IMPORT_RUNNING_HARD_TIMEOUT_MS,
  InterviewEngine,
  type ImportJobRunnerHook,
} from '../engine.ts'
import type { ImportJob, ImportResult } from '../../history-import/types.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'

const MIN = 60_000
const OWNER = 't1'
const TOPIC = 'topic-1'
const USER = 'u-1'

// ---------------------------------------------------------------------------
// Pure-helper unit tests — `evaluateImportTimeout`
// ---------------------------------------------------------------------------

describe('evaluateImportTimeout — progress-aware job timeout decision', () => {
  const T0 = 1_000_000_000_000 // arbitrary fixed epoch (no Date.now())

  test('the floor constant is 30 minutes (raised from 15)', () => {
    expect(IMPORT_RUNNING_HARD_TIMEOUT_MS).toBe(30 * MIN)
  })

  test('a young job (under the floor) is never cancelled, even with no progress', () => {
    const d = evaluateImportTimeout({
      observed_at: T0 + 20 * MIN,
      started_at: T0,
      progress_anchor_at: T0, // no progress since start
      pass1_chunks_done: 2,
      pass1_chunks_total: 8,
      status: 'pass1-running',
    })
    expect(d.fire).toBe(false)
  })

  test('Pass-1 read past the floor with a fresh progress anchor is NOT cancelled', () => {
    // 40 min elapsed (past floor + past the old flat 15-min cap), but the
    // anchor was just reset by a chunk advance 1 min ago → still progressing.
    const d = evaluateImportTimeout({
      observed_at: T0 + 40 * MIN,
      started_at: T0,
      progress_anchor_at: T0 + 39 * MIN,
      pass1_chunks_done: 6,
      pass1_chunks_total: 8,
      status: 'pass1-running',
    })
    expect(d.fire).toBe(false)
  })

  test('zero forward progress for the read window past the floor IS cancelled', () => {
    const d = evaluateImportTimeout({
      observed_at: T0 + 31 * MIN + (IMPORT_NO_PROGRESS_WINDOW_MS + MIN),
      started_at: T0,
      progress_anchor_at: T0 + 31 * MIN, // stalled here, never advanced
      pass1_chunks_done: 2,
      pass1_chunks_total: 8,
      status: 'pass1-running',
    })
    expect(d.fire).toBe(true)
    expect(d.reason).toBe('no_progress')
    expect(d.in_consolidate).toBe(false)
  })

  test("owner's exact failure: pass1 100% → consolidate past the flat 15-min mark is NOT cancelled", () => {
    // pass1 reached 100% at minute 31 (anchor reset there); consolidate has
    // been running silently for 3 min ($0, status still pass1-running). The
    // generous consolidate window protects it well past the old 15-min cap.
    const d = evaluateImportTimeout({
      observed_at: T0 + 34 * MIN,
      started_at: T0,
      progress_anchor_at: T0 + 31 * MIN,
      pass1_chunks_done: 8,
      pass1_chunks_total: 8,
      status: 'pass1-running',
    })
    expect(d.in_consolidate).toBe(true)
    expect(d.window_ms).toBe(IMPORT_CONSOLIDATE_NO_PROGRESS_WINDOW_MS)
    expect(d.fire).toBe(false)
  })

  test('a genuinely wedged consolidate past the consolidate window IS cancelled', () => {
    const d = evaluateImportTimeout({
      observed_at: T0 + 31 * MIN + (IMPORT_CONSOLIDATE_NO_PROGRESS_WINDOW_MS + MIN),
      started_at: T0,
      progress_anchor_at: T0 + 31 * MIN,
      pass1_chunks_done: 8,
      pass1_chunks_total: 8,
      status: 'pass1-running',
    })
    expect(d.fire).toBe(true)
    expect(d.reason).toBe('no_progress')
    expect(d.in_consolidate).toBe(true)
  })

  test('the 4h ceiling backstops a livelock even while actively progressing', () => {
    const d = evaluateImportTimeout({
      observed_at: T0 + IMPORT_RUNNING_HARD_TIMEOUT_CEILING_MS + MIN,
      started_at: T0,
      progress_anchor_at: T0 + IMPORT_RUNNING_HARD_TIMEOUT_CEILING_MS + MIN, // fresh anchor (still moving)
      pass1_chunks_done: 500,
      pass1_chunks_total: 900,
      status: 'pass1-running',
    })
    expect(d.fire).toBe(true)
    expect(d.reason).toBe('ceiling')
  })

  test('rate-limit states are never timed out here (owned by the resume/degrade path)', () => {
    for (const status of ['rate_limit_cooling_off', 'rate_limit_paused'] as const) {
      const d = evaluateImportTimeout({
        observed_at: T0 + 10 * IMPORT_RUNNING_HARD_TIMEOUT_CEILING_MS, // way past everything
        started_at: T0,
        progress_anchor_at: T0,
        pass1_chunks_done: 1,
        pass1_chunks_total: 8,
        status,
      })
      expect(d.fire).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Integration tests — the real engine poll path (`pollImportRunningTick`)
// ---------------------------------------------------------------------------

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

/** A runner whose `status()` returns a single mutable job the test scripts
 *  across ticks. Records cancels + synthesizeOnDemand calls. */
function scriptedRunner(job: ImportJob): {
  runner: ImportJobRunnerHook
  cancels: string[]
} {
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

async function seedImportRunning(job_id: string, started_at: number): Promise<void> {
  await stateStore.upsert({
    user_id: USER,
    project_slug: OWNER,
    phase: 'import_running',
    phase_state_patch: {
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
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
  tmp = mkdtempSync(join(tmpdir(), 'neutron-import-timeout-'))
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

describe('pollImportRunningTick — progress-aware timeout (integration)', () => {
  test('a slow-but-progressing import past the old 15-min flat cap is NOT cancelled, then completes', async () => {
    const T0 = 5_000_000_000_000
    const job: ImportJob = {
      job_id: 'job-slow',
      project_slug: OWNER,
      source: 'claude-zip',
      status: 'pass1-running',
      dollars_spent: 0,
      pass1_chunks_done: 0,
      pass1_chunks_total: 8,
      chunks_total_known: true,
      started_at: T0,
    }
    const { runner, cancels } = scriptedRunner(job)
    const engine = buildEngine(runner)
    await seedImportRunning('job-slow', T0)

    // Advance one chunk every ~4 min, from minute 5 to minute 45 — well past
    // both the old flat 15-min cap AND the new 30-min floor. Each advance
    // resets the deadline, so the import is never guillotined.
    for (let i = 1; i <= 10; i += 1) {
      job.pass1_chunks_done = i
      const out = await engine.pollImportRunningTick({
        project_slug: OWNER,
        user_id: USER,
        observed_at: T0 + (5 + i * 4) * MIN,
      })
      expect(out.outcome).toBe('in_progress')
      expect(out.state?.phase).toBe('import_running')
    }
    expect(cancels).toEqual([]) // never cancelled mid-flight

    // Synthesis finishes → completed with a non-empty user-model.
    job.status = 'completed'
    job.pass1_chunks_done = 8
    job.result = SAMPLE_RESULT
    const done = await engine.pollImportRunningTick({
      project_slug: OWNER,
      user_id: USER,
      observed_at: T0 + 50 * MIN,
    })
    expect(done.state?.phase).toBe('import_analysis_presented')
    expect(done.state?.phase_state['import_failed']).toBe(false)
    expect(done.state?.phase_state['import_result']).not.toBeNull()
  })

  test("owner's exact failure: pass1 100% → consolidate past 15 min is NOT cancelled mid-synthesis, then completes", async () => {
    const T0 = 6_000_000_000_000
    const job: ImportJob = {
      job_id: 'job-consolidate',
      project_slug: OWNER,
      source: 'claude-zip',
      status: 'pass1-running',
      dollars_spent: 0, // Max-OAuth: no dollar signal during synthesis
      pass1_chunks_done: 7,
      pass1_chunks_total: 8,
      chunks_total_known: true,
      started_at: T0,
    }
    const { runner, cancels } = scriptedRunner(job)
    const engine = buildEngine(runner)
    await seedImportRunning('job-consolidate', T0)

    // Tick at minute 20 — still reading (7/8). Initializes the anchor.
    let out = await engine.pollImportRunningTick({
      project_slug: OWNER,
      user_id: USER,
      observed_at: T0 + 20 * MIN,
    })
    expect(out.state?.phase).toBe('import_running')

    // Pass-1 reaches 100% at minute 31 (past the 30-min floor) — chunk
    // advance resets the anchor; we enter the silent consolidate phase.
    job.pass1_chunks_done = 8
    out = await engine.pollImportRunningTick({
      project_slug: OWNER,
      user_id: USER,
      observed_at: T0 + 31 * MIN,
    })
    expect(out.state?.phase).toBe('import_running')

    // Consolidate runs silently for 3 more min ($0, status still
    // pass1-running) — past the old flat 15-min cap AND past the 30-min
    // floor. The generous consolidate window protects it. (Owner's failure.)
    out = await engine.pollImportRunningTick({
      project_slug: OWNER,
      user_id: USER,
      observed_at: T0 + 34 * MIN,
    })
    expect(out.outcome).toBe('in_progress')
    expect(out.state?.phase).toBe('import_running')
    expect(cancels).toEqual([]) // NOT guillotined mid-synthesis

    // Synthesis writes a non-empty user-model → completed.
    job.status = 'completed'
    job.result = SAMPLE_RESULT
    const done = await engine.pollImportRunningTick({
      project_slug: OWNER,
      user_id: USER,
      observed_at: T0 + 35 * MIN,
    })
    expect(done.state?.phase).toBe('import_analysis_presented')
    expect(done.state?.phase_state['import_failed']).toBe(false)
    expect(done.state?.phase_state['import_result']).not.toBeNull()
  })

  test('a genuinely stuck import (zero progress for the no-progress window past the floor) IS cancelled', async () => {
    const T0 = 7_000_000_000_000
    const job: ImportJob = {
      job_id: 'job-stuck',
      project_slug: OWNER,
      source: 'claude-zip',
      status: 'pass1-running',
      dollars_spent: 0,
      pass1_chunks_done: 2,
      pass1_chunks_total: 8, // NOT in consolidate → short read window
      chunks_total_known: true,
      started_at: T0,
    }
    const { runner, cancels } = scriptedRunner(job)
    const engine = buildEngine(runner)
    await seedImportRunning('job-stuck', T0)

    // Tick 1 at minute 31 (past floor) — initializes the anchor.
    let out = await engine.pollImportRunningTick({
      project_slug: OWNER,
      user_id: USER,
      observed_at: T0 + 31 * MIN,
    })
    expect(out.state?.phase).toBe('import_running')

    // Tick 2 well past the no-progress window with the job UNCHANGED → stuck.
    out = await engine.pollImportRunningTick({
      project_slug: OWNER,
      user_id: USER,
      observed_at: T0 + 31 * MIN + IMPORT_NO_PROGRESS_WINDOW_MS + 2 * MIN,
    })
    expect(out.state?.phase).toBe('import_analysis_presented')
    expect(out.state?.phase_state['import_failed']).toBe(true)
    expect(cancels).toEqual(['job-stuck']) // runner cancelled to stop the burn
  })
})
