/**
 * @neutronai/channels — Telegram UTF-16 truncation.
 *
 * Telegram adapter — the
 * Telegram 4096-char message limit is UTF-16-code-unit-counted, NOT
 * byte-counted (Bot API spec). Naive byte-truncation breaks emoji + Cyrillic
 * + every BMP-supplementary character; UTF-16 truncation here treats each
 * surrogate pair as inseparable so we never split a single user-perceived
 * character down the middle.
 *
 * Lift target: Hermes `gateway/platforms/telegram.py` (Python `surrogateescape`
 * dance is unnecessary in JS — String.length is already UTF-16 code units).
 */

/**
 * Telegram message-text limit per Bot API documentation. Reference:
 * https://core.telegram.org/bots/api#sendmessage
 *
 * Caption limits (1024) and inline-result limits (256) are different — this
 * constant is for the message-text path used by sendMessage / editMessageText.
 */
export const TELEGRAM_MESSAGE_MAX_UTF16 = 4096

/**
 * Continuation suffix appended after truncation. Counted into the budget so
 * the final string still fits. Plain ASCII (3 chars) so adapters that switch
 * parse_mode don't accidentally HTML-escape the suffix.
 */
const ELLIPSIS = '…' // single ellipsis char (1 UTF-16 code unit)

export interface TruncationOptions {
  max_utf16?: number
  /** Append the ellipsis when truncation occurs. Default true. */
  append_ellipsis?: boolean
  /**
   * When true, the input is assumed to be Telegram MarkdownV2-formatted
   * and the cut point is rewound so the truncated prefix remains a
   * valid MarkdownV2 fragment — never leaves a dangling backslash from
   * an `\X` escape and never truncates inside a `[label](url)` inline
   * link. Off by default; the plain-text fast path stays cheap. Argus
   * P7.3 BLOCKING #1: without this, a long doc-link reply that gets
   * cut mid-link or just after a `\` makes Telegram reject the whole
   * sendMessage with "can't parse entities".
   */
  markdown_v2?: boolean
}

/**
 * Truncate `text` to fit Telegram's UTF-16 budget, preserving surrogate-pair
 * integrity. Returns the (possibly unchanged) string. If `text` already fits,
 * it is returned verbatim — no allocation, no ellipsis.
 *
 * Returns the original `text` reference when no truncation is needed so
 * callers can compare by reference for "was anything changed?" checks.
 *
 * When `options.markdown_v2` is true, the cut point is additionally
 * rewound so the prefix remains a valid MarkdownV2 fragment (no
 * dangling `\` from an `\X` escape, no truncation inside a
 * `[label](url)` inline link).
 */
export function truncateForTelegram(text: string, options: TruncationOptions = {}): string {
  const max = options.max_utf16 ?? TELEGRAM_MESSAGE_MAX_UTF16
  const append = options.append_ellipsis ?? true
  if (text.length <= max) return text

  const reserve = append ? ELLIPSIS.length : 0
  let cut = max - reserve
  if (cut < 0) cut = 0

  if (options.markdown_v2 === true) {
    cut = findSafeMarkdownV2Cut(text, cut)
  } else if (cut > 0) {
    // Keep surrogate pairs intact: if `cut` lands on a high surrogate (0xD800-
    // 0xDBFF), back off by one so we don't split the pair. We never need to
    // back off more than 1 because surrogate pairs are exactly 2 code units.
    const code = text.charCodeAt(cut - 1)
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  }

  const head = text.slice(0, cut)
  return append ? head + ELLIPSIS : head
}

/**
 * Walk `text` as MarkdownV2 and return the largest cut position
 * `p ∈ [0, budget]` such that `text.slice(0, p)` is a valid MarkdownV2
 * prefix — i.e. we are NOT mid-escape (`\X`) and NOT inside a
 * `[label](url)` inline link construct. Also avoids splitting a
 * surrogate pair.
 *
 * The state machine only tracks the constructs our composer actually
 * emits: backslash-escapes and inline links. Other MarkdownV2 entities
 * (`*emphasis*`, ``code``, custom emoji, etc.) are not produced by the
 * Telegram doc-link composer so we don't track them here. If the
 * composer ever grows new entity kinds the machine needs to grow with
 * it.
 */
function findSafeMarkdownV2Cut(text: string, budget: number): number {
  type State =
    | 'text'
    | 'esc'
    | 'label'
    | 'label_esc'
    | 'pre_url'
    | 'url'
    | 'url_esc'
  let state: State = 'text'
  let safe = 0
  const limit = Math.min(budget, text.length)
  for (let i = 0; i < limit; i++) {
    const ch = text[i]
    switch (state) {
      case 'text':
        if (ch === '\\') state = 'esc'
        else if (ch === '[') state = 'label'
        break
      case 'esc':
        state = 'text'
        break
      case 'label':
        if (ch === '\\') state = 'label_esc'
        else if (ch === ']') state = 'pre_url'
        break
      case 'label_esc':
        state = 'label'
        break
      case 'pre_url':
        state = ch === '(' ? 'url' : 'text'
        break
      case 'url':
        if (ch === '\\') state = 'url_esc'
        else if (ch === ')') state = 'text'
        break
      case 'url_esc':
        state = 'url'
        break
    }
    if (state === 'text') {
      const code = text.charCodeAt(i)
      // High surrogate at this position means we'd cut between the
      // high and low surrogate — skip this candidate.
      if (code >= 0xd800 && code <= 0xdbff) continue
      safe = i + 1
    }
  }
  return safe
}

/**
 * Count the UTF-16 code units in `text` — same number Telegram counts. Useful
 * for caller-side guard rails and for tests.
 */
export function countUtf16(text: string): number {
  return text.length
}
