import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import type { ButtonChoice, ButtonPrompt } from '../../../channels/button-primitive.ts'
import { InterviewEngine } from '../engine.ts'
import { STATIC_PHASE_SPECS } from '../phase-prompts.ts'
import { InMemoryOnboardingStateStore } from '../state-store.ts'
import { TranscriptWriter } from '../transcript.ts'

// 2026-05-10 sprint — the per-channel `S1_PROMPT_BODY_WEB` filter has
// gone. Both telegram and web signups land on the same static fallback
// body when the LLM driver is unwired; the LLM driver handles
// per-channel context (sees `signup_via` in the bundle) when wired.
const SIGNUP_FALLBACK_BODY = STATIC_PHASE_SPECS['signup']!.body
const SIGNUP_FALLBACK_OPTIONS_LEN = STATIC_PHASE_SPECS['signup']!.options.length
// Aliases so legacy assertions read clearly; both channels resolve to
// the same body now.
const S1_PROMPT_BODY = SIGNUP_FALLBACK_BODY
const S1_PROMPT_BODY_WEB = SIGNUP_FALLBACK_BODY
const S1_PROMPT_OPTIONS = { length: SIGNUP_FALLBACK_OPTIONS_LEN }

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: InMemoryOnboardingStateStore
let transcriptPath: string
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>
let engine: InterviewEngine

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-eng-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new InMemoryOnboardingStateStore()
  transcriptPath = join(tmp, 'persona', 'onboarding-transcript.jsonl')
  transcript = new TranscriptWriter({ path: transcriptPath })
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

describe('InterviewEngine — S1 single hardcoded phase', () => {
  test('start emits the hardcoded "What\'s your name?" prompt', async () => {
    const out = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    expect(out.was_new).toBe(true)
    expect(sentPrompts.length).toBe(1)
    expect(sentPrompts[0]?.prompt.body).toBe(S1_PROMPT_BODY)
    expect(sentPrompts[0]?.prompt.options.length).toBe(S1_PROMPT_OPTIONS.length)
  })

  test('start writes the agent line to the transcript', async () => {
    await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    const entries = transcript.readAll()
    expect(entries.length).toBe(1)
    expect(entries[0]?.role).toBe('agent')
    expect(entries[0]?.body).toBe(S1_PROMPT_BODY)
    expect(entries[0]?.phase).toBe('signup')
  })

  test('start advances state to phase=signup', async () => {
    await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    const state = await stateStore.get('t1', 'u-1')
    expect(state?.phase).toBe('signup')
    expect(state?.phase_state.signup_via).toBe('telegram')
  })

  test('start is idempotent — re-start collapses on idempotency_key', async () => {
    const a = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    const b = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    expect(b.was_new).toBe(false)
    expect(b.prompt_id).toBe(a.prompt_id)
    const rows = db
      .prepare<{ c: number }, []>(`SELECT COUNT(*) AS c FROM button_prompts`)
      .get()
    expect(rows?.c).toBe(1)
  })

  // K4a (refactor) — `acceptChoice` deleted (zero production callers; the
  // production path is `advance` → `consumeChoice`). The button-choice-
  // advances-past-signup + user-transcript-line assertions are preserved on
  // the advance path by engine-router-integration.test.ts ("signup: typed
  // name maps to consumeChoice + transcript user line") and the
  // advance-driven port in engine-advance-choice-parity.test.ts.

  // K4a (refactor) — the persona-sync fire / skip-on-null / survive-throw
  // discipline these three `acceptChoice` tests covered is preserved on the
  // PRODUCTION advance path by signup-asks-name.test.ts, which drives
  // `engine.advance` and asserts `recordUserFirstName` fires on a name reply
  // (L147), is skipped on a non-name reply (L244), and swallows a throw
  // (L476). Note: on the signup ADVANCE the engine fires `recordUserFirstName`
  // (v2), not `recordAgentName` (a legacy acceptChoice-only signup artifact —
  // advance fires `recordAgentName` at the `agent_name_chosen` transition
  // instead). The `__freeform__`→transcript-body and duplicate-no-re-advance
  // assertions are covered on the advance path by
  // engine-router-integration.test.ts ("signup: typed name maps to
  // consumeChoice + transcript user line"; "DEDUPED redelivered hybrid
  // advance") and final-handoff-resolve-roundtrip.test.ts (double-tap noop).

  test('state is persisted BEFORE the send call (Codex r8 P1)', async () => {
    // Race scenario: user taps the keyboard before the post-send state
    // upsert lands. With the old order, acceptChoice would throw
    // owner_state_missing and the resolved row would dedup the retry.
    // The fix writes state BEFORE send so a fast tap can find state.
    let stateAtSendTime: { phase: string; active_prompt_id: unknown } | null = null
    const localEngine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        const peek = await stateStore.get('t1', 'u-1')
        stateAtSendTime = peek
          ? { phase: peek.phase, active_prompt_id: peek.phase_state.active_prompt_id }
          : null
        sentPrompts.push(input)
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
    })
    await localEngine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    expect(stateAtSendTime).not.toBeNull()
    expect(stateAtSendTime!.phase).toBe('signup')
    expect(typeof stateAtSendTime!.active_prompt_id).toBe('string')
    expect((stateAtSendTime!.active_prompt_id as string).length).toBeGreaterThan(0)
  })

  test('start does NOT roll back state when phase has already advanced (Codex r3 P1)', async () => {
    const start = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    // K4a (refactor) — advance the phase via the PRODUCTION path
    // (`engine.advance` with a button choice), not the deleted `acceptChoice`.
    await engine.advance({
      user_id: 'u-1',
      project_slug: 't1',
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
    const advancedState = await stateStore.get('t1', 'u-1')
    // Under the PRODUCTION `advance` path the engine walks
    // signup → instance_provisioned → (AUTO_SKIP) → ai_substrate_offered AND
    // emits the ai_substrate_offered prompt, so a live active prompt exists
    // (unlike the retired `acceptChoice`, which advanced state without
    // emitting the post-skip prompt).
    expect(advancedState?.phase).toBe('ai_substrate_offered')
    expect(typeof advancedState?.phase_state.active_prompt_id).toBe('string')

    // Spurious second start (e.g. duplicate signup trigger / reconnect). The
    // r3 guarantee — no state rollback — holds: the phase remains
    // ai_substrate_offered and start collapses idempotently (was_new=false)
    // instead of resetting the row back to signup.
    const out = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    expect(out.was_new).toBe(false)
    expect(out.state.phase).toBe('ai_substrate_offered')
    expect(typeof out.prompt_id).toBe('string')
    expect((out.prompt_id ?? '').length).toBeGreaterThan(0)
  })

  test('start retries the send when the prior attempt failed (no delivered_at)', async () => {
    let attempt = 0
    const localEngine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        attempt++
        if (attempt === 1) {
          throw new Error('synthetic transient send failure')
        }
        sentPrompts.push(input)
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
    })
    // First start: persists row, send fails, throws.
    await expect(
      localEngine.start({
        project_slug: 't1',
        topic_id: 'topic-1',
        user_id: 'u-1',
        signup_via: 'telegram',
      }),
    ).rejects.toThrow(/failed to send S1 prompt/)
    // Second start: idempotent persistence collapses, BUT delivered_at
    // is still null → engine MUST retry the send.
    const out = await localEngine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    expect(attempt).toBe(2)
    expect(sentPrompts.length).toBe(1) // only the successful retry sent
    expect(out.was_new).toBe(false)

    const row = db
      .prepare<{ delivered_at: number | null; c: number }, []>(
        `SELECT delivered_at, COUNT(*) OVER () AS c FROM button_prompts`,
      )
      .get()
    expect(row?.c).toBe(1)
    expect(row?.delivered_at).not.toBeNull()

    // Codex r2 P2.2 — transcript MUST contain the agent line even
    // though emit.was_new was false on the successful retry. Without
    // the fix the onboarding history would be silently missing the
    // opening agent message.
    const entries = transcript.readAll()
    const agentLines = entries.filter((e) => e.role === 'agent')
    expect(agentLines.length).toBe(1)
  })

  // K4a (refactor) — the "__timeout__ / __cancel__ synthetic sentinel does
  // NOT advance the phase" assertions lived ONLY on the deleted `acceptChoice`
  // entry (its top-of-method NON_ADVANCING_CHOICE_VALUES guard). The
  // production `advance` → `consumeChoice` path has no such generic guard, and
  // the sentinels do not reach it: `__timeout__` is rejected at the gateway
  // boundary (FORBIDDEN_INBOUND_VALUES in the app-socket adapter + chat-bridge
  // button_choice handler) and is produced only by ButtonStore.sweepExpired,
  // which has no production consumer that feeds the engine. This behavior was
  // therefore dead-with-acceptChoice and is intentionally not ported. (The
  // `__cancel__` app-socket path DOES reach `advance`; hardening consumeChoice
  // to no-op on it is a separate concern flagged in the K4a PR, out of scope
  // for a pure deletion.)

  // K4a (refactor) — removed. This test fed a swept `__timeout__` sentinel
  // through `acceptChoice`, relying on that method's NON_ADVANCING guard to
  // CLEAR `active_prompt_id` so the next `start()` re-emits fresh. That guard
  // was acceptChoice-only and is deleted; `__timeout__` never reaches the
  // production engine (see the NON_ADVANCING note above). The surviving
  // start-recovery guarantee — next `start()` re-emits after a prompt was
  // resolved before the phase advanced — is covered by the sibling test below
  // ("start recovers when prompt was resolved before phase advance").

  test('start recovers when prompt was resolved before phase advance (Codex r9 P1 + r11 P2)', async () => {
    // Simulate the crash: store.resolve commits, then process dies
    // before acceptChoice writes the user transcript line + advances
    // phase. Next start() must NOT loop forever on the resolved row.
    const a = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    // Resolve via the channel-side router but skip driving engine.advance.
    await buttonStore.resolve({
      choice: {
        prompt_id: a.prompt_id,
        choice_value: 'use-telegram-name',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'telegram',
      },
    })
    // Process dies. Next start() runs.
    const sentBefore = sentPrompts.length
    const recovered = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    expect(recovered.was_new).toBe(false)
    // 2026-05-14 — T9: signup recovery target is `instance_provisioned`
    // (the spec'd default route). Pre-T9 this was `name_chosen` via
    // the shortcut bypass.
    expect(recovered.state.phase).toBe('instance_provisioned')
    expect(recovered.state.phase_state.chosen_value).toBe('use-telegram-name')
    // No additional send — the prompt was already resolved.
    expect(sentPrompts.length).toBe(sentBefore)
    // Codex r11 P2 — recovered answer lands as role='user' so
    // downstream consumers reading the user-line stream see it.
    const entries = transcript.readAll()
    const userLines = entries.filter((e) => e.role === 'user')
    expect(userLines.length).toBe(1)
    expect(userLines[0]?.body).toBe('use-telegram-name')
    expect(userLines[0]?.button_choice).toBe('use-telegram-name')
  })

  test('Sprint 30 (Codex r3 P2) — start-recovery fires personaSync on freeform answer; null-skip on button-only', async () => {
    // Two recovery scenarios. (1) Resolved freeform answer recovers +
    // syncs the actual name. (2) Resolved button-only answer recovers
    // but does NOT sync (would clobber registry default with null).
    const recorded: Array<{ project_slug: string; agent_name: string | null }> = []
    const localEngine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push(input)
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
      personaSync: {
        recordAgentName: async (input) => {
          recorded.push(input)
        },
      },
    })

    // Case 1: freeform recovery → sync fires.
    const a = await localEngine.start({
      project_slug: 't-recover-freeform',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    await buttonStore.resolve({
      choice: {
        prompt_id: a.prompt_id,
        choice_value: '__freeform__',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'telegram',
        freeform_text: 'Recovery Name',
      },
    })
    await localEngine.start({
      project_slug: 't-recover-freeform',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    expect(recorded.length).toBe(1)
    expect(recorded[0]?.agent_name).toBe('Recovery Name')

    // Case 2: button-only recovery → sync does NOT fire.
    const b = await localEngine.start({
      project_slug: 't-recover-button',
      topic_id: 'topic-2',
      user_id: 'u-2',
      signup_via: 'telegram',
    })
    await buttonStore.resolve({
      choice: {
        prompt_id: b.prompt_id,
        choice_value: 'use-telegram-name',
        chosen_at: Date.now(),
        speaker_user_id: 'u-2',
        channel_kind: 'telegram',
      },
    })
    await localEngine.start({
      project_slug: 't-recover-button',
      topic_id: 'topic-2',
      user_id: 'u-2',
      signup_via: 'telegram',
    })
    expect(recorded.length).toBe(1) // unchanged
  })

  test('start recovery preserves freeform_text from a resolved freeform answer (Codex r10 P1)', async () => {
    const a = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    // App-socket-style freeform answer: store.resolve writes both
    // resolution_value=__freeform__ AND resolution_freeform_text=...
    await buttonStore.resolve({
      choice: {
        prompt_id: a.prompt_id,
        choice_value: '__freeform__',
        chosen_at: Date.now(),
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
        freeform_text: 'Alice the freeform name',
      },
    })
    // Process dies before the engine advances the phase. Recovery start():
    const recovered = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    // 2026-05-14 — T9: signup recovery target is `instance_provisioned`.
    expect(recovered.state.phase).toBe('instance_provisioned')
    expect(recovered.state.phase_state.chosen_freeform).toBe('Alice the freeform name')
  })

  test('reuse-active retry sends to the persisted topic_id, not input.topic_id (Codex r9 P2)', async () => {
    // First start sends to topic-1 but the send fails (delivered_at
    // stays null). Second start arrives with a different topic_id (e.g.
    // process restart); the retry MUST target topic-1 (where the row
    // belongs), not the new input topic.
    let attempt = 0
    const sentTopics: string[] = []
    const localEngine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        attempt++
        sentTopics.push(input.topic_id)
        if (attempt === 1) {
          throw new Error('synthetic failure')
        }
        return { message_id: `msg-${attempt}`, was_new: true }
      },
    })
    await expect(
      localEngine.start({
        project_slug: 't1',
        topic_id: 'topic-1',
        user_id: 'u-1',
        signup_via: 'telegram',
      }),
    ).rejects.toThrow(/failed to send S1 prompt/)

    // Second start with a DIFFERENT topic_id — retry must target topic-1.
    await localEngine.start({
      project_slug: 't1',
      topic_id: 'topic-DIFFERENT',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    expect(sentTopics).toEqual(['topic-1', 'topic-1'])
  })

  // K4a (refactor) — removed. Same shape as the deleted `__timeout__` start-
  // fresh test: it drove the swept `__cancel__` sentinel through `acceptChoice`
  // to clear `active_prompt_id` before asserting the next `start()` re-emits.
  // That clear was acceptChoice-only. Start re-emit / prompt-reuse on signup is
  // covered by "start during signup with active prompt reuses prompt_id" below
  // and "start recovers when prompt was resolved before phase advance" above.

  test('start during signup with active prompt reuses prompt_id (Codex r5 P2)', async () => {
    const a = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    expect(sentPrompts.length).toBe(1)
    // Spurious second start with a DIFFERENT topic_id — must NOT
    // overwrite active_prompt_id.
    const b = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-DIFFERENT',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    expect(b.was_new).toBe(false)
    expect(b.prompt_id).toBe(a.prompt_id)
    expect(b.state.phase_state.active_prompt_id).toBe(a.prompt_id)
    expect(b.state.phase_state.topic_id).toBe('topic-1')
    expect(sentPrompts.length).toBe(1)
  })

  test('advance with a choice but no prior state is a no-op (noop_no_state)', async () => {
    // K4a (refactor) — the deleted `acceptChoice` THREW `owner_state_missing`
    // when driven with no prior `start()`. The production `advance` path
    // instead returns `outcome: 'noop_no_state'` (engine.advance's terminal
    // no-op when the (project_slug, user_id) row is absent). This pins that
    // contract so a missing-state inbound is swallowed, never crashing the
    // chat-bridge turn.
    const choice: ButtonChoice = {
      prompt_id: '00000000-0000-0000-0000-000000000000',
      choice_value: 'x',
      chosen_at: 1234,
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    }
    const out = await engine.advance({
      project_slug: 't1',
      user_id: 'u-1',
      topic_id: 'topic-1',
      channel_kind: 'telegram',
      choice,
    })
    expect(out.outcome).toBe('noop_no_state')
    expect(out.state).toBeNull()
  })
})

// Bandaid for the misleading "Option A — Use my Telegram display name" the
// M2 web-signup test (instance `t-00000000`, 2026-05-09) surfaced. Standalone
// hotfix from § 8.1 of `docs/research/onboarding-llm-prompts-architecture-
// 2026-05-09.md`. The full LLM-driven `PhaseSpecResolver` replacement lands
// in a separate sprint; these regressions guard the bandaid in the
// meantime.
describe('InterviewEngine — signup phase (LLM-driven fallback)', () => {
  // 2026-05-10 — the per-channel `S1_PROMPT_BODY_WEB` filter is gone.
  // Both telegram and web signups land on the same static fallback body
  // when the LLM driver is unwired (which is the default in unit tests).
  // Removed tests with a one-line note in AS_BUILT.md:
  //   - "drops Option A (use-telegram-name)" — fallback has no options
  //   - "keeps the full 4 options + telegram body" — fallback has no options
  //   - "web variant emits a distinct idempotency_key" — same seed both
  //   - "cross-channel resume re-emits the right-channel spec" — same body
  //   - "web variant relabels surviving options sequentially A, B" — no opts
  //   - "signup re-emit honours the web spec" — no per-channel spec

  test('emits the same fallback body for both telegram and web', async () => {
    await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    expect(sentPrompts.length).toBe(1)
    expect(sentPrompts[0]?.prompt.body).toBe(SIGNUP_FALLBACK_BODY)
    expect(sentPrompts[0]?.prompt.options.length).toBe(0)
  })

  test('telegram signup emits the same fallback body', async () => {
    await engine.start({
      project_slug: 't2',
      topic_id: 'topic-2',
      user_id: 'u-2',
      signup_via: 'telegram',
    })
    expect(sentPrompts[0]?.prompt.body).toBe(SIGNUP_FALLBACK_BODY)
    expect(sentPrompts[0]?.prompt.options.length).toBe(0)
  })

  test('cross-channel resume preserves a resolved-but-not-advanced answer (Codex r2 P2)', async () => {
    // Crash-recovery + channel-switch scenario: an owner tapped a button
    // (or typed freeform) on the Telegram-shaped prompt, the
    // `buttonStore.resolve(...)` write landed, the engine then died
    // before `acceptChoice()` could advance the phase. Resuming via web
    // MUST go through `recoverResolvedAnswer` so the user's answer is
    // promoted onto the transcript + phase advances to `name_chosen`.
    // The cross-channel guard MUST NOT clobber `active_prompt_id` when
    // the prompt is resolved, or the answer is silently dropped.
    const tg_start = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-tg',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    // Simulate the user's answer landing in the ButtonStore via
    // `resolve` (the same path Telegram callbacks + app-socket choices
    // take). The engine has not yet been re-entered to advance.
    const resolveOut = await buttonStore.resolve({
      choice: {
        prompt_id: tg_start.prompt_id,
        choice_value: '__freeform__',
        chosen_at: 5_000,
        speaker_user_id: 'u-1',
        channel_kind: 'telegram',
        freeform_text: 'Athena',
      },
    })
    expect(resolveOut.was_new).toBe(true)

    // Resume on web — same project_slug, fresh topic_id.
    sentPrompts.length = 0
    await engine.start({
      project_slug: 't1',
      topic_id: 'topic-web',
      user_id: 'u-1',
      signup_via: 'web',
    })

    // The recovery path advanced past signup; no fresh prompt should
    // have been emitted, the phase should now be `instance_provisioned`
    // (post-T9 spec'd default route, was `name_chosen` shortcut
    // pre-T9), and the freeform answer should be recorded (the same
    // shape `recoverResolvedAnswer` writes on the same-channel resume).
    expect(sentPrompts.length).toBe(0)
    const post = await stateStore.get('t1', 'u-1')
    expect(post?.phase).toBe('instance_provisioned')
    expect(post?.phase_state['chosen_freeform']).toBe('Athena')
    expect(post?.phase_state['chosen_value']).toBe('__freeform__')
    // The transcript should contain the recovered user line + the
    // system note tagging it as recovered.
    const entries = transcript.readAll()
    const recovered = entries.find((e) => e.role === 'user' && e.body === 'Athena')
    expect(recovered).not.toBeUndefined()
  })

  test('signup re-emit emits the fallback body for both channels', async () => {
    await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    await stateStore.upsert({
      user_id: 'u-1',
      project_slug: 't1',
      phase: 'signup',
      phase_state_patch: { active_prompt_id: null },
      advanced_at: 9000,
    })
    sentPrompts.length = 0
    const reemit = await engine.emitCurrentPhasePrompt({
      user_id: 'u-1',
      project_slug: 't1',
      topic_id: 'topic-1',
    })
    expect(reemit.outcome).toBe('reemitted_current')
    expect(sentPrompts[0]?.prompt.body).toBe(SIGNUP_FALLBACK_BODY)
    expect(sentPrompts[0]!.prompt.options.length).toBe(0)
  })

  test('transcript records the fallback body the user actually saw', async () => {
    await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'web',
    })
    const entries = transcript.readAll()
    expect(entries.length).toBe(1)
    expect(entries[0]?.body).toBe(SIGNUP_FALLBACK_BODY)
  })
})
