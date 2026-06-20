/**
 * 2026-05-28 sprint — engine surfaces every project the user confirmed
 * at `projects_proposed` to the wow dispatcher.
 *
 * Pre-fix the engine's `buildWowSignalsFromState` populated
 * `captured_projects` from `phase_state.captured_projects`, a field the
 * engine NEVER writes. As a result the wow-action 03-project-shells
 * fell through to `import_result.proposed_projects` only — silently
 * dropping any project the user volunteered via freeform amend at
 * `projects_proposed`. Sam walkthrough 2026-05-28: confirmed 7
 * projects, post-Max-OAuth emit showed only 5.
 *
 * This test pins the contract: when the user has confirmed at
 * `projects_proposed`, EVERY confirmed entry flows through to
 * 03-project-shells.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
import type { ButtonChoice, ButtonPrompt } from '../../../channels/button-primitive.ts'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: SqliteOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-shells-created-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new SqliteOnboardingStateStore({ db })
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeRecorder(): {
  hook: WowDispatcherHook
  calls: WowDispatcherHookInput[]
} {
  const calls: WowDispatcherHookInput[] = []
  const dispatch = async (
    input: WowDispatcherHookInput,
  ): Promise<WowDispatcherHookOutcome> => {
    calls.push(input)
    return {
      fired: [],
      skipped_no_trigger: [],
      failed: [],
      rescheduled: false,
    }
  }
  return { hook: { dispatch }, calls }
}

function buildEngine(opts: { wowDispatcher?: WowDispatcherHook } = {}): InterviewEngine {
  const sendButtonPrompt = async (input: {
    project_slug: string
    topic_id: string
    prompt: ButtonPrompt
  }) => {
    sentPrompts.push(input)
    return { message_id: `msg-${sentPrompts.length}`, was_new: true }
  }
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt,
    ...(opts.wowDispatcher !== undefined ? { wowDispatcher: opts.wowDispatcher } : {}),
  })
}

const OWNER = 'sam'
const USER = 'u-sam'
const TOPIC = 'tg:sam'

const SEVEN_PROJECTS = [
  'Topline',
  'Northwind Labs',
  'Acme',
  'Acme Holdco',
  'n8n Automation',
  'Home Assistant',
  'LA Property',
]

async function driveFireFromMaxOauth(engine: InterviewEngine): Promise<void> {
  const emit = await engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'telegram',
    observed_at: 1_700_000_000_000,
  })
  const choice: ButtonChoice = {
    prompt_id: emit.prompt_id!,
    choice_value: 'skip',
    chosen_at: 1_700_000_001_000,
    speaker_user_id: USER,
    channel_kind: 'telegram',
  }
  await engine.advance({
    project_slug: OWNER,
    topic_id: TOPIC,
    user_id: USER,
    channel_kind: 'telegram',
    choice,
    observed_at: 1_700_000_001_000,
  })
}

describe('shells-created emit — every confirmed project surfaces', () => {
  test('buildWowSignalsFromState reads primary_projects_confirmed (not the never-written captured_projects field)', async () => {
    // Seed: user reached max_oauth_offered with all 7 projects confirmed
    // at projects_proposed. Mirrors Sam's 2026-05-28 walkthrough state.
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'max_oauth_offered',
      phase_state_patch: {
        user_id: USER,
        topic_id: TOPIC,
        primary_projects_confirmed: SEVEN_PROJECTS,
      },
    })
    const rec = makeRecorder()
    const engine = buildEngine({ wowDispatcher: rec.hook })
    await driveFireFromMaxOauth(engine)
    expect(rec.calls.length).toBe(1)
    const signals = rec.calls[0]?.signals
    expect(signals).toBeDefined()
    const captured = signals!.captured_projects
    expect(captured.length).toBe(SEVEN_PROJECTS.length)
    const names = captured.map((p) => p.name).sort()
    expect(names).toEqual([...SEVEN_PROJECTS].sort())
  })

  test('regression: Home Assistant and LA Property (freeform-added concepts) are NOT dropped', async () => {
    // The original bug: import_result.proposed_projects only carries
    // company-shaped kinds, so concepts (Home Assistant / LA Property)
    // were silently dropped by the old captured_projects-via-phase_state
    // read path. Pinned here because the symptom is invisible until you
    // count the bullets.
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'max_oauth_offered',
      phase_state_patch: {
        user_id: USER,
        topic_id: TOPIC,
        primary_projects_confirmed: SEVEN_PROJECTS,
      },
    })
    const rec = makeRecorder()
    const engine = buildEngine({ wowDispatcher: rec.hook })
    await driveFireFromMaxOauth(engine)
    const signals = rec.calls[0]?.signals
    const names = signals!.captured_projects.map((p) => p.name)
    expect(names).toContain('Home Assistant')
    expect(names).toContain('LA Property')
  })

  test('empty/missing primary_projects_confirmed falls through to legacy captured_projects field', async () => {
    // Back-compat: non-onboarding callers (or pre-confirm flows) that
    // never set primary_projects_confirmed but DID write
    // phase_state.captured_projects still see their data plumbed.
    const legacyCaptured = [{ name: 'Legacy-A' }, { name: 'Legacy-B' }]
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'max_oauth_offered',
      phase_state_patch: {
        user_id: USER,
        topic_id: TOPIC,
        captured_projects: legacyCaptured,
      },
    })
    const rec = makeRecorder()
    const engine = buildEngine({ wowDispatcher: rec.hook })
    await driveFireFromMaxOauth(engine)
    const signals = rec.calls[0]?.signals
    const names = signals!.captured_projects.map((p) => p.name)
    expect(names).toEqual(['Legacy-A', 'Legacy-B'])
  })

  test('deliberate empty confirm (skip-ahead) flags projects_confirmed=true so action skips import fallback', async () => {
    // Codex review pickup: `PROJECTS_PROPOSED_SKIP_AHEAD` writes
    // `primary_projects_confirmed: []` (user explicitly declined the
    // import-derived list). Pre-fix `captured_projects.length === 0`
    // looked identical to "never confirmed", so 03-project-shells
    // would fall back to `import_result.proposed_projects` and create
    // shells for the projects the user just declined. The engine now
    // exposes `projects_confirmed: true` whenever the field was written
    // — empty array included — so the action can short-circuit.
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'max_oauth_offered',
      phase_state_patch: {
        user_id: USER,
        topic_id: TOPIC,
        primary_projects_confirmed: [],
      },
    })
    const rec = makeRecorder()
    const engine = buildEngine({ wowDispatcher: rec.hook })
    await driveFireFromMaxOauth(engine)
    const signals = rec.calls[0]?.signals
    expect(signals).toBeDefined()
    expect(signals!.captured_projects.length).toBe(0)
    expect(signals!.projects_confirmed).toBe(true)
  })

  test('never-confirmed project flags projects_confirmed=false (legacy fallback still allowed)', async () => {
    // No `primary_projects_confirmed` ever written → action MAY fall
    // back to `import_result.proposed_projects` per the legacy
    // contract. The signal carries that information explicitly so the
    // dispatcher can route correctly.
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'max_oauth_offered',
      phase_state_patch: {
        user_id: USER,
        topic_id: TOPIC,
      },
    })
    const rec = makeRecorder()
    const engine = buildEngine({ wowDispatcher: rec.hook })
    await driveFireFromMaxOauth(engine)
    const signals = rec.calls[0]?.signals
    expect(signals).toBeDefined()
    expect(signals!.projects_confirmed).toBe(false)
  })

  test('confirmed list takes precedence over a stale captured_projects field', async () => {
    // If BOTH are present, primary_projects_confirmed wins. The
    // confirmed list is the post-amend authoritative answer; any value
    // sitting in `captured_projects` is older and may have been
    // superseded by a freeform "drop X" reply.
    await stateStore.upsert({
      user_id: USER,
      project_slug: OWNER,
      phase: 'max_oauth_offered',
      phase_state_patch: {
        user_id: USER,
        topic_id: TOPIC,
        primary_projects_confirmed: ['Confirmed-A'],
        captured_projects: [{ name: 'Stale-only' }],
      },
    })
    const rec = makeRecorder()
    const engine = buildEngine({ wowDispatcher: rec.hook })
    await driveFireFromMaxOauth(engine)
    const signals = rec.calls[0]?.signals
    const names = signals!.captured_projects.map((p) => p.name)
    expect(names).toEqual(['Confirmed-A'])
  })
})
