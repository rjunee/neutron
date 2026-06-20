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

  test('acceptChoice advances past signup and writes user transcript line', async () => {
    const start = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    const choice: ButtonChoice = {
      prompt_id: start.prompt_id,
      choice_value: 'use-telegram-name',
      chosen_at: 1234,
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    }
    const out = await engine.acceptChoice({ project_slug: 't1', user_id: 'u-1', choice })
    expect(out.advanced).toBe(true)
    // 2026-05-14 — T9 (Codex r1 P2): signup → instance_provisioned →
    // import_offered. The engine runs the AUTO_SKIP walker on the
    // acceptChoice path so the user lands on the first interactive
    // phase (import_offered) instead of the hidden instance_provisioned
    // transit. The pre-T9 path advanced to name_chosen via the
    // shortcut and skipped both import_offered + archetype_picked
    // entirely.
    expect(out.state.phase).toBe('ai_substrate_offered')
    const entries = transcript.readAll()
    expect(entries.length).toBe(2)
    expect(entries[1]?.role).toBe('user')
    expect(entries[1]?.button_choice).toBe('use-telegram-name')
  })

  test('Sprint 30 — personaSync.recordAgentName fires on the name_chosen transition with freeform name', async () => {
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
    const start = await localEngine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    const choice: ButtonChoice = {
      prompt_id: start.prompt_id,
      choice_value: '__freeform__',
      chosen_at: 1234,
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
      freeform_text: 'Athena',
    }
    await localEngine.acceptChoice({ project_slug: 't1', user_id: 'u-1', choice })
    expect(recorded.length).toBe(1)
    expect(recorded[0]?.project_slug).toBe('t1')
    expect(recorded[0]?.agent_name).toBe('Athena')
  })

  test('Sprint 30 (Codex r1 P2) — personaSync is NOT called when agent_name is null on button-only choice', async () => {
    // Button-only choices ('use-telegram-name', 'keep-display-name') do
    // not carry literal text, so the engine cannot determine the user's
    // chosen name. Per Codex r1 P2 finding, the engine MUST NOT
    // overwrite the stored `agent_name` with NULL — that would clobber
    // any provisioning-time default OR a name set by an earlier
    // resume. The hook is silently skipped; the local
    // `phase_state.agent_name` still records null so a later sprint
    // can backfill from channel context.
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
    const start = await localEngine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    const choice: ButtonChoice = {
      prompt_id: start.prompt_id,
      choice_value: 'use-telegram-name',
      chosen_at: 1234,
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    }
    await localEngine.acceptChoice({ project_slug: 't1', user_id: 'u-1', choice })
    expect(recorded.length).toBe(0)
  })

  test('Sprint 30 — engine survives a personaSync failure (best-effort)', async () => {
    const localEngine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push(input)
        return { message_id: `msg-${sentPrompts.length}`, was_new: true }
      },
      personaSync: {
        recordAgentName: async () => {
          throw new Error('synthetic registry-write failure')
        },
      },
    })
    const start = await localEngine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    const choice: ButtonChoice = {
      prompt_id: start.prompt_id,
      choice_value: '__freeform__',
      chosen_at: 1234,
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
      freeform_text: 'Hermes',
    }
    const out = await localEngine.acceptChoice({ project_slug: 't1', user_id: 'u-1', choice })
    expect(out.advanced).toBe(true)
    // 2026-05-14 — T9 (Codex r1 P2): signup → instance_provisioned →
    // import_offered via AUTO_SKIP walker on acceptChoice path.
    expect(out.state.phase).toBe('ai_substrate_offered')
  })

  test('acceptChoice with __freeform__ records freeform_text in transcript body', async () => {
    const start = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    const choice: ButtonChoice = {
      prompt_id: start.prompt_id,
      choice_value: '__freeform__',
      chosen_at: 1234,
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
      freeform_text: 'Alice',
    }
    await engine.acceptChoice({ project_slug: 't1', user_id: 'u-1', choice })
    const entries = transcript.readAll()
    expect(entries[1]?.body).toBe('Alice')
  })

  test('duplicate acceptChoice does NOT re-advance', async () => {
    const start = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    const choice: ButtonChoice = {
      prompt_id: start.prompt_id,
      choice_value: 'use-telegram-name',
      chosen_at: 1234,
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    }
    const a = await engine.acceptChoice({ project_slug: 't1', user_id: 'u-1', choice })
    const b = await engine.acceptChoice({ project_slug: 't1', user_id: 'u-1', choice })
    expect(a.advanced).toBe(true)
    expect(b.advanced).toBe(false)
    const entries = transcript.readAll()
    expect(entries.length).toBe(2) // only one user line
  })

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
    await engine.acceptChoice({
      user_id: 'u-1',
      project_slug: 't1',
      choice: {
        prompt_id: start.prompt_id,
        choice_value: 'use-telegram-name',
        chosen_at: 1234,
        speaker_user_id: 'u-1',
        channel_kind: 'telegram',
      },
    })
    const advancedState = await stateStore.get('t1', 'u-1')
    // 2026-05-14 — T9 (Codex r1 P2): signup → instance_provisioned (auto-
    // skip walker on the acceptChoice path) → import_offered. The
    // post-acceptChoice phase is the first non-AUTO_SKIP phase reached
    // by the walker, so callbacks land the user on the import-substrate
    // picker instead of stranding on a hidden transit phase.
    // The walker clears active_prompt_id on the entry-side patch, so
    // there is no in-flight prompt to re-send on reconnect — the
    // import_offered emit happens via the next start() / advance().
    expect(advancedState?.phase).toBe('ai_substrate_offered')
    expect(advancedState?.phase_state.active_prompt_id ?? null).toBeNull()

    // Spurious second start (e.g. duplicate signup trigger / reconnect).
    // The r3 guarantee — no state rollback — still holds: state.phase
    // remains import_offered. The r4 guarantee (unresolved-prompt re-
    // send on reconnect) is moot here because the walker cleared the
    // active prompt at acceptChoice time; instead, start() reaches the
    // !has_active_prompt + has_phase_prompt branch and emits a fresh
    // import_offered prompt via emitCurrentPhasePrompt.
    const sentBefore = sentPrompts.length
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
    expect(sentPrompts.length).toBe(sentBefore + 1)
    // The freshly emitted prompt is for import_offered.
    expect(sentPrompts[sentPrompts.length - 1]?.prompt.body).toContain(
      'ChatGPT',
    )
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

  test('acceptChoice with __timeout__ does NOT advance phase (Codex r5 P1)', async () => {
    const start = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    const out = await engine.acceptChoice({
      user_id: 'u-1',
      project_slug: 't1',
      choice: {
        prompt_id: start.prompt_id,
        choice_value: '__timeout__',
        chosen_at: 1234,
        speaker_user_id: '__system__',
        channel_kind: 'webhook',
      },
    })
    expect(out.advanced).toBe(false)
    expect(out.state.phase).toBe('signup')
    const entries = transcript.readAll()
    const userLines = entries.filter((e) => e.role === 'user')
    expect(userLines.length).toBe(0)
    const systemLines = entries.filter((e) => e.role === 'system')
    expect(systemLines.length).toBe(1)
    expect(systemLines[0]?.button_choice).toBe('__timeout__')
  })

  test('acceptChoice with __cancel__ does NOT advance phase (Codex r5 P1)', async () => {
    const start = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    const out = await engine.acceptChoice({
      user_id: 'u-1',
      project_slug: 't1',
      choice: {
        prompt_id: start.prompt_id,
        choice_value: '__cancel__',
        chosen_at: 1234,
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
    })
    expect(out.advanced).toBe(false)
    expect(out.state.phase).toBe('signup')
  })

  test('after __timeout__ (via sweepExpired), next start() emits a FRESH prompt (Codex r7 P1.3)', async () => {
    // sweepExpired runs in production from cron tick; here we simulate
    // it advancing time past expires_at and calling sweep, then feed
    // the synthesized __timeout__ choice into the engine the way
    // production routeChoice would (sweepExpired returns ButtonChoice[],
    // each gets routed; engine.acceptChoice handles it).
    const a = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
      // Short expires so sweep can fire deterministically below.
    })
    // Pin the row's expires_at to fire on a known clock.
    await db.run(`UPDATE button_prompts SET expires_at = ? WHERE prompt_id = ?`, [
      1_000,
      a.prompt_id,
    ])
    const sweep = await buttonStore.sweepExpired(2_000)
    expect(sweep.resolved.length).toBe(1)
    const synth = sweep.resolved[0]!
    await engine.acceptChoice({ project_slug: 't1', user_id: 'u-1', choice: synth })

    const cleared = await stateStore.get('t1', 'u-1')
    expect(cleared?.phase_state.active_prompt_id).toBeNull()

    // Next start() must emit a fresh prompt + send Telegram again.
    const sentBefore = sentPrompts.length
    const b = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    expect(b.was_new).toBe(true)
    expect(b.prompt_id).not.toBe(a.prompt_id)
    expect(sentPrompts.length).toBe(sentBefore + 1)
  })

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
    // Resolve via the channel-side router but skip engine.acceptChoice.
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
    // Process dies before engine.acceptChoice. Recovery start():
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

  test('after __cancel__ (via app-socket routeChoice), next start() emits a FRESH prompt (Codex r7 P1.3)', async () => {
    const a = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    // App-socket cancel: routeChoice → store.resolve writes the row's
    // resolution_value=__cancel__. Mirror that here.
    await buttonStore.resolve({
      choice: {
        prompt_id: a.prompt_id,
        choice_value: '__cancel__',
        chosen_at: 1234,
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
    })
    await engine.acceptChoice({
      user_id: 'u-1',
      project_slug: 't1',
      choice: {
        prompt_id: a.prompt_id,
        choice_value: '__cancel__',
        chosen_at: 1234,
        speaker_user_id: 'u-1',
        channel_kind: 'app-socket',
      },
    })
    // Time passes past the original prompt's expires_at so the sweep-
    // resolved row is treated as stale on re-emit.
    await db.run(`UPDATE button_prompts SET expires_at = 0 WHERE prompt_id = ?`, [a.prompt_id])
    const sentBefore = sentPrompts.length
    const b = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    expect(b.was_new).toBe(true)
    expect(b.prompt_id).not.toBe(a.prompt_id)
    expect(sentPrompts.length).toBe(sentBefore + 1)
  })

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

  test('acceptChoice without prior start throws owner_state_missing', async () => {
    const choice: ButtonChoice = {
      prompt_id: '00000000-0000-0000-0000-000000000000',
      choice_value: 'x',
      chosen_at: 1234,
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    }
    try {
      await engine.acceptChoice({ project_slug: 't1', user_id: 'u-1', choice })
    } catch (err) {
      expect((err as Error).name).toBe('InterviewError')
      return
    }
    throw new Error('expected throw')
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
