/**
 * Unit tests for the app-socket renderer + mock socket server (P2 S5).
 *
 * Asserts:
 *   - Renderer emits the locked envelope shape
 *     `{v:1, type:'button_prompt', prompt_id, body, options[], expires_at_ms}`
 *   - 4-option keyboard encodes correctly
 *   - option.value > VALUE_BYTE_CAP throws ButtonPrimitiveError(value_too_long)
 *   - decoration round-trip preserves icon/style fields
 *   - parseAppSocketButtonChoice rejects malformed envelopes
 *   - mock socket server: send / onOutbound / deliverChoice / outbounds round-trip
 */

import { describe, expect, test } from 'bun:test'
import {
  renderButtonPromptAppSocket,
  parseAppSocketButtonChoice,
} from '../render-button-prompt.ts'
import { createMockAppSocketServer } from '../socket-server.ts'
import {
  buildButtonPrompt,
  ButtonPrimitiveError,
  VALUE_BYTE_CAP,
} from '../../../button-primitive.ts'

const FROZEN_UUID = '00000000-0000-0000-0000-00000000abcd'

describe('renderButtonPromptAppSocket', () => {
  test('emits the locked envelope shape', () => {
    const prompt = buildButtonPrompt({
      uuid: () => FROZEN_UUID,
      body: "What's your name?",
      options: [
        { label: 'A', body: 'Use Telegram name', value: 'use-telegram-name' },
        { label: 'B', body: 'Type a different one', value: 'type-different' },
      ],
      allow_freeform: true,
      idempotency_key: 'idem-1',
    })

    const env = renderButtonPromptAppSocket({ prompt, expires_at_ms: 1_700_000_000_000 })

    expect(env.v).toBe(1)
    expect(env.type).toBe('button_prompt')
    expect(env.prompt_id).toBe(FROZEN_UUID)
    expect(env.body).toBe("What's your name?")
    expect(env.options).toHaveLength(2)
    expect(env.options[0]).toEqual({
      label: 'A',
      body: 'Use Telegram name',
      value: 'use-telegram-name',
    })
    expect(env.allow_freeform).toBe(true)
    expect(env.expires_at_ms).toBe(1_700_000_000_000)
    expect(env.idempotency_key).toBe('idem-1')
  })

  test('encodes a 4-option keyboard correctly', () => {
    const prompt = buildButtonPrompt({
      uuid: () => FROZEN_UUID,
      body: 'pick',
      options: [
        { label: 'A', body: 'one', value: 'opt-A' },
        { label: 'B', body: 'two', value: 'opt-B' },
        { label: 'C', body: 'three', value: 'opt-C' },
        { label: 'D', body: 'four', value: 'opt-D' },
      ],
    })
    const env = renderButtonPromptAppSocket({ prompt, expires_at_ms: 1 })
    expect(env.options.map((o) => o.value)).toEqual(['opt-A', 'opt-B', 'opt-C', 'opt-D'])
    expect(env.allow_freeform).toBe(false)
    expect(env.idempotency_key).toBeUndefined()
  })

  test('preserves decoration fields when present', () => {
    const prompt = buildButtonPrompt({
      uuid: () => FROZEN_UUID,
      body: 'pick',
      options: [
        {
          label: 'A',
          body: 'confirm',
          value: 'confirm',
          decoration: { icon_custom_emoji_id: 'icon-1', style: 'primary' },
        },
        { label: 'B', body: 'cancel', value: 'cancel-x', decoration: { style: 'destructive' } },
      ],
    })
    const env = renderButtonPromptAppSocket({ prompt, expires_at_ms: 1 })
    expect(env.options[0]?.decoration).toEqual({
      icon_custom_emoji_id: 'icon-1',
      style: 'primary',
    })
    expect(env.options[1]?.decoration).toEqual({ style: 'destructive' })
  })

  test('rejects option.value > VALUE_BYTE_CAP', () => {
    const oversize = 'x'.repeat(VALUE_BYTE_CAP + 1)
    // The buildButtonPrompt validator will catch this first; assert it
    // lands as a ButtonPrimitiveError(value_too_long).
    expect(() =>
      buildButtonPrompt({
        uuid: () => FROZEN_UUID,
        body: 'b',
        options: [{ label: 'A', body: 'a', value: oversize }],
      }),
    ).toThrow(ButtonPrimitiveError)
  })

  test('renderer rejects oversize value when bypassing buildButtonPrompt', () => {
    // Construct the prompt object manually to confirm the renderer's
    // own defense-in-depth check fires when validate didn't see the
    // oversize value (e.g. a legacy persisted row).
    const prompt = {
      prompt_id: FROZEN_UUID,
      body: 'b',
      // 38 ASCII bytes — buildButtonPrompt would reject; here we
      // bypass it.
      options: [{ label: 'A', body: 'a', value: 'x'.repeat(VALUE_BYTE_CAP + 1) }],
      allow_freeform: false,
    }
    // `validateButtonPrompt` runs inside the renderer too, so it'll
    // throw at the validate step. Either path produces ButtonPrimitiveError.
    expect(() =>
      renderButtonPromptAppSocket({
        prompt,
        expires_at_ms: 1,
      }),
    ).toThrow(ButtonPrimitiveError)
  })
})

describe('parseAppSocketButtonChoice', () => {
  test('parses a well-formed envelope', () => {
    const parsed = parseAppSocketButtonChoice({
      v: 1,
      type: 'button_choice',
      prompt_id: FROZEN_UUID,
      choice_value: 'opt-A',
      speaker_user_id: 'u-1',
    })
    expect(parsed).toEqual({
      prompt_id: FROZEN_UUID,
      raw_value: 'opt-A',
      speaker_user_id: 'u-1',
    })
  })

  test('threads freeform_text through when present (non-reserved value)', () => {
    // Codex r7 P1 — clients can't supply `__freeform__` directly
    // (router-side reserved sentinel). The freeform_text slot still
    // round-trips for clients that ship typed text alongside an
    // option value (e.g. an "edit & confirm" UX where the user
    // tweaks the text before tapping).
    const parsed = parseAppSocketButtonChoice({
      v: 1,
      type: 'button_choice',
      prompt_id: FROZEN_UUID,
      choice_value: 'opt-A',
      freeform_text: 'something custom',
      speaker_user_id: 'u-1',
    })
    expect(parsed?.freeform_text).toBe('something custom')
  })

  test('rejects __freeform__ and __timeout__ but allows __cancel__ (Codex r7 P1 + r8 P2)', () => {
    for (const forbidden of ['__freeform__', '__timeout__']) {
      const parsed = parseAppSocketButtonChoice({
        v: 1,
        type: 'button_choice',
        prompt_id: FROZEN_UUID,
        choice_value: forbidden,
        speaker_user_id: 'u-1',
      })
      expect(parsed).toBeNull()
    }
    // __cancel__ IS a legitimate user action; should round-trip.
    const cancel = parseAppSocketButtonChoice({
      v: 1,
      type: 'button_choice',
      prompt_id: FROZEN_UUID,
      choice_value: '__cancel__',
      speaker_user_id: 'u-1',
    })
    expect(cancel?.raw_value).toBe('__cancel__')
  })

  test('rejects wrong v / wrong type / missing fields', () => {
    expect(parseAppSocketButtonChoice({ v: 2, type: 'button_choice', prompt_id: 'x', choice_value: 'y', speaker_user_id: 'u' })).toBeNull()
    expect(parseAppSocketButtonChoice({ v: 1, type: 'agent_message', prompt_id: 'x', choice_value: 'y', speaker_user_id: 'u' })).toBeNull()
    expect(parseAppSocketButtonChoice({ v: 1, type: 'button_choice', choice_value: 'y', speaker_user_id: 'u' })).toBeNull()
    expect(parseAppSocketButtonChoice('not an object')).toBeNull()
    expect(parseAppSocketButtonChoice(null)).toBeNull()
  })
})

describe('createMockAppSocketServer', () => {
  test('records outbounds and routes inbounds to the registered handler', async () => {
    const server = createMockAppSocketServer()
    const received: unknown[] = []
    server.onInbound(async (env) => {
      received.push(env)
    })
    const outbounds: unknown[] = []
    server.onOutbound((env) => {
      outbounds.push(env)
    })

    const prompt = buildButtonPrompt({
      uuid: () => FROZEN_UUID,
      body: 'pick',
      options: [{ label: 'A', body: 'a', value: 'opt-A' }],
    })
    const env = renderButtonPromptAppSocket({ prompt, expires_at_ms: 1 })
    server.send(env)

    expect(server.outbounds()).toEqual([env])
    expect(outbounds).toEqual([env])

    await server.deliverChoice({
      v: 1,
      type: 'button_choice',
      prompt_id: FROZEN_UUID,
      choice_value: 'opt-A',
      speaker_user_id: 'u-1',
    })
    expect(received).toHaveLength(1)
    server.close()
  })

  test('throws after close', () => {
    const server = createMockAppSocketServer()
    server.close()
    expect(() =>
      server.send({
        v: 1,
        type: 'button_prompt',
        prompt_id: FROZEN_UUID,
        body: 'b',
        options: [],
        allow_freeform: false,
        expires_at_ms: 1,
      }),
    ).toThrow(/after close/)
  })
})
