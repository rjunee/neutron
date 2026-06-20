/**
 * Onboarding handoff (2026-05-28 sidebar sprint) — engine fires
 * `onboardingHandoff.emitProjectSeeds(...)` on the
 * `wow_fired` → `completed` SUCCESS transition with the captured
 * primary_projects pulled from `phase_state`. Original onboarding
 * topic_id (`web:<user_id>`) stays as General. Tests verify the
 * sidebar's per-project seed emit landed via the production helper.
 *
 * Per the 2026-05-28 sidebar sprint brief — § E test contract.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import {
  InterviewEngine,
  type OnboardingHandoffHook,
  type WowDispatcherHook,
  type WowDispatcherHookInput,
  type WowDispatcherHookOutcome,
} from '../engine.ts'
import { SqliteOnboardingStateStore } from '../sqlite-state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import {
  buildOnboardingHandoffHook,
  defaultProjectIdSlugifier,
} from '../../../gateway/realmode-composer/build-onboarding-handoff.ts'
import type { ButtonChoice, ButtonPrompt } from '../../../channels/button-primitive.ts'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: SqliteOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-onboarding-handoff-'))
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

function makeWowDispatcher(): WowDispatcherHook {
  const dispatch = mock(async (_input: WowDispatcherHookInput): Promise<WowDispatcherHookOutcome> => ({
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
  }))
  return { dispatch }
}

function buildEngine(opts: {
  wowDispatcher: WowDispatcherHook
  onboardingHandoff?: OnboardingHandoffHook
}): InterviewEngine {
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
    ...(opts.onboardingHandoff !== undefined ? { onboardingHandoff: opts.onboardingHandoff } : {}),
  })
}

async function seedAndTapFire(
  engine: InterviewEngine,
  primary_projects: string[],
): Promise<void> {
  // Seed at max_oauth_offered with primary_projects_confirmed in phase_state
  // so the handoff hook has projects to walk.
  await stateStore.upsert({
    user_id: 'u-1',
    project_slug: 'casey',
    phase: 'max_oauth_offered',
    phase_state_patch: {
      user_id: 'u-1',
      topic_id: 'web:u-1',
      primary_projects_confirmed: primary_projects,
    },
  })
  const emit = await engine.advance({
    project_slug: 'casey',
    topic_id: 'web:u-1',
    user_id: 'u-1',
    channel_kind: 'app-socket',
    observed_at: 1_700_000_000_000,
  })
  expect(emit.prompt_id).toBeDefined()
  const choice: ButtonChoice = {
    prompt_id: emit.prompt_id!,
    choice_value: 'skip',
    chosen_at: 1_700_000_001_000,
    speaker_user_id: 'u-1',
    channel_kind: 'app-socket',
  }
  await engine.advance({
    project_slug: 'casey',
    topic_id: 'web:u-1',
    user_id: 'u-1',
    channel_kind: 'app-socket',
    choice,
    observed_at: 1_700_000_001_000,
  })
}

describe('Onboarding-to-General handoff (2026-05-28 sidebar sprint)', () => {
  test('engine fires onboardingHandoff exactly once with primary_projects_confirmed on wow_fired → completed', async () => {
    const handoffCalls: Array<{ primary_projects: ReadonlyArray<string>; project_slug: string; user_id: string }> = []
    const handoff: OnboardingHandoffHook = {
      emitProjectSeeds: mock(async (input) => {
        handoffCalls.push({
          primary_projects: input.primary_projects,
          project_slug: input.project_slug,
          user_id: input.user_id,
        })
      }),
    }
    const engine = buildEngine({ wowDispatcher: makeWowDispatcher(), onboardingHandoff: handoff })
    await seedAndTapFire(engine, ['Neutron', 'Acme', 'Northwind Labs'])
    expect(handoffCalls.length).toBe(1)
    expect(handoffCalls[0]!.project_slug).toBe('casey')
    expect(handoffCalls[0]!.user_id).toBe('u-1')
    expect([...handoffCalls[0]!.primary_projects]).toEqual(['Neutron', 'Acme', 'Northwind Labs'])
    // Engine still advances to completed even with the hook wired.
    const s = await stateStore.get('casey', 'u-1')
    expect(s!.phase).toBe('completed')
  })

  test('production handoff hook seeds one button_prompts row per project under web:<user_id>:<project_id>', async () => {
    const productionHandoff = buildOnboardingHandoffHook({ buttonStore })
    const engine = buildEngine({ wowDispatcher: makeWowDispatcher(), onboardingHandoff: productionHandoff })
    await seedAndTapFire(engine, ['Neutron', 'Acme', 'Northwind Labs'])
    // Query the per-project topic_ids — the seed rows must exist.
    const general = 'web:u-1'
    const topics = await buttonStore.listTopicsByUser({
      user_id_prefix: general,
      now: 1_700_000_002_000,
    })
    const projectTopics = topics.filter((t) => t.project_id !== null)
    expect(projectTopics.length).toBe(3)
    const projectIds = projectTopics.map((t) => t.project_id).sort()
    expect(projectIds).toEqual(['acme', 'neutron', 'northwind-labs'])
    // Each project topic has exactly one unresolved row (the seed) →
    // unread_count: 1.
    for (const t of projectTopics) {
      expect(t.unread_count).toBe(1)
    }
    // Body contains the original (un-slugified) name so the user sees
    // "Northwind Labs" not "northwind-labs".
    const northwindTopic = projectTopics.find((t) => t.project_id === 'northwind-labs')!
    expect(northwindTopic.last_body).toContain('Northwind Labs')
  })

  test('engine state.phase=completed is unchanged when handoff throws (best-effort)', async () => {
    const handoff: OnboardingHandoffHook = {
      emitProjectSeeds: async () => {
        throw new Error('seed boom')
      },
    }
    const engine = buildEngine({ wowDispatcher: makeWowDispatcher(), onboardingHandoff: handoff })
    await seedAndTapFire(engine, ['Neutron'])
    const s = await stateStore.get('casey', 'u-1')
    expect(s!.phase).toBe('completed')
    expect(s!.wow_fired).toBe(true)
  })

  test('handoff is NOT fired when primary_projects_confirmed is empty', async () => {
    const handoff: OnboardingHandoffHook = {
      emitProjectSeeds: mock(async () => {}),
    }
    const engine = buildEngine({ wowDispatcher: makeWowDispatcher(), onboardingHandoff: handoff })
    await seedAndTapFire(engine, [])
    expect(handoff.emitProjectSeeds).toHaveBeenCalledTimes(0)
    const s = await stateStore.get('casey', 'u-1')
    expect(s!.phase).toBe('completed')
  })

  test('original onboarding topic_id (web:<user_id>) is unchanged — General stays General', async () => {
    const productionHandoff = buildOnboardingHandoffHook({ buttonStore })
    const engine = buildEngine({ wowDispatcher: makeWowDispatcher(), onboardingHandoff: productionHandoff })
    await seedAndTapFire(engine, ['Neutron'])
    const topics = await buttonStore.listTopicsByUser({
      user_id_prefix: 'web:u-1',
      now: 1_700_000_002_000,
    })
    const general = topics.find((t) => t.project_id === null)
    expect(general).toBeDefined()
    expect(general!.topic_id).toBe('web:u-1')
    // The general topic has the onboarding prompt rows the engine emit
    // produced during the test seed.
    expect(general!.last_created_at).not.toBeNull()
  })

  test('defaultProjectIdSlugifier preserves dot/underscore/dash but lower-cases and trims', () => {
    expect(defaultProjectIdSlugifier('Northwind Labs')).toBe('northwind-labs')
    expect(defaultProjectIdSlugifier('Project X')).toBe('project-x')
    expect(defaultProjectIdSlugifier('acme')).toBe('acme')
    // Existing dots / dashes / underscores survive.
    expect(defaultProjectIdSlugifier('proj.1_alpha-beta')).toBe('proj.1_alpha-beta')
    // All-emoji name falls back to "project" sentinel.
    expect(defaultProjectIdSlugifier('🍩🍩🍩')).toBe('project')
    // Multiple separators collapse.
    expect(defaultProjectIdSlugifier('a  &  b')).toBe('a-b')
  })

  test('re-fire on wow_fired idempotent — repeat seed maps to the same idempotency key', async () => {
    const productionHandoff = buildOnboardingHandoffHook({ buttonStore })
    const engine = buildEngine({ wowDispatcher: makeWowDispatcher(), onboardingHandoff: productionHandoff })
    await seedAndTapFire(engine, ['Neutron'])
    // Manually re-emit through the helper to simulate a re-fire — the
    // idempotency key collapses onto the same row.
    await productionHandoff.emitProjectSeeds({
      project_slug: 'casey',
      user_id: 'u-1',
      primary_projects: ['Neutron'],
      // 2026-05-29 content-aware seeds sprint -- engine now threads
      // import_result through the hook. The idempotency test does not
      // need real import data; null exercises the freeform-fallback
      // shape (matches the test's intent to verify "second emit
      // collapses to the same row").
      import_result: null,
      observed_at: 1_700_000_003_000,
    })
    const topics = await buttonStore.listTopicsByUser({
      user_id_prefix: 'web:u-1',
      now: 1_700_000_004_000,
    })
    const neutron = topics.find((t) => t.project_id === 'neutron')!
    // Only ONE active unresolved seed row even after a second emit.
    expect(neutron.unread_count).toBe(1)
  })
})
