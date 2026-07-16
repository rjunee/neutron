/**
 * Integration test for the P2 S1 button primitive cross-channel round-trip,
 * EXTENDED in S5 to cover the app-socket adapter.
 *
 * Re-anchored 2026-07-06 (K11a6-rem/grammar): this test's pinned behavior is
 * the RETAINED button-primitive grammar — emit a `ButtonPrompt` into
 * `ButtonStore`, render it through a channel adapter (Telegram / app-socket),
 * deliver the user's tap back through the callback router →
 * `DefaultButtonRouter.routeChoice` → `ButtonStore.resolve`, and surface a
 * `ButtonChoice`. None of that involves the interview engine. The original
 * spec drove the emit via `engine.start` and consumed the tap via
 * `engine.advance` (asserting the engine's phase-walk landed on
 * `ai_substrate_offered`); K11b1 deletes that conversational drive, so the
 * emit is re-anchored onto `ButtonStore.emit` + the channel renderer, and the
 * two `state.phase` phase-walk assertions (engine-drive only, no non-engine
 * analog) are dropped. Every button-primitive assertion — render body, tap
 * delivery, idempotent re-delivery, unknown-prompt rejection, cross-channel
 * `ButtonChoice` parity — is preserved.
 *
 *   Given: a `ButtonPrompt` body="What's your name?" with one option, emitted
 *     into `ButtonStore` and rendered via the Telegram adapter.
 *   When:  a mock Telegram `callback_query` with
 *     `callback_data='btn:<base64url-prompt-id>:opt-A'` arrives.
 *   Then:  `DefaultButtonRouter.routeChoice` records the choice + surfaces a
 *     `ButtonChoice{choice_value:'use-telegram-name'}`; re-delivery of the
 *     same callback returns `was_new:false`; a callback for an unknown
 *     prompt_id returns `delivered:false`.
 *
 *   S5 EXTENSION: repeat the flow over a mock app-socket adapter
 *   (`channels/adapters/app-socket/socket-server.ts`). Asserts the same
 *   `ButtonChoice` shape arrives — cross-channel parity.
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
import { buildButtonPrompt, type ButtonChoice } from '@neutronai/channels/button-primitive.ts'

// A prompt WITH options to exercise the tap roundtrip. Logically equivalent to
// what the LLM driver emits when it judges a tap is friendlier than freeform —
// exercises the wire shape without depending on any onboarding menu copy.
const S1_PROMPT_OPTIONS: ReadonlyArray<{ value: string; label: string; body: string }> = [
  { value: 'use-telegram-name', label: 'A', body: 'Use my Telegram display name' },
]
const TEST_SIGNUP_BODY = "What's your name?"

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
let sendCalls: SendCall[]
let answerCalls: AnswerCall[]
let receivedChoiceValues: string[]

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-int-bp-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  store = new ButtonStore({ db })
  router = new DefaultButtonRouter({ store })
  sendCalls = []
  answerCalls = []
  receivedChoiceValues = []
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * Emit an S1-shaped button prompt into `ButtonStore` and render it through the
 * Telegram adapter (recording the send). Returns the persisted `prompt_id` —
 * the same thing the engine's `start()` used to return. This IS the retained
 * agent-emits-a-button grammar, minus the deleted engine wrapper.
 */
async function emitTelegramPrompt(s: ButtonStore, topic_id: string): Promise<string> {
  const prompt = buildButtonPrompt({
    body: TEST_SIGNUP_BODY,
    options: S1_PROMPT_OPTIONS.map((o) => ({ label: o.label, body: o.body, value: o.value })),
    idempotency_key: `k-${topic_id}`,
  })
  const emit = await s.emit(prompt, { topic_id })
  const rendered = renderButtonPromptTelegram(prompt)
  sendCalls.push({ text: rendered.text, reply_markup: rendered.reply_markup, topic_id })
  return emit.prompt_id
}

function makeCallbackHandler() {
  return buildTelegramCallbackHandler({
    buttonRouter: {
      routeChoice: async (input) => {
        const result = await router.routeChoice(input)
        if (result.delivered && result.prompt) {
          // Re-anchored (K11a6-rem): the retained button-primitive grammar
          // resolves the tap via DefaultButtonRouter → ButtonStore.resolve and
          // surfaces the ButtonChoice HERE. The engine.advance phase-walk that
          // used to consume it is deleted by K11b1; the choice-delivery
          // contract lives entirely in the router/store.
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
  test('agent emits → render → user-tap → router surfaces ButtonChoice', async () => {
    const prompt_id = await emitTelegramPrompt(store, 'topic-1')
    expect(sendCalls.length).toBe(1)
    expect(sendCalls[0]?.text).toContain("What's your name?")

    const handler = makeCallbackHandler()
    // Pick the first option's value
    const optAValue = S1_PROMPT_OPTIONS[0]?.value ?? 'use-telegram-name'
    const callback_data = encodeCallbackData(prompt_id, optAValue)
    const result = await handler({
      id: 'cb-1',
      data: callback_data,
      from_user_id: 'u-1',
    })
    expect(result.delivered).toBe(true)
    expect(result.was_new).toBe(true)
    expect(receivedChoiceValues).toEqual([optAValue])
    expect(answerCalls.length).toBe(1)
  })

  test('re-delivery of the same callback returns was_new=false (idempotent)', async () => {
    const prompt_id = await emitTelegramPrompt(store, 'topic-1')
    const handler = makeCallbackHandler()
    const optAValue = S1_PROMPT_OPTIONS[0]?.value ?? 'use-telegram-name'
    const callback_data = encodeCallbackData(prompt_id, optAValue)
    const a = await handler({ id: 'cb-1', data: callback_data, from_user_id: 'u-1' })
    const b = await handler({ id: 'cb-1', data: callback_data, from_user_id: 'u-1' })
    expect(a.was_new).toBe(true)
    expect(b.was_new).toBe(false)
  })

  test('callback for an unknown prompt_id returns delivered=false', async () => {
    await emitTelegramPrompt(store, 'topic-1')
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
  test('agent emits via app-socket → user delivers choice → router surfaces identical ButtonChoice', async () => {
    // Boot a SECOND store/router wired over the mock app-socket transport.
    const tmpDir2 = mkdtempSync(join(tmpdir(), 'neutron-int-bp-as-'))
    const db2 = ProjectDb.open(join(tmpDir2, 'owner.db'))
    applyMigrations(db2.raw())
    const store2 = new ButtonStore({ db: db2 })
    const router2 = new DefaultButtonRouter({ store: store2 })
    const server = createMockAppSocketServer()

    const sentEnvelopes: AppSocketButtonPromptMessage[] = []
    server.onOutbound((env) => {
      sentEnvelopes.push(env)
    })

    // Emit + render over the app-socket transport (the retained emit grammar).
    const prompt = buildButtonPrompt({
      body: TEST_SIGNUP_BODY,
      options: S1_PROMPT_OPTIONS.map((o) => ({ label: o.label, body: o.body, value: o.value })),
      idempotency_key: 'k-as-1',
    })
    const emitOut = await store2.emit(prompt, { topic_id: 'topic-as-1' })
    const start_prompt_id = emitOut.prompt_id
    const peek = await store2.peek(start_prompt_id)
    if (peek === null) throw new Error('expected ButtonStore row to exist after emit')
    server.send(renderButtonPromptAppSocket({ prompt, expires_at_ms: peek.expires_at }))
    await store2.markDelivered(start_prompt_id)

    let appSocketChoice: ButtonChoice | null = null
    server.onInbound(async (envelope) => {
      const parsed = parseAppSocketButtonChoice(envelope)
      if (parsed === null) return
      const result = await router2.routeChoice({
        prompt_id: parsed.prompt_id,
        raw_value: parsed.raw_value,
        speaker_user_id: parsed.speaker_user_id,
        channel_kind: 'app_socket',
        ...(parsed.freeform_text !== undefined ? { freeform_text: parsed.freeform_text } : {}),
      })
      if (result.delivered) {
        appSocketChoice = result.choice
      }
    })

    expect(sentEnvelopes.length).toBe(1)
    const env = sentEnvelopes[0]!
    expect(env.v).toBe(1)
    expect(env.type).toBe('button_prompt')
    expect(env.prompt_id).toBe(start_prompt_id)
    expect(env.body).toContain("What's your name?")
    expect(env.options.length).toBeGreaterThan(0)
    expect(typeof env.expires_at_ms).toBe('number')

    // Tap the first option from the app-socket side.
    const optAValue = S1_PROMPT_OPTIONS[0]?.value ?? 'use-telegram-name'
    await server.deliverChoice({
      v: 1,
      type: 'button_choice',
      prompt_id: start_prompt_id,
      choice_value: optAValue,
      speaker_user_id: 'u-as-1',
    })

    expect(appSocketChoice).not.toBeNull()
    expect(appSocketChoice!.choice_value).toBe(optAValue)
    expect(appSocketChoice!.channel_kind).toBe('app_socket')

    // Re-delivery: same envelope should resolve idempotently with was_new=false.
    let secondResult: Awaited<ReturnType<DefaultButtonRouter['routeChoice']>> | null = null
    secondResult = await router2.routeChoice({
      prompt_id: start_prompt_id,
      raw_value: optAValue,
      speaker_user_id: 'u-as-1',
      channel_kind: 'app_socket',
    })
    expect(secondResult.delivered).toBe(true)
    expect(secondResult.was_new).toBe(false)

    server.close()
    db2.close()
    rmSync(tmpDir2, { recursive: true, force: true })
  })

  test('cross-channel parity — Telegram + app-socket produce identical ButtonChoice shape (excluding channel_kind)', async () => {
    // Round-trip the same prompt over BOTH channels in lockstep and assert the
    // resulting `ButtonChoice` differs only in `channel_kind` (the rest of the
    // shape is the cross-channel contract).
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
    const server = createMockAppSocketServer()

    // Emit the same S1-shaped prompt into both stores + render over each
    // channel's adapter.
    const promptA = buildButtonPrompt({
      body: TEST_SIGNUP_BODY,
      options: S1_PROMPT_OPTIONS.map((o) => ({ label: o.label, body: o.body, value: o.value })),
      idempotency_key: 'k-parity-tg',
    })
    const promptB = buildButtonPrompt({
      body: TEST_SIGNUP_BODY,
      options: S1_PROMPT_OPTIONS.map((o) => ({ label: o.label, body: o.body, value: o.value })),
      idempotency_key: 'k-parity-as',
    })
    const emitA = await storeA.emit(promptA, { topic_id: 'top' })
    renderButtonPromptTelegram(promptA)
    const emitB = await storeB.emit(promptB, { topic_id: 'top' })
    const peekB = await storeB.peek(emitB.prompt_id)
    if (peekB === null) throw new Error('row missing')
    server.send(renderButtonPromptAppSocket({ prompt: promptB, expires_at_ms: peekB.expires_at }))

    const optAValue = S1_PROMPT_OPTIONS[0]?.value ?? 'use-telegram-name'

    const tgResult = await routerA.routeChoice({
      prompt_id: emitA.prompt_id,
      raw_value: optAValue,
      speaker_user_id: 'u',
      channel_kind: 'telegram',
    })
    const asResult = await routerB.routeChoice({
      prompt_id: emitB.prompt_id,
      raw_value: optAValue,
      speaker_user_id: 'u',
      channel_kind: 'app_socket',
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
