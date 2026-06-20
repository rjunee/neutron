/**
 * ISSUES #2 (2026-05-19) — engine.acceptChoice receives user_id and
 * routes to the correct (project_slug, user_id) row.
 *
 * Onboarding state isolation spec § 2.4 + § 6.1 #4.
 *
 * Pre-fix: `acceptChoice({project_slug, choice})` had no user_id, so a
 * single instance could only ever have one user; a button tap from a
 * second user would either no-op (active_prompt_id mismatch) or
 * silently advance the first user's row.
 *
 * Post-fix: `acceptChoice({project_slug, user_id, choice})` reads the
 * correct row by composite PK; only that user's row advances.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import { InterviewEngine } from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'

let tmp: string
let db: ProjectDb
let stateStore: InMemoryOnboardingStateStore
let engine: InterviewEngine
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-accept-uid-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  const transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
  engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
  })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

test('acceptChoice routes to the calling user, not the project-default user', async () => {
  // Two users on the same instance, each starts independently.
  const startA = await engine.start({
    project_slug: 't1',
    topic_id: 'web:a',
    user_id: 'u-A',
    signup_via: 'web',
  })
  const startB = await engine.start({
    project_slug: 't1',
    topic_id: 'web:b',
    user_id: 'u-B',
    signup_via: 'web',
  })
  // Both users have their own active prompt.
  expect(startA.was_new).toBe(true)
  expect(startB.was_new).toBe(true)

  // User A taps a choice on User A's prompt.
  const choiceA = sentPrompts.find((p) => p.topic_id === 'web:a')!.prompt
  await engine.acceptChoice({
    project_slug: 't1',
    user_id: 'u-A',
    choice: {
      prompt_id: choiceA.prompt_id,
      choice_value: '__freeform__',
      freeform_text: 'My name is Alice',
      chosen_at: Date.now(),
      speaker_user_id: 'u-A',
      channel_kind: 'app-socket',
    },
  })

  // User A's row advanced past signup; User B's row is still on signup.
  const a = await stateStore.get('t1', 'u-A')
  const b = await stateStore.get('t1', 'u-B')
  expect(a?.phase, 'userA advanced').not.toBe('signup')
  expect(b?.phase, 'userB untouched').toBe('signup')
})

test('acceptChoice with a wrong-user prompt_id is a no-op (stale callback)', async () => {
  const startA = await engine.start({
    project_slug: 't1',
    topic_id: 'web:a',
    user_id: 'u-A',
    signup_via: 'web',
  })
  await engine.start({
    project_slug: 't1',
    topic_id: 'web:b',
    user_id: 'u-B',
    signup_via: 'web',
  })

  // Adversary: User B tries to resolve User A's prompt.
  void startA
  const choiceA = sentPrompts.find((p) => p.topic_id === 'web:a')!.prompt
  const result = await engine.acceptChoice({
    project_slug: 't1',
    user_id: 'u-B', // mismatched user
    choice: {
      prompt_id: choiceA.prompt_id,
      choice_value: '__freeform__',
      freeform_text: 'pwn',
      chosen_at: Date.now(),
      speaker_user_id: 'u-B',
      channel_kind: 'app-socket',
    },
  })

  // User B's row has its own active_prompt_id; the prompt_id from User
  // A's row doesn't match B's active_prompt_id, so acceptChoice returns
  // advanced=false and User A's row is untouched.
  expect(result.advanced).toBe(false)
  const a = await stateStore.get('t1', 'u-A')
  expect(a?.phase, 'userA stays on signup; mismatched call was a no-op').toBe('signup')
})
