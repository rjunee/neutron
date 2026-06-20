/**
 * @neutronai/channels — Telegram adapter: ButtonPrompt → reply_markup shim.
 *
 * Per docs/plans/P2-onboarding.md § 2.1 Pass-2 wire format + § 4.4.
 *
 * Wraps `inline-keyboards.ts:renderInlineKeyboard` (verified PRESENT on
 * main) so the rest of the channel layer can stay channel-agnostic. Each
 * `ButtonOption` becomes one inline-keyboard button with
 *   callback_data: `btn:` + base64url(prompt_id_uuid) + `:` + option.value
 *
 * Truncation: the channel-agnostic primitive caps at MAX_OPTIONS_TELEGRAM
 * (8) for usability; this adapter enforces the cap at render time and
 * issues a single `console.warn` so ops can spot agents that are over-
 * producing options. We never silently swallow >8 options on Telegram —
 * the caller's prompt would render with hidden choices the user can't tap.
 */

import type { InlineChoice } from '../../types.ts'
import {
  encodePromptIdWire,
  ROUTING_PREFIX,
  CALLBACK_DATA_BYTE_CAP,
  ButtonPrimitiveError,
  MAX_OPTIONS_TELEGRAM,
  type ButtonOption,
  type ButtonPrompt,
} from '../../button-primitive.ts'
import {
  renderInlineKeyboard,
  type TelegramInlineKeyboardButton,
  type TelegramReplyMarkup,
} from './inline-keyboards.ts'
import { decorateButtonForTelegram } from './decoration-emoji.ts'

export interface RenderedButtonPrompt {
  /** Markdown body for the Telegram sendMessage. */
  text: string
  /**
   * Telegram inline_keyboard shape — pass verbatim to sendMessage. When
   * the prompt has zero options (LLM-driven free-text only), the
   * renderer omits this field so the bot sends a plain text message
   * (Telegram rejects an empty `inline_keyboard.keyboard`). The user
   * still replies via normal Telegram message text — the engine routes
   * inbound `freeform_text` against the active prompt the same way.
   */
  reply_markup?: TelegramReplyMarkup
  /** True when the renderer truncated > MAX_OPTIONS_TELEGRAM options. */
  truncated: boolean
}

/**
 * Render a `ButtonPrompt` into Telegram-shaped `text` + `reply_markup`.
 * Throws `ButtonPrimitiveError(value_too_long)` when an encoded
 * callback_data blows the 64-byte budget (defensive — `validateButtonPrompt`
 * already caps `value` at 37 bytes, but UTF-8 is sneaky and the prompt_id
 * encode is the runtime source of truth).
 *
 * Also throws `ButtonPrimitiveError(no_options)` when
 * `options.length > MAX_OPTIONS_TELEGRAM`. Codex r11 P1 — silently
 * truncating leaves the persisted ButtonStore row with options the
 * user can never see, which `DefaultButtonRouter.routeChoice` would
 * still match against. A crafted callback could then resolve a hidden
 * option. Force the caller to emit a smaller prompt (or split into
 * multiple) so what the user sees is what the router accepts.
 */
export function renderButtonPromptTelegram(prompt: ButtonPrompt): RenderedButtonPrompt {
  if (prompt.options.length > MAX_OPTIONS_TELEGRAM) {
    throw new ButtonPrimitiveError(
      'no_options',
      `renderButtonPromptTelegram: ${prompt.options.length} options exceeds Telegram cap of ${MAX_OPTIONS_TELEGRAM}; ` +
        `the renderer refuses to truncate because the persisted ButtonStore row would still expose hidden options`,
    )
  }
  // LLM-driven prompts sprint (2026-05-09) — free-text-only prompts
  // (zero options + allow_freeform=true) render as plain Telegram text
  // with no inline_keyboard. Telegram's API rejects empty
  // `inline_keyboard.keyboard`, so we omit `reply_markup` entirely.
  // The user replies via normal message text; the engine's freeform
  // path advances the phase the same way it does for typed answers
  // against a buttoned prompt.
  if (prompt.options.length === 0) {
    if (!prompt.allow_freeform) {
      throw new ButtonPrimitiveError(
        'no_options',
        `renderButtonPromptTelegram: zero options without allow_freeform — user has no path forward`,
      )
    }
    const text = renderTextBody(prompt, [])
    return { text, truncated: false }
  }
  const wireId = encodePromptIdWire(prompt.prompt_id)
  const options = prompt.options
  const truncated = false

  const choices: InlineChoice[] = options.map((opt) => {
    const callback_data = `${ROUTING_PREFIX}${wireId}:${opt.value}`
    const byteLen = Buffer.byteLength(callback_data, 'utf8')
    if (byteLen > CALLBACK_DATA_BYTE_CAP) {
      throw new ButtonPrimitiveError(
        'value_too_long',
        `encoded callback_data is ${byteLen} bytes, cap is ${CALLBACK_DATA_BYTE_CAP}; value=${JSON.stringify(opt.value)}`,
      )
    }
    // Bot API 9.6 polish — agents that set `metadata.action_kind` get
    // emoji-prefixed labels + (for `destructive`) the red `style`
    // override. Falls through to the bare label when no action_kind
    // is set, so existing prompts render unchanged. Idempotent on
    // re-render (`decoration-emoji.ts` short-circuits when the label
    // already starts with the kind's emoji).
    return {
      label: labelFor(opt),
      callback_data,
    }
  })

  // Decoration round-trip: the existing renderInlineKeyboard takes a
  // `decorate` hook keyed by the InlineChoice. We map ButtonOption.decoration
  // into that hook by aligning indices.
  const decorationByCallback = new Map<string, ReturnType<typeof decorationFor>>()
  for (let i = 0; i < choices.length; i++) {
    const opt = options[i]
    const choice = choices[i]
    if (opt === undefined || choice === undefined) continue
    const dec = decorationFor(opt)
    if (dec !== undefined) decorationByCallback.set(choice.callback_data, dec)
  }

  const reply_markup = renderInlineKeyboard(choices, {
    decorate: (c) => decorationByCallback.get(c.callback_data) ?? {},
  })

  const text = renderTextBody(prompt, options)

  return { text, reply_markup, truncated }
}

/**
 * The visible button face. Conventional A/B/C/D `label` is preferred —
 * we don't truncate here because Telegram's button text limit (~64 chars)
 * comfortably fits any reasonable label.
 *
 * Bot API 9.6 polish — when the agent sets
 * `option.metadata.action_kind`, prefix the label with the kind's
 * emoji so a user scanning a 4-button keyboard immediately spots
 * confirm/destructive/skip/etc. Falls through to the raw label when
 * no `action_kind` is set.
 */
function labelFor(opt: ButtonOption): string {
  return decorateButtonForTelegram(opt).label
}

/**
 * Compose the message body + a numbered legend so the user knows what
 * each label means. Telegram inline-keyboard buttons show only the short
 * label; the full `body` lands above the keyboard.
 */
function renderTextBody(prompt: ButtonPrompt, options: ButtonOption[]): string {
  const lines: string[] = []
  lines.push(prompt.body)
  if (options.length > 0) {
    lines.push('')
    for (const opt of options) {
      lines.push(`${opt.label}. ${opt.body}`)
    }
  }
  return lines.join('\n')
}

/**
 * Map `ButtonOption.decoration` + `metadata.action_kind` → Telegram's
 * `icon_custom_emoji_id` / `style` fields. Returns undefined when no
 * decoration AND no action_kind polish was applied so the default
 * render path stays untouched. Telegram's `style` enum is
 * `default | destructive | cta`; the channel-agnostic primitive uses
 * `default | destructive | primary` — `primary` maps to `cta`.
 *
 * Both sources can stack: explicit `decoration.style` wins over
 * `action_kind`-derived style so an agent that wants to express a
 * specific style without an action_kind still gets it. The label
 * emoji prefix is applied separately by `labelFor` (so
 * `metadata.action_kind` decorates the visible label face) and
 * doesn't appear in this function's return.
 */
export function decorationFor(option: ButtonOption): Partial<TelegramInlineKeyboardButton> | undefined {
  const out: Partial<TelegramInlineKeyboardButton> = {}
  // Bot API 9.6 action_kind polish — destructive maps to style.
  const polish = decorateButtonForTelegram(option)
  if (polish.style !== undefined) {
    out.style = polish.style
  }
  const dec = option.decoration
  if (dec !== undefined) {
    if (dec.icon_custom_emoji_id !== undefined) {
      out.icon_custom_emoji_id = dec.icon_custom_emoji_id
    }
    if (dec.style !== undefined) {
      out.style = dec.style === 'primary' ? 'cta' : dec.style
    }
  }
  if (out.icon_custom_emoji_id === undefined && out.style === undefined) return undefined
  return out
}

/**
 * Wire-budget guardrail used by tests. Returns the encoded callback_data
 * for `(prompt_id, option.value)` or throws `ButtonPrimitiveError` when
 * the encoded string would blow the 64-byte cap.
 */
export function encodeCallbackData(prompt_id: string, value: string): string {
  const wireId = encodePromptIdWire(prompt_id)
  const data = `${ROUTING_PREFIX}${wireId}:${value}`
  const byteLen = Buffer.byteLength(data, 'utf8')
  if (byteLen > CALLBACK_DATA_BYTE_CAP) {
    throw new ButtonPrimitiveError(
      'value_too_long',
      `encoded callback_data is ${byteLen} bytes, cap is ${CALLBACK_DATA_BYTE_CAP}`,
    )
  }
  return data
}
