/**
 * Integration test — S12 (2026-05-16) — import-running cron-tick.
 *
 * Per docs/plans/P2-onboarding-v2.md § 3.4 + § S5: `import_running` is a
 * transit phase that advances to `import_analysis_presented` when the
 * `ImportJobRunner` reaches `completed`. The original wiring polled
 * once inside `notifyImportUpload`, leaving the engine stranded at
 * `import_running` after Pass-1+Pass-2 finished. This test pins the
 * cron-tick fix: a per-instance cron that polls on an interval (5 s by
 * default since 2026-05-21, lowered from the original 15 s — see
 * `DEFAULT_IMPORT_RUNNING_TICK_INTERVAL_MS`) and advances the phase the
 * moment the runner's status flips to `completed`.
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

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
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
  DEFAULT_IMPORT_RUNNING_TICK_INTERVAL_MS,
  IDLE_TICK_LOG_INTERVAL_MS,
  registerImportRunningCron,
  ONBOARDING_IMPORT_RUNNING_HANDLER_NAME,
} from '@neutronai/onboarding/index.ts'
import type { ImportJobRunnerHook } from '@neutronai/onboarding/interview/engine.ts'
import type { ImportJob, ImportResult } from '@neutronai/onboarding/history-import/types.ts'
import { CronJobRegistry } from '@neutronai/cron/jobs.ts'
import { CronHandlerRegistry } from '@neutronai/cron/handlers.ts'
import { CronScheduler } from '@neutronai/cron/scheduler.ts'
import { resetLoggerStateForTests } from '@neutronai/logger'

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
      owner_slug: OWNER,
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
    registerImportRunningCron({ owner_slug: OWNER, jobs, handlers, handler })

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

    const engine = makeEngine(() => T0 + 30_000)
    const handler = buildImportRunningHandler({ engine, db, now: () => T0 + 30_000 })
    const jobs = new CronJobRegistry()
    const handlers = new CronHandlerRegistry()
    registerImportRunningCron({ owner_slug: OWNER, jobs, handlers, handler })

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
      owner_slug: OWNER,
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
      owner_slug: OWNER,
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
      owner_slug: OWNER,
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
      owner_slug: OWNER,
      phase: 'import_analysis_presented',
      phase_state_patch: {},
      advanced_at: T0 + 5_000,
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

    const r = await scheduler.fireOnce(`onboarding-import-running-${OWNER}`)
    expect(r.status).toBe('skipped')
    expect(r.detail ?? '').toContain('no_in_flight_imports')
    expect(sentPrompts.length).toBe(0)
  })
})

describe('the idle tick heartbeat is throttled, not silenced', () => {
  // WHY THIS EXISTS. The tick logged unconditionally, and on an idle install that
  // is one line every 5 s forever with `in_flight_imports=0` — ~17,280 lines/day,
  // measured on the owner's box, where it BURIED everything else: diagnosing a live
  // turn meant discovering the flood first and filtering it out. A log that hides
  // the signal sitting next to it has negative information value.
  //
  // The trap is that the cheap fix and the correct fix differ. Silencing idle ticks
  // outright would have removed the S15 liveness proof the line exists for — "the
  // line stopped appearing" is a real operator signal. So idle ticks still log,
  // just at most once per interval — the forward-clock bound. These cases pin that
  // bound, through the handler, on a forward clock. The behaviour off that path —
  // `rateLimited` emitting an extra line once a reading lands BEHIND its last stamp,
  // which errs toward more heartbeat, not less — is pinned in
  // `logger/__tests__/logger.test.ts`, on the primitive; nothing here drives a
  // decreasing clock.
  //
  // THEY DRIVE THE HANDLER AND READ THE REAL LINE, deliberately. The first version
  // of these cases called an exported predicate directly, and deleting the handler's
  // throttle call left all of them green with the flood fully restored — coverage of
  // a helper, zero coverage of the fix. Asserting on what actually reaches the sink
  // is the only shape that can see that mutation. That does couple these cases to the
  // logger's transport — the handler builds its own logger, so there is no sink to
  // inject at this seam and the assertion goes through a `console.log` spy. Deliberate:
  // coupling to the real output is what buys coverage of the real wiring.
  //
  // Each case uses its OWN slug: the rate window is keyed by subsystem × key and the
  // key carries the slug, so distinct slugs keep the cases independent of EACH OTHER.
  // That is not enough on its own — the window is PROCESS-global state that outlives a
  // test, so the reset below is what keeps the file independent of ITSELF. Without it a
  // second pass in the same process (`bun test --rerun-each 2`) reuses run 1's stamps
  // and three of these cases go red.
  beforeEach(resetLoggerStateForTests)

  const T0 = 1_700_000_000_000

  let logSpy: ReturnType<typeof spyOn<Console, 'log'>> | undefined
  let logged: string[] = []

  function captureLogLines(): void {
    logged = []
    logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]): void => {
      logged.push(args.map((a) => String(a)).join(' '))
    })
  }

  /** Only this subsystem's tick lines — the scheduler and engine log too. */
  function tickLines(): string[] {
    return logged.filter((l) => l.startsWith('[import-running-cron] event=tick '))
  }

  function tickLine(slug: string, in_flight: number): string {
    return `[import-running-cron] event=tick project=${slug} in_flight_imports=${in_flight}`
  }

  afterEach(() => {
    logSpy?.mockRestore()
    logSpy = undefined
  })

  /**
   * ONE handler plus a mutable clock, fired repeatedly — the production shape
   * (build-core-modules.ts builds the handler once at boot and the scheduler fires
   * it forever). The ctx is the same one `CronScheduler.fireOnceInner` passes.
   */
  function makeTicker(slug: string): (at: number) => Promise<void> {
    let clock = T0
    const handler = buildImportRunningHandler({
      engine: makeEngine(() => clock),
      db,
      now: () => clock,
    })
    return async (at: number): Promise<void> => {
      clock = at
      await handler({
        job_name: `onboarding-import-running-${slug}`,
        owner_slug: slug,
        fired_at: at,
      })
    }
  }

  test('the FIRST idle tick logs — a fresh process must prove it came up', async () => {
    const tick = makeTicker('idle-first')
    captureLogLines()
    await tick(T0)
    expect(tickLines()).toEqual([tickLine('idle-first', 0)])
  })

  test('the NEXT idle tick 5s later does NOT log — this is the flood being cut', async () => {
    const slug = 'idle-flood'
    const tick = makeTicker(slug)
    captureLogLines()
    await tick(T0)
    // The real sweep cadence, so this is the exact case that produced 17k lines/day.
    await tick(T0 + DEFAULT_IMPORT_RUNNING_TICK_INTERVAL_MS)
    await tick(T0 + 60_000)
    expect(tickLines()).toEqual([tickLine(slug, 0)])
  })

  test('an idle tick logs again once the interval elapses — the heartbeat SURVIVES', async () => {
    const slug = 'idle-heartbeat'
    const tick = makeTicker(slug)
    captureLogLines()
    await tick(T0)
    // One millisecond short, then exactly at the boundary: pins the comparison
    // rather than merely "some later time works".
    await tick(T0 + IDLE_TICK_LOG_INTERVAL_MS - 1)
    expect(tickLines()).toEqual([tickLine(slug, 0)])
    await tick(T0 + IDLE_TICK_LOG_INTERVAL_MS)
    expect(tickLines()).toEqual([tickLine(slug, 0), tickLine(slug, 0)])
  })

  test('the window is keyed per slug, not globally', async () => {
    const alpha = makeTicker('idle-alpha')
    const beta = makeTicker('idle-beta')
    captureLogLines()
    await alpha(T0)
    // Under one global key this second line would be suppressed, and whichever slug
    // ticked first would be the only one you could observe.
    await beta(T0 + 1_000)
    expect(tickLines()).toEqual([tickLine('idle-alpha', 0), tickLine('idle-beta', 0)])
  })

  test('two back-to-back ticks WITH WORK both log — the throttle skips the work branch', async () => {
    // The half that a blanket throttle would have broken: the throttle must apply
    // to the IDLE branch only, so a >0 count still reports on consecutive ticks.
    // The second tick lands one cadence apart, well inside the window that DOES
    // suppress an idle tick, so it fails if the throttle is applied unconditionally.
    //
    // What this does NOT assert: that ">0 for >15 min" is an alarm. It is not —
    // it stopped being one on 2026-06-18 when the import timeout became
    // progress-aware (30-min floor, deadline resets on progress inside a 5-min
    // no-progress window, 4-h ceiling; see engine-internals.ts and the handler's
    // comment). This line carries only the count, never progress, so it cannot
    // separate slow-healthy from stuck. Read >0 as "work is in flight".
    //
    // Scope note: this pins TWO ticks, one of them inside the window that would
    // have suppressed an idle tick. That is what discriminates "throttle the idle
    // branch only" from "throttle everything"; it is NOT evidence about
    // arbitrarily many ticks, so the name claims neither "EVERY" nor "never".
    const job_id = 'job-heartbeat-busy'
    await stateStore.upsert({
      user_id: 'test-user',
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
      status: 'pass1-running',
      dollars_spent: 0.4,
      pass1_chunks_done: 2,
      pass1_chunks_total: 8,
      chunks_total_known: false,
      started_at: T0 - 30_000,
    })

    const tick = makeTicker(OWNER)
    captureLogLines()
    await tick(T0)
    await tick(T0 + DEFAULT_IMPORT_RUNNING_TICK_INTERVAL_MS)
    expect(tickLines()).toEqual([tickLine(OWNER, 1), tickLine(OWNER, 1)])
  })

  test('the interval is long enough to matter and short enough to notice', async () => {
    // A guard on the constant itself: at 5s sweeps this is the difference between
    // ~17,280 and ~144 lines/day.
    //
    // Both bounds are a BUDGET, not a derivation. Upper: one interval must pass
    // before "the line stopped appearing" means anything, so keep that inside a
    // single sitting. The literal is a round quarter-hour and any nearby figure
    // would serve — it does NOT inherit from the S15 stuck-count window, which the
    // throttle cannot collide with in the first place, since the throttle applies
    // only to the idle branch and that branch reports `in_flight_imports=0` by
    // definition.
    expect(IDLE_TICK_LOG_INTERVAL_MS).toBeLessThan(15 * 60_000)
    // Lower bound — the lines/day ceiling IS the floor (it forces ≳ 2.9 min), so a
    // separate small-ms assertion would be unreachable and would read as covering
    // something it cannot fail on.
    const idleLinesPerDay = 86_400_000 / IDLE_TICK_LOG_INTERVAL_MS
    expect(idleLinesPerDay).toBeLessThan(500)
  })
})
