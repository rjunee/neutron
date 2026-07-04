/**
 * K4a (refactor) — advance-driven parity for the DELETED `acceptChoice`.
 *
 * `InterviewEngine.acceptChoice` (the legacy single-prompt signup entry) had
 * ZERO production callers — the chat-bridge drives `engine.advance(...)` with
 * a `ButtonChoice` on `AdvanceInput.choice` for every tap (gateway/http/
 * chat-bridge.ts button_choice branch). This file ports the still-meaningful
 * assertions acceptChoice's tests covered onto the PRODUCTION `advance` path
 * so coverage is not lost by the deletion:
 *
 *   1. a button choice on the signup prompt advances the phase + writes the
 *      user's transcript line (ported from engine-skeleton.test.ts
 *      "acceptChoice advances past signup and writes user transcript line").
 *   2. a choice routes to the calling (project_slug, user_id) row only, never
 *      another user's row (ported from engine-accept-choice-user-id.test.ts).
 *   3. a wrong-user / stale prompt_id choice is a no-op — the adversary
 *      cannot advance another user's row (ported from the same file).
 *
 * Per-user routing + stale-tap rejection are onboarding-state-isolation
 * guarantees (spec § 2.4 + § 6.1 #4); they were only exercised via
 * acceptChoice, so they are re-pinned here through advance.
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
let transcript: TranscriptWriter
let engine: InterviewEngine
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-advance-parity-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  const buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({
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

async function activePromptId(project_slug: string, user_id: string): Promise<string> {
  const state = await stateStore.get(project_slug, user_id)
  const ap = state?.phase_state.active_prompt_id
  if (typeof ap !== 'string') throw new Error('no active_prompt_id on state')
  return ap
}

test('advance with a button choice on the signup prompt advances the phase + writes the user transcript line', async () => {
  const start = await engine.start({
    project_slug: 't1',
    topic_id: 'topic-1',
    user_id: 'u-1',
    signup_via: 'telegram',
  })
  const out = await engine.advance({
    project_slug: 't1',
    user_id: 'u-1',
    topic_id: 'topic-1',
    channel_kind: 'telegram',
    choice: {
      prompt_id: start.prompt_id,
      choice_value: 'use-telegram-name',
      chosen_at: 1234,
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    },
  })
  expect(out.outcome).toBe('advanced')
  // signup → instance_provisioned → (AUTO_SKIP walker) → ai_substrate_offered,
  // the first interactive phase — identical to the retired acceptChoice walk.
  expect(out.state?.phase).toBe('ai_substrate_offered')
  const userLines = transcript.readAll().filter((e) => e.role === 'user')
  expect(userLines.length).toBe(1)
  expect(userLines[0]?.button_choice).toBe('use-telegram-name')
})

test('KNOWN-DIVERGENCE: `__cancel__` on the signup prompt currently ADVANCES via the live advance path', async () => {
  // Characterization test (K4 adjudication of Codex r-review). `__cancel__` is a
  // NON_ADVANCING_CHOICE_VALUES sentinel (engine-internals.ts) AND is NOT in the
  // gateway's FORBIDDEN_INBOUND_VALUES ({ __freeform__, __timeout__ } —
  // channels/adapters/app-socket/render-button-prompt.ts:64), so an app-socket
  // `button_choice` carrying it passes chat-bridge (chat-bridge.ts:1643) and
  // reaches engine.advance → consumeChoice. consumeChoice's signup generic route
  // applies NO NON_ADVANCING guard (the guards live only in
  // consumeWowFallbackChoice + handleFinalHandoffOnCompleted), so the cancel
  // sentinel WRONGLY advances signup → instance_provisioned → ai_substrate_offered.
  //
  // This is a PRE-EXISTING latent bug, NOT a K4 regression: the deleted
  // `acceptChoice` (which DID guard NON_ADVANCING) had ZERO production callers —
  // the live tap path was always advance→consumeChoice, both before and after
  // this deletion, so the observable behavior is unchanged by K4. We pin CURRENT
  // behavior here so a dedicated fix unit (port the guard into consumeChoice's
  // signup route) flips this assertion from 'advanced' to a no-op. Codex r-review
  // correctly flagged the coverage gap; the fix is out of scope for a pure
  // deletion. See the wave-1 known-divergence log.
  const start = await engine.start({
    project_slug: 't1',
    topic_id: 'topic-1',
    user_id: 'u-1',
    signup_via: 'telegram',
  })
  const out = await engine.advance({
    project_slug: 't1',
    user_id: 'u-1',
    topic_id: 'topic-1',
    channel_kind: 'app-socket',
    choice: {
      prompt_id: start.prompt_id,
      choice_value: '__cancel__',
      chosen_at: 1234,
      speaker_user_id: 'u-1',
      channel_kind: 'app-socket',
    },
  })
  // CURRENT (buggy) behavior — pinned, not endorsed. Flip to 'no_active_prompt'
  // + phase 'signup' when the guard is ported in the dedicated fix unit.
  expect(out.outcome).toBe('advanced')
  expect(out.state?.phase).toBe('ai_substrate_offered')
})

test('advance routes a choice to the calling user, not the project-default user', async () => {
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
  expect(startA.was_new).toBe(true)
  expect(startB.was_new).toBe(true)

  // User A taps a choice on User A's own prompt.
  const apA = await activePromptId('t1', 'u-A')
  await engine.advance({
    project_slug: 't1',
    user_id: 'u-A',
    topic_id: 'web:a',
    channel_kind: 'app-socket',
    choice: {
      prompt_id: apA,
      choice_value: '__freeform__',
      freeform_text: 'My name is Alice',
      chosen_at: Date.now(),
      speaker_user_id: 'u-A',
      channel_kind: 'app-socket',
    },
  })

  // User A's row advanced past signup; User B's row is untouched.
  const a = await stateStore.get('t1', 'u-A')
  const b = await stateStore.get('t1', 'u-B')
  expect(a?.phase, 'userA advanced').not.toBe('signup')
  expect(b?.phase, 'userB untouched').toBe('signup')
})

test('advance with a wrong-user prompt_id is a no-op (stale / adversarial callback)', async () => {
  await engine.start({
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

  // Adversary: User B submits User A's prompt_id. It does not match B's own
  // active_prompt_id, so advance never consumes it as a choice — neither row
  // advances.
  const apA = await activePromptId('t1', 'u-A')
  await engine.advance({
    project_slug: 't1',
    user_id: 'u-B',
    topic_id: 'web:b',
    channel_kind: 'app-socket',
    choice: {
      prompt_id: apA,
      choice_value: '__freeform__',
      freeform_text: 'pwn',
      chosen_at: Date.now(),
      speaker_user_id: 'u-B',
      channel_kind: 'app-socket',
    },
  })

  const a = await stateStore.get('t1', 'u-A')
  const b = await stateStore.get('t1', 'u-B')
  expect(a?.phase, 'userA untouched by mismatched call').toBe('signup')
  expect(b?.phase, 'userB did not advance on a stale prompt_id').toBe('signup')
})
