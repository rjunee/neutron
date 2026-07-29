/**
 * @neutronai/channels — Telegram inline-keyboard polish (Bot API 9.6).
 *
 * Per docs/plans/P2-onboarding.md § 6 S5 line 2145. Telegram Bot API 9.6
 * added two optional fields to inline-keyboard buttons:
 *
 *   * `icon_custom_emoji_id` — render a tiny custom emoji to the left
 *     of the button label. Lives outside the 64-byte callback_data
 *     budget; it's a separate metadata field on the button, not on the
 *     callback. Already wired by `inline-keyboards.ts:renderInlineKeyboard`.
 *   * `style` — `'default' | 'destructive' | 'cta'`. The destructive
 *     style renders red on iOS / Android; we use it to mark
 *     irreversible actions (confirm-cancel, delete, etc.) so a user
 *     scanning a 4-button keyboard immediately spots the hot path.
 *
 * Both fields are optional + ignored by older clients, so we render
 * them whenever the agent's `ButtonOption.metadata.action_kind`
 * declares an `action_kind`. No schema change to `ButtonOption` is
 * required — the agent passes the hint via `metadata`, this module
 * maps it to the wire fields.
 *
 * Falls through gracefully if `metadata` or `action_kind` is missing —
 * decoration is opt-in. Agents that don't think about action semantics
 * get the boring default rendering.
 */

import type { ButtonOption } from '../../button-primitive.ts'

/**
 * Curated semantic action kinds. The mapping is intentionally tiny —
 * every emoji must read instantly + every kind must have an obvious
 * action. Adding a new kind is a deliberate UX decision; do NOT extend
 * this set without a design discussion.
 *
 * `destructive` is the only kind that maps to `style: destructive`;
 * everything else stays default. The CTA style is reserved for the
 * channel-agnostic primitive's `style: 'primary'` (handled by
 * `render-button-prompt.ts:decorationFor`); this module owns the
 * action-kind path.
 */
export type ButtonActionKind =
  | 'confirm'
  | 'destructive'
  | 'skip'
  | 'edit'
  | 'send'
  | 'cancel'
  | 'continue'
  | 'back'

interface EmojiPolish {
  /** Standard emoji rendered as a prefix on the button label. Browser
   *  + native clients all support these without `icon_custom_emoji_id`. */
  emoji: string
  /** Bot API 9.6 `style` field. Only set for `destructive` — every other
   *  kind keeps the default-styled rendering. */
  style?: 'destructive'
}

const KIND_TO_POLISH: Readonly<Record<ButtonActionKind, EmojiPolish>> = {
  confirm: { emoji: '✅' },
  destructive: { emoji: '⚠️', style: 'destructive' },
  skip: { emoji: '↩️' },
  edit: { emoji: '📝' },
  send: { emoji: '📤' },
  cancel: { emoji: '✖️' },
  continue: { emoji: '➡️' },
  back: { emoji: '⬅️' },
}

export interface DecoratedLabel {
  /** Updated label string with emoji prefix; pass-through when no kind matched. */
  label: string
  /** Bot API 9.6 style override; absent for non-destructive kinds. */
  style?: 'destructive'
}

/**
 * Apply Bot API 9.6 polish to a `ButtonOption`. Reads
 * `option.metadata.action_kind`; returns the decorated label + the
 * optional `style` override. Falls through to the bare label when:
 *
 *   - `option.metadata` is missing (most callers)
 *   - `metadata.action_kind` is missing
 *   - `metadata.action_kind` is not one of the known kinds (we never
 *     guess — unknown kinds mean the agent has a typo and the user
 *     should still see the unmolested label)
 *
 * Idempotent: a label that already starts with one of the kind emojis
 * is left alone, so repeated render passes don't compound prefixes.
 */
export function decorateButtonForTelegram(option: ButtonOption): DecoratedLabel {
  const kind = readActionKind(option)
  if (kind === null) return { label: option.label }
  const polish = KIND_TO_POLISH[kind]
  // Idempotency guard — never prefix twice.
  const alreadyPrefixed = option.label.startsWith(polish.emoji)
  const label = alreadyPrefixed
    ? option.label
    : `${polish.emoji} ${option.label}`
  const out: DecoratedLabel = { label }
  if (polish.style !== undefined) out.style = polish.style
  return out
}

/**
 * Read `metadata.action_kind` from a `ButtonOption`. The `metadata`
 * field is intentionally not in the `ButtonOption` interface (the
 * channel-agnostic primitive doesn't need it); this function reads it
 * defensively via index access so unknown shapes fall through cleanly.
 */
function readActionKind(option: ButtonOption): ButtonActionKind | null {
  const meta = (option as unknown as { metadata?: unknown }).metadata
  if (typeof meta !== 'object' || meta === null) return null
  const ak = (meta as Record<string, unknown>)['action_kind']
  if (typeof ak !== 'string') return null
  if (!isKnownKind(ak)) return null
  return ak
}

function isKnownKind(s: string): s is ButtonActionKind {
  return Object.prototype.hasOwnProperty.call(KIND_TO_POLISH, s)
}

/** Exported for tests + ops dashboards. */
export const KNOWN_ACTION_KINDS: readonly ButtonActionKind[] = Object.keys(
  KIND_TO_POLISH,
) as readonly ButtonActionKind[]
