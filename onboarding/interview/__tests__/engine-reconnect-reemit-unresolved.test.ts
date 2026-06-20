/**
 * 2026-05-13 — no-restart slug rename: engine.start re-emits unresolved
 * active prompt on reconnect. Codex r4 BLOCKING finding on PR #85.
 *
 * The no-restart slug-rename driver in chat-bridge.ts:880-901 emits an
 * agent_message confirmation + advances the engine which emits the
 * next-phase prompt over the (still-open) WS. Neither call rolls state
 * back when delivery returns false (WS closed mid-flow). State has
 * advanced past slug_chosen and active_prompt_id is set, but the user
 * never saw the body or the keyboard.
 *
 * On reconnect the existing early-return in engine.start would surface
 * the stale prompt_id without re-sending — stranding the user on an
 * empty chat. Fix: peek the active prompt; if resolved_at is null
 * (user hasn't acted on it or never saw it), re-send the stored prompt.
 * Once resolved, normal early-return semantics apply.
 *
 * Tests:
 *   1. UNRESOLVED active prompt + reconnect → re-emit the stored prompt
 *      (same prompt_id, no competing keyboard).
 *   2. RESOLVED active prompt + reconnect → NO re-emit (the engine is
 *      awaiting the next user-driven advance trigger).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { InterviewEngine } from '../engine.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'

const PROJECT_SLUG = 'nova'
const TOPIC_ID = 'web:u-1'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-eng-reconnect-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  sentPrompts = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeEngine(): InterviewEngine {
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
  })
}

async function seedPersistedPrompt(prompt_id: string, body: string): Promise<ButtonPrompt> {
  const prompt: ButtonPrompt = {
    prompt_id,
    body,
    options: [],
    allow_freeform: true,
  }
  // Persist a button_prompts row with resolved_at = null. The
  // engine's reuse path uses buttonStore.peek + buttonStore.get to
  // re-fetch the spec; both are powered by the same DB row that
  // `emit()` writes.
  await buttonStore.emit(prompt, { topic_id: TOPIC_ID })
  return prompt
}

describe('InterviewEngine.start — Codex r4 BLOCKING re-emit on reconnect', () => {
  test('UNRESOLVED active prompt: reconnect after no-restart rename re-emits the stored prompt', async () => {
    // Setup: simulate the post-rename state. State has advanced past
    // slug_chosen (the no-restart driver advanced it in chat-bridge).
    // `active_prompt_id` is set; the corresponding button_prompts row
    // is unresolved (the user never clicked because the WS was closed
    // mid-emit).
    const PROMPT_ID = crypto.randomUUID()
    const PROMPT_BODY = "Tell me about how you work — solo, small team, larger org?"
    await seedPersistedPrompt(PROMPT_ID, PROMPT_BODY)
    await stateStore.upsert({
      user_id: 'u-1',
      project_slug: PROJECT_SLUG,
      phase: 'work_interview_gap_fill',
      phase_state_patch: {
        agent_name: 'Athena',
        signup_via: 'web',
        active_prompt_id: PROMPT_ID,
      },
      advanced_at: 1_000,
    })

    const peekBefore = await buttonStore.peek(PROMPT_ID)
    expect(peekBefore?.resolved_at).toBeNull()
    expect(sentPrompts.length).toBe(0)

    const engine = makeEngine()
    const out = await engine.start({
      project_slug: PROJECT_SLUG,
      topic_id: TOPIC_ID,
      user_id: 'u-1',
      signup_via: 'web',
    })

    // State is preserved (no rollback to signup); the active prompt is
    // re-sent so the reconnecting user sees the missed prompt body +
    // keyboard.
    expect(out.was_new).toBe(false)
    expect(out.state.phase).toBe('work_interview_gap_fill')
    expect(out.prompt_id).toBe(PROMPT_ID)
    expect(sentPrompts.length).toBe(1)
    expect(sentPrompts[0]?.prompt.prompt_id).toBe(PROMPT_ID)
    expect(sentPrompts[0]?.prompt.body).toBe(PROMPT_BODY)
    // Re-emit MUST route to the topic_id stored at original emit time
    // (stable per user-id; reconnect re-registers under the same key).
    expect(sentPrompts[0]?.topic_id).toBe(TOPIC_ID)
  })

  test('RESOLVED active prompt: reconnect does NOT re-emit (engine is awaiting next-turn advance)', async () => {
    // Setup: the user has already answered the active prompt (the
    // button_prompts row is resolved) but the engine hasn't yet
    // processed the advance (or this is an idempotent duplicate start
    // arriving while the answer is in flight). start() MUST NOT emit a
    // duplicate of the already-resolved keyboard.
    const PROMPT_ID = crypto.randomUUID()
    const PROMPT_BODY = "Tell me about how you work"
    await seedPersistedPrompt(PROMPT_ID, PROMPT_BODY)
    // Resolve the row via the public API so `resolved_at` is set the
    // same way the production tap path sets it.
    await buttonStore.resolve({
      choice: {
        prompt_id: PROMPT_ID,
        choice_value: '__freeform__',
        chosen_at: 2_000,
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
        freeform_text: 'small team of three',
      },
    })
    await stateStore.upsert({
      user_id: 'u-1',
      project_slug: PROJECT_SLUG,
      phase: 'work_interview_gap_fill',
      phase_state_patch: {
        agent_name: 'Athena',
        signup_via: 'web',
        active_prompt_id: PROMPT_ID,
      },
      advanced_at: 1_000,
    })

    const peekBefore = await buttonStore.peek(PROMPT_ID)
    expect(peekBefore?.resolved_at).not.toBeNull()
    expect(sentPrompts.length).toBe(0)

    const engine = makeEngine()
    const out = await engine.start({
      project_slug: PROJECT_SLUG,
      topic_id: TOPIC_ID,
      user_id: 'u-1',
      signup_via: 'web',
    })

    // State is preserved AND no duplicate re-emit fires.
    expect(out.was_new).toBe(false)
    expect(out.state.phase).toBe('work_interview_gap_fill')
    expect(out.prompt_id).toBe(PROMPT_ID)
    expect(sentPrompts.length).toBe(0)
  })
})
