/**
 * @neutronai/channels — channel-agnostic button-prompt primitive.
 *
 * Per docs/plans/P2-onboarding.md § 2.1 (locked 2026-04-29; wire format
 * pinned 2026-04-30) + § 4.1 module contract.
 *
 * Every agent turn that wants user input via tap-not-type emits a
 * `ButtonPrompt`. The channel layer renders. The wire format is
 * deliberately the lowest common denominator across Telegram and
 * app-socket so adapters can reuse the same routing keys.
 *
 * Wire-format budget (Telegram callback_data, hard-capped at 64 bytes
 * UTF-8 by Bot API 9.6):
 *
 *   total            = 64
 *   prefix `btn:`    =  4
 *   prompt_id seg    = 22 (base64url of 16-byte UUID, no padding) + ':' = 23
 *   value seg        = 64 - 4 - 23 = 37
 *
 * Therefore `ButtonOption.value` is hard-capped at 37 bytes UTF-8. Pass-1
 * said 60; Pass-2 corrected the math because the prompt_id has to round-
 * trip on the callback for routing without a side-table read.
 *
 * App-socket has no equivalent cap, but the contract enforces 37 bytes
 * for cross-channel parity. P5 introduces a `RichButtonPrompt` extension
 * for richer payloads that subclasses this contract instead of replacing
 * it (see § 7 risk row "Button primitive cross-channel divergence").
 */

import { createHash, randomUUID } from 'node:crypto'

import type { WireAgentMessageOption } from '@neutronai/wire-types'

/** Hard byte cap for `ButtonOption.value` per § 2.1 Pass-2 wire format. */
export const VALUE_BYTE_CAP = 37
/** Total Telegram callback_data byte cap. */
export const CALLBACK_DATA_BYTE_CAP = 64
/** `prompt_id` segment width on the wire (base64url 22 chars + ':'). */
export const PROMPT_ID_WIRE_LEN = 23
/** Telegram routing prefix the channel adapter prepends. */
export const ROUTING_PREFIX = 'btn:'
/** Telegram inline-keyboard usability cap — beyond 8 we truncate + warn. */
export const MAX_OPTIONS_TELEGRAM = 8
/** Default 24-hour expiration for outstanding prompts. */
export const DEFAULT_EXPIRES_IN_MS = 24 * 60 * 60 * 1_000

/**
 * Routing sentinels that the button-routing layer treats as control
 * values (freeform fallback / timeout sweep / app-socket cancel). An
 * option whose `value` collides with one of these would be misrouted as
 * a synthetic control path. `validateButtonPrompt` rejects them up front.
 */
export const RESERVED_OPTION_VALUES: ReadonlySet<string> = new Set([
  '__freeform__',
  '__timeout__',
  '__cancel__',
])

export type ChannelKindForButton = 'telegram' | 'app-socket' | 'webhook'

/**
 * The channel-agnostic INPUT primitive for a tappable option.
 *
 * ── L6 (option-shape unification) ─────────────────────────────────────────
 * `ButtonOption` is an EXPLICIT PROJECTION of the canonical
 * {@link WireAgentMessageOption} (`@neutronai/wire-types`): it is a strict
 * structural SUPERSET, adding ONLY the open `metadata` bag below. That
 * `metadata` field is the LOSSY edge preserved explicitly here — it carries
 * Telegram Bot-API decoration hints that are DROPPED when the option is
 * projected onto the app-ws wire (the wire `options[]` never carries
 * `metadata`). Every other field (`label` / `body` / `value` / `image_url` /
 * `decoration`) is inherited verbatim from the canonical shape, so the three
 * byte-identical wire declarations and this input primitive can never drift.
 *
 * Field notes carried over from the pre-L6 declaration:
 *   - `label`     — the A/B/C/D face rendered as the visible button.
 *   - `body`      — human-readable copy shown next to the label.
 *   - `value`     — routing value the agent receives on tap; ≤ VALUE_BYTE_CAP
 *                   UTF-8 bytes (enforced at runtime by `validateButtonPrompt`,
 *                   NOT by the type — the wire shape imposes no cap).
 *   - `decoration`— optional Bot API 9.6 inline-keyboard decoration.
 *   - `image_url` — Sprint 28 image-gallery thumbnail (absolute or
 *                   project-relative URL the channel resolves to bytes; the URL
 *                   does NOT travel on Telegram callback_data — only `value`).
 */
export interface ButtonOption extends WireAgentMessageOption {
  /**
   * Optional channel-agnostic metadata. The Telegram adapter reads
   * `metadata.action_kind` to apply Bot API 9.6 emoji + style polish
   * (see `channels/adapters/telegram/decoration-emoji.ts`); other
   * adapters may grow their own polish hooks off this slot.
   *
   * Open shape so future adapters can read additional hints without
   * re-running the schema lock-step. Codex r6 P2 fix — previously
   * `action_kind` was reachable only via unsafe casts at the wire
   * boundary; promoting it onto the typed contract lets agents pass
   * it through `buildButtonPrompt` without surgery.
   *
   * L6: this is the ONE field that makes `ButtonOption` a superset of the
   * canonical wire option — it never reaches the app-ws wire (lossy edge).
   */
  metadata?: { action_kind?: string; [key: string]: unknown }
}

/**
 * Sprint 28 — `ButtonPrompt.kind` discriminator for the Telegram /
 * web-socket / app-socket renderers. Default `'buttons'` keeps every
 * pre-Sprint-28 prompt at parity (no flag, same render). The new
 * `'image-gallery'` variant signals that adapters should render the
 * options as a horizontal photo gallery + a parallel button row whose
 * `value`s map back to `pipeline.pick(...)`.
 */
export type ButtonPromptKind = 'buttons' | 'image-gallery'

export interface ButtonPrompt {
  /** Stable id; the channel layer deduplicates outbound + correlates inbound. */
  prompt_id: string
  /** Markdown body shown above the buttons. */
  body: string
  options: ButtonOption[]
  /** When true, the channel layer also accepts a freeform reply that gets
   *  normalized to value=`__freeform__`. */
  allow_freeform: boolean
  /** Wall-clock ms after which the channel layer auto-resolves with `__timeout__`. */
  expires_in_ms?: number
  /** Idempotency key — repeated emits with the same key collapse to one render. */
  idempotency_key?: string
  /**
   * Sprint 28 — render hint for the channel adapter. Default `'buttons'`
   * keeps the pre-Sprint-28 contract (single keyboard); `'image-gallery'`
   * signals that every option carries an `image_url` and the adapter
   * should render a parallel photo gallery. Adapters MAY ignore the hint
   * (graceful degradation — a non-image-aware surface still receives the
   * text label per option), but production adapters honor it.
   */
  kind?: ButtonPromptKind
  /**
   * P2 v2 § 6.2 (S4) — open-shape, prompt-level metadata bag. Mirrors
   * the per-option `metadata` field but lives at the prompt root so an
   * agent can thread a render hint that applies to the keyboard as a
   * whole (rather than to a single button). The first consumer is the
   * `upload_affordance: { source: 'chatgpt' | 'claude' }`
   * hint the `import_upload_pending` phase carries so the web client
   * renders a file-picker + drag-drop overlay alongside the buttons.
   *
   * Channel adapters that do not understand a given metadata key MUST
   * ignore it (graceful degradation). Telegram's render path drops the
   * field on the floor; the web bridge picks `upload_affordance` off
   * the prompt and forwards it on the `agent_message` envelope.
   */
  metadata?: Record<string, unknown>
}

export interface ButtonChoice {
  prompt_id: string
  /** option.value | '__freeform__' | '__timeout__' | '__cancel__' */
  choice_value: string
  freeform_text?: string
  /** Unix ms when the user tapped (or sweepExpired fired). */
  chosen_at: number
  speaker_user_id: string
  channel_kind: ChannelKindForButton
}

export type ButtonPrimitiveErrorCode =
  | 'value_too_long'
  | 'duplicate_value'
  | 'no_options'
  | 'invalid_label'
  | 'invalid_prompt_id'
  | 'body_required'
  | 'reserved_value'
  | 'image_url_missing'

export class ButtonPrimitiveError extends Error {
  override readonly name = 'ButtonPrimitiveError'
  constructor(
    readonly code: ButtonPrimitiveErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Validate a `ButtonPrompt`. Throws `ButtonPrimitiveError` on:
 *   - empty `body` or `options`
 *   - any `value` longer than VALUE_BYTE_CAP UTF-8 bytes
 *   - any empty `label`
 *   - duplicate `value` across options
 *   - malformed `prompt_id` (not a 36-char canonical UUID)
 *
 * NOTE: > MAX_OPTIONS_TELEGRAM options is NOT a validation error — adapters
 * truncate. The contract is channel-agnostic; oversized input is the
 * Telegram adapter's problem.
 */
export function validateButtonPrompt(prompt: ButtonPrompt): void {
  if (typeof prompt.prompt_id !== 'string' || !UUID_RE.test(prompt.prompt_id)) {
    throw new ButtonPrimitiveError(
      'invalid_prompt_id',
      `prompt_id must be a 36-char canonical UUID, got=${JSON.stringify(prompt.prompt_id)}`,
    )
  }
  if (typeof prompt.body !== 'string' || prompt.body.length === 0) {
    throw new ButtonPrimitiveError(
      'body_required',
      `prompt.body must be a non-empty string, got=${typeof prompt.body}`,
    )
  }
  if (!Array.isArray(prompt.options)) {
    throw new ButtonPrimitiveError(
      'no_options',
      `prompt.options must be an array`,
    )
  }
  if (prompt.options.length === 0 && !prompt.allow_freeform) {
    // LLM-driven prompts sprint (2026-05-09) — a free-text-only prompt
    // (no buttons, allow_freeform=true) is a valid new shape: the LLM
    // body asks the user something open-ended and the channel renders
    // text + freeform input. The primitive only refuses zero-options
    // when the prompt ALSO disallows freeform — that combination has
    // no path forward for the user.
    throw new ButtonPrimitiveError(
      'no_options',
      `prompt.options must be non-empty when allow_freeform=false (zero-option prompts only valid for free-text intents)`,
    )
  }
  const seen = new Set<string>()
  for (const opt of prompt.options) {
    if (typeof opt.label !== 'string' || opt.label.length === 0) {
      throw new ButtonPrimitiveError(
        'invalid_label',
        `each option.label must be a non-empty string`,
      )
    }
    if (typeof opt.value !== 'string') {
      throw new ButtonPrimitiveError(
        'invalid_label',
        `option.value must be a string for label=${JSON.stringify(opt.label)}`,
      )
    }
    if (RESERVED_OPTION_VALUES.has(opt.value)) {
      throw new ButtonPrimitiveError(
        'reserved_value',
        `option.value=${JSON.stringify(opt.value)} collides with a routing sentinel; reserved values: ${[...RESERVED_OPTION_VALUES].join(', ')}`,
      )
    }
    const byteLen = Buffer.byteLength(opt.value, 'utf8')
    if (byteLen > VALUE_BYTE_CAP) {
      throw new ButtonPrimitiveError(
        'value_too_long',
        `option.value=${JSON.stringify(opt.value)} is ${byteLen} bytes UTF-8; cap is ${VALUE_BYTE_CAP}`,
      )
    }
    if (seen.has(opt.value)) {
      throw new ButtonPrimitiveError(
        'duplicate_value',
        `duplicate option.value=${JSON.stringify(opt.value)}`,
      )
    }
    seen.add(opt.value)
  }
  // Sprint 28 — image-gallery prompts MUST attach an image_url to every
  // option whose value is a candidate id (i.e. NOT a control-row option
  // like 'regen' / 'gallery' / 'upload'). We don't try to enumerate the
  // control values here — instead we require every option to either
  // declare a non-empty `image_url` OR have a value starting with the
  // `__` reserved-prefix-style control marker. This keeps the contract
  // tight enough that "I forgot to attach a thumbnail" fails fast, but
  // loose enough that a "Regenerate" button without an image still ships.
  if (prompt.kind === 'image-gallery') {
    for (const opt of prompt.options) {
      const isControlRow =
        opt.value === 'regen' ||
        opt.value === 'gallery' ||
        opt.value === 'upload' ||
        opt.value === 'skip' ||
        opt.value === 'skip-portrait' ||
        opt.value === 'skip-slug' ||
        opt.value === 'pause'
      const hasImage = typeof opt.image_url === 'string' && opt.image_url.length > 0
      if (!hasImage && !isControlRow) {
        throw new ButtonPrimitiveError(
          'image_url_missing',
          `image-gallery prompt option.label=${JSON.stringify(opt.label)} value=${JSON.stringify(opt.value)} is missing image_url; non-control options in an image gallery require a renderable thumbnail`,
        )
      }
    }
  }
}

export interface BuildButtonPromptInput {
  body: string
  options: Array<{
    label: string
    body: string
    value: string
    decoration?: ButtonOption['decoration']
    metadata?: ButtonOption['metadata']
    /** Sprint 28 — see `ButtonOption.image_url`. */
    image_url?: string
  }>
  allow_freeform?: boolean
  expires_in_ms?: number
  /** Caller-supplied dedup key. Wins over `idempotency_seed` when both are set. */
  idempotency_key?: string
  /** Override for tests. Production passes `randomUUID`. */
  uuid?: () => string
  /**
   * Stable derivation triple. When `idempotency_key` is absent and these
   * are provided, the constructor derives the key via `deriveIdempotencyKey`
   * (sha256 truncated to 16 hex chars) so callers get the same key on
   * retry without having to thread a hash through the call site.
   */
  idempotency?: { project_slug: string; topic_id: string; seed: string }
  /** Sprint 28 — see `ButtonPrompt.kind`. */
  kind?: ButtonPromptKind
  /** P2 v2 § 6.2 (S4) — open-shape prompt-level metadata bag. See
   *  `ButtonPrompt.metadata` for the full contract. */
  metadata?: Record<string, unknown>
}

/**
 * Constructor sugar — agents call this rather than building objects manually.
 * Generates a fresh prompt_id (UUID v4) and validates the result before
 * returning. Throws `ButtonPrimitiveError` on bad shapes.
 */
export function buildButtonPrompt(input: BuildButtonPromptInput): ButtonPrompt {
  const uuid = input.uuid ?? randomUUID
  const prompt: ButtonPrompt = {
    prompt_id: uuid(),
    body: input.body,
    options: input.options.map((o) => {
      const opt: ButtonOption = { label: o.label, body: o.body, value: o.value }
      if (o.decoration !== undefined) opt.decoration = o.decoration
      if (o.metadata !== undefined) opt.metadata = o.metadata
      if (o.image_url !== undefined) opt.image_url = o.image_url
      return opt
    }),
    allow_freeform: input.allow_freeform ?? false,
  }
  if (input.expires_in_ms !== undefined) prompt.expires_in_ms = input.expires_in_ms
  if (input.idempotency_key !== undefined) {
    prompt.idempotency_key = input.idempotency_key
  } else if (input.idempotency !== undefined) {
    prompt.idempotency_key = deriveIdempotencyKey(input.idempotency)
  }
  if (input.kind !== undefined) prompt.kind = input.kind
  if (input.metadata !== undefined) prompt.metadata = input.metadata
  validateButtonPrompt(prompt)
  return prompt
}

/**
 * Helper — derive a stable 16-hex-char idempotency key from a (instance,
 * topic, seed) triple. The agent rarely needs this directly; it's exposed
 * because `ButtonStore.emit` consumes it AND tests assert determinism.
 */
export function deriveIdempotencyKey(input: {
  project_slug: string
  topic_id: string
  seed: string
}): string {
  const h = createHash('sha256')
  h.update(input.project_slug)
  h.update(':')
  h.update(input.topic_id)
  h.update(':')
  h.update(input.seed)
  return h.digest('hex').slice(0, 16)
}

/**
 * Canonical-JSON over (body, options[].value, expires_at?). Stable across
 * key insertion order — caller can derive an idempotency seed from the
 * prompt content alone without worrying about V8 property order.
 */
export function canonicalPromptSeed(input: {
  body: string
  options: Array<{ value: string }>
  expires_at?: number
}): string {
  const opts = input.options.map((o) => o.value)
  const obj: Record<string, unknown> = { body: input.body, options: opts }
  if (input.expires_at !== undefined) obj.expires_at = input.expires_at
  return JSON.stringify(obj)
}

/**
 * Encode a 16-byte UUID as 22-char base64url (no padding). The Telegram
 * callback_data wire format relies on this — see § 2.1 Pass-2 wire format.
 * Exported for the Telegram adapter + the routing parser.
 */
export function encodePromptIdWire(prompt_id: string): string {
  if (!UUID_RE.test(prompt_id)) {
    throw new ButtonPrimitiveError('invalid_prompt_id', `not a UUID: ${prompt_id}`)
  }
  const hex = prompt_id.replace(/-/g, '')
  const bytes = Buffer.from(hex, 'hex')
  return bytes.toString('base64url')
}

/** Inverse of `encodePromptIdWire`. Returns null on malformed input. */
export function decodePromptIdWire(wire: string): string | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(wire)) return null
  let bytes: Buffer
  try {
    bytes = Buffer.from(wire, 'base64url')
  } catch {
    return null
  }
  if (bytes.length !== 16) return null
  const hex = bytes.toString('hex')
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20)
  )
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
