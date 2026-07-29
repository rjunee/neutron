/**
 * @neutronai/channels — Telegram inline-keyboard primitive.
 *
 * A/B/C/D callback shape lifted from the reference implementation. Bot API 9.6 added
 * `icon_custom_emoji_id` and
 * `style` fields — supported but optional.
 *
 * The renderer takes the channel-agnostic `InlineChoice[]` from `types.ts`
 * and returns the Telegram-shaped `reply_markup` JSON sub-object that the
 * webhook client passes verbatim to sendMessage.
 */

import type { InlineChoice } from '../../types.ts'

export interface TelegramInlineKeyboardButton {
  text: string
  callback_data: string
  /** Bot API 9.6 — optional decoration. */
  icon_custom_emoji_id?: string
  /** Bot API 9.6 — optional button style. */
  style?: 'default' | 'destructive' | 'cta'
}

export interface TelegramReplyMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][]
}

export interface RenderOptions {
  /** Max buttons per row. Default 2 (A/B then C/D). */
  per_row?: number
  /** Optional per-choice extras keyed by callback_data. */
  decorate?: (choice: InlineChoice) => Partial<TelegramInlineKeyboardButton>
}

/**
 * Render `choices` as a Telegram `reply_markup` block. Splits into rows of
 * at most `per_row` buttons (default 2). Empty input returns an empty
 * keyboard so callers don't need to branch — Telegram accepts an empty
 * inline_keyboard but the field is unnecessary in that case; the gateway
 * uses `if (choices.length === 0)` to omit `reply_markup` entirely.
 */
export function renderInlineKeyboard(
  choices: InlineChoice[],
  options: RenderOptions = {},
): TelegramReplyMarkup {
  const per_row = Math.max(1, options.per_row ?? 2)
  const rows: TelegramInlineKeyboardButton[][] = []
  let row: TelegramInlineKeyboardButton[] = []
  for (const c of choices) {
    const button: TelegramInlineKeyboardButton = {
      text: c.label,
      callback_data: c.callback_data,
    }
    const decorated = options.decorate ? options.decorate(c) : undefined
    if (decorated?.icon_custom_emoji_id !== undefined) {
      button.icon_custom_emoji_id = decorated.icon_custom_emoji_id
    }
    if (decorated?.style !== undefined) {
      button.style = decorated.style
    }
    row.push(button)
    if (row.length >= per_row) {
      rows.push(row)
      row = []
    }
  }
  if (row.length > 0) rows.push(row)
  return { inline_keyboard: rows }
}
