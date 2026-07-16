/**
 * Integration test — S15 (2026-05-17): import-running cron actually
 * fires when the production composer boots.
 *
 * Backstop for the regression S15 closes. Pre-S15 every cron module's
 * docblock claimed "the cron starts ticking on the next
 * `CronScheduler.start()`" — but no production code path EVER called
 * `start()`. The cronModule in `gateway/composition.ts` constructed the
 * scheduler; the `onboarding-telemetry` module registered the import-
 * running job + handler against the shared registries; and then the
 * setInterval mesh was simply never wired. Result on prod (v0.1.36):
 * `cron_state` stays empty for every instance; import_running strands the
 * user mid-onboarding because pollImportRunningTick never runs.
 *
 * Spec-vs-current diff (mirrors the S15 brief):
 *
 *   SPEC § 3.4 + § S5: import_running cron-tick polls every 15s and
 *   advances phase when ImportJobRunner reaches a terminal status.
 *
 *   CURRENT WIRING (pre-S15): handler + job registered, but scheduler
 *   never started. cron_state empty.
 *
 *   GAP: scheduler.start() never called after compose().
 *
 *   THIS SPRINT FIXES: gap above.
 *
 * Assertions:
 *   1. `composeProductionGraph` starts the scheduler and the
 *      import-running job ticks WITHOUT any manual `fireOnce` call.
 *   2. After one real tick fires against a seeded `import_running` row,
 *      `cron_state.onboarding-import-running-<slug>` has a row with
 *      `last_run_status='ok'`.
 *   3. The engine's phase advances to `import_analysis_presented` as a
 *      direct side effect of the autonomous tick.
 *
 * Test cadence: 200 ms tick + 300 ms wait window. setInterval(cb, ms)
 * fires at +ms, +2ms, ... — at 300 ms only the first tick has landed.
 * Keeping the window to one tick is critical: the cron handler returns
 * `ok` ONLY on the tick that detects the terminal status; subsequent
 * ticks (with the phase already advanced past `import_running`) return
 * `skipped`, which would overwrite `cron_state.last_run_status` and
 * mask the 'ok' that proves the advance. Production 15 s cadence is
 * exercised by other tests; this one pins the boot-shell wiring.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import {
  InterviewEngine,
  SqliteOnboardingStateStore,
  TranscriptWriter,
} from '@neutronai/onboarding/index.ts'
import type { ImportJobRunnerHook } from '@neutronai/onboarding/interview/engine.ts'
import type { ImportJob, ImportResult } from '@neutronai/onboarding/history-import/types.ts'
import { CronStateStore } from '@neutronai/cron/state.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'

const OWNER = 'owner-s15'
const TOPIC = 'chat-s15'
const USER = 'u-s15'

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
    conversation_count: 12,
    entities: [],
    topics: [],
    proposed_projects: [
      { name: 'Project A', rationale: 'r', suggested_topics: [] },
      { name: 'Project B', rationale: 'r', suggested_topics: [] },
    ],
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {},
    facts: {},
    inferred_interests: [{ name: 'meditation', basis: 'corpus signal' }],
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-s15-cron-boot-'))
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

describe('S15 — composeProductionGraph boots the cron scheduler', () => {
  test('autonomous tick advances import_running → import_analysis_presented and populates cron_state', async () => {
    const T0 = 1_700_000_000_000
    // Seed phase=import_running with a runner already reporting
    // `completed`. The very first scheduler tick MUST detect the
    // terminal status and route through pollImportRunningAndAdvance →
    // advanceFromImportRunningOnComplete → phase moves to
    // `import_analysis_presented`.
    const job_id = 'job-s15-finishes'
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
      status: 'completed',
      dollars_spent: 1.2,
      pass1_chunks_done: 4,
      pass1_chunks_total: 4,
      chunks_total_known: false,
      started_at: T0 - 10_000,
      completed_at: T0 + 5_000,
      result: completedResult(),
    })

    const engine = makeEngine(() => T0 + 10_000)
    const graph = await composeProductionGraph({
      db,
      project_slug: OWNER,
      topic_handler: async () => {},
      approval_notifier: { notify: async () => undefined },
      watchdog_notifier: { notify: async () => undefined },
      reminder_dispatcher: { dispatch: async () => undefined },
      heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
      onboarding_import_running_cron: {
        engine,
        // 50 ms tick — tests must not block on the 15 s production
        // cadence. The first setInterval fire lands at +interval_ms;
        // the wait window below clears it with margin.
        interval_ms: 200,
      },
    })

    try {
      // Wait for the first autonomous tick. NO manual fireOnce — the
      // bug S15 fixes is exactly that the scheduler must tick on its
      // own. 300 ms covers exactly one 200 ms tick window so the
      // `cron_state.last_run_status` we read below reflects the FIRST
      // tick (which advances the phase and returns 'ok') rather than
      // a later 'skipped' tick that would mask the proof.
      await new Promise((resolve) => setTimeout(resolve, 300))

      // Assertion #1 — phase advanced as a side effect of the
      // autonomous tick. THE bug fix: pre-S15 phase stayed at
      // import_running forever because the scheduler never started.
      const after = await stateStore.get(OWNER, 'test-user')
      expect(after).not.toBeNull()
      expect(after!.phase).toBe('import_analysis_presented')
      expect(after!.phase_state['import_result']).toBeDefined()

      // Assertion #2 — cron_state row exists with last_run_status='ok'.
      // Pre-S15 this row never existed for any cron job on any instance.
      const cronStateStore = new CronStateStore(db)
      const row = cronStateStore.get(
        `onboarding-import-running-${OWNER}`,
        OWNER,
      )
      expect(row).not.toBeNull()
      expect(row!.last_run_status).toBe('ok')
      expect(row!.last_run_at).toBeGreaterThan(0)
    } finally {
      await graph.shutdown()
    }
  })

  test('autonomous tick is a silent no-op when no in-flight imports exist (cron_state still records skipped)', async () => {
    // No onboarding_state row at all. The cron's SQL pre-filter
    // returns zero rows; the handler returns `skipped`. The scheduler
    // still records the tick into cron_state — proof the mesh is live.
    const engine = makeEngine(() => Date.now())
    const graph = await composeProductionGraph({
      db,
      project_slug: OWNER,
      topic_handler: async () => {},
      approval_notifier: { notify: async () => undefined },
      watchdog_notifier: { notify: async () => undefined },
      reminder_dispatcher: { dispatch: async () => undefined },
      heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
      onboarding_import_running_cron: {
        engine,
        interval_ms: 200,
      },
    })

    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      const cronStateStore = new CronStateStore(db)
      const row = cronStateStore.get(
        `onboarding-import-running-${OWNER}`,
        OWNER,
      )
      expect(row).not.toBeNull()
      expect(row!.last_run_status).toBe('skipped')
      // Zero channel sends — silent no-op surface.
      expect(sentPrompts.length).toBe(0)
    } finally {
      await graph.shutdown()
    }
  })
})
