/**
 * @neutronai/channels — inbound channel callback → ButtonChoice routing.
 *
 * Per docs/plans/P2-onboarding.md § 4.3.
 *
 * Telegram callback_data shape (from § 2.1 Pass-2 wire format):
 *   `btn:` + base64url(prompt_id_uuid_16_bytes) + `:` + value
 *      4         22                                  1     ≤37   = ≤64 ✓
 *
 * The router handles three terminal states:
 *   - `__freeform__` — set when the user typed a freeform reply against an
 *     active prompt with `allow_freeform: true`. The freeform body is in
 *     `freeform_text`.
 *   - `__timeout__` — synthesized by `ButtonStore.sweepExpired` for
 *     unresolved prompts past `expires_at`.
 *   - `__cancel__` — app-socket only; Telegram has no cancel primitive.
 *
 * Edge cases (locked):
 *   - Choice for an unknown prompt_id → `delivered: false` (the agent
 *     likely moved on; do not surface as an error).
 *   - Second choice for the same prompt_id → idempotent; resolves to the
 *     first choice + surfaces `was_new: false`.
 *   - Choice with a `value` that doesn't match any of the prompt's options
 *     resolves to `__freeform__` IF `allow_freeform: true`, else returns
 *     `delivered: false`.
 */

import { decodePromptIdWire, normalizeChannelKindForButton, ROUTING_PREFIX, type ButtonChoice, type ChannelKindForButton } from './button-primitive.ts'
import { ButtonStoreError, type ButtonStore } from './button-store.ts'

export interface RouteChoiceInput {
  /** Already-decoded prompt_id (canonical UUID). */
  prompt_id: string
  /** Raw value from the channel — may be the plain option.value, or a
   *  reserved `__freeform__:<text>` / `__timeout__` / `__cancel__` literal. */
  raw_value: string
  speaker_user_id: string
  channel_kind: ChannelKindForButton
  /** Wall-clock the channel observed the callback. Defaults to `now()`. */
  chosen_at?: number
  /** Optional freeform body when `raw_value === '__freeform__'`. */
  freeform_text?: string
}

export interface RouteChoiceResult {
  /** True when the choice was applied to a prompt; false on unknown prompt_id
   *  or on a non-matching value when allow_freeform=false. */
  delivered: boolean
  /** Populated whenever the channel is a valid `ChannelKindForButton` — even on
   *  `delivered:false` (unknown prompt / non-matching value), callers may want to
   *  log it. ABSENT only when the ingress channel itself is invalid/corrupt (no
   *  honest `ButtonChoice` can be built); `rejected_channel_kind` carries the raw
   *  value in that case. */
  choice?: ButtonChoice
  /** The raw, unrecognized channel token when the ingress channel was rejected
   *  as invalid (N6 trust boundary). Present iff `choice` is absent. For
   *  diagnostics only — never persisted. */
  rejected_channel_kind?: string
  /** Populated when `delivered: true`. Absent on `delivered:false` so a caller
   *  using `result.prompt.body` defensively crashes loudly. */
  prompt?: import('./button-primitive.ts').ButtonPrompt
  /** False for duplicate channel callbacks for the same prompt_id. */
  was_new: boolean
}

export interface ButtonRouter {
  routeChoice(input: RouteChoiceInput): Promise<RouteChoiceResult>
}

export interface DefaultButtonRouterDeps {
  store: ButtonStore
  now?: () => number
}

export class DefaultButtonRouter implements ButtonRouter {
  private readonly store: ButtonStore
  private readonly now: () => number

  constructor(deps: DefaultButtonRouterDeps) {
    this.store = deps.store
    this.now = deps.now ?? ((): number => Date.now())
  }

  async routeChoice(input: RouteChoiceInput): Promise<RouteChoiceResult> {
    const chosen_at = input.chosen_at ?? this.now()

    // N6 dual-read + validation (ingress trust boundary) —
    // `RouteChoiceInput.channel_kind` is typed to the canonical vocabulary, but
    // a runtime/legacy caller (an in-flight process, or a client sending the
    // pre-unification hyphen off the wire) may still hand us `'app-socket'`.
    // Normalize once here so both the returned choice AND the value ButtonStore
    // persists are canonical. A token that does NOT normalize to a supported
    // button channel is an unsupported/corrupt channel: reject it before any
    // store write so a bogus value can never enter `resolution_channel_kind`
    // (nor slip past the Telegram hostile-payload guard by masquerading as a
    // non-Telegram channel).
    const channel_kind = normalizeChannelKindForButton(input.channel_kind)
    if (channel_kind === null) {
      // The ingress channel is unsupported/corrupt: we cannot honestly build a
      // `ButtonChoice` (its `channel_kind` is `ChannelKindForButton`), so omit
      // `choice` entirely and surface the raw token for diagnostics only. Reject
      // before any store read/write so a bogus value never enters the DB.
      return {
        delivered: false,
        was_new: false,
        rejected_channel_kind: String(input.channel_kind),
      }
    }

    // Pass the observation time so the get() expiry check uses the same
    // wall clock the caller witnessed — avoids the race where a tap
    // observed before expires_at could be rejected if routing takes long
    // enough for Date.now() to cross the boundary.
    const prompt = await this.store.get(input.prompt_id, chosen_at)
    if (prompt === null) {
      const choice: ButtonChoice = {
        prompt_id: input.prompt_id,
        choice_value: input.raw_value,
        chosen_at,
        speaker_user_id: input.speaker_user_id,
        channel_kind,
      }
      if (input.freeform_text !== undefined) choice.freeform_text = input.freeform_text
      return { delivered: false, choice, was_new: false }
    }

    let choice_value = input.raw_value
    let freeform_text = input.freeform_text

    const isReserved = RESERVED_VALUES.has(choice_value)
    const matchedOption = !isReserved
      ? prompt.options.find((o) => o.value === choice_value)
      : undefined

    // Codex r4 + r8 — Telegram callback_data must match a rendered
    // option (or be one of the reserved sentinels emitted by app-socket
    // /sweepExpired in non-Telegram contexts). A Telegram callback can
    // never legitimately carry __cancel__/__timeout__ (no such button
    // was rendered) or freeform text (typed text comes through the
    // inbound text path, not via callback_data). Anything that doesn't
    // match an option is a crafted/hostile payload; reject with
    // delivered:false rather than coercing to __freeform__, which would
    // let an attacker force-resolve any active prompt.
    if (channel_kind === 'telegram') {
      if (matchedOption === undefined) {
        const undeliverable: ButtonChoice = {
          prompt_id: input.prompt_id,
          choice_value: input.raw_value,
          chosen_at,
          speaker_user_id: input.speaker_user_id,
          channel_kind,
        }
        if (input.freeform_text !== undefined) undeliverable.freeform_text = input.freeform_text
        return { delivered: false, choice: undeliverable, prompt, was_new: false }
      }
    } else if (!isReserved && matchedOption === undefined) {
      // Non-Telegram channel (app-socket / webhook). The freeform
      // fallback applies when the prompt explicitly allowed it.
      if (prompt.allow_freeform) {
        freeform_text = choice_value
        choice_value = '__freeform__'
      } else {
        const undeliverable: ButtonChoice = {
          prompt_id: input.prompt_id,
          choice_value: input.raw_value,
          chosen_at,
          speaker_user_id: input.speaker_user_id,
          channel_kind,
        }
        if (input.freeform_text !== undefined) undeliverable.freeform_text = input.freeform_text
        return { delivered: false, choice: undeliverable, prompt, was_new: false }
      }
    }

    const choice: ButtonChoice = {
      prompt_id: prompt.prompt_id,
      choice_value,
      chosen_at,
      speaker_user_id: input.speaker_user_id,
      channel_kind,
    }
    if (freeform_text !== undefined) choice.freeform_text = freeform_text

    let result
    try {
      result = await this.store.resolve({ choice })
    } catch (err) {
      // The get() above may have OK'd the prompt at observation time,
      // but a concurrent expire-and-sweep could have raced the resolve()
      // transaction — surface as undelivered rather than a 5xx so the
      // user just sees the "this prompt expired" answer-callback.
      if (err instanceof ButtonStoreError && err.code === 'expired') {
        return { delivered: false, choice, prompt, was_new: false }
      }
      throw err
    }
    return {
      delivered: true,
      choice: result.choice,
      prompt: result.prompt,
      was_new: result.was_new,
    }
  }
}

const RESERVED_VALUES = new Set<string>(['__freeform__', '__timeout__', '__cancel__'])

/**
 * Parse a Telegram `callback_data` of the wire form `btn:<22b64>:<value>`
 * into `{ prompt_id (canonical UUID), value }`. Returns null on any
 * malformed input — the caller decides whether to log or drop.
 */
export function parseTelegramCallbackData(
  callback_data: string,
): { prompt_id: string; value: string } | null {
  if (typeof callback_data !== 'string') return null
  if (!callback_data.startsWith(ROUTING_PREFIX)) return null
  const tail = callback_data.slice(ROUTING_PREFIX.length)
  // The wire format is `<22 base64url>:<value>`. The first 22 bytes are
  // the prompt_id segment; the 23rd is the literal ':'; the rest is the
  // value (which may itself contain ':' and is therefore matched greedily).
  if (tail.length < 23) return null
  const wireId = tail.slice(0, 22)
  if (tail[22] !== ':') return null
  const value = tail.slice(23)
  const prompt_id = decodePromptIdWire(wireId)
  if (prompt_id === null) return null
  return { prompt_id, value }
}
