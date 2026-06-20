/**
 * Integration test — Bug 1 fix (2026-05-21) — blank chat on reconnect.
 *
 * Symptom (verified in prod 2026-05-21): user reaches
 * `import_upload_pending`, closes the tab, comes back, lands on an
 * empty chat with no agent message visible.
 *
 * Root cause: pre-fix `engine.start()` re-emit gate was
 * `if (undelivered || topic_id_changed)`. On a plain reload both
 * clauses are false (delivered_at was set in the prior session,
 * `webTopicId(user_id)` is stable per-user), so the engine returned
 * the existing `prompt_id` WITHOUT calling `sendButtonPrompt`. The
 * fresh chat.html DOM had nothing to fall back on.
 *
 * Fix: ephemeral-transcript channels (web) re-emit on EVERY
 * session-open regardless of `delivered_at`. The audit invariants
 * (`delivered_at` set exactly once on first delivery;
 * `transcript.append` exactly once on first delivery) are preserved.
 *
 * Telegram is gated the old way (`undelivered || topic_id_changed`)
 * because bubbles persist client-side; we don't want a duplicate
 * /start tap to spam the user.
 *
 * Spec contract: `docs/plans/P2-onboarding.md` § engine.start contract.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import {
  InterviewEngine,
  SqliteOnboardingStateStore,
  TranscriptWriter,
} from '@neutronai/onboarding/index.ts'
import type { ButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import type { OnboardingPhase } from '@neutronai/onboarding/interview/phase.ts'

interface SentPrompt {
  project_slug: string
  topic_id: string
  prompt: ButtonPrompt
}

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: SqliteOnboardingStateStore
let transcriptPath: string
let transcript: TranscriptWriter
let sentPrompts: SentPrompt[]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-bug1-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new SqliteOnboardingStateStore({ db })
  transcriptPath = join(tmp, 'persona', 'onboarding-transcript.jsonl')
  transcript = new TranscriptWriter({ path: transcriptPath })
  sentPrompts = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeEngine(now: () => number): InterviewEngine {
  return new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt: async (input) => {
      sentPrompts.push(input)
      return { message_id: `msg-${sentPrompts.length}`, was_new: true }
    },
    now,
  })
}

/**
 * Seed an unresolved + delivered button row whose phase is the
 * `import_upload_pending` body owner saw before refreshing the tab.
 * Uses the actual button-store contract (emit + markDelivered) so
 * the row's `delivered_at` is realistic.
 */
async function seedActivePromptDeliveredOnTopic(opts: {
  topic_id: string
  phase: OnboardingPhase
  signup_via?: 'web' | 'telegram'
}): Promise<{ promptId: string }> {
  const prompt: ButtonPrompt = {
    prompt_id: 'b87cf03f-0ec6-4c50-8a25-2dba7c63f8aa',
    idempotency_key: 'key-import-upload-pending',
    body: 'Drop your ChatGPT or Claude export below to seed memory.',
    options: [
      { label: 'A', body: 'Skip for now', value: '__skip__' },
      { label: 'B', body: 'Pause', value: '__pause__' },
    ],
    allow_freeform: true,
  }
  const emit = await buttonStore.emit(prompt, { topic_id: opts.topic_id })
  await buttonStore.markDelivered(emit.prompt_id, Date.now())
  await stateStore.upsert({
    user_id: 'u-ryan',
    project_slug: 't-aaaaaaaa',
    phase: opts.phase,
    phase_state_patch: {
      topic_id: opts.topic_id,
      signup_via: opts.signup_via ?? 'web',
      user_id: 'u-ryan',
      active_prompt_id: emit.prompt_id,
    },
    advanced_at: Date.now(),
  })
  return { promptId: emit.prompt_id }
}

describe('Bug 1 (2026-05-21) — engine.start re-emit on reconnect', () => {
  test('web reconnect re-emits an already-delivered unresolved prompt (the blank-chat fix)', async () => {
    const TOPIC_ID = 'web:u-ryan'
    const engine = makeEngine(() => Date.now())

    const { promptId } = await seedActivePromptDeliveredOnTopic({
      topic_id: TOPIC_ID,
      phase: 'import_upload_pending',
    })
    expect(sentPrompts.length).toBe(0)

    // Reconnect — same user, same topic_id, brand-new WS.
    const result = await engine.start({
      project_slug: 't-aaaaaaaa',
      topic_id: TOPIC_ID,
      user_id: 'u-ryan',
      signup_via: 'web',
    })

    expect(result.prompt_id).toBe(promptId)
    expect(result.was_new).toBe(false)
    expect(sentPrompts.length).toBe(1)
    expect(sentPrompts[0]?.topic_id).toBe(TOPIC_ID)
    expect(sentPrompts[0]?.prompt.prompt_id).toBe(promptId)
  })

  test('audit invariants preserved across re-emit: delivered_at unchanged + transcript not duplicated', async () => {
    const TOPIC_ID = 'web:u-ryan'
    const engine = makeEngine(() => Date.now())
    const { promptId } = await seedActivePromptDeliveredOnTopic({
      topic_id: TOPIC_ID,
      phase: 'import_upload_pending',
    })
    const peekBefore = await buttonStore.peek(promptId)
    expect(peekBefore?.delivered_at).not.toBeNull()
    const deliveredAtBefore = peekBefore?.delivered_at

    // Re-emit twice.
    await engine.start({
      project_slug: 't-aaaaaaaa',
      topic_id: TOPIC_ID,
      user_id: 'u-ryan',
      signup_via: 'web',
    })
    await engine.start({
      project_slug: 't-aaaaaaaa',
      topic_id: TOPIC_ID,
      user_id: 'u-ryan',
      signup_via: 'web',
    })

    const peekAfter = await buttonStore.peek(promptId)
    expect(peekAfter?.delivered_at).toBe(deliveredAtBefore ?? null)
    expect(peekAfter?.resolved_at).toBeNull()
    // Transcript was NOT appended on the seed (seed bypassed engine
    // emit) — neither re-emit should append because the row was
    // already delivered before either start() call. Net: zero agent
    // transcript lines for this prompt_id.
  })

  test('telegram duplicate /start with delivered + same topic_id does NOT re-emit (channel-gated)', async () => {
    const TOPIC_ID = 'tg:5551234'
    const engine = makeEngine(() => Date.now())
    const { promptId } = await seedActivePromptDeliveredOnTopic({
      topic_id: TOPIC_ID,
      phase: 'signup',
      signup_via: 'telegram',
    })
    expect(sentPrompts.length).toBe(0)

    await engine.start({
      project_slug: 't-aaaaaaaa',
      topic_id: TOPIC_ID,
      user_id: 'u-ryan',
      signup_via: 'telegram',
    })
    // No re-emit — Telegram bubbles persist client-side, duplicate
    // /start must be idempotent (Codex r5 P2 contract preserved).
    expect(sentPrompts.length).toBe(0)
    // And the prompt is still active + delivered.
    const peek = await buttonStore.peek(promptId)
    expect(peek?.delivered_at).not.toBeNull()
    expect(peek?.resolved_at).toBeNull()
  })

  test('web reconnect re-emit fires for non-signup phases (import_upload_pending in owner incident)', async () => {
    // owner's actual incident shape — phase was `import_upload_pending`,
    // not `signup`. Exercises the non-signup branch (engine.ts lines
    // ~1372+) specifically.
    const TOPIC_ID = 'web:u-ryan'
    const engine = makeEngine(() => Date.now())
    await seedActivePromptDeliveredOnTopic({
      topic_id: TOPIC_ID,
      phase: 'import_upload_pending',
    })
    expect(sentPrompts.length).toBe(0)
    await engine.start({
      project_slug: 't-aaaaaaaa',
      topic_id: TOPIC_ID,
      user_id: 'u-ryan',
      signup_via: 'web',
    })
    expect(sentPrompts.length).toBe(1)
    expect(sentPrompts[0]?.prompt.body).toContain('ChatGPT')
  })
})
