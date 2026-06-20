/**
 * Wow-fired hang-resilience (2026-06-10 — live prod incident, instance
 * t-33333333).
 *
 * Sam's real signup hung FOREVER at `wow_fired` ("Setting up your first
 * week… One moment…"): a Day-1 action's `run(...)` never resolved (no
 * per-action timeout existed), so `WowDispatcher.dispatch` awaited
 * forever, `dispatchWowAndAdvance` never advanced to `completed`, and —
 * because the action HUNG rather than THREW — the retry/skip fallback
 * path was never reached either. The user saw an infinite typing
 * indicator.
 *
 * Two properties pinned here (REPRODUCE-BEFORE-FIX per the sprint
 * brief — both tests FAIL on pre-fix main):
 *
 *   1. HANG → HANDLED: an action whose `run` never resolves is
 *      converted to a `failed[]` entry (reason 'timeout') by the
 *      action-runner's per-action timeout, and the engine still
 *      reaches `phase=completed` within bounded wall-clock.
 *
 *   2. FAILED ≠ BLOCKED: Day-1 actions are best-effort. Even when
 *      `01-first-week-brief` lands in `failed[]`, the engine ALWAYS
 *      advances to `completed` and emits the final-handoff guide
 *      (recording the failure in `wow_report.failed`) instead of
 *      stranding the user at `wow_fired`. This deliberately supersedes
 *      the T2-r3 (2026-05-13) "brief failure → stay at wow_fired"
 *      policy: since GAP3 (2026-06-09) the final-handoff guide is the
 *      guaranteed terminal user-visible message, so completing with a
 *      failed brief no longer leaves the user with nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import { ReminderStore } from '../../../reminders/store.ts'
import { CronJobRegistry } from '../../../cron/jobs.ts'
import { CronStateStore } from '../../../cron/state.ts'
import {
  InterviewEngine,
  type WowDispatcherHook,
  type WowDispatcherHookInput,
  type WowDispatcherHookOutcome,
} from '../engine.ts'
import { SqliteOnboardingStateStore } from '../sqlite-state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import { FINAL_HANDOFF_METADATA_TAG } from '../final-handoff-prompts.ts'
import {
  ActionRunner,
  WowDispatcher,
  WowTelemetry,
  type BriefSubstrate,
  type WowChannelAdapter,
} from '../../wow-moment/index.ts'
import type { ButtonChoice, ButtonPrompt } from '../../../channels/button-primitive.ts'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: SqliteOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-wow-hang-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new SqliteOnboardingStateStore({ db })
  transcript = new TranscriptWriter({ path: join(tmp, 'persona', 'onboarding-transcript.jsonl') })
  sentPrompts = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function buildEngine(opts: { wowDispatcher: WowDispatcherHook }): InterviewEngine {
  const sendButtonPrompt = async (input: { project_slug: string; topic_id: string; prompt: ButtonPrompt }) => {
    sentPrompts.push(input)
    return { message_id: `msg-${sentPrompts.length}`, was_new: true }
  }
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt,
    wowDispatcher: opts.wowDispatcher,
  })
}

/** Drive max_oauth_offered → tap "skip" so the engine enters wow_fired. */
async function tapFireFromMaxOauth(engine: InterviewEngine): Promise<void> {
  await stateStore.upsert({
    user_id: 'u-1',
    project_slug: 'casey',
    phase: 'max_oauth_offered',
    phase_state_patch: { user_id: 'u-1', topic_id: 'tg:1' },
  })
  const emit = await engine.advance({
    project_slug: 'casey',
    topic_id: 'tg:1',
    user_id: 'u-1',
    channel_kind: 'telegram',
    observed_at: 1_700_000_000_000,
  })
  expect(emit.prompt_id).toBeDefined()
  const choice: ButtonChoice = {
    prompt_id: emit.prompt_id!,
    choice_value: 'skip',
    chosen_at: 1_700_000_001_000,
    speaker_user_id: 'u-1',
    channel_kind: 'telegram',
  }
  await engine.advance({
    project_slug: 'casey',
    topic_id: 'tg:1',
    user_id: 'u-1',
    channel_kind: 'telegram',
    choice,
    observed_at: 1_700_000_001_000,
  })
}

/**
 * A REAL WowDispatcher (real catalogue, real action-runner) whose
 * action-01 substrate NEVER resolves — the exact prod failure shape.
 * The hook mirrors `buildWowDispatcherHook`'s outcome mapping.
 */
function buildHangingDispatcherHook(opts: { action_timeout_ms: number }): WowDispatcherHook {
  const telemetry = new WowTelemetry({ db })
  const noSleep = async (_ms: number): Promise<void> => {}
  const runner = new ActionRunner({
    telemetry,
    sleep: noSleep,
    action_timeout_ms: opts.action_timeout_ms,
  })
  const dispatcher = new WowDispatcher({
    telemetry,
    runner,
    inter_action_pause_ms: 0,
    sleep: noSleep,
  })
  const hangingSubstrate: BriefSubstrate = {
    // The prod hang: a CC-spawn that never returns. No resolve, no
    // reject — the promise stays pending forever.
    composeBrief: () => new Promise(() => {}),
  }
  const channel: WowChannelAdapter = {
    emitPrompt: async () => ({ prompt_id: `p-${Math.random().toString(36).slice(2)}` }),
    sendText: async () => ({ message_id: 'm-1' }),
  }
  return {
    async dispatch(hookInput: WowDispatcherHookInput): Promise<WowDispatcherHookOutcome> {
      const outcome = await dispatcher.dispatch({
        project_slug: hookInput.project_slug,
        topic_id: hookInput.topic_id,
        owner_home: tmp,
        interview: hookInput.signals.interview,
        import_result: hookInput.signals.import_result,
        rituals: [...hookInput.signals.rituals],
        captured_projects: [...hookInput.signals.captured_projects],
        projects_confirmed: hookInput.signals.projects_confirmed,
        contemplative_keywords: [...hookInput.signals.contemplative_keywords],
        stalled_threads: [...hookInput.signals.stalled_threads],
        gmail_scopes: hookInput.signals.gmail_scopes,
        reminders: new ReminderStore(db),
        cron_jobs: new CronJobRegistry(),
        cron_state: new CronStateStore(db),
        db,
        channel,
        gmail: null,
        substrate: hangingSubstrate,
      })
      return {
        fired: outcome.fired,
        skipped_no_trigger: outcome.skipped_no_trigger,
        failed: outcome.failed.map((f) => ({ ...f })),
        rescheduled: outcome.rescheduled,
      }
    },
  }
}

describe('wow_fired hang-resilience (prod incident 2026-06-10, t-33333333)', () => {
  test(
    'a Day-1 action whose run() NEVER resolves is timed out and the engine still reaches completed (no infinite spinner)',
    async () => {
      const hook = buildHangingDispatcherHook({ action_timeout_ms: 250 })
      const engine = buildEngine({ wowDispatcher: hook })
      await tapFireFromMaxOauth(engine)

      const s = await stateStore.get('casey', 'u-1')
      expect(s).not.toBeNull()
      // The engine MUST NOT be stranded at wow_fired.
      expect(s!.phase).toBe('completed')
      expect(s!.completed_at).not.toBeNull()
      // The hung brief is recorded as a timeout failure, not silently
      // dropped.
      const report = s!.phase_state['wow_report'] as Record<string, unknown>
      expect(report).toBeDefined()
      const failed = report['failed'] as Array<{ action_id: string; reason: string }>
      const brief = failed.find((f) => f.action_id === '01-first-week-brief')
      expect(brief).toBeDefined()
      expect(brief!.reason).toBe('timeout')
      // Action 07 (overnight pass) fired before the hang — survives in
      // the report.
      const fired = report['fired'] as string[]
      expect(fired).toContain('07-overnight-pass')
    },
    10_000,
  )

  test(
    'failed Day-1 actions are best-effort: brief in failed[] → engine STILL advances to completed and emits the final-handoff guide',
    async () => {
      const hook: WowDispatcherHook = {
        dispatch: async (_input: WowDispatcherHookInput): Promise<WowDispatcherHookOutcome> => ({
          fired: ['07-overnight-pass'],
          skipped_no_trigger: [
            '02-lifestyle-reminders',
            '03-project-shells',
            '04-overdue-task',
            '05-followup-email-draft',
            '06-interest-check-in',
          ],
          failed: [{ action_id: '01-first-week-brief', reason: 'timeout' }],
          rescheduled: false,
        }),
      }
      const engine = buildEngine({ wowDispatcher: hook })
      await tapFireFromMaxOauth(engine)

      const s = await stateStore.get('casey', 'u-1')
      expect(s).not.toBeNull()
      expect(s!.phase).toBe('completed')
      expect(s!.completed_at).not.toBeNull()
      const report = s!.phase_state['wow_report'] as Record<string, unknown>
      expect(report).toBeDefined()
      const failed = report['failed'] as Array<{ action_id: string; reason: string }>
      expect(failed.some((f) => f.action_id === '01-first-week-brief' && f.reason === 'timeout')).toBe(true)
      // The final-handoff guide is the terminal message — the user is
      // never left staring at a spinner or a dead phase.
      const last = sentPrompts[sentPrompts.length - 1]
      expect(last).toBeDefined()
      const metadata = (last!.prompt as unknown as { metadata?: Record<string, unknown> }).metadata
      expect(metadata?.[FINAL_HANDOFF_METADATA_TAG]).toBe(true)
    },
    10_000,
  )
})
