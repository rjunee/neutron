/**
 * Integration test for the P2 S1 button primitive cross-channel round-trip,
 * EXTENDED in S5 to cover the app-socket adapter.
 *
 * Per docs/plans/P2-onboarding.md § 6a:
 *
 *   Given (S1): an interview-engine spawn with one hardcoded phase that emits
 *     a 4-option `ButtonPrompt` body="What's your name?" via the Telegram
 *     adapter. A mock Telegram callback shipper.
 *   When:  mock Telegram delivers a `callback_query` with
 *     `callback_data='btn:<base64url-prompt-id>:opt-A'` for the first
 *     option's value.
 *   Then:  `ButtonStore.resolve` records the choice; the engine receives
 *     a `ButtonChoice{choice_value:'opt-A'}`; engine advances; subsequent
 *     re-delivery of the same callback returns `was_new:false`; second
 *     callback for an unknown prompt_id returns 200 with `delivered:false`.
 *   Mocks: Telegram client (records `sendMessage` calls); substrate
 *     (returns deterministic single-token-stream).
 *
 *   S5 EXTENSION: repeat the flow over a mock app-socket adapter
 *   (`channels/adapters/app-socket/socket-server.ts`). Asserts the same
 *   `ButtonChoice` shape arrives at the engine — cross-channel parity.
 */

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
// 2026-05-10 — the static signup fallback no longer ships A/B/C menu
// options. These cross-channel button-primitive tests need a prompt
// WITH options to exercise the tap roundtrip; we inject a deterministic
// `phaseSpecResolver` stub that returns a single-option spec. The stub
// is logically equivalent to what the LLM driver would emit when it
// judges a tap is friendlier than freeform — exercises the wire shape
// without depending on the old hardcoded menu copy.
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
      // 2026-05-14 — T9: signup advances to `instance_provisioned` per
      // the spec'd flow (was `name_chosen` as a shortcut pre-T9).
      // instance_provisioned is in AUTO_SKIP_PHASES and falls through
      // to import_offered.
      next_phase_on_default: 'instance_provisioned',
    }
  },
}
import { TranscriptWriter } from '@neutronai/onboarding/interview/transcript.ts'
import { InMemoryOnboardingStateStore } from '@neutronai/onboarding/interview/state-store.ts'
import type { ButtonChoice } from '@neutronai/channels/button-primitive.ts'

interface SendCall {
  text: string
  reply_markup: unknown
  topic_id: string
}

interface AnswerCall {
  callback_query_id: string
  text?: string
}

let tmp: string
let db: ProjectDb
let store: ButtonStore
let router: DefaultButtonRouter
let stateStore: InMemoryOnboardingStateStore
let transcript: TranscriptWriter
let engine: InterviewEngine
let sendCalls: SendCall[]
let answerCalls: AnswerCall[]
let receivedChoiceValues: string[]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-int-bp-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new ButtonStore({ db })
  router = new DefaultButtonRouter({ store })
  stateStore = new InMemoryOnboardingStateStore()
  transcript = new TranscriptWriter({ path: join(tmp, 'persona', 'onboarding-transcript.jsonl') })
  sendCalls = []
  answerCalls = []
  receivedChoiceValues = []

  engine = new InterviewEngine({
    buttonStore: store,
    stateStore,
    transcript,
    sendButtonPrompt: async ({ prompt, topic_id }) => {
      const rendered = renderButtonPromptTelegram(prompt)
      sendCalls.push({ text: rendered.text, reply_markup: rendered.reply_markup, topic_id })
      return { message_id: `msg-${sendCalls.length}`, was_new: true }
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
      // Wrap the production router so we can also feed the engine inline.
      // The production wiring (S2) lives in `gateway/composition.ts` —
      // the engine attaches a router-listener; here we mimic that wiring.
      routeChoice: async (input) => {
        const result = await router.routeChoice(input)
        if (result.delivered && result.prompt) {
          await engine.acceptChoice({
            user_id: 'u-1',
            project_slug: 't1',
            choice: result.choice,
          })
          receivedChoiceValues.push(result.choice.choice_value)
        }
        return result
      },
    },
    telegram: {
      answerCallbackQuery: async (input) => {
        const call: AnswerCall = { callback_query_id: input.callback_query_id }
        if (input.text !== undefined) call.text = input.text
        answerCalls.push(call)
        return true as const
      },
    },
  })
}

describe('button-primitive cross-channel — Telegram round-trip', () => {
  test('agent emits → render → user-tap → engine receives ButtonChoice', async () => {
    const start = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    expect(sendCalls.length).toBe(1)
    expect(sendCalls[0]?.text).toContain("What's your name?")

    const handler = makeCallbackHandler()
    // Pick the first hardcoded option's value
    const optAValue = S1_PROMPT_OPTIONS[0]?.value ?? 'use-telegram-name'
    const callback_data = encodeCallbackData(start.prompt_id, optAValue)
    const result = await handler({
      id: 'cb-1',
      data: callback_data,
      from_user_id: 'u-1',
    })
    expect(result.delivered).toBe(true)
    expect(result.was_new).toBe(true)
    expect(receivedChoiceValues).toEqual([optAValue])

    const state = await stateStore.get('t1', 'u-1')
    // 2026-05-14 — T9 (Codex r1 P2): signup → instance_provisioned →
    // import_offered via the AUTO_SKIP walker on acceptChoice path.
    // The user lands on the import-substrate picker, not stranded on
    // the hidden instance_provisioned transit.
    expect(state?.phase).toBe('ai_substrate_offered')
    expect(answerCalls.length).toBe(1)
  })

  test('re-delivery of the same callback returns was_new=false (idempotent)', async () => {
    const start = await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    const handler = makeCallbackHandler()
    const optAValue = S1_PROMPT_OPTIONS[0]?.value ?? 'use-telegram-name'
    const callback_data = encodeCallbackData(start.prompt_id, optAValue)
    const a = await handler({ id: 'cb-1', data: callback_data, from_user_id: 'u-1' })
    const b = await handler({ id: 'cb-1', data: callback_data, from_user_id: 'u-1' })
    expect(a.was_new).toBe(true)
    expect(b.was_new).toBe(false)
  })

  test('callback for an unknown prompt_id returns delivered=false', async () => {
    await engine.start({
      project_slug: 't1',
      topic_id: 'topic-1',
      user_id: 'u-1',
      signup_via: 'telegram',
    })
    const handler = makeCallbackHandler()
    const callback_data = encodeCallbackData(
      '00000000-0000-0000-0000-000000000000',
      'opt-X',
    )
    const result = await handler({
      id: 'cb-1',
      data: callback_data,
      from_user_id: 'u-1',
    })
    expect(result.delivered).toBe(false)
    expect(result.reason).toBe('unknown_prompt')
  })
})

// ─────────────────────────────────────────────────────────────────────
// S5 EXTENSION — app-socket round-trip + cross-channel parity assert
// ─────────────────────────────────────────────────────────────────────

describe('button-primitive cross-channel — app-socket round-trip (S5)', () => {
  test('agent emits via app-socket → user delivers choice → engine receives identical ButtonChoice', async () => {
    // Boot a SECOND engine wired over the mock app-socket transport.
    const tmpDir2 = mkdtempSync(join(tmpdir(), 'neutron-int-bp-as-'))
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
        const env = renderButtonPromptAppSocket({
          prompt,
          expires_at_ms: peek.expires_at,
        })
        server.send(env)
        await store2.markDelivered(prompt.prompt_id)
        return { message_id: `socket-${sentEnvelopes.length}`, was_new: true }
      },
      phaseSpecResolver: fixedSignupResolver,
    })

    let appSocketChoice: ButtonChoice | null = null
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
        appSocketChoice = result.choice
        await engine2.acceptChoice({ project_slug: 't2', user_id: 'u-as-1', choice: result.choice })
      }
    })

    // Drive a fresh interview spawn on the app-socket transport. Use
    // `signup_via='telegram'` so the rendered prompt keeps all 4 S1
    // options — this test exercises the app-socket TRANSPORT, not the
    // web-signup prompt variant. (`signup_via='web'` would drop Option
    // A — see `s1PromptForSignupVia` in onboarding/interview/engine.ts —
    // and the optAValue assertion below would fail to match a rendered
    // option, falling through to the freeform coercion path.)
    const start = await engine2.start({
      project_slug: 't2',
      topic_id: 'topic-as-1',
      user_id: 'u-as-1',
      signup_via: 'telegram',
    })
    expect(sentEnvelopes.length).toBe(1)
    const env = sentEnvelopes[0]!
    expect(env.v).toBe(1)
    expect(env.type).toBe('button_prompt')
    expect(env.prompt_id).toBe(start.prompt_id)
    expect(env.body).toContain("What's your name?")
    expect(env.options.length).toBeGreaterThan(0)
    expect(typeof env.expires_at_ms).toBe('number')

    // Tap the first option from the app-socket side.
    const optAValue = S1_PROMPT_OPTIONS[0]?.value ?? 'use-telegram-name'
    await server.deliverChoice({
      v: 1,
      type: 'button_choice',
      prompt_id: start.prompt_id,
      choice_value: optAValue,
      speaker_user_id: 'u-as-1',
    })

    expect(appSocketChoice).not.toBeNull()
    expect(appSocketChoice!.choice_value).toBe(optAValue)
    expect(appSocketChoice!.channel_kind).toBe('app-socket')
    const state = await stateStore2.get('t2', 'u-as-1')
    // 2026-05-14 — T9 (Codex r1 P2): signup → instance_provisioned →
    // import_offered via the AUTO_SKIP walker on acceptChoice path.
    expect(state?.phase).toBe('ai_substrate_offered')

    // Re-delivery: same envelope should resolve idempotently with was_new=false.
    let secondResult: Awaited<ReturnType<DefaultButtonRouter['routeChoice']>> | null = null
    secondResult = await router2.routeChoice({
      prompt_id: start.prompt_id,
      raw_value: optAValue,
      speaker_user_id: 'u-as-1',
      channel_kind: 'app-socket',
    })
    expect(secondResult.delivered).toBe(true)
    expect(secondResult.was_new).toBe(false)

    server.close()
    db2.close()
    rmSync(tmpDir2, { recursive: true, force: true })
  })

  test('cross-channel parity — Telegram + app-socket produce identical ButtonChoice shape (excluding channel_kind)', async () => {
    // Round-trip the same prompt over BOTH channels in lockstep and
    // assert the resulting `ButtonChoice` differs only in
    // `channel_kind` (the rest of the shape is the cross-channel
    // contract).
    const tmpA = mkdtempSync(join(tmpdir(), 'neutron-int-parity-tg-'))
    const tmpB = mkdtempSync(join(tmpdir(), 'neutron-int-parity-as-'))
    const dbA = ProjectDb.open(join(tmpA, 't.db'))
    const dbB = ProjectDb.open(join(tmpB, 't.db'))
    applyMigrations(dbA.raw())
    applyMigrations(dbB.raw())
    const storeA = new ButtonStore({ db: dbA })
    const storeB = new ButtonStore({ db: dbB })
    const routerA = new DefaultButtonRouter({ store: storeA })
    const routerB = new DefaultButtonRouter({ store: storeB })
    const stA = new InMemoryOnboardingStateStore()
    const stB = new InMemoryOnboardingStateStore()
    const trA = new TranscriptWriter({ path: join(tmpA, 'persona', 't.jsonl') })
    const trB = new TranscriptWriter({ path: join(tmpB, 'persona', 't.jsonl') })
    const server = createMockAppSocketServer()

    const engineA = new InterviewEngine({
      buttonStore: storeA, stateStore: stA, transcript: trA,
      sendButtonPrompt: async ({ prompt }) => {
        renderButtonPromptTelegram(prompt)
        return { message_id: 'a', was_new: true }
      },
      phaseSpecResolver: fixedSignupResolver,
    })
    const engineB = new InterviewEngine({
      buttonStore: storeB, stateStore: stB, transcript: trB,
      sendButtonPrompt: async ({ prompt }) => {
        const peek = await storeB.peek(prompt.prompt_id)
        if (peek === null) throw new Error('row missing')
        server.send(renderButtonPromptAppSocket({ prompt, expires_at_ms: peek.expires_at }))
        return { message_id: 'b', was_new: true }
      },
      phaseSpecResolver: fixedSignupResolver,
    })

    // Both engines use `signup_via='telegram'` so the rendered options
    // include Option A; the test asserts CROSS-CHANNEL parity (telegram
    // vs app-socket TRANSPORT), not cross-signup-channel. Web signups
    // drop Option A — see `s1PromptForSignupVia` in
    // onboarding/interview/engine.ts.
    const startA = await engineA.start({ project_slug: 'tA', topic_id: 'top', user_id: 'u', signup_via: 'telegram' })
    const startB = await engineB.start({ project_slug: 'tB', topic_id: 'top', user_id: 'u', signup_via: 'telegram' })
    const optAValue = S1_PROMPT_OPTIONS[0]?.value ?? 'use-telegram-name'

    const tgResult = await routerA.routeChoice({
      prompt_id: startA.prompt_id,
      raw_value: optAValue,
      speaker_user_id: 'u',
      channel_kind: 'telegram',
    })
    const asResult = await routerB.routeChoice({
      prompt_id: startB.prompt_id,
      raw_value: optAValue,
      speaker_user_id: 'u',
      channel_kind: 'app-socket',
    })

    expect(tgResult.delivered).toBe(true)
    expect(asResult.delivered).toBe(true)

    // Strip channel_kind + prompt_id (per-instance) + chosen_at (per-call)
    // and assert the rest is byte-identical.
    const norm = (c: ButtonChoice): Omit<ButtonChoice, 'channel_kind' | 'prompt_id' | 'chosen_at'> => ({
      choice_value: c.choice_value,
      speaker_user_id: c.speaker_user_id,
      ...(c.freeform_text !== undefined ? { freeform_text: c.freeform_text } : {}),
    })
    expect(norm(tgResult.choice)).toEqual(norm(asResult.choice))

    server.close()
    dbA.close()
    dbB.close()
    rmSync(tmpA, { recursive: true, force: true })
    rmSync(tmpB, { recursive: true, force: true })
  })
})
