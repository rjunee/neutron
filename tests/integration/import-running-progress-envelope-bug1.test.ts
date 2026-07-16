/**
 * Integration test — Bug 1 fix (2026-05-21, v0.1.75) — import-progress
 * envelope emission from the import-running cron tick.
 *
 * Symptom (owner, 2026-05-21 after v0.1.74 deploy): user uploads a
 * Claude-export ZIP, the chat surface shows ONE static agent bubble
 * ("Analyzing your N conversations from claude — this takes about 30
 * seconds."), and then nothing visibly changes for minutes while the
 * runner does real work. `import_jobs.pass1_chunks_done` ticks up to
 * `pass1_chunks_total` — none of that reaches the WS client.
 *
 * Root cause: the import-running cron tick (S12, 2026-05-16) calls
 * `pollImportRunningTick` with `suppress_in_progress_status_emit: true`
 * to avoid spamming the channel with re-emitted agent bodies. That was
 * the right call for the prompt-emit path but left the user with zero
 * client-visible motion.
 *
 * Fix (v0.1.75): when `suppress_in_progress_status_emit: true` AND
 * `deps.sendImportProgress` is wired AND status is in-progress, the
 * engine fires a UI-only `import_progress` envelope through the
 * channel. The envelope carries job_id / status / pass / pct /
 * chunks_total_known / body — the client renders a pulsing-dot
 * indicator below the most recent agent bubble that updates every 5s.
 *
 * 2026-05-22 UX fix follow-up (this file's current shape): the
 * original v0.1.75 envelope carried a `dollars_spent` field that the
 * client rendered as "· $X spent". On Claude Max OAuth (M2 default,
 * only prod path) there is no marginal per-token cost, so the field
 * is misleading and was stripped. The same sprint added
 * `chunks_total_known: boolean` so the bubble switches between
 * "N/M batches" (stable denominator, pre-counted) and "N batches
 * processed" (count-only, streaming-fallback) modes. Both shapes
 * are pinned by the cases in this file.
 *
 * Critical: progress envelopes do NOT touch `button_prompts.delivered_at`,
 * `transcript.jsonl`, or any audit state (preserving S16 invariants).
 *
 * Spec contract: `docs/plans/P2-onboarding-v2.md` § 3.6 (revised) +
 * § 9.5 (client-side liveness contract — import_progress envelope) +
 * `docs/plans/2026-05-22-001-fix-import-progress-ux-plan.md`.
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
} from '@neutronai/onboarding/index.ts'
import type {
  ImportJobRunnerHook,
  SendImportProgressFn,
} from '@neutronai/onboarding/interview/engine.ts'
import type { ImportJob } from '@neutronai/onboarding/history-import/types.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import { CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import { CronScheduler } from '@neutronai/cron/scheduler.ts'

interface SentProgress {
  project_slug: string
  topic_id: string
  event: Parameters<SendImportProgressFn>[0]['event']
}

const OWNER = 'alice'
const TOPIC = 'web:u-alice'
const USER = 'u-alice'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: SqliteOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ prompt: ButtonPrompt }>
let sentProgress: SentProgress[]
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
    sendImportProgress: async (input) => {
      sentProgress.push({
        project_slug: input.owner_slug,
        topic_id: input.topic_id,
        event: input.event,
      })
      return { delivered: true }
    },
    importJobRunner: makeRunner(),
    now,
  })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-import-progress-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new SqliteOnboardingStateStore({ db })
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
  sentProgress = []
  runnerResults = new Map()
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('Bug 1 (2026-05-21, v0.1.75) — import_progress envelope from cron tick', () => {
  test('cron tick emits a Pass-1 progress envelope while runner is pass1-running', async () => {
    const T0 = 1_700_000_000_000
    const job_id = 'job-progress-pass1'
    await stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        import_job_id: job_id,
        import_source: 'claude-zip',
      },
      advanced_at: T0,
    })
    runnerResults.set(job_id, {
      job_id,
      owner_slug: OWNER,
      source: 'claude-zip',
      status: 'pass1-running',
      dollars_spent: 0.21,
      pass1_chunks_done: 47,
      pass1_chunks_total: 57,
      // Pre-counted (2026-05-22 UX fix) → bubble renders 47/57.
      chunks_total_known: true,
      started_at: T0 - 30_000,
    })

    const engine = makeEngine(() => T0 + 5_000)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 + 5_000 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ owner_slug: OWNER, jobs, handlers, handler })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      owner_slug: OWNER,
      now: () => T0 + 5_000,
    })

    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)

    expect(sentProgress.length).toBe(1)
    const env = sentProgress[0]!.event
    expect(env.type).toBe('import_progress')
    expect(env.job_id).toBe(job_id)
    expect(env.status).toBe('pass1-running')
    expect(env.pass).toBe(1)
    // 47 / 57 = ~0.824
    expect(env.pct).toBeGreaterThan(0.8)
    expect(env.pct).toBeLessThan(0.85)
    expect(env.chunks_total_known).toBe(true)
    expect(env.body).toContain('Pass 1')
    expect(env.body).toContain('47/57')
    // 2026-05-22 — Max-OAuth users aren't billed per-token; the bubble
    // must NOT carry a `$` anywhere AND the serialized envelope JSON
    // must NOT carry a `dollars_spent` key (pre-fix renderers will
    // refuse to parse the new shape if either drifts back in).
    expect(env.body ?? '').not.toContain('$')
    const serialized = JSON.stringify(env)
    expect(serialized).not.toContain('dollars_spent')
    expect(serialized).not.toContain('$')
    // Critical: progress envelopes MUST NOT count as agent_message
    // emissions — no button_prompt sent.
    expect(sentPrompts.length).toBe(0)
  })

  test('cron tick emits a Pass-2 progress envelope while runner is pass2-running', async () => {
    const T0 = 1_700_000_000_000
    const job_id = 'job-progress-pass2'
    await stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
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
      owner_slug: OWNER,
      source: 'chatgpt-zip',
      status: 'pass2-running',
      dollars_spent: 1.74,
      pass1_chunks_done: 173,
      pass1_chunks_total: 173,
      // Pre-counted in Pass 1 (chunks_total_known=true) → body should
      // include the "from 173 batches" anchor.
      chunks_total_known: true,
      started_at: T0 - 30_000,
    })

    const engine = makeEngine(() => T0 + 10_000)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 + 10_000 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ owner_slug: OWNER, jobs, handlers, handler })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      owner_slug: OWNER,
      now: () => T0 + 10_000,
    })

    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)

    expect(sentProgress.length).toBe(1)
    const env = sentProgress[0]!.event
    expect(env.status).toBe('pass2-running')
    expect(env.pass).toBe(2)
    // Pass 2 pct is elapsed/expected — never claims 100% before
    // completion.
    expect(env.pct).toBeGreaterThan(0)
    expect(env.pct).toBeLessThanOrEqual(0.95)
    expect(env.chunks_total_known).toBe(true)
    expect(env.body).toContain('Pass 2')
    expect(env.body).toContain('synthesizing')
    // 2026-05-22 — no `$` regardless of pass / status.
    expect(env.body ?? '').not.toContain('$')
    const serialized = JSON.stringify(env)
    expect(serialized).not.toContain('dollars_spent')
  })

  test('cron tick does NOT emit progress when runner has terminated (completed) — terminal status emits agent_message instead', async () => {
    const T0 = 1_700_000_000_000
    const job_id = 'job-completed'
    await stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        import_job_id: job_id,
        import_source: 'claude-zip',
      },
      advanced_at: T0,
    })
    runnerResults.set(job_id, {
      job_id,
      owner_slug: OWNER,
      source: 'claude-zip',
      status: 'completed',
      dollars_spent: 1.74,
      pass1_chunks_done: 57,
      pass1_chunks_total: 57,
      chunks_total_known: false,
      started_at: T0 - 60_000,
      completed_at: T0 - 1_000,
      result: {
        conversation_count: 57,
        entities: [],
        topics: [],
        proposed_projects: [
          { name: 'Project A', rationale: '', suggested_topics: [] },
          { name: 'Project B', rationale: '', suggested_topics: [] },
          { name: 'Project C', rationale: '', suggested_topics: [] },
        ],
        proposed_tasks: [],
        proposed_reminders: [],
        voice_signals: {},
        facts: {},
        inferred_interests: [{ name: 'climbing' }],
      },
    })

    const engine = makeEngine(() => T0 + 5_000)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 + 5_000 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ owner_slug: OWNER, jobs, handlers, handler })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      owner_slug: OWNER,
      now: () => T0 + 5_000,
    })

    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)

    // No progress envelope (we hit the completed terminal branch which
    // advances phase + emits an agent_message instead).
    expect(sentProgress.length).toBe(0)
    // The terminal advance emits the analysis-presented prompt.
    expect(sentPrompts.length).toBeGreaterThan(0)
  })

  test('cron tick interval is 5s (lowered from 15s for live progress feel)', () => {
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    const engine = makeEngine(() => 1_700_000_000_000)
    const handler = buildImportRunningHandler({ engine, db, now: () => 1_700_000_000_000 })
    registerImportRunningCron({ owner_slug: OWNER, jobs, handlers, handler })
    const job = jobs.get(`onboarding-import-running-${OWNER}`)!
    expect(job.schedule.kind).toBe('interval_ms')
    if (job.schedule.kind === 'interval_ms') {
      expect(job.schedule.interval_ms).toBe(5_000)
    }
  })

  test('audit invariants preserved across progress envelope: no markDelivered, no transcript.append, no button_prompts touch', async () => {
    const T0 = 1_700_000_000_000
    const job_id = 'job-audit'
    await stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        import_job_id: job_id,
        import_source: 'claude-zip',
      },
      advanced_at: T0,
    })
    runnerResults.set(job_id, {
      job_id,
      owner_slug: OWNER,
      source: 'claude-zip',
      status: 'pass1-running',
      dollars_spent: 0.05,
      pass1_chunks_done: 1,
      pass1_chunks_total: 57,
      chunks_total_known: false,
      started_at: T0 - 1_000,
    })

    const engine = makeEngine(() => T0 + 5_000)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 + 5_000 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ owner_slug: OWNER, jobs, handlers, handler })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      owner_slug: OWNER,
      now: () => T0 + 5_000,
    })

    // Three ticks back-to-back simulating 15s elapsed wall-clock.
    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)

    expect(sentProgress.length).toBe(3)
    // ZERO button_prompts emitted across all ticks.
    expect(sentPrompts.length).toBe(0)
    // No transcript lines.
    const transcriptPath = join(tmp, 'persona', 'onboarding-transcript.jsonl')
    let transcriptContent = ''
    try {
      const fs = await import('node:fs')
      if (fs.existsSync(transcriptPath)) {
        transcriptContent = fs.readFileSync(transcriptPath, 'utf-8')
      }
    } catch {
      // File doesn't exist → no transcript writes, which is what we want.
    }
    // The seed didn't append anything either, so the transcript should
    // be empty (or contain only system lines, which are fine).
    expect(transcriptContent.split('\n').filter((l) => l.includes('"role":"agent"')).length).toBe(0)
  })

  test('streaming-fallback mode (chunks_total_known=false) renders count-only "N batches processed"', async () => {
    // 2026-05-22 UX fix follow-up. Pre-fix the bubble ALWAYS rendered
    // "${done}/${total} batches", even when the runner was still
    // discovering chunks → user saw 5/5 → 6/6 → 7/7 with no real
    // progress signal. The new pre-count path sets
    // `chunks_total_known=true` and renders a stable denominator; the
    // streaming-fallback path (pre-count threw) sets the flag to
    // `false` so the bubble omits the denominator entirely.
    const T0 = 1_700_000_000_000
    const job_id = 'job-streaming-fallback'
    await stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        import_job_id: job_id,
        import_source: 'claude-zip',
      },
      advanced_at: T0,
    })
    runnerResults.set(job_id, {
      job_id,
      owner_slug: OWNER,
      source: 'claude-zip',
      status: 'pass1-running',
      dollars_spent: 0.09,
      pass1_chunks_done: 5,
      pass1_chunks_total: 5,
      chunks_total_known: false,
      started_at: T0 - 30_000,
    })

    const engine = makeEngine(() => T0 + 5_000)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 + 5_000 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ owner_slug: OWNER, jobs, handlers, handler })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      owner_slug: OWNER,
      now: () => T0 + 5_000,
    })

    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)

    expect(sentProgress.length).toBe(1)
    const env = sentProgress[0]!.event
    expect(env.chunks_total_known).toBe(false)
    expect(env.body).toContain('Pass 1: 5 batches processed')
    // The misleading "N/N" denominator must NOT appear in fallback
    // mode — this is the exact pre-fix artifact the sprint resolves.
    expect(env.body ?? '').not.toContain('/5')
    expect(env.body ?? '').not.toContain('5/5')
    expect(env.body ?? '').not.toContain('$')
    const serialized = JSON.stringify(env)
    expect(serialized).not.toContain('dollars_spent')
  })
})

// ---------------------------------------------------------------------------
// 2026-05-31 — ETA suffix on Pass-1 progress body.
//
// Per the "Import pass-1 — Opus default + parallel + ETA + chunk-size audit"
// sprint brief (Part C). When chunks_done >= 3 AND chunks_total_known is
// true AND chunks_remaining > 0, the body gets a "· ~N min remaining"
// (or "· almost done" / "· ~1 min remaining") suffix derived from
// (elapsed / done) * remaining.
// ---------------------------------------------------------------------------

describe('2026-05-31 — ETA suffix on Pass-1 progress body', () => {
  test('Pass-1 with >=3 chunks done + known total emits "· ~N min remaining" suffix', async () => {
    const T0 = 1_700_000_000_000
    const job_id = 'job-eta'
    await stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        import_job_id: job_id,
        import_source: 'claude-zip',
      },
      advanced_at: T0,
    })
    // 5 chunks done out of 100 → 95 remaining; started 1 minute ago.
    // ETA = (60s / 5) * 95 / 60s = 19 min remaining.
    runnerResults.set(job_id, {
      job_id,
      owner_slug: OWNER,
      source: 'claude-zip',
      status: 'pass1-running',
      dollars_spent: 0,
      pass1_chunks_done: 5,
      pass1_chunks_total: 100,
      chunks_total_known: true,
      started_at: T0 - 60_000,
    })

    const engine = makeEngine(() => T0)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ owner_slug: OWNER, jobs, handlers, handler })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      owner_slug: OWNER,
      now: () => T0,
    })

    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)

    expect(sentProgress.length).toBe(1)
    const env = sentProgress[0]!.event
    expect(env.body).toContain('Pass 1: 5/100 batches')
    expect(env.body).toContain('min remaining')
    expect(env.body ?? '').toMatch(/Pass 1: 5\/100 batches · ~\d+ min remaining/)
  })

  test('Pass-1 with <3 chunks done emits NO ETA suffix (too noisy to estimate)', async () => {
    const T0 = 1_700_000_000_000
    const job_id = 'job-no-eta'
    await stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        import_job_id: job_id,
        import_source: 'claude-zip',
      },
      advanced_at: T0,
    })
    runnerResults.set(job_id, {
      job_id,
      owner_slug: OWNER,
      source: 'claude-zip',
      status: 'pass1-running',
      dollars_spent: 0,
      pass1_chunks_done: 2,
      pass1_chunks_total: 100,
      chunks_total_known: true,
      started_at: T0 - 30_000,
    })

    const engine = makeEngine(() => T0)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ owner_slug: OWNER, jobs, handlers, handler })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      owner_slug: OWNER,
      now: () => T0,
    })

    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)

    expect(sentProgress.length).toBe(1)
    const env = sentProgress[0]!.event
    expect(env.body).toBe('Pass 1: 2/100 batches')
    expect(env.body ?? '').not.toContain('remaining')
    expect(env.body ?? '').not.toContain('almost done')
  })

  test('Pass-1 with knownTotal=false emits NO ETA suffix (denominator unknown)', async () => {
    const T0 = 1_700_000_000_000
    const job_id = 'job-no-eta-streaming'
    await stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        import_job_id: job_id,
        import_source: 'claude-zip',
      },
      advanced_at: T0,
    })
    runnerResults.set(job_id, {
      job_id,
      owner_slug: OWNER,
      source: 'claude-zip',
      status: 'pass1-running',
      dollars_spent: 0,
      pass1_chunks_done: 10,
      pass1_chunks_total: 0,
      chunks_total_known: false,
      started_at: T0 - 120_000,
    })

    const engine = makeEngine(() => T0)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ owner_slug: OWNER, jobs, handlers, handler })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      owner_slug: OWNER,
      now: () => T0,
    })

    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)

    expect(sentProgress.length).toBe(1)
    const env = sentProgress[0]!.event
    expect(env.body).toBe('Pass 1: 10 batches processed')
    expect(env.body ?? '').not.toContain('remaining')
  })

  test('Pass-1 with chunks_done == chunks_total emits NO ETA suffix (job done in Pass-1)', async () => {
    const T0 = 1_700_000_000_000
    const job_id = 'job-no-eta-done'
    await stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        import_job_id: job_id,
        import_source: 'claude-zip',
      },
      advanced_at: T0,
    })
    runnerResults.set(job_id, {
      job_id,
      owner_slug: OWNER,
      source: 'claude-zip',
      status: 'pass1-running',
      dollars_spent: 0,
      pass1_chunks_done: 50,
      pass1_chunks_total: 50,
      chunks_total_known: true,
      started_at: T0 - 600_000,
    })

    const engine = makeEngine(() => T0)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ owner_slug: OWNER, jobs, handlers, handler })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      owner_slug: OWNER,
      now: () => T0,
    })

    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)

    expect(sentProgress.length).toBe(1)
    const env = sentProgress[0]!.event
    expect(env.body).toBe('Pass 1: 50/50 batches')
    expect(env.body ?? '').not.toContain('remaining')
  })

  test('Argus r1 — Pass-1 with 1 chunk remaining and sub-minute ETA emits "almost done"', async () => {
    // Pre-fix the `<= 0` gate at engine.ts:7489 only fired when
    // elapsedMs === 0 (clock skew / same-tick poll), since
    // Math.ceil(positive_number) is always >= 1. The realistic last-
    // mile case (1 chunk left, ETA under a minute) silently rendered
    // "~1 min remaining" forever. Argus widened the gate to
    // `etaRemainingMin <= 1 && chunksRemaining <= 1` so the UX is
    // honest. With 49/50 chunks done over 10 minutes elapsed,
    // minutesPerChunk = 10/49 ≈ 0.204, chunksRemaining = 1,
    // etaRemainingMin = Math.ceil(0.204) = 1 → fires "almost done".
    //
    // NOTE: the engine reads `Date.now() - job.started_at` directly
    // (not the supplied `now()` mock), so we anchor `started_at` to
    // real wall clock to get a deterministic 10-min elapsed window.
    const T0 = 1_700_000_000_000
    const job_id = 'job-almost-done'
    await stateStore.upsert({
      user_id: USER,
      owner_slug: OWNER,
      phase: 'import_running',
      phase_state_patch: {
        topic_id: TOPIC,
        user_id: USER,
        signup_via: 'web',
        import_job_id: job_id,
        import_source: 'claude-zip',
      },
      advanced_at: T0,
    })
    runnerResults.set(job_id, {
      job_id,
      owner_slug: OWNER,
      source: 'claude-zip',
      status: 'pass1-running',
      dollars_spent: 0,
      pass1_chunks_done: 49,
      pass1_chunks_total: 50,
      chunks_total_known: true,
      started_at: Date.now() - 600_000, // 10 min elapsed via real clock
    })

    const engine = makeEngine(() => T0)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ owner_slug: OWNER, jobs, handlers, handler })
    const scheduler = new CronScheduler({
      jobs,
      handlers,
      db,
      owner_slug: OWNER,
      now: () => T0,
    })

    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)

    expect(sentProgress.length).toBe(1)
    const env = sentProgress[0]!.event
    expect(env.body).toBe('Pass 1: 49/50 batches · almost done')
  })
})
