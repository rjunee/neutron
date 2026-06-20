/**
 * Integration test — Bug 2 fix (2026-05-21) — re-emit-vs-inbound race
 * clobbers user-typed message (v0.1.75 follow-up to PR #261).
 *
 * Symptom (owner, 2026-05-21, instance `t-aaaaaaaa` at 21:28:10-21:28:18):
 * after PR #261 added unconditional ephemeral-channel re-emit on
 * session-open, a follow-on race surfaced: when the user types a reply
 * and the WS reconnects within ~1 s of the user_message being received
 * but BEFORE the engine has processed it, the new session's
 * `engine.start` sees `active_prompt_id` set + `resolved_at=null` and
 * re-emits the SAME prompt. The user's in-flight typed text is
 * discarded; they see the same question and have to retype.
 *
 * Root cause: pre-fix the re-emit branch in `engine.start()` (line
 * ~1487, the `ephemeral || undelivered || topic_id_changed` gate)
 * fired unconditionally on every fresh WS while `resolved_at IS NULL`
 * — but the resolved_at write happens INSIDE `engine.advance`, so the
 * window between "chat-bridge.handleInbound received user_message" and
 * "engine.advance committed ButtonStore.resolve" is a race.
 *
 * Fix: chat-bridge.handleInbound writes
 * `phase_state.last_inbound_received_at` BEFORE calling engine.advance.
 * On the next engine.start, the re-emit branch reads this marker — if
 * the timestamp is newer than the active prompt's `delivered_at` AND
 * less than `PENDING_INBOUND_WINDOW_MS` (5s) old, the gate fires and
 * re-emit is skipped. The in-flight engine.advance is authoritative
 * for the next channel emit.
 *
 * Outside the 5s window (advance crashed silently with no resolved_at
 * write), the gate releases — the next engine.start re-emits the
 * original prompt. Graceful fallback, never strands the user.
 *
 * Spec contract: `docs/plans/P2-onboarding-v2.md` § 9.2.1 (pending-
 * inbound guard sub-bullet, added 2026-05-21).
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
let mockNow: number

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-bug2-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new SqliteOnboardingStateStore({ db })
  transcriptPath = join(tmp, 'persona', 'onboarding-transcript.jsonl')
  transcript = new TranscriptWriter({ path: transcriptPath })
  sentPrompts = []
  mockNow = 1_700_000_000_000
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
    now: () => mockNow,
  })
}

async function seedActivePromptDelivered(opts: {
  topic_id: string
  phase: OnboardingPhase
  signup_via?: 'web' | 'telegram'
  delivered_at: number
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
  await buttonStore.markDelivered(emit.prompt_id, opts.delivered_at)
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
    advanced_at: opts.delivered_at,
  })
  return { promptId: emit.prompt_id }
}

describe('Bug 2 (2026-05-21) — engine.start re-emit pending-inbound gate', () => {
  test('reproduces owner-2026-05-21 sequence: user_message → reconnect within 5s → engine.start skips re-emit', async () => {
    const TOPIC_ID = 'web:u-ryan'
    const DELIVERED_AT = 1_700_000_000_000

    const engine = makeEngine()
    const { promptId } = await seedActivePromptDelivered({
      topic_id: TOPIC_ID,
      phase: 'signup',
      delivered_at: DELIVERED_AT,
    })

    // Session A delivers a user_message — chat-bridge.handleInbound
    // writes the inbound marker BEFORE engine.advance runs.
    mockNow = DELIVERED_AT + 1_000 // 1 s after delivery
    await engine.recordInboundReceived({
      project_slug: 't-aaaaaaaa',
      user_id: 'u-ryan',
      received_at: mockNow,
    })

    // Session B opens 500ms later — well within the 5s pending-inbound
    // window. The advance from session A's inbound is still in flight.
    mockNow = mockNow + 500
    const result = await engine.start({
      project_slug: 't-aaaaaaaa',
      topic_id: TOPIC_ID,
      user_id: 'u-ryan',
      signup_via: 'web',
    })

    // The re-emit MUST NOT fire — the user's typed message hasn't been
    // processed yet, and re-emitting would clobber it on the new DOM.
    expect(sentPrompts.length).toBe(0)
    expect(result.prompt_id).toBe(promptId)
    expect(result.was_new).toBe(false)

    // The prompt row should still be active + unresolved (advance
    // hasn't run in this test).
    const peek = await buttonStore.peek(promptId)
    expect(peek?.resolved_at).toBeNull()
    expect(peek?.delivered_at).toBe(DELIVERED_AT)
  })

  test('outside the 5s window the gate releases — re-emit fires (no permanent stranding)', async () => {
    const TOPIC_ID = 'web:u-ryan'
    const DELIVERED_AT = 1_700_000_000_000

    const engine = makeEngine()
    const { promptId } = await seedActivePromptDelivered({
      topic_id: TOPIC_ID,
      phase: 'signup',
      delivered_at: DELIVERED_AT,
    })

    // Inbound landed 6s ago — past the window. (engine.advance must
    // have crashed silently for this to happen; the gate releases.)
    mockNow = DELIVERED_AT + 1_000
    await engine.recordInboundReceived({
      project_slug: 't-aaaaaaaa',
      user_id: 'u-ryan',
      received_at: mockNow,
    })

    // 6s later, reconnect.
    mockNow = mockNow + 6_000
    await engine.start({
      project_slug: 't-aaaaaaaa',
      topic_id: TOPIC_ID,
      user_id: 'u-ryan',
      signup_via: 'web',
    })

    // Re-emit fires — graceful fallback.
    expect(sentPrompts.length).toBe(1)
    expect(sentPrompts[0]?.prompt.prompt_id).toBe(promptId)
    expect(sentPrompts[0]?.topic_id).toBe(TOPIC_ID)
  })

  test('inbound BEFORE delivered_at does NOT trigger the gate (stale marker from a prior phase)', async () => {
    const TOPIC_ID = 'web:u-ryan'
    const DELIVERED_AT = 1_700_000_000_000

    const engine = makeEngine()
    await seedActivePromptDelivered({
      topic_id: TOPIC_ID,
      phase: 'signup',
      delivered_at: DELIVERED_AT,
    })

    // Stale inbound — older than the active prompt's delivery. (E.g.,
    // user typed a reply that advanced phase, then the next prompt's
    // delivered_at was written — the marker is now obsolete.)
    mockNow = DELIVERED_AT - 30_000
    await engine.recordInboundReceived({
      project_slug: 't-aaaaaaaa',
      user_id: 'u-ryan',
      received_at: mockNow,
    })

    // Reconnect right now (current sim time).
    mockNow = DELIVERED_AT + 1_000
    await engine.start({
      project_slug: 't-aaaaaaaa',
      topic_id: TOPIC_ID,
      user_id: 'u-ryan',
      signup_via: 'web',
    })

    // Re-emit fires — stale marker is below the delivered threshold so
    // the gate doesn't trip.
    expect(sentPrompts.length).toBe(1)
  })

  test('no marker at all (legacy state row) — re-emit fires as in PR #261', async () => {
    const TOPIC_ID = 'web:u-ryan'
    const DELIVERED_AT = 1_700_000_000_000

    const engine = makeEngine()
    await seedActivePromptDelivered({
      topic_id: TOPIC_ID,
      phase: 'signup',
      delivered_at: DELIVERED_AT,
    })

    // No recordInboundReceived call — the marker is absent (this is
    // every existing test row pre-v0.1.75).
    mockNow = DELIVERED_AT + 1_000
    await engine.start({
      project_slug: 't-aaaaaaaa',
      topic_id: TOPIC_ID,
      user_id: 'u-ryan',
      signup_via: 'web',
    })

    // Re-emit fires per PR #261 — the gate only activates when a
    // recent inbound marker is present.
    expect(sentPrompts.length).toBe(1)
  })

  test('Codex r1 P1: gate does NOT fire when delivered_at IS NULL (undelivered prompt MUST be delivered on reconnect)', async () => {
    // Codex r1 P1 finding: pre-fix the gate read `delivered_at ?? 0`,
    // so an undelivered prompt (delivered_at === null) had its delivery
    // time coerced to 0. ANY non-null last_inbound_received_at then
    // tripped the gate, suppressing the re-emit and stranding the user
    // with no visible prompt AND no retry trigger.
    //
    // Fix: only apply the gate when `meta.delivered_at !== null`. An
    // undelivered prompt MUST be delivered — the "user typed a reply"
    // race can only happen on a prompt that was actually delivered to
    // them first.
    const TOPIC_ID = 'web:u-ryan'

    const engine = makeEngine()
    // Seed a prompt that was emitted but NEVER delivered (the prior
    // send returned was_new=false — no live sender at emit time).
    const prompt: ButtonPrompt = {
      prompt_id: 'ce8a1f02-0ec6-4c50-8a25-2dba7c63f8aa',
      idempotency_key: 'key-undelivered-prompt',
      body: 'Drop your ChatGPT or Claude export below to seed memory.',
      options: [
        { label: 'A', body: 'Skip for now', value: '__skip__' },
        { label: 'B', body: 'Pause', value: '__pause__' },
      ],
      allow_freeform: true,
    }
    const emit = await buttonStore.emit(prompt, { topic_id: TOPIC_ID })
    // CRITICAL: DO NOT markDelivered — this simulates the
    // was_new=false return path.
    await stateStore.upsert({
      user_id: 'u-ryan',
      project_slug: 't-aaaaaaaa',
      phase: 'import_upload_pending',
      phase_state_patch: {
        topic_id: TOPIC_ID,
        signup_via: 'web',
        user_id: 'u-ryan',
        active_prompt_id: emit.prompt_id,
      },
      advanced_at: 1_700_000_000_000,
    })

    // Some prior inbound marker is sitting in phase_state from a
    // previous phase (e.g. the user typed something that completed
    // the earlier phase and advanced into this one before the next
    // emit's send failed). The marker IS recent.
    mockNow = 1_700_000_000_000 + 1_000
    await engine.recordInboundReceived({
      project_slug: 't-aaaaaaaa',
      user_id: 'u-ryan',
      received_at: mockNow,
    })

    // Reconnect now. The prompt is undelivered AND a recent inbound
    // marker exists. PRE-FIX (delivered_at ?? 0): the gate trips and
    // we skip re-emit → blank chat with no future retry. POST-FIX
    // (delivered_at !== null check): the gate releases and re-emit
    // fires.
    mockNow = mockNow + 500
    await engine.start({
      project_slug: 't-aaaaaaaa',
      topic_id: TOPIC_ID,
      user_id: 'u-ryan',
      signup_via: 'web',
    })

    expect(sentPrompts.length).toBe(1)
    expect(sentPrompts[0]?.prompt.prompt_id).toBe(emit.prompt_id)
  })

  test('gate also fires on the signup-phase reuseActivePrompt branch (mirror of non-signup gate)', async () => {
    // The signup phase uses `reuseActivePrompt(...)` for the duplicate-
    // start path (line ~2080 in engine.ts). Bug 2's gate is mirrored
    // there too so signup-phase reconnects don't clobber a typed name.
    const TOPIC_ID = 'web:u-ryan'
    const DELIVERED_AT = 1_700_000_000_000

    const engine = makeEngine()
    const { promptId } = await seedActivePromptDelivered({
      topic_id: TOPIC_ID,
      phase: 'signup',
      delivered_at: DELIVERED_AT,
    })

    mockNow = DELIVERED_AT + 500
    await engine.recordInboundReceived({
      project_slug: 't-aaaaaaaa',
      user_id: 'u-ryan',
      received_at: mockNow,
    })

    mockNow = mockNow + 100
    const result = await engine.start({
      project_slug: 't-aaaaaaaa',
      topic_id: TOPIC_ID,
      user_id: 'u-ryan',
      signup_via: 'web',
    })

    expect(sentPrompts.length).toBe(0)
    expect(result.prompt_id).toBe(promptId)
  })
})
