/**
 * Shared test helpers for the 2026-05-28 final-handoff sprint tests.
 * Mirrors the wow-fired.test.ts shape (ProjectDb + migrations + button
 * store + state store + transcript writer) so every final-handoff test
 * runs against a real persistence layer.
 *
 * Each test file imports the `setup(opts?)` factory and a couple of
 * convenience drivers (`tapFireFromMaxOauth` etc.) that walk the engine
 * to `completed` and surface the active handoff prompt's `prompt_id`.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mock } from 'bun:test'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import {
  InterviewEngine,
  type WowDispatcherHook,
  type WowDispatcherHookInput,
  type WowDispatcherHookOutcome,
} from '../engine.ts'
import { SqliteOnboardingStateStore } from '../sqlite-state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import type {
  ButtonPrompt,
  ChannelKindForButton,
} from '../../../channels/button-primitive.ts'

export interface SentPromptRecord {
  project_slug: string
  topic_id: string
  prompt: ButtonPrompt
}

export interface DispatchRecorder {
  hook: WowDispatcherHook
  calls: WowDispatcherHookInput[]
  dispatch: (input: WowDispatcherHookInput) => Promise<WowDispatcherHookOutcome>
}

export function makeDispatchRecorder(opts: {
  outcome?: WowDispatcherHookOutcome
  throws?: unknown
} = {}): DispatchRecorder {
  const calls: WowDispatcherHookInput[] = []
  const dispatch = mock(
    async (input: WowDispatcherHookInput): Promise<WowDispatcherHookOutcome> => {
      calls.push(input)
      if (opts.throws !== undefined) throw opts.throws
      return (
        opts.outcome ?? {
          fired: ['01-first-week-brief', '07-overnight-pass'],
          skipped_no_trigger: [
            '02-lifestyle-reminders',
            '03-project-shells',
            '04-overdue-task',
            '05-followup-email-draft',
            '06-interest-check-in',
          ],
          failed: [],
          rescheduled: false,
        }
      )
    },
  )
  const hook: WowDispatcherHook = { dispatch }
  return { hook, calls, dispatch }
}

export interface FinalHandoffTestSetup {
  tmp: string
  db: ProjectDb
  buttonStore: ButtonStore
  stateStore: SqliteOnboardingStateStore
  transcript: TranscriptWriter
  sentPrompts: SentPromptRecord[]
  cleanup(): void
}

export function setupFinalHandoffTest(): FinalHandoffTestSetup {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-final-handoff-'))
  const db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const buttonStore = new ButtonStore({ db })
  const stateStore = new SqliteOnboardingStateStore({ db })
  const transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  const sentPrompts: SentPromptRecord[] = []
  const cleanup = (): void => {
    db.close()
    rmSync(tmp, { recursive: true, force: true })
  }
  return { tmp, db, buttonStore, stateStore, transcript, sentPrompts, cleanup }
}

export interface BuildEngineOpts {
  setup: FinalHandoffTestSetup
  wowDispatcher?: WowDispatcherHook
  mintTelegramBindToken?: (input: {
    project_slug: string
    user_id: string
  }) => Promise<string | null>
  telegramBotUsername?: string
  /**
   * Mobile-app page URL injected into the engine. Defaults to a non-empty
   * test host so the mobile-app follow-up renders (the env-derived
   * `MOBILE_APP_URL` is '' under the test harness). Pass `''` explicitly to
   * exercise the Open-default suppression branch.
   */
  mobileAppUrl?: string
}

/** Default mobile-app URL used by the test harness (non-empty). */
export const TEST_MOBILE_APP_URL = 'https://app.test.neutron.example/mobile'

export function buildFinalHandoffEngine(opts: BuildEngineOpts): InterviewEngine {
  const sendButtonPrompt = async (input: SentPromptRecord) => {
    opts.setup.sentPrompts.push(input)
    return { message_id: `msg-${opts.setup.sentPrompts.length}`, was_new: true }
  }
  const deps: ConstructorParameters<typeof InterviewEngine>[0] = {
    buttonStore: opts.setup.buttonStore,
    stateStore: opts.setup.stateStore,
    transcript: opts.setup.transcript,
    sendButtonPrompt,
  }
  if (opts.wowDispatcher !== undefined) deps.wowDispatcher = opts.wowDispatcher
  if (opts.mintTelegramBindToken !== undefined)
    deps.mintTelegramBindToken = opts.mintTelegramBindToken
  if (opts.telegramBotUsername !== undefined)
    deps.telegramBotUsername = opts.telegramBotUsername
  deps.mobileAppUrl =
    opts.mobileAppUrl !== undefined ? opts.mobileAppUrl : TEST_MOBILE_APP_URL
  return new InterviewEngine(deps)
}

/**
 * Drive an owner from `max_oauth_offered` → tap "skip" → `wow_fired` →
 * dispatcher resolves → `completed`. Returns the latest emitted prompt
 * so the caller can assert against the final-handoff body / buttons.
 */
export interface WalkToCompletedInput {
  setup: FinalHandoffTestSetup
  engine: InterviewEngine
  project_slug: string
  user_id: string
  topic_id: string
  channel_kind: ChannelKindForButton
  observed_at?: number
  seed_phase_state?: Record<string, unknown>
}

export async function walkToCompleted(input: WalkToCompletedInput): Promise<{
  prompt: ButtonPrompt
}> {
  const seed_state: Record<string, unknown> = {
    user_id: input.user_id,
    topic_id: input.topic_id,
    user_first_name: 'Sam',
    primary_projects_confirmed: ['Topline', 'Northwind Labs', 'Acme'],
    ...(input.seed_phase_state ?? {}),
  }
  await input.setup.stateStore.upsert({
    user_id: input.user_id,
    project_slug: input.project_slug,
    phase: 'max_oauth_offered',
    phase_state_patch: seed_state,
  })
  const t0 = input.observed_at ?? 1_700_000_000_000
  const emit = await input.engine.advance({
    project_slug: input.project_slug,
    topic_id: input.topic_id,
    user_id: input.user_id,
    channel_kind: input.channel_kind,
    observed_at: t0,
  })
  if (emit.prompt_id === undefined) {
    throw new Error('walkToCompleted: max_oauth_offered did not emit a prompt')
  }
  await input.engine.advance({
    project_slug: input.project_slug,
    topic_id: input.topic_id,
    user_id: input.user_id,
    channel_kind: input.channel_kind,
    choice: {
      prompt_id: emit.prompt_id,
      choice_value: 'skip',
      chosen_at: t0 + 1_000,
      speaker_user_id: input.user_id,
      channel_kind: input.channel_kind,
    },
    observed_at: t0 + 1_000,
  })
  const last = input.setup.sentPrompts[input.setup.sentPrompts.length - 1]
  if (last === undefined) {
    throw new Error('walkToCompleted: no final-handoff prompt was emitted')
  }
  return { prompt: last.prompt }
}

export async function tapHandoffChoice(input: {
  setup: FinalHandoffTestSetup
  engine: InterviewEngine
  project_slug: string
  user_id: string
  topic_id: string
  channel_kind: ChannelKindForButton
  prompt_id: string
  choice_value: string
  observed_at: number
}): Promise<void> {
  await input.engine.advance({
    project_slug: input.project_slug,
    topic_id: input.topic_id,
    user_id: input.user_id,
    channel_kind: input.channel_kind,
    choice: {
      prompt_id: input.prompt_id,
      choice_value: input.choice_value,
      chosen_at: input.observed_at,
      speaker_user_id: input.user_id,
      channel_kind: input.channel_kind,
    },
    observed_at: input.observed_at,
  })
}

export async function sendHandoffFreeform(input: {
  setup: FinalHandoffTestSetup
  engine: InterviewEngine
  project_slug: string
  user_id: string
  topic_id: string
  channel_kind: ChannelKindForButton
  text: string
  observed_at: number
}): Promise<void> {
  await input.engine.advance({
    project_slug: input.project_slug,
    topic_id: input.topic_id,
    user_id: input.user_id,
    channel_kind: input.channel_kind,
    freeform_text: input.text,
    observed_at: input.observed_at,
  })
}
