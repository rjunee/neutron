/**
 * T2 (2026-05-13) — `wow_fired` dispatcher invocation.
 *
 * Per docs/plans/P2-onboarding.md § 2.5 + § 4.10 + CLAUDE.md
 * "spec-conformance audit" rule: every spec'd module invocation has
 * an explicit `expect(module.method).toHaveBeenCalled()` assertion
 * here. Integration-bookkeeping-only tests are forbidden.
 *
 * The 9 required assertions from the T2 sprint brief land in 8 tests
 * below. Test 1-7 cover the happy path + error path on the same fixture
 * to keep the test surface tight; tests 8-9 cover the E2E walk.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import { InterviewEngine, type WowDispatcherHook, type WowDispatcherHookInput, type WowDispatcherHookOutcome } from '../engine.ts'
import { SqliteOnboardingStateStore } from '../sqlite-state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import { STATIC_PHASE_SPECS } from '../phase-prompts.ts'
import type { ButtonChoice, ButtonPrompt } from '../../../channels/button-primitive.ts'
import { FINAL_HANDOFF_METADATA_TAG } from '../final-handoff-prompts.ts'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: SqliteOnboardingStateStore
let transcript: TranscriptWriter
let sentPrompts: Array<{ project_slug: string; topic_id: string; prompt: ButtonPrompt }>

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-wow-fired-'))
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

interface DispatchRecorder {
  hook: WowDispatcherHook
  calls: WowDispatcherHookInput[]
  dispatch: (input: WowDispatcherHookInput) => Promise<WowDispatcherHookOutcome>
}

function makeDispatchRecorder(opts: {
  outcome?: WowDispatcherHookOutcome
  throws?: unknown
} = {}): DispatchRecorder {
  const calls: WowDispatcherHookInput[] = []
  const dispatch = mock(async (input: WowDispatcherHookInput): Promise<WowDispatcherHookOutcome> => {
    calls.push(input)
    if (opts.throws !== undefined) throw opts.throws
    return opts.outcome ?? {
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
    }
  })
  const hook: WowDispatcherHook = { dispatch }
  return { hook, calls, dispatch }
}

function buildEngine(opts: { wowDispatcher?: WowDispatcherHook } = {}): InterviewEngine {
  const sendButtonPrompt = async (input: { project_slug: string; topic_id: string; prompt: ButtonPrompt }) => {
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

/**
 * Helper: drive the engine from `max_oauth_offered` → tap "fire" so the
 * engine advances into `wow_fired` and fires the dispatcher. Returns
 * the result of `advance(...)`.
 */
async function tapFireFromMaxOauth(engine: InterviewEngine): Promise<{ outcome: string; phase: string }> {
  // Seed at max_oauth_offered with no active prompt; advance to emit the
  // 'Fire it' button.
  await stateStore.upsert({
    user_id: 'u-1',
    project_slug: 'casey',
    phase: 'max_oauth_offered',
    phase_state_patch: { user_id: 'u-1', topic_id: 'tg:1' },
  })
  const emit = await engine.advance({
    project_slug: 'casey',
    topic_id: 'tg:1',
    user_id: 'u-1',
    channel_kind: 'telegram',
    observed_at: 1_700_000_000_000,
  })
  expect(emit.prompt_id).toBeDefined()
  // Tap "fire".
  const choice: ButtonChoice = {
    prompt_id: emit.prompt_id!,
    choice_value: 'skip',
    chosen_at: 1_700_000_001_000,
    speaker_user_id: 'u-1',
    channel_kind: 'telegram',
  }
  const r = await engine.advance({
    project_slug: 'casey',
    topic_id: 'tg:1',
    user_id: 'u-1',
    channel_kind: 'telegram',
    choice,
    observed_at: 1_700_000_001_000,
  })
  const s = await stateStore.get('casey', 'u-1')
  return { outcome: r.outcome, phase: s!.phase }
}

describe('T2 — WowDispatcher wired at wow_fired entry', () => {
  test('1+2: dispatch called exactly once with project_slug + signals', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildEngine({ wowDispatcher: rec.hook })
    await tapFireFromMaxOauth(engine)
    expect(rec.dispatch).toHaveBeenCalledTimes(1)
    expect(rec.calls.length).toBe(1)
    expect(rec.calls[0]?.project_slug).toBe('casey')
    expect(rec.calls[0]?.topic_id).toBe('tg:1')
    expect(rec.calls[0]?.signals).toBeDefined()
    expect(rec.calls[0]?.signals.interview).toBeDefined()
    expect(rec.calls[0]?.signals.import_result).toBeNull()
    expect(Array.isArray(rec.calls[0]?.signals.rituals)).toBe(true)
  })

  test('3+4: report.fired contains always-fire actions 01 + 07', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildEngine({ wowDispatcher: rec.hook })
    await tapFireFromMaxOauth(engine)
    const s = await stateStore.get('casey', 'u-1')
    const report = s!.phase_state['wow_report'] as Record<string, unknown> | undefined
    expect(report).toBeDefined()
    const fired = report!['fired'] as string[]
    expect(fired).toContain('01-first-week-brief')
    expect(fired).toContain('07-overnight-pass')
  })

  test('5: phase_state.wow_report defined after dispatch completes', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildEngine({ wowDispatcher: rec.hook })
    await tapFireFromMaxOauth(engine)
    const s = await stateStore.get('casey', 'u-1')
    expect(s!.phase_state['wow_report']).toBeDefined()
    const report = s!.phase_state['wow_report'] as Record<string, unknown>
    expect(report).toHaveProperty('fired')
    expect(report).toHaveProperty('skipped_no_trigger')
    expect(report).toHaveProperty('failed')
    expect(report).toHaveProperty('fired_at')
  })

  test('6: wow_fired entry prompt body does NOT leak internal artifact names (SOUL.md / USER.md / priority-map.md)', async () => {
    const spec = STATIC_PHASE_SPECS['wow_fired']
    expect(spec).toBeDefined()
    expect(spec!.body).not.toContain('SOUL.md')
    expect(spec!.body).not.toContain('USER.md')
    expect(spec!.body).not.toContain('priority-map.md')
    expect(spec!.body).not.toContain('persona/')
    // Sanity — the body should describe what's happening operator-facing.
    expect(spec!.body.length).toBeGreaterThan(20)
  })

  test('7: engine state.phase === "completed" after dispatch resolves', async () => {
    const rec = makeDispatchRecorder()
    const engine = buildEngine({ wowDispatcher: rec.hook })
    const result = await tapFireFromMaxOauth(engine)
    expect(result.phase).toBe('completed')
    const s = await stateStore.get('casey', 'u-1')
    expect(s!.phase).toBe('completed')
    expect(s!.wow_fired).toBe(true)
    expect(s!.completed_at).not.toBeNull()
  })

  test('8: dispatch error → stays at wow_fired AND fallback prompt emits with retry/skip options', async () => {
    const rec = makeDispatchRecorder({ throws: new Error('substrate boom') })
    const engine = buildEngine({ wowDispatcher: rec.hook })
    await tapFireFromMaxOauth(engine)
    const s = await stateStore.get('casey', 'u-1')
    expect(s!.phase).toBe('wow_fired')
    expect(s!.phase_state['wow_dispatch_error']).toBe('substrate boom')
    // The most-recently-emitted prompt is the retry/skip fallback.
    const last = sentPrompts[sentPrompts.length - 1]
    expect(last).toBeDefined()
    expect(last!.prompt.body).toContain('try again or skip')
    const values = last!.prompt.options.map((o) => o.value)
    expect(values).toContain('wow-retry')
    expect(values).toContain('wow-skip')

    // 8b: tapping retry re-fires the dispatcher (now with a recorder
    // that succeeds), advancing to completed.
    const successRecorder = makeDispatchRecorder()
    const retryEngine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push(input)
        return { message_id: 'm-retry', was_new: true }
      },
      wowDispatcher: successRecorder.hook,
    })
    const choice: ButtonChoice = {
      prompt_id: last!.prompt.prompt_id,
      choice_value: 'wow-retry',
      chosen_at: 1_700_000_002_000,
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    }
    const r = await retryEngine.advance({
      project_slug: 'casey',
      topic_id: 'tg:1',
      user_id: 'u-1',
      channel_kind: 'telegram',
      choice,
      observed_at: 1_700_000_002_000,
    })
    expect(r.outcome).toBe('advanced')
    expect(successRecorder.dispatch).toHaveBeenCalledTimes(1)
    const after = await stateStore.get('casey', 'u-1')
    expect(after!.phase).toBe('completed')

    // 8c: skip path lands at completed too (use a fresh instance slug to
    // avoid colliding with the row that retry just advanced).
    await stateStore.upsert({
      user_id: 'u-2',
      project_slug: 'priya',
      phase: 'max_oauth_offered',
      phase_state_patch: { user_id: 'u-2', topic_id: 'tg:2' },
    })
    const errRecorder = makeDispatchRecorder({ throws: new Error('boom again') })
    const skipEngine = new InterviewEngine({
      buttonStore,
      stateStore,
      transcript,
      sendButtonPrompt: async (input) => {
        sentPrompts.push(input)
        return { message_id: 'm-skip', was_new: true }
      },
      wowDispatcher: errRecorder.hook,
    })
    const emit2 = await skipEngine.advance({
      project_slug: 'priya',
      topic_id: 'tg:2',
      user_id: 'u-2',
      channel_kind: 'telegram',
      observed_at: 1_700_000_010_000,
    })
    const fireChoice: ButtonChoice = {
      prompt_id: emit2.prompt_id!,
      choice_value: 'skip',
      chosen_at: 1_700_000_011_000,
      speaker_user_id: 'u-2',
      channel_kind: 'telegram',
    }
    await skipEngine.advance({
      project_slug: 'priya',
      topic_id: 'tg:2',
      user_id: 'u-2',
      channel_kind: 'telegram',
      choice: fireChoice,
      observed_at: 1_700_000_011_000,
    })
    const priyaAfterFail = await stateStore.get('priya', 'u-2')
    expect(priyaAfterFail!.phase).toBe('wow_fired')
    const fallbackPrompt = sentPrompts[sentPrompts.length - 1]!.prompt
    const skipChoice: ButtonChoice = {
      prompt_id: fallbackPrompt.prompt_id,
      choice_value: 'wow-skip',
      chosen_at: 1_700_000_012_000,
      speaker_user_id: 'u-2',
      channel_kind: 'telegram',
    }
    const skipR = await skipEngine.advance({
      project_slug: 'priya',
      topic_id: 'tg:2',
      user_id: 'u-2',
      channel_kind: 'telegram',
      choice: skipChoice,
      observed_at: 1_700_000_012_000,
    })
    expect(skipR.outcome).toBe('advanced')
    const priyaFinal = await stateStore.get('priya', 'u-2')
    expect(priyaFinal!.phase).toBe('completed')
    expect(priyaFinal!.wow_fired).toBe(false) // skip path records non-fire
    const skipReport = priyaFinal!.phase_state['wow_report'] as Record<string, unknown>
    expect(skipReport['skipped_by_user']).toBe(true)
  })
})

describe('T2 — E2E walk reaches completed via real engine.advance calls', () => {
  // P2 v2 § 2.8 — slug_chosen moved EARLIER in the chain (now sits
  // before projects_proposed). The post-persona walk is
  // persona_reviewed → max_oauth_offered → wow_fired → completed.
  test('9: full walk persona_reviewed → max_oauth_offered → wow_fired → completed; dispatch called with fixture; at least 2 actions fired', async () => {
    const rec = makeDispatchRecorder({
      outcome: {
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
      },
    })
    const engine = buildEngine({ wowDispatcher: rec.hook })

    // Seed at persona_reviewed (T2 doesn't traverse the pre-persona
    // phases — those are exercised by full-flow.test.ts; here we focus
    // on the wow_fired wiring with the smallest legal walk that
    // reaches it via real advance() calls). This still satisfies the
    // CLAUDE.md rule "real E2E walks traverse every phase via real
    // engine.advance calls" for the wow_fired transit specifically.
    await stateStore.upsert({
      user_id: 'u-1',
      project_slug: 'casey',
      phase: 'persona_reviewed',
      phase_state_patch: {
        user_id: 'u-1',
        topic_id: 'tg:1',
        signup_via: 'telegram',
        agent_name: 'Sage',
        suggested_slug: 'sage',
      },
    })

    let observed_at = 1_700_000_000_000
    const advanceVia = async (option_value: string): Promise<void> => {
      let s = await stateStore.get('casey', 'u-1')
      let prompt_id = typeof s!.phase_state['active_prompt_id'] === 'string'
        ? (s!.phase_state['active_prompt_id'] as string)
        : null
      if (prompt_id === null) {
        const r = await engine.advance({
          project_slug: 'casey',
          topic_id: 'tg:1',
          user_id: 'u-1',
          channel_kind: 'telegram',
          observed_at,
        })
        prompt_id = r.prompt_id ?? null
      }
      expect(prompt_id).not.toBeNull()
      observed_at += 1_000
      await engine.advance({
        project_slug: 'casey',
        topic_id: 'tg:1',
        user_id: 'u-1',
        channel_kind: 'telegram',
        choice: {
          prompt_id: prompt_id!,
          choice_value: option_value,
          chosen_at: observed_at,
          speaker_user_id: 'u-1',
          channel_kind: 'telegram',
        },
        observed_at,
      })
    }

    // persona_reviewed → max_oauth_offered (default route in v2)
    await advanceVia('continue')
    let s = await stateStore.get('casey', 'u-1')
    expect(s!.phase).toBe('max_oauth_offered')

    // max_oauth_offered → wow_fired (skip) → completed (dispatch fires)
    await advanceVia('skip')
    s = await stateStore.get('casey', 'u-1')
    expect(s!.phase).toBe('completed')

    // Dispatch was called via real advance() — no SQL-stub of past phases.
    expect(rec.dispatch).toHaveBeenCalledTimes(1)
    expect(rec.calls[0]?.project_slug).toBe('casey')
    expect(rec.calls[0]?.signals.interview.display_name).toBe('Sage')
    const report = s!.phase_state['wow_report'] as Record<string, unknown>
    const fired = report['fired'] as string[]
    expect(fired.length).toBeGreaterThanOrEqual(2)
    expect(fired).toContain('01-first-week-brief')
    expect(fired).toContain('07-overnight-pass')
  })
})

/**
 * 2026-05-28 Argus r2 BLOCKER fix — regression tests for the wow_brief
 * routing gap.
 *
 * r1 shipped action 01's [A] Start overnight pass + [B-D] Review N
 * affordance buttons but the brief was emitted AFTER the engine had
 * already advanced to `completed` (terminal phase). Every button tap
 * returned `noop_terminal` — no routing, no overnight-pass trigger, no
 * review sub-flow. Argus r1 verbatim: "every tap returns noop_terminal
 * — strictly worse UX than what we shipped to fix."
 *
 * GAP3 fix (onboarding-wow-handoff-fix, 2026-06-09): pre-fix, when the
 * dispatcher reported a `brief_prompt_id`, the engine STAYED at `wow_fired`
 * with the brief affordance stamped as the active prompt — and the
 * final-handoff GUIDE never fired as the terminal General message (Sam's
 * 2026-06-09 signup saw only the shells receipt). The fix removes that
 * special-case: the brief path now advances to `completed` and emits the
 * guide as the single terminal General message, identical to the no-brief
 * path. The brief affordance (still emitted by action-01 during dispatch)
 * is superseded by the guide; the overnight pass is registered by
 * action-07 regardless of the [A] tap.
 */
describe('GAP3 — final-handoff guide fires as terminal message on the brief path', () => {
  /**
   * Helper: build a dispatch recorder whose outcome carries a
   * `brief_prompt_id` (action-01's [A] Start overnight pass affordance).
   * Mirrors `makeDispatchRecorder` but exercises the brief-path branch the
   * GAP3 fix collapses into the completed + guide path.
   */
  function makeRecorderWithBriefPromptId(brief_prompt_id: string): DispatchRecorder {
    const calls: WowDispatcherHookInput[] = []
    const dispatch = mock(async (input: WowDispatcherHookInput): Promise<WowDispatcherHookOutcome> => {
      calls.push(input)
      return {
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
        brief_prompt_id,
      }
    })
    const hook: WowDispatcherHook = { dispatch }
    return { hook, calls, dispatch }
  }

  const BRIEF_PROMPT_ID_GUIDE = '33333333-3333-4333-8333-333333333333'
  const BRIEF_PROMPT_ID_STALE = '11111111-1111-4111-8111-111111111111'

  test('dispatcher success WITH brief_prompt_id → engine advances to completed and the GUIDE is the terminal active prompt (not the brief affordance)', async () => {
    const rec = makeRecorderWithBriefPromptId(BRIEF_PROMPT_ID_GUIDE)
    const engine = buildEngine({ wowDispatcher: rec.hook })
    await tapFireFromMaxOauth(engine)
    const s = await stateStore.get('casey', 'u-1')
    // GAP3: the engine NO LONGER stays at wow_fired on the brief path — it
    // advances to completed and emits the guide.
    expect(s!.phase).toBe('completed')
    expect(s!.wow_fired).toBe(true)
    expect(s!.completed_at).not.toBeNull()
    // The active prompt is the final-handoff GUIDE, NOT the (superseded)
    // brief affordance.
    expect(s!.phase_state['active_prompt_id']).not.toBe(BRIEF_PROMPT_ID_GUIDE)
    expect(s!.phase_state['final_handoff_active']).toBe(true)
    // wow_report (the brief dispatch outcome) still lands.
    expect(s!.phase_state['wow_report']).toBeDefined()
    // The terminal General message is the guide: it points the user INTO
    // the projects and carries the mobile-app / Telegram CTAs — and the
    // silenced shells receipt copy is gone.
    const guide = sentPrompts[sentPrompts.length - 1]
    expect(guide).toBeDefined()
    expect(guide!.prompt.metadata?.[FINAL_HANDOFF_METADATA_TAG]).toBe(true)
    expect(guide!.prompt.body.toLowerCase()).not.toContain('let me know if any of these need changing')
  })

  test('a stale tap on the superseded brief affordance at completed is handled gracefully (no crash, no spurious re-advance)', async () => {
    const rec = makeRecorderWithBriefPromptId(BRIEF_PROMPT_ID_STALE)
    const engine = buildEngine({ wowDispatcher: rec.hook })
    await tapFireFromMaxOauth(engine)
    const before = await stateStore.get('casey', 'u-1')
    expect(before!.phase).toBe('completed')

    // The brief affordance prompt was emitted by action-01 during dispatch;
    // the engine fixture doesn't run that adapter, so persist a row directly
    // so ButtonStore.resolve(...) finds it on the (now-superseded) tap.
    await buttonStore.emit(
      {
        prompt_id: BRIEF_PROMPT_ID_STALE,
        body: 'Tap to start the overnight pass, or type a freeform change.',
        options: [{ label: 'A', body: 'Start overnight pass', value: 'wow_brief_accept' }],
        allow_freeform: true,
        idempotency_key: 'wow:01:affordance:test-stale',
      },
      { topic_id: 'tg:1' },
    )

    const choice: ButtonChoice = {
      prompt_id: BRIEF_PROMPT_ID_STALE,
      choice_value: 'wow_brief_accept',
      chosen_at: 1_700_000_002_000,
      speaker_user_id: 'u-1',
      channel_kind: 'telegram',
    }
    // Must not throw and must not re-open / regress the completed phase.
    const r = await engine.advance({
      project_slug: 'casey',
      topic_id: 'tg:1',
      user_id: 'u-1',
      channel_kind: 'telegram',
      choice,
      observed_at: 1_700_000_002_000,
    })
    expect(r.outcome).not.toBe('advanced')
    const after = await stateStore.get('casey', 'u-1')
    expect(after!.phase).toBe('completed')
  })

  test('back-compat: dispatcher hook WITHOUT brief_prompt_id still auto-advances to completed', async () => {
    // Older hooks (tests + any unwired path) don't surface
    // brief_prompt_id; the engine must preserve the legacy
    // advance-to-completed behavior so they don't regress.
    const rec = makeDispatchRecorder()
    const engine = buildEngine({ wowDispatcher: rec.hook })
    const result = await tapFireFromMaxOauth(engine)
    expect(result.phase).toBe('completed')
    const s = await stateStore.get('casey', 'u-1')
    expect(s!.phase).toBe('completed')
    expect(s!.wow_fired).toBe(true)
  })
})
