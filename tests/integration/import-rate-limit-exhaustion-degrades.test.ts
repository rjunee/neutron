/**
 * Reproduce-first regression suite for ISSUES #91 — ChatGPT import-analysis
 * degrades to "couldn't analyze your export" under sustained 429 backoff
 * exhaustion.
 *
 * Root cause (confirmed candidate (c) — see AS-BUILT.md):
 *   The `rate_limit_paused` → auto-resume loop in
 *   `pollImportRunningAndAdvance` had NO ceiling. Every time the in-process
 *   `retryWith429` schedule exhausted (~27 min of 429 backoff) the runner
 *   flipped the job to `rate_limit_paused`; the engine's cron tick then
 *   auto-resumed it after `COOLDOWN_AFTER_PAUSED_MS` (5 min) by dispatching
 *   a fresh `runner.start(...)`. Under GENUINE sustained rate limiting
 *   (owner's Max account saturated, or a huge export) each resumed job
 *   immediately re-exhausts and re-pauses → an UNBOUNDED resume loop. The
 *   user was either stranded in the "still waiting on rate limit" body
 *   forever, OR — when a transient non-429 eventually flipped the job to
 *   `failed` — surfaced "couldn't analyze your export" while DISCARDING the
 *   cached Pass-1 signal (`import_result=null`), matching the prod symptom
 *   ("falls through to gap-fill with no extracted signals").
 *
 * Candidates (a) and (b) were investigated and ruled out as the LIVE root
 * cause (a: the in-process credential-pool cooldown isn't on the import
 * dispatch path — the `claude` subprocess owns its own creds; b: the
 * Max-OAuth 4K chunk override is correctly wired via
 * `importGetCurrentCredentialKind`, so 50K chunks no longer 429 at submit).
 *
 * Fix:
 *   1. Bound the loop with `MAX_RATE_LIMIT_RESUME_CYCLES`. Only CONSECUTIVE
 *      resume cycles that make NO Pass-1 progress count toward the ceiling
 *      (a slowly-but-genuinely-progressing large export keeps resuming).
 *   2. On give-up, degrade GRACEFULLY: salvage whatever Pass-1 signal
 *      reached the cache via `synthesizeOnDemand` and present it as a
 *      partial result; only surface the bare "couldn't analyze" (null
 *      result) when there is genuinely nothing to salvage.
 *
 * These tests drive the real cron tick loop (same harness as
 * import-paused-auto-resume.test.ts).
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
  MAX_RATE_LIMIT_RESUME_CYCLES,
} from '@neutronai/onboarding/index.ts'
import type {
  ImportJobRunnerHook,
  ImportPayloadResolver,
} from '@neutronai/onboarding/interview/engine.ts'
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
let runnerStatuses: Map<string, ImportJob>
let runnerStartCalls: Array<{ project_slug: string; source: string }>
let synthesizeCalls: string[]
let jobIdCounter: number
// Test-controllable salvage result for synthesizeOnDemand.
let salvageResult: ImportResult | null

function fakeResolver(): ImportPayloadResolver {
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
      return { job_id: `job-resumed-${jobIdCounter}` }
    },
    status: async (job_id) => runnerStatuses.get(job_id) ?? null,
    cancel: async () => undefined,
    synthesizeOnDemand: async (job_id) => {
      synthesizeCalls.push(job_id)
      return salvageResult
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
    importPayloadResolver: fakeResolver(),
    now,
  })
}

function seedPausedOriginal(opts: { pass1_chunks_done: number; last_paused_at: number }) {
  return {
    job_id: 'job-original',
    project_slug: OWNER,
    source: 'chatgpt-zip' as const,
    status: 'rate_limit_paused' as const,
    dollars_spent: 1.2,
    pass1_chunks_done: opts.pass1_chunks_done,
    pass1_chunks_total: 10,
    chunks_total_known: true,
    started_at: opts.last_paused_at - 30 * 60_000,
    last_paused_at: opts.last_paused_at,
  }
}

async function seedImportRunningPaused(original: ImportJob) {
  await stateStore.upsert({
    user_id: 'test-user',
    project_slug: OWNER,
    phase: 'import_running',
    phase_state_patch: {
      topic_id: TOPIC,
      user_id: USER,
      signup_via: 'web',
      import_job_id: original.job_id,
      import_source: 'chatgpt-zip',
    },
    advanced_at: original.started_at,
  })
  runnerStatuses.set(original.job_id, original)
}

function buildCron(now: () => number) {
  const engine = makeEngine(now)
  const handler = buildImportRunningHandler({ engine, db, now })
  const jobs = new CronJobRegistry()
  const handlers = new CronHandlerRegistry()
  registerImportRunningCron({ project_slug: OWNER, jobs, handlers, handler })
  return new CronScheduler({ jobs, handlers, db, project_slug: OWNER, now })
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-import-429-exhaust-'))
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
  synthesizeCalls = []
  jobIdCounter = 0
  salvageResult = null
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('sanity: MAX_RATE_LIMIT_RESUME_CYCLES is a small finite ceiling', () => {
  expect(MAX_RATE_LIMIT_RESUME_CYCLES).toBeGreaterThanOrEqual(2)
  expect(MAX_RATE_LIMIT_RESUME_CYCLES).toBeLessThanOrEqual(10)
})

test('persistent 429 with no Pass-1 progress is BOUNDED — engine stops resuming and degrades to import_analysis_presented (does NOT loop forever)', async () => {
  const T0 = 1_700_000_000_000
  let now_ms = T0
  await seedImportRunningPaused(seedPausedOriginal({ pass1_chunks_done: 0, last_paused_at: T0 }))

  // Pre-stage enough resumed jobs, all stuck at rate_limit_paused with NO
  // forward Pass-1 progress (the genuine-exhaustion case). The runner's
  // start() creates `job-resumed-${counter}` deterministically, so we can
  // pre-populate their statuses. last_paused_at is stamped per tick below.
  const scheduler = buildCron(() => now_ms)

  const maxTicks = MAX_RATE_LIMIT_RESUME_CYCLES + 5
  let advancedPhase: string | null = null
  for (let cycle = 1; cycle <= maxTicks; cycle += 1) {
    now_ms += COOLDOWN_AFTER_PAUSED_MS + 1_000
    // The job this tick may spawn: pre-populate it paused, last_paused_at
    // = this tick's clock so the in-tick recursion doesn't immediately
    // re-resume (cooldown gate), but the NEXT tick (clock advanced past
    // cooldown) does.
    runnerStatuses.set(`job-resumed-${cycle}`, {
      job_id: `job-resumed-${cycle}`,
      project_slug: OWNER,
      source: 'chatgpt-zip',
      status: 'rate_limit_paused',
      dollars_spent: 0,
      pass1_chunks_done: 0, // never makes progress → genuine exhaustion
      pass1_chunks_total: 10,
      chunks_total_known: true,
      started_at: now_ms,
      last_paused_at: now_ms,
    })
    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
    const s = await stateStore.get(OWNER, 'test-user')
    if (s?.phase !== 'import_running') {
      advancedPhase = s?.phase ?? null
      break
    }
  }

  // THE BUG: pre-fix, the engine resumes on every cooldown-elapsed tick
  // forever — phase stays `import_running` and runnerStartCalls grows
  // without bound. Post-fix, the ceiling fires and the engine advances.
  expect(advancedPhase).toBe('import_analysis_presented')
  // The number of resume dispatches is bounded by the ceiling (+1 for the
  // free first cycle whose progress-mark seeds from the original job).
  expect(runnerStartCalls.length).toBeLessThanOrEqual(MAX_RATE_LIMIT_RESUME_CYCLES + 1)

  // Give-up must STOP dispatching: two more ticks change nothing.
  const startsAtGiveUp = runnerStartCalls.length
  now_ms += COOLDOWN_AFTER_PAUSED_MS + 1_000
  await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
  now_ms += COOLDOWN_AFTER_PAUSED_MS + 1_000
  await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
  expect(runnerStartCalls.length).toBe(startsAtGiveUp)
})

test('on give-up the engine SALVAGES cached Pass-1 signal (import_partial=true, import_result present) instead of "couldn\'t analyze with no signals"', async () => {
  const T0 = 1_700_000_000_000
  let now_ms = T0
  await seedImportRunningPaused(seedPausedOriginal({ pass1_chunks_done: 4, last_paused_at: T0 }))

  // Scripted salvage: synthesizeOnDemand returns real Pass-1 aggregated
  // signal from the cache (entities + topics), simulating a partial import.
  salvageResult = {
    entities: [{ name: 'Ledgerline', kind: 'company', mention_count: 9 }],
    topics: [{ name: 'fundraising', recurrence_score: 3, recency_score: 2 }],
    proposed_projects: [],
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {},
    facts: {},
    conversation_count: 4,
  } as unknown as ImportResult

  const scheduler = buildCron(() => now_ms)
  const maxTicks = MAX_RATE_LIMIT_RESUME_CYCLES + 5
  for (let cycle = 1; cycle <= maxTicks; cycle += 1) {
    now_ms += COOLDOWN_AFTER_PAUSED_MS + 1_000
    runnerStatuses.set(`job-resumed-${cycle}`, {
      job_id: `job-resumed-${cycle}`,
      project_slug: OWNER,
      source: 'chatgpt-zip',
      status: 'rate_limit_paused',
      dollars_spent: 0,
      pass1_chunks_done: 4,
      pass1_chunks_total: 10,
      chunks_total_known: true,
      started_at: now_ms,
      last_paused_at: now_ms,
    })
    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
    const s = await stateStore.get(OWNER, 'test-user')
    if (s?.phase !== 'import_running') break
  }

  const final = await stateStore.get(OWNER, 'test-user')
  expect(final?.phase).toBe('import_analysis_presented')
  // Salvaged: partial signal surfaced, NOT a hard "couldn't analyze".
  expect(synthesizeCalls.length).toBeGreaterThanOrEqual(1)
  expect(final?.phase_state['import_partial']).toBe(true)
  expect(final?.phase_state['import_failed']).toBe(false)
  const result = final?.phase_state['import_result'] as ImportResult | null
  expect(result).not.toBeNull()
  expect(result?.entities.length ?? 0).toBeGreaterThan(0)
})

test('on give-up with NOTHING to salvage, the engine surfaces the graceful "couldn\'t analyze" (import_failed=true, null result)', async () => {
  const T0 = 1_700_000_000_000
  let now_ms = T0
  await seedImportRunningPaused(seedPausedOriginal({ pass1_chunks_done: 0, last_paused_at: T0 }))
  salvageResult = null // nothing in the Pass-1 cache to salvage

  const scheduler = buildCron(() => now_ms)
  const maxTicks = MAX_RATE_LIMIT_RESUME_CYCLES + 5
  for (let cycle = 1; cycle <= maxTicks; cycle += 1) {
    now_ms += COOLDOWN_AFTER_PAUSED_MS + 1_000
    runnerStatuses.set(`job-resumed-${cycle}`, {
      job_id: `job-resumed-${cycle}`,
      project_slug: OWNER,
      source: 'chatgpt-zip',
      status: 'rate_limit_paused',
      dollars_spent: 0,
      pass1_chunks_done: 0,
      pass1_chunks_total: 10,
      chunks_total_known: true,
      started_at: now_ms,
      last_paused_at: now_ms,
    })
    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
    const s = await stateStore.get(OWNER, 'test-user')
    if (s?.phase !== 'import_running') break
  }

  const final = await stateStore.get(OWNER, 'test-user')
  expect(final?.phase).toBe('import_analysis_presented')
  expect(final?.phase_state['import_failed']).toBe(true)
  expect(final?.phase_state['import_result']).toBeNull()
})

test('a slowly-but-genuinely-progressing import is NOT capped — forward Pass-1 progress resets the resume ceiling', async () => {
  const T0 = 1_700_000_000_000
  let now_ms = T0
  await seedImportRunningPaused(seedPausedOriginal({ pass1_chunks_done: 0, last_paused_at: T0 }))

  const scheduler = buildCron(() => now_ms)
  // Drive MANY more ticks than the ceiling, but advance pass1_chunks_done
  // by one on every resumed job — genuine forward progress. The engine
  // must KEEP resuming (never give up) because this is not exhaustion.
  const ticks = MAX_RATE_LIMIT_RESUME_CYCLES * 3
  for (let cycle = 1; cycle <= ticks; cycle += 1) {
    now_ms += COOLDOWN_AFTER_PAUSED_MS + 1_000
    runnerStatuses.set(`job-resumed-${cycle}`, {
      job_id: `job-resumed-${cycle}`,
      project_slug: OWNER,
      source: 'chatgpt-zip',
      status: 'rate_limit_paused',
      dollars_spent: 0,
      pass1_chunks_done: cycle, // monotonically increasing → real progress
      pass1_chunks_total: 10_000,
      chunks_total_known: true,
      started_at: now_ms,
      last_paused_at: now_ms,
    })
    await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
  }

  const final = await stateStore.get(OWNER, 'test-user')
  // Still resuming — never degraded — because every cycle made progress.
  expect(final?.phase).toBe('import_running')
  expect(runnerStartCalls.length).toBe(ticks)
  expect(synthesizeCalls.length).toBe(0)
})
