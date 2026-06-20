/**
 * Integration test — onboarding resume-on-reconnect (P2 S2 § 6a).
 *
 * Given: an in-progress onboarding at `phase='personality_offered'` with
 * `last_advanced_at = now - 25h`. The agent process restarts (clean state
 * in memory). User sends a new inbound after the restart.
 *
 * When: InterviewEngine.advance runs on the inbound.
 *
 * Then: the engine reads `onboarding_state`, detects the 24h gap, emits
 * a "Welcome back, we left off at picking your archetype" button prompt;
 * user taps `[A] Continue`; engine advances to `phase='agent_name_chosen'`. No
 * data loss; transcript JSONL append-only across the restart.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import {
  InterviewEngine,
  SqliteOnboardingStateStore,
  TranscriptWriter,
  RESUME_PROMPT_BODY_PREFIX,
} from '@neutronai/onboarding/index.ts'
import type { ButtonChoice, ButtonPrompt } from '@neutronai/channels/button-primitive.ts'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: SqliteOnboardingStateStore
let transcriptPath: string
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-resume-'))
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

describe('onboarding resume-on-reconnect', () => {
  test('reemitResumePrompt actually re-renders when inbound does not match the active resume prompt (Codex r3 P2)', async () => {
    const T0 = 1_700_000_000_000
    const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1_000

    // Seed at archetype_picked + 25h gap.
    await stateStore.upsert({
      user_id: 'u-1',
      project_slug: 'bob',
      phase: 'personality_offered',
      phase_state_patch: { topic_id: 'tg:1', signup_via: 'telegram', user_id: 'u-1' },
      advanced_at: T0 - TWENTY_FIVE_HOURS_MS,
    })

    const engine = makeEngine(() => T0)
    // First advance: emits the resume prompt.
    const r1 = await engine.advance({
      project_slug: 'bob',
      topic_id: 'tg:1',
      user_id: 'u-1',
      channel_kind: 'telegram',
      observed_at: T0,
    })
    expect(r1.outcome).toBe('resume_prompt_emitted')
    expect(sentPrompts.length).toBe(1)
    const resume_prompt_id = r1.prompt_id!

    // Second advance: user types unrelated freeform — engine should
    // re-render the resume prompt rather than silently ignoring.
    const r2 = await engine.advance({
      project_slug: 'bob',
      topic_id: 'tg:1',
      user_id: 'u-1',
      channel_kind: 'telegram',
      freeform_text: 'wait what?',
      observed_at: T0 + 1_000,
    })
    expect(r2.outcome).toBe('resume_prompt_emitted')
    expect(r2.prompt_id).toBe(resume_prompt_id)
    // Critical: a fresh send DID happen (re-render) — sentPrompts has 2 entries.
    expect(sentPrompts.length).toBe(2)
    expect(sentPrompts[1]!.prompt.prompt_id).toBe(resume_prompt_id)
  })

  test('emitCurrentPhasePrompt preserves last_advanced_at so the resume window is not reset (Codex r3 P2)', async () => {
    const T0 = 1_700_000_000_000
    const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1_000

    // Seed at archetype_picked with a 25h-old last_advanced_at.
    await stateStore.upsert({
      user_id: 'u-1',
      project_slug: 'cara',
      phase: 'personality_offered',
      phase_state_patch: { topic_id: 'tg:1', signup_via: 'telegram', user_id: 'u-1' },
      advanced_at: T0 - TWENTY_FIVE_HOURS_MS,
    })

    const engine = makeEngine(() => T0)
    // emitCurrentPhasePrompt without an inbound — like a bridge-side greeting.
    const r = await engine.emitCurrentPhasePrompt({
      user_id: 'u-1',
      project_slug: 'cara',
      topic_id: 'tg:1',
      observed_at: T0,
    })
    expect(r.outcome).toBe('reemitted_current')
    // last_advanced_at must be preserved (still 25h ago) so the next
    // advance() trips the resume-on-reconnect detection.
    const after = await stateStore.get('cara', 'u-1')
    expect(after!.last_advanced_at).toBe(T0 - TWENTY_FIVE_HOURS_MS)
  })

  test('Codex r5 P1: resume-pause + later inbound emits a NEW resume prompt (no idempotency loop)', async () => {
    const T0 = 1_700_000_000_000
    const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1_000

    await stateStore.upsert({
      user_id: 'u-1',
      project_slug: 'dana',
      phase: 'personality_offered',
      phase_state_patch: { topic_id: 'tg:1', signup_via: 'telegram', user_id: 'u-1' },
      advanced_at: T0 - TWENTY_FIVE_HOURS_MS,
    })

    const engine = makeEngine(() => T0)
    // First wave: resume prompt emitted.
    const r1 = await engine.advance({
      project_slug: 'dana',
      topic_id: 'tg:1',
      user_id: 'u-1',
      channel_kind: 'telegram',
      observed_at: T0,
    })
    expect(r1.outcome).toBe('resume_prompt_emitted')
    const first_prompt_id = r1.prompt_id!

    // User taps Pause.
    await engine.advance({
      project_slug: 'dana',
      topic_id: 'tg:1',
      user_id: 'u-1',
      channel_kind: 'telegram',
      choice: {
        prompt_id: first_prompt_id,
        choice_value: 'resume-pause',
        chosen_at: T0 + 1_000,
        speaker_user_id: 'u-1',
        channel_kind: 'telegram',
      },
      observed_at: T0 + 1_000,
    })

    // Some hours later, user comes back and types something. Engine
    // should emit a FRESH resume prompt (not return the prior pause-
    // resolved row from idempotency). Without the attempt-counter fix,
    // the seed would match and ButtonStore would surface the old row.
    const T2 = T0 + 6 * 60 * 60 * 1_000
    const r2 = await engine.advance({
      project_slug: 'dana',
      topic_id: 'tg:1',
      user_id: 'u-1',
      channel_kind: 'telegram',
      freeform_text: 'hello again',
      observed_at: T2,
    })
    expect(r2.outcome).toBe('resume_prompt_emitted')
    expect(r2.prompt_id).not.toBe(first_prompt_id)
    // 2 distinct sends across the test (initial emit + new emit after pause).
    const sentIds = new Set(sentPrompts.map((p) => p.prompt.prompt_id))
    expect(sentIds.size).toBeGreaterThanOrEqual(2)
  })

  // 2026-05-12 — `name_chosen` is now in `AUTO_SKIP_PHASES`; the resume-
  // continue path now walks past it to `slug_chosen` (the next user-
  // visible phase). Test name + assertions updated accordingly.
  test('detects 24h+ gap → emits welcome-back → Continue advances past auto-skipped name_chosen to slug_chosen', async () => {
    const T0 = 1_700_000_000_000 // arbitrary fixed wall clock
    const ONE_HOUR_MS = 60 * 60 * 1_000
    const TWENTY_FIVE_HOURS_MS = 25 * ONE_HOUR_MS

    // Seed: owner is at phase='personality_offered' with last_advanced_at 25h ago.
    await stateStore.upsert({
      user_id: 'u-1',
      project_slug: 'alice',
      phase: 'personality_offered',
      phase_state_patch: {
        topic_id: 'tg:1',
        signup_via: 'telegram',
        user_id: 'u-1',
      },
      advanced_at: T0 - TWENTY_FIVE_HOURS_MS,
    })
    // Verify the 25h gap survived.
    const seeded = await stateStore.get('alice', 'u-1')
    expect(seeded).not.toBeNull()
    expect(seeded!.phase).toBe('personality_offered')

    // Restart: a fresh engine with a clock at T0 (25h after the prior advance).
    const engine = makeEngine(() => T0)

    // First advance: user sends a freeform inbound after the restart.
    const result1 = await engine.advance({
      project_slug: 'alice',
      topic_id: 'tg:1',
      user_id: 'u-1',
      channel_kind: 'telegram',
      freeform_text: 'hello?',
      observed_at: T0,
    })
    expect(result1.outcome).toBe('resume_prompt_emitted')
    expect(sentPrompts.length).toBe(1)
    const resume_prompt = sentPrompts[0]!.prompt
    expect(resume_prompt.body.startsWith(RESUME_PROMPT_BODY_PREFIX)).toBe(true)
    expect(resume_prompt.body.includes('picking your personality')).toBe(true)
    // Resume options [A]Continue [B]Restart [C]Pause
    const valuesEmitted = resume_prompt.options.map((o) => o.value)
    expect(valuesEmitted).toEqual(['resume-continue', 'resume-restart', 'resume-pause'])
    // State still at archetype_picked; resume_active_prompt_id set.
    const stateAfter1 = await stateStore.get('alice', 'u-1')
    expect(stateAfter1!.phase).toBe('personality_offered')
    expect(stateAfter1!.phase_state['resume_active_prompt_id']).toBe(resume_prompt.prompt_id)

    // Second advance: user taps Continue.
    const continueChoice: ButtonChoice = {
      prompt_id: resume_prompt.prompt_id,
      choice_value: 'resume-continue',
      chosen_at: T0 + 5_000,
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    }
    const result2 = await engine.advance({
      project_slug: 'alice',
      topic_id: 'tg:1',
      user_id: 'u-1',
      channel_kind: 'telegram',
      choice: continueChoice,
      observed_at: T0 + 5_000,
    })
    expect(result2.outcome).toBe('resume_handled')
    // P2 v2 § 2.8 — Continue advances from personality_offered to its
    // direct legal next phase `agent_name_chosen` (no auto-skip phase
    // intervenes in v2; the v1 name_chosen auto-skip is gone — v2 makes
    // `agent_name_chosen` user-visible per § 3.10).
    expect(result2.state).not.toBeNull()
    expect(result2.state!.phase).toBe('agent_name_chosen')
    // resume_active_prompt_id cleared; new active_prompt_id set for the
    // post-walker landing phase (time_style_picked).
    expect(result2.state!.phase_state['resume_active_prompt_id']).toBeNull()
    expect(typeof result2.state!.phase_state['active_prompt_id']).toBe('string')
    // A new prompt for the next interactive phase was sent.
    expect(sentPrompts.length).toBeGreaterThanOrEqual(2)

    // Transcript is append-only across the restart: it includes the
    // resume agent emit + the user choice + the next-phase agent emit.
    const transcript_text = readFileSync(transcriptPath, 'utf8')
    const lines = transcript_text.split('\n').filter((l) => l.length > 0)
    const bodies = lines.map((l) => JSON.parse(l) as { role: string; body: string })
    expect(
      bodies.some(
        (e) => e.role === 'agent' && e.body.startsWith(RESUME_PROMPT_BODY_PREFIX),
      ),
    ).toBe(true)
    expect(
      bodies.some((e) => e.role === 'user' && e.body === 'resume-continue'),
    ).toBe(true)
  })

  // 2026-05-12 Codex r1 — an owner persisted directly on an
  // AUTO_SKIP_PHASE (e.g. `name_chosen`) with a 24h+ gap can hit
  // welcome-back and tap `[B] Restart this step`. The resume-restart
  // branch re-emits the current phase's prompt; the new
  // resolvePhasePromptSpecUncached guard returns null for auto-skip
  // phases, so without an additional walker call the emit throws
  // `no prompt content for phase=name_chosen`. The walker fix advances
  // the user past name_chosen → time_style_picked (post-2026-05-13
  // reorder) so Restart works.
  test('Restart from stale name_chosen walks the auto-skip phase and emits the next-phase prompt', async () => {
    const T0 = 1_700_000_000_000
    const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1_000

    // Seed at name_chosen with a 25h-old last_advanced_at.
    await stateStore.upsert({
      user_id: 'u-1',
      project_slug: 'dora',
      phase: 'agent_name_chosen',
      phase_state_patch: {
        topic_id: 'tg:1',
        signup_via: 'telegram',
        user_id: 'u-1',
        agent_name: 'Dora',
        suggested_slug: 'dora',
      },
      advanced_at: T0 - TWENTY_FIVE_HOURS_MS,
    })

    const engine = makeEngine(() => T0)
    // First advance: emits the welcome-back resume prompt for the
    // current phase (name_chosen).
    const r1 = await engine.advance({
      project_slug: 'dora',
      topic_id: 'tg:1',
      user_id: 'u-1',
      channel_kind: 'telegram',
      observed_at: T0,
    })
    expect(r1.outcome).toBe('resume_prompt_emitted')
    expect(sentPrompts.length).toBe(1)
    const resume_prompt = sentPrompts[0]!.prompt
    expect(resume_prompt.body.startsWith(RESUME_PROMPT_BODY_PREFIX)).toBe(true)

    // Second advance: user taps Restart.
    const restartChoice: ButtonChoice = {
      prompt_id: resume_prompt.prompt_id,
      choice_value: 'resume-restart',
      chosen_at: T0 + 5_000,
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    }
    const r2 = await engine.advance({
      project_slug: 'dora',
      topic_id: 'tg:1',
      user_id: 'u-1',
      channel_kind: 'telegram',
      choice: restartChoice,
      observed_at: T0 + 5_000,
    })
    expect(r2.outcome).toBe('resume_handled')
    // P2 v2 § 2.8 — agent_name_chosen is NOT auto-skip in v2 (it's a
    // user-visible "what should I be called?" phase per § 3.10).
    // Restart on a stale row re-emits the agent_name_chosen prompt body
    // so the user can finish picking a name.
    expect(r2.state).not.toBeNull()
    expect(r2.state!.phase).toBe('agent_name_chosen')
    expect(sentPrompts.length).toBeGreaterThanOrEqual(2)
    const post_restart_prompt = sentPrompts[sentPrompts.length - 1]!.prompt
    expect(post_restart_prompt.body.toLowerCase()).toContain('called')
  })
})
