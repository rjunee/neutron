import { describe, expect, test } from 'bun:test'
import {
  buildButtonPrompt,
  CALLBACK_DATA_BYTE_CAP,
  encodePromptIdWire,
  ROUTING_PREFIX,
  VALUE_BYTE_CAP,
  ButtonPrimitiveError,
} from '../../../button-primitive.ts'
import {
  decorationFor,
  encodeCallbackData,
  renderButtonPromptTelegram,
} from '../render-button-prompt.ts'

const SAMPLE_UUID = '0123abcd-4567-89ef-0123-456789abcdef'

describe('renderButtonPromptTelegram', () => {
  test('renders A/B/C/D inline keyboard with btn:<wire>:<value> callback_data', () => {
    const prompt = buildButtonPrompt({
      body: 'Pick',
      options: [
        { label: 'A', body: 'A body', value: 'opt-A' },
        { label: 'B', body: 'B body', value: 'opt-B' },
        { label: 'C', body: 'C body', value: 'opt-C' },
        { label: 'D', body: 'D body', value: 'opt-D' },
      ],
      uuid: () => SAMPLE_UUID,
    })
    const r = renderButtonPromptTelegram(prompt)
    const wire = encodePromptIdWire(SAMPLE_UUID)
    expect(r.reply_markup!.inline_keyboard.length).toBe(2)
    expect(r.reply_markup!.inline_keyboard[0]?.[0]?.callback_data).toBe(
      `${ROUTING_PREFIX}${wire}:opt-A`,
    )
    expect(r.reply_markup!.inline_keyboard[0]?.[1]?.callback_data).toBe(
      `${ROUTING_PREFIX}${wire}:opt-B`,
    )
    expect(r.reply_markup!.inline_keyboard[1]?.[0]?.callback_data).toBe(
      `${ROUTING_PREFIX}${wire}:opt-C`,
    )
    expect(r.reply_markup!.inline_keyboard[1]?.[1]?.callback_data).toBe(
      `${ROUTING_PREFIX}${wire}:opt-D`,
    )
    expect(r.truncated).toBe(false)
  })

  test('text body composes the markdown prompt + numbered legend', () => {
    const prompt = buildButtonPrompt({
      body: 'Pick',
      options: [
        { label: 'A', body: 'first', value: 'a' },
        { label: 'B', body: 'second', value: 'b' },
      ],
      uuid: () => SAMPLE_UUID,
    })
    const r = renderButtonPromptTelegram(prompt)
    expect(r.text).toBe('Pick\n\nA. first\nB. second')
  })

  test('throws ButtonPrimitiveError when options > 8 (Codex r11 P1)', () => {
    // Silently truncating left the persisted ButtonStore row with
    // hidden options the user never saw; routeChoice still matched
    // them, so a crafted callback could resolve a hidden branch.
    // Force the caller to emit a smaller prompt instead.
    const opts = Array.from({ length: 10 }, (_, i) => ({
      label: String.fromCharCode(65 + i),
      body: `body ${i}`,
      value: `v${i}`,
    }))
    const prompt = buildButtonPrompt({
      body: 'Pick',
      options: opts,
      uuid: () => SAMPLE_UUID,
    })
    expect(() => renderButtonPromptTelegram(prompt)).toThrowError(ButtonPrimitiveError)
  })

  test('renders exactly 8 options without throw (boundary)', () => {
    const opts = Array.from({ length: 8 }, (_, i) => ({
      label: String.fromCharCode(65 + i),
      body: `body ${i}`,
      value: `v${i}`,
    }))
    const prompt = buildButtonPrompt({
      body: 'Pick',
      options: opts,
      uuid: () => SAMPLE_UUID,
    })
    const r = renderButtonPromptTelegram(prompt)
    expect(r.truncated).toBe(false)
    const flat = r.reply_markup!.inline_keyboard.flat()
    expect(flat.length).toBe(8)
  })

  test('every encoded callback_data fits inside the 64-byte cap', () => {
    const longestValue = 'x'.repeat(VALUE_BYTE_CAP)
    const prompt = buildButtonPrompt({
      body: 'Pick',
      options: [{ label: 'A', body: 'a', value: longestValue }],
      uuid: () => SAMPLE_UUID,
    })
    const r = renderButtonPromptTelegram(prompt)
    for (const row of r.reply_markup!.inline_keyboard) {
      for (const btn of row) {
        expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeLessThanOrEqual(
          CALLBACK_DATA_BYTE_CAP,
        )
      }
    }
  })

  test('decoration round-trips through inline-keyboards.decorate hook', () => {
    const prompt = buildButtonPrompt({
      body: 'Pick',
      options: [
        {
          label: 'A',
          body: 'a',
          value: 'a',
          decoration: { style: 'destructive', icon_custom_emoji_id: 'emoji-1' },
        },
      ],
      uuid: () => SAMPLE_UUID,
    })
    const r = renderButtonPromptTelegram(prompt)
    const btn = r.reply_markup!.inline_keyboard[0]?.[0]
    expect(btn?.style).toBe('destructive')
    expect(btn?.icon_custom_emoji_id).toBe('emoji-1')
  })

  test('primary style maps to Telegram cta', () => {
    const opt = {
      label: 'A',
      body: 'a',
      value: 'a',
      decoration: { style: 'primary' as const },
    }
    expect(decorationFor(opt)?.style).toBe('cta')
  })
})

describe('action_kind polish wiring (S5)', () => {
  test('action_kind=destructive prefixes label emoji + sets style=destructive', () => {
    const prompt = buildButtonPrompt({
      body: 'Pick',
      options: [
        { label: 'Confirm', body: 'go ahead', value: 'go', metadata: { action_kind: 'confirm' } },
        { label: 'Delete project', body: 'irreversible', value: 'del', metadata: { action_kind: 'destructive' } },
      ],
      uuid: () => SAMPLE_UUID,
    })
    const r = renderButtonPromptTelegram(prompt)
    expect(r.reply_markup!.inline_keyboard[0]?.[0]?.text).toBe('✅ Confirm')
    expect(r.reply_markup!.inline_keyboard[0]?.[1]?.text).toBe('⚠️ Delete project')
    expect(r.reply_markup!.inline_keyboard[0]?.[1]?.style).toBe('destructive')
    expect(r.reply_markup!.inline_keyboard[0]?.[0]?.style).toBeUndefined()
  })

  test('explicit decoration.style wins over action_kind-derived style', () => {
    const prompt = buildButtonPrompt({
      body: 'Pick',
      options: [
        {
          label: 'A',
          body: 'a',
          value: 'a',
          decoration: { style: 'primary' },
          metadata: { action_kind: 'destructive' },
        },
      ],
      uuid: () => SAMPLE_UUID,
    })
    const r = renderButtonPromptTelegram(prompt)
    expect(r.reply_markup!.inline_keyboard[0]?.[0]?.style).toBe('cta')
    // Label still gets the destructive emoji prefix.
    expect(r.reply_markup!.inline_keyboard[0]?.[0]?.text.startsWith('⚠️')).toBe(true)
  })

  test('options without action_kind render unchanged', () => {
    const prompt = buildButtonPrompt({
      body: 'Pick',
      options: [{ label: 'A', body: 'a', value: 'a' }],
      uuid: () => SAMPLE_UUID,
    })
    const r = renderButtonPromptTelegram(prompt)
    expect(r.reply_markup!.inline_keyboard[0]?.[0]?.text).toBe('A')
    expect(r.reply_markup!.inline_keyboard[0]?.[0]?.style).toBeUndefined()
  })
})

describe('encodeCallbackData', () => {
  test('throws when the encoded length blows the 64-byte cap', () => {
    // Pick a value that fits VALUE_BYTE_CAP but wire still busts (here we
    // force a bust by passing a value > VALUE_BYTE_CAP).
    expect(() =>
      encodeCallbackData(SAMPLE_UUID, 'x'.repeat(VALUE_BYTE_CAP + 5)),
    ).toThrowError(ButtonPrimitiveError)
  })

  test('round-trips a normal value', () => {
    const data = encodeCallbackData(SAMPLE_UUID, 'opt-A')
    expect(data.startsWith(ROUTING_PREFIX)).toBe(true)
  })
})
