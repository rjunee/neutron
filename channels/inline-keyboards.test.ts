import { describe, expect, test } from 'bun:test'
import { renderInlineKeyboard } from './adapters/telegram/inline-keyboards.ts'

describe('renderInlineKeyboard', () => {
  test('renders A/B/C/D into 2-per-row grid', () => {
    const choices = [
      { label: 'A', callback_data: 'a' },
      { label: 'B', callback_data: 'b' },
      { label: 'C', callback_data: 'c' },
      { label: 'D', callback_data: 'd' },
    ]
    const out = renderInlineKeyboard(choices)
    expect(out.inline_keyboard).toEqual([
      [
        { text: 'A', callback_data: 'a' },
        { text: 'B', callback_data: 'b' },
      ],
      [
        { text: 'C', callback_data: 'c' },
        { text: 'D', callback_data: 'd' },
      ],
    ])
  })

  test('respects per_row override', () => {
    const choices = [
      { label: 'A', callback_data: 'a' },
      { label: 'B', callback_data: 'b' },
      { label: 'C', callback_data: 'c' },
    ]
    const out = renderInlineKeyboard(choices, { per_row: 1 })
    expect(out.inline_keyboard.length).toBe(3)
  })

  test('decorate hook adds Bot API 9.6 fields', () => {
    const out = renderInlineKeyboard(
      [{ label: 'X', callback_data: 'x' }],
      { decorate: () => ({ style: 'cta', icon_custom_emoji_id: 'emoji-1' }) },
    )
    expect(out.inline_keyboard[0]?.[0]?.style).toBe('cta')
    expect(out.inline_keyboard[0]?.[0]?.icon_custom_emoji_id).toBe('emoji-1')
  })

  test('empty input returns empty inline_keyboard', () => {
    expect(renderInlineKeyboard([])).toEqual({ inline_keyboard: [] })
  })
})
