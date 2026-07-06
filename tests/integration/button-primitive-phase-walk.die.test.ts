// DIES WITH K11b1 — pins engine.advance choice-consumption phase transition, deleted in K11b1.
//
// These assertions were split out of `button-primitive-cross-channel.test.ts`
// (K11a6-rem re-anchor). That file's button-primitive / adapter / router
// coverage was re-anchored off the engine and survives K11b1; the two
// phase-walk assertions below still legitimately drive the LIVE interview
// engine — `engine.start` emits the signup prompt and `engine.advance`
// (→ consumeChoice → AUTO_SKIP walker) transitions signup → instance_provisioned
// → import_offered → ai_substrate_offered when the button choice is consumed.
// That drive is live at HEAD (engine.ts:693 start, :1728 advance) and is
// deleted by K11b1, which will co-delete this whole file. Until then this
// pins the phase transition so the still-live code is not left unpinned.
//
// Byte-preserved from the original cross-channel spec's engine-driven flow:
//   Given: an interview-engine spawn (signup phase) that emits a 1-option
//     `ButtonPrompt`; the tap is routed via DefaultButtonRouter → the
//     engine's `advance(...)` path (matching the app-ws / chat-bridge
//     button_choice wiring).
//   Then: after the choice is consumed, the persisted phase has walked
//     signup → instance_provisioned → import_offered → ai_substrate_offered
//     (T9 AUTO_SKIP walker, Codex r1 P2).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import { DefaultButtonRouter } from '@neutronai/channels/button-routing.ts'
import { buildTelegramCallbackHandler } from '@neutronai/channels/adapters/telegram/callback-router.ts'
import {
  encodeCallbackData,
  renderButtonPromptTelegram,
} from '@neutronai/channels/adapters/telegram/render-button-prompt.ts'
import {
  renderButtonPromptAppSocket,
  parseAppSocketButtonChoice,
  type AppSocketButtonPromptMessage,
} from '@neutronai/channels/adapters/app-socket/render-button-prompt.ts'
import { createMockAppSocketServer } from '@neutronai/channels/adapters/app-socket/socket-server.ts'
import { InterviewEngine } from '@neutronai/onboarding/interview/engine.ts'
import type { PhaseSpecResolver } from '@neutronai/onboarding/interview/phase-spec-resolver.ts'
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'
import { InMemoryOnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'

// A prompt WITH options to exercise the tap roundtrip; a deterministic
// `phaseSpecResolver` stub returns a single-option signup spec that advances
// to `instance_provisioned` (in AUTO_SKIP_PHASES → falls through to
// import_offered → ai_substrate_offered).
const S1_PROMPT_OPTIONS: ReadonlyArray<{ value: string; label: string; body: string }> = [
  { value: 'use-telegram-name', label: 'A', body: 'Use my Telegram display name' },
]
const TEST_SIGNUP_BODY = "What's your name?"
const fixedSignupResolver: PhaseSpecResolver = {
  async resolve(bundle) {
    if (bundle.phase !== 'signup') return null
    return {
      phase: 'signup',
      body: TEST_SIGNUP_BODY,
      options: S1_PROMPT_OPTIONS.map((o) => ({ ...o })),
      allow_freeform: true,
      next_phase_on_default: 'instance_provisioned',
    }
  },
}

let tmp: string
let db: ProjectDb
let store: ButtonStore
let router: DefaultButtonRouter
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let engine: InterviewEngine
let receivedChoiceValues: string[]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-int-bp-phasewalk-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new ButtonStore({ db })
  router = new DefaultButtonRouter({ store })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({ path: join(tmp, 'persona', 'onboarding-transcript.jsonl') })
  receivedChoiceValues = []

  engine = new InterviewEngine({
    buttonStore: store,
    stateStore,
    transcript,
    sendButtonPrompt: async ({ prompt }) => {
      renderButtonPromptTelegram(prompt)
      return { message_id: 'msg', was_new: true }
    },
    phaseSpecResolver: fixedSignupResolver,
  })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeCallbackHandler() {
  return buildTelegramCallbackHandler({
    buttonRouter: {
      routeChoice: async (input) => {
        const result = await router.routeChoice(input)
        if (result.delivered && result.prompt) {
          // Drive the PRODUCTION engine path (`advance` with a ButtonChoice),
          // matching the app-ws / chat-bridge button_choice wiring.
          await engine.advance({
            user_id: 'u-1',
            project_slug: 't1',
            topic_id: 'topic-1',
            channel_kind: 'telegram',
            choice: result.choice,
          })
          receivedChoiceValues.push(result.choice.choice_value)
        }
        return result
      },
    },
    telegram: {
      answerCallbackQuery: async () => true as const,
    },
  })
}

describe('button-primitive phase-walk (DIES WITH K11b1) — Telegram tap → engine.advance transition', () => {
  test('signup tap → engine.advance walks phase to ai_substrate_offered', async () => {
    const start = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })

    const handler = makeCallbackHandler()
    const optAValue = S1_PROMPT_OPTIONS[0]?.value ?? 'use-telegram-name'
    const callback_data = encodeCallbackData(start.prompt_id, optAValue)
    const result = await handler({ id: 'cb-1', data: callback_data, from_user_id: 'u-1' })
    expect(result.delivered).toBe(true)
    expect(receivedChoiceValues).toEqual([optAValue])

    const state = await stateStore.get('t1', 'u-1')
    // 2026-05-14 — T9 (Codex r1 P2): signup → instance_provisioned →
    // import_offered via the AUTO_SKIP walker on the advance choice path.
    expect(state?.phase).toBe('ai_substrate_offered')
  })
})

describe('button-primitive phase-walk (DIES WITH K11b1) — app-socket tap → engine.advance transition', () => {
  test('app-socket signup tap → engine.advance walks phase to ai_substrate_offered', async () => {
    const tmpDir2 = mkdtempSync(join(tmpdir(), 'neutron-int-bp-phasewalk-as-'))
    const db2 = ProjectDb.open(join(tmpDir2, 'owner.db'))
    applyMigrations(db2.raw())
    const store2 = new ButtonStore({ db: db2 })
    const router2 = new DefaultButtonRouter({ store: store2 })
    const stateStore2 = new InMemoryOnboardingStateStore()
    const transcript2 = new TranscriptWriter({ path: join(tmpDir2, 'persona', 'onboarding-transcript.jsonl') })
    const server = createMockAppSocketServer()

    const sentEnvelopes: AppSocketButtonPromptMessage[] = []
    server.onOutbound((env) => {
      sentEnvelopes.push(env)
    })

    const engine2 = new InterviewEngine({
      buttonStore: store2,
      stateStore: stateStore2,
      transcript: transcript2,
      sendButtonPrompt: async ({ prompt }) => {
        const peek = await store2.peek(prompt.prompt_id)
        if (peek === null) throw new Error('expected ButtonStore row to exist after engine.start')
        server.send(renderButtonPromptAppSocket({ prompt, expires_at_ms: peek.expires_at }))
        await store2.markDelivered(prompt.prompt_id)
        return { message_id: `socket-${sentEnvelopes.length}`, was_new: true }
      },
      phaseSpecResolver: fixedSignupResolver,
    })

    server.onInbound(async (envelope) => {
      const parsed = parseAppSocketButtonChoice(envelope)
      if (parsed === null) return
      const result = await router2.routeChoice({
        prompt_id: parsed.prompt_id,
        raw_value: parsed.raw_value,
        speaker_user_id: parsed.speaker_user_id,
        channel_kind: 'app-socket',
        ...(parsed.freeform_text !== undefined ? { freeform_text: parsed.freeform_text } : {}),
      })
      if (result.delivered) {
        await engine2.advance({
          project_slug: 't2',
          user_id: 'u-as-1',
          topic_id: 'topic-as-1',
          channel_kind: 'app-socket',
          choice: result.choice,
        })
      }
    })

    const start = await engine2.start({
      project_slug: 't2',
      topic_id: 'topic-as-1',
      user_id: 'u-as-1',
      signup_via: 'telegram',
    })
    expect(sentEnvelopes.length).toBe(1)

    const optAValue = S1_PROMPT_OPTIONS[0]?.value ?? 'use-telegram-name'
    await server.deliverChoice({
      v: 1,
      type: 'button_choice',
      prompt_id: start.prompt_id,
      choice_value: optAValue,
      speaker_user_id: 'u-as-1',
    })

    const state = await stateStore2.get('t2', 'u-as-1')
    // 2026-05-14 — T9 (Codex r1 P2): signup → instance_provisioned →
    // import_offered via the AUTO_SKIP walker on the advance choice path.
    expect(state?.phase).toBe('ai_substrate_offered')

    server.close()
    db2.close()
    rmSync(tmpDir2, { recursive: true, force: true })
  })
})
