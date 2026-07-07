/**
 * K11b1 survivor (Codex BLOCKER B re-anchor) — final-handoff prompt
 * RENDERING contract.
 *
 * The original coverage lived in the deleted `final-handoff-*.test.ts`
 * suites (final-handoff-emit, -emit-telegram-variant, -mobile-app-button,
 * -telegram-bind-button + friends), which drove the engine via
 * `engine.advance` + button-choice taps (the conversational drive K11b1
 * excised). The builders in `final-handoff-prompts.ts` and the engine's
 * completion-time emit (`emitFinalHandoffPrompt`, engine.ts:1987, called
 * from `dispatchWowAndAdvance`'s success path) are RETAINED and still
 * reachable from live code, so the rendering contract is re-pinned here:
 *
 *   Part 1 — the retained builders DIRECTLY (pure spec output):
 *     * initial handoff, web (`app-socket`): items 7+9 SHORT-close shape
 *       — single mobile-app CTA + freeform, LEFT pointer, no project
 *       re-list, actionable invite, tweak-later promise.
 *     * initial handoff, telegram: buttons-free variant (the user is
 *       already on their phone; Telegram-bind/Skip CTAs removed).
 *     * mobile-app follow-up: MOBILE_APP_URL surfaced + single Done;
 *       empty URL → null (Open-surface honesty fix, Argus PR #15).
 *     * telegram-bind follow-up: `t.me/<bot>?start=bind_<token>` deep
 *       link + Done.
 *     * skip follow-up + freeform keyword routing.
 *
 *   Part 2 — the engine EMIT wiring through the retained seam:
 *     `emitCurrentPhasePrompt` at `max_oauth_offered` with Max attached
 *     auto-advances → wow dispatch → `completed`, and the final-handoff
 *     prompt must be EMITTED (durable ButtonStore row + channel send)
 *     as the terminal General message, with the once-per-instance
 *     `onboarding_handoff_emitted_at` idempotency gate honoured.
 *
 * NO deleted drive methods (`advance`/`consumeChoice`/`start`) are used.
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
  type MaxOauthSecretsStore,
  type WowDispatcherHook,
  type WowDispatcherHookInput,
  type WowDispatcherHookOutcome,
} from '../engine.ts'
import { SqliteOnboardingStateStore } from '../sqlite-state-store.ts'
import { TranscriptWriter } from '../transcript.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import {
  FINAL_HANDOFF_DONE_CHOICE,
  FINAL_HANDOFF_METADATA_TAG,
  FINAL_HANDOFF_MOBILE_APP_CHOICE,
  FINAL_HANDOFF_SKIP_CHOICE,
  FINAL_HANDOFF_TELEGRAM_BIND_CHOICE,
  buildFinalHandoffMobileAppFollowupPromptSpec,
  buildFinalHandoffPromptSpec,
  buildFinalHandoffSkipFollowupPromptSpec,
  buildFinalHandoffTelegramBindFollowupPromptSpec,
  routeFinalHandoffFreeform,
} from '../final-handoff-prompts.ts'

// ---------------------------------------------------------------------------
// Part 1 — retained builders, engine-free (the cleanest re-anchor: the
// prompt SHAPE contract is pure builder output).
// ---------------------------------------------------------------------------

describe('final-handoff builders (K11b1 survivor, engine-free)', () => {
  test('web (app-socket) initial: short close — single mobile-app button + freeform, LEFT pointer, no project re-list', () => {
    // Ported from deleted final-handoff-emit.test.ts "emits short close".
    const spec = buildFinalHandoffPromptSpec({
      channel_kind: 'app-socket',
      user_first_name: 'Sam',
      project_names: [
        'Topline',
        'Northwind Labs',
        'Acme',
        'Acme Holdco',
        'n8n Automation',
        'Home Assistant',
        'LA Property',
      ],
    })
    expect(spec.phase).toBe('completed')
    expect(spec.metadata?.[FINAL_HANDOFF_METADATA_TAG]).toBe(true)
    expect(spec.metadata?.['final_handoff_shape']).toBe('initial')
    expect(spec.metadata?.['final_handoff_channel']).toBe('app-socket')
    // Single mobile-app button + freeform (Telegram-bind + Skip dropped —
    // items 7+9, 2026-06-19 owner live-dogfood).
    expect(spec.options.length).toBe(1)
    expect(spec.allow_freeform).toBe(true)
    const values = spec.options.map((o) => o.value)
    expect(values).toContain(FINAL_HANDOFF_MOBILE_APP_CHOICE)
    expect(values).not.toContain(FINAL_HANDOFF_TELEGRAM_BIND_CHOICE)
    expect(values).not.toContain(FINAL_HANDOFF_SKIP_CHOICE)
    // Greeting includes the first name; body points LEFT to the sidebar.
    expect(spec.body).toContain('Sam')
    expect(spec.body.toLowerCase()).toContain('left')
    // The SHORT close does NOT re-enumerate the confirmed projects.
    expect(spec.body).not.toContain('Northwind Labs')
    expect(spec.body).not.toContain('LA Property')
    // It keeps the actionable invite + the tweak-later promise.
    expect(spec.body).toContain("What's something I can help you with right now?")
    expect(spec.body.toLowerCase()).toContain('rename')
    // The sole button is the mobile-app affordance.
    const labels = spec.options.map((o) => o.body.toLowerCase())
    expect(labels.some((l) => l.includes('mobile'))).toBe(true)
  })

  test('web initial: no-projects fallback keeps the General pointer, never claims "spun up 0"', () => {
    // Ported from deleted final-handoff-emit.test.ts "renders no-projects
    // fallback when primary_projects_confirmed is empty".
    const spec = buildFinalHandoffPromptSpec({
      channel_kind: 'app-socket',
      user_first_name: 'Sam',
      project_names: [],
    })
    expect(spec.body.toLowerCase()).toContain('general')
    expect(spec.body).not.toContain('I have spun up 0')
    expect(spec.options.length).toBe(1)
    expect(spec.options[0]?.value).toBe(FINAL_HANDOFF_MOBILE_APP_CHOICE)
  })

  test('missing first name → neutral greeting, never "undefined"', () => {
    const spec = buildFinalHandoffPromptSpec({
      channel_kind: 'app-socket',
      user_first_name: null,
      project_names: ['Topline'],
    })
    expect(spec.body).not.toContain('undefined')
    expect(spec.body).toContain("Everything's ready.")
  })

  test('telegram initial: buttons-free + freeform close (no mobile/skip/telegram-bind CTAs)', () => {
    // Ported from deleted final-handoff-emit-telegram-variant.test.ts.
    const spec = buildFinalHandoffPromptSpec({
      channel_kind: 'telegram',
      user_first_name: 'Sam',
      project_names: ['Topline', 'Northwind Labs'],
    })
    expect(spec.metadata?.[FINAL_HANDOFF_METADATA_TAG]).toBe(true)
    expect(spec.metadata?.['final_handoff_channel']).toBe('telegram')
    // Buttons-free close — the user answers the invite by typing.
    expect(spec.options.length).toBe(0)
    expect(spec.allow_freeform).toBe(true)
    const values = spec.options.map((o) => o.value)
    expect(values).not.toContain(FINAL_HANDOFF_MOBILE_APP_CHOICE)
    expect(values).not.toContain(FINAL_HANDOFF_SKIP_CHOICE)
    expect(values).not.toContain(FINAL_HANDOFF_TELEGRAM_BIND_CHOICE)
    // Ends with the actionable invite so General doesn't dead-end.
    expect(spec.body).toContain("What's something I can help you with right now?")
  })

  test('mobile-app follow-up: surfaces the injected URL + single Done affordance', () => {
    // Ported from deleted final-handoff-mobile-app-button.test.ts (the
    // spec-shape assertions; the tap plumbing died with the drive).
    const url = 'https://app.test.neutron.example/mobile'
    const spec = buildFinalHandoffMobileAppFollowupPromptSpec(url)
    expect(spec).not.toBeNull()
    expect(spec!.body).toContain(url)
    expect(spec!.metadata?.['final_handoff_mobile_app_url']).toBe(url)
    expect(spec!.metadata?.['final_handoff_shape']).toBe('mobile-app')
    expect(spec!.options.length).toBe(1)
    expect(spec!.options[0]?.body.toLowerCase()).toContain('done')
    expect(spec!.options[0]?.value).toBe(FINAL_HANDOFF_DONE_CHOICE)
  })

  test('mobile-app follow-up: empty/whitespace URL → null (suppressed — no dangling-link copy)', () => {
    // Ported from deleted final-handoff-mobile-app-button.test.ts "empty
    // mobile-app URL → no follow-up" (Open-surface honesty fix, Argus PR #15).
    expect(buildFinalHandoffMobileAppFollowupPromptSpec('')).toBeNull()
    expect(buildFinalHandoffMobileAppFollowupPromptSpec('   ')).toBeNull()
  })

  test('telegram-bind follow-up: t.me/<bot>?start=bind_<token> deep link + Done', () => {
    // Ported from deleted final-handoff-telegram-bind-button.test.ts (the
    // spec-shape assertions).
    const spec = buildFinalHandoffTelegramBindFollowupPromptSpec({
      bot_username: 'neutron_test_bot',
      bind_token: 'tok-abc-123',
    })
    expect(spec.body).toContain('https://t.me/neutron_test_bot?start=bind_tok-abc-123')
    expect(spec.metadata?.['final_handoff_shape']).toBe('telegram-bind')
    expect(spec.metadata?.['final_handoff_telegram_bind_link']).toBe(
      'https://t.me/neutron_test_bot?start=bind_tok-abc-123',
    )
    expect(spec.options.length).toBe(1)
    expect(spec.options[0]?.body.toLowerCase()).toContain('done')
    expect(spec.options[0]?.value).toBe(FINAL_HANDOFF_DONE_CHOICE)
    // Telegram start-payload grammar: no colon/dot/plus in the payload tail.
    expect(spec.body).toMatch(/start=bind_[A-Za-z0-9_-]+/)
  })

  test('skip follow-up: buttons-free ack that never promises a chat interaction', () => {
    const spec = buildFinalHandoffSkipFollowupPromptSpec()
    expect(spec.metadata?.['final_handoff_shape']).toBe('skip')
    expect(spec.options.length).toBe(0)
    expect(spec.body.toLowerCase()).toContain('come back')
  })

  test('freeform routing: keyword map per shape (telegram before mobile; skip shape routes null)', () => {
    // Initial shape — telegram must match before mobile.
    expect(routeFinalHandoffFreeform('the telegram one please', 'initial')).toBe(
      FINAL_HANDOFF_TELEGRAM_BIND_CHOICE,
    )
    expect(routeFinalHandoffFreeform('get the mobile app', 'initial')).toBe(
      FINAL_HANDOFF_MOBILE_APP_CHOICE,
    )
    expect(routeFinalHandoffFreeform('maybe later', 'initial')).toBe(
      FINAL_HANDOFF_SKIP_CHOICE,
    )
    expect(routeFinalHandoffFreeform('what is the weather', 'initial')).toBeNull()
    // Follow-up shapes — only "done"-class replies route.
    expect(routeFinalHandoffFreeform('done', 'mobile-app')).toBe(FINAL_HANDOFF_DONE_CHOICE)
    expect(routeFinalHandoffFreeform('ok thanks', 'telegram-bind')).toBe(
      FINAL_HANDOFF_DONE_CHOICE,
    )
    expect(routeFinalHandoffFreeform('tell me a joke', 'mobile-app')).toBeNull()
    // Skip shape routes nothing.
    expect(routeFinalHandoffFreeform('ok put Neutron on my phone', 'skip')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Part 2 — engine emit wiring through the RETAINED auto-advance seam
// (`emitCurrentPhasePrompt` → maybeAutoAdvancePastMaxOauthOffered →
// advanceFromMaxOauthOffered → dispatchWowAndAdvance → emitFinalHandoffPrompt).
// ---------------------------------------------------------------------------

const OWNER = 'casey'
const USER = 'u-1'
const TOPIC = `web:${USER}`
const T0 = 1_700_000_000_000

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore
let stateStore: SqliteOnboardingStateStore
let transcript: TranscriptWriter
let savedEnvToken: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-final-handoff-survivor-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db })
  stateStore = new SqliteOnboardingStateStore({ db })
  transcript = new TranscriptWriter({
    path: join(tmp, 'persona', 'onboarding-transcript.jsonl'),
  })
  savedEnvToken = process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
})

afterEach(() => {
  if (savedEnvToken !== undefined) {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = savedEnvToken
  } else {
    delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  }
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeAttachedSecrets(): MaxOauthSecretsStore {
  return {
    put: async () => ({ id: 's-put' }),
    list: async (input) =>
      input.kind === 'max_oauth_refresh'
        ? [{ id: 's-1', label: 'max', kind: 'max_oauth_refresh' }]
        : [],
  }
}

function makeDispatchRecorder(): {
  hook: WowDispatcherHook
  calls: WowDispatcherHookInput[]
} {
  const calls: WowDispatcherHookInput[] = []
  const dispatch = async (
    input: WowDispatcherHookInput,
  ): Promise<WowDispatcherHookOutcome> => {
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
    }
  }
  return { hook: { dispatch }, calls }
}

interface SentPrompt {
  project_slug: string
  topic_id: string
  prompt: ButtonPrompt
}

function buildEngine(): { engine: InterviewEngine; sent: SentPrompt[] } {
  const sent: SentPrompt[] = []
  const sendButtonPrompt = async (input: SentPrompt) => {
    sent.push(input)
    return { message_id: `msg-${sent.length}`, was_new: true }
  }
  const engine = new InterviewEngine({
    buttonStore,
    stateStore,
    transcript,
    sendButtonPrompt,
    wowDispatcher: makeDispatchRecorder().hook,
    secrets: makeAttachedSecrets(),
  })
  return { engine, sent }
}

async function seedAndAutoAdvance(engine: InterviewEngine): Promise<void> {
  await stateStore.upsert({
    user_id: USER,
    project_slug: OWNER,
    phase: 'max_oauth_offered',
    phase_state_patch: {
      user_id: USER,
      topic_id: TOPIC,
      user_first_name: 'Sam',
      primary_projects_confirmed: ['Topline', 'Northwind Labs', 'Acme'],
    },
  })
  await engine.emitCurrentPhasePrompt({
    project_slug: OWNER,
    user_id: USER,
    topic_id: TOPIC,
    observed_at: T0,
  })
}

describe('final-handoff emit via retained auto-advance seam (K11b1 survivor)', () => {
  test('completion emits the final-handoff prompt as the terminal message, stamped on the completed row', async () => {
    // Ported from deleted final-handoff-emit.test.ts "state.phase ===
    // completed AND active_prompt_id is the handoff prompt" + the shape
    // assertions of the emit test — re-anchored on the retained seam.
    const { engine, sent } = buildEngine()
    await seedAndAutoAdvance(engine)
    expect(sent.length).toBeGreaterThan(0)
    const last = sent[sent.length - 1]!
    expect(last.topic_id).toBe(TOPIC)
    const prompt = last.prompt
    // It IS the final-handoff prompt, in its web initial shape.
    expect(prompt.metadata?.[FINAL_HANDOFF_METADATA_TAG]).toBe(true)
    expect(prompt.metadata?.['final_handoff_shape']).toBe('initial')
    expect(prompt.options.length).toBe(1)
    expect(prompt.options[0]?.value).toBe(FINAL_HANDOFF_MOBILE_APP_CHOICE)
    expect(prompt.allow_freeform).toBe(true)
    expect(prompt.body).toContain('Sam')
    expect(prompt.body).toContain("What's something I can help you with right now?")
    // State: completed, wow fired, active prompt = the handoff, and the
    // once-per-instance marker stamped.
    const s = await stateStore.get(OWNER, USER)
    expect(s).not.toBeNull()
    expect(s!.phase).toBe('completed')
    expect(s!.wow_fired).toBe(true)
    expect(s!.phase_state['active_prompt_id']).toBe(prompt.prompt_id)
    expect(s!.phase_state['final_handoff_active']).toBe(true)
    expect(s!.phase_state['final_handoff_shape']).toBe('initial')
    expect(typeof s!.onboarding_handoff_emitted_at).toBe('number')
  })

  test('once-per-instance gate: a crash-resume second pass does NOT re-emit the handoff', async () => {
    // Ports the onboarding_handoff_emitted_at idempotency contract
    // (sprint 2026-06-03 § 5) previously exercised via the deleted
    // drive: after a simulated restart the completion path re-runs but
    // the guide is never double-emitted.
    const { engine, sent } = buildEngine()
    await seedAndAutoAdvance(engine)
    const handoffEmits = sent.filter(
      (p) => p.prompt.metadata?.[FINAL_HANDOFF_METADATA_TAG] === true,
    )
    expect(handoffEmits.length).toBe(1)

    // Simulated mid-flight restart: rewind the phase, KEEP the
    // onboarding_handoff_emitted_at stamp (upsert leaves omitted fields
    // untouched).
    await stateStore.upsert({
      project_slug: OWNER,
      user_id: USER,
      phase: 'max_oauth_offered',
      phase_state_patch: {
        active_prompt_id: null,
        wow_report: null,
        wow_dispatch_error: null,
      },
      advanced_at: T0 + 2_000,
    })
    await engine.emitCurrentPhasePrompt({
      project_slug: OWNER,
      user_id: USER,
      topic_id: TOPIC,
      observed_at: T0 + 3_000,
    })
    const after = sent.filter(
      (p) => p.prompt.metadata?.[FINAL_HANDOFF_METADATA_TAG] === true,
    )
    // Still exactly ONE handoff emit — the gate suppressed the re-emit.
    expect(after.length).toBe(1)
    const s = await stateStore.get(OWNER, USER)
    expect(s!.phase).toBe('completed')
  })
})
