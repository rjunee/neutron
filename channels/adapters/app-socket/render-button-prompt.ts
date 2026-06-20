/**
 * @neutronai/channels — app-socket adapter: ButtonPrompt → wire envelope.
 *
 * Per docs/plans/P2-onboarding.md § 2.1 (cross-channel parity locked) +
 * § 6 S5 line 2143 ("full impl supersedes S1 STUB"). The S1 STUB threw
 * AppSocketRenderNotWiredError; S5 replaces it with the real renderer
 * over the app-socket transport.
 *
 * Wire envelope (locked here so P5's polished WebSocket transport honors
 * the same shape):
 *
 *   {
 *     v: 1,
 *     type: 'button_prompt',
 *     prompt_id: <canonical UUID>,
 *     body: <markdown>,
 *     options: [{ label, body, value, decoration? }, ...],
 *     allow_freeform: <bool>,
 *     expires_at_ms: <unix ms>,
 *     idempotency_key?: <string>
 *   }
 *
 * Encoding handles option `value` strings up to VALUE_BYTE_CAP (37 bytes
 * UTF-8) — same cap as Telegram callback_data so cross-channel parity
 * holds. App-socket has no native byte-budget but we enforce the cap so
 * an option that round-trips between channels can never silently lose
 * bytes.
 *
 * Idempotency: identical to the Telegram path. The caller's
 * `ButtonStore.emit` is the dedup primitive; this renderer is a pure
 * function over the prompt + the resolved expires_at.
 */

import {
  validateButtonPrompt,
  VALUE_BYTE_CAP,
  ButtonPrimitiveError,
  type ButtonPrompt,
} from '../../button-primitive.ts'

/**
 * Sentinels that an inbound app-socket envelope MUST NOT carry.
 *
 * `__freeform__` is router-internal — the freeform fallback path
 * fires when a non-matching value arrives at a prompt with
 * `allow_freeform: true`, NOT when a client supplies the literal
 * sentinel.
 *
 * `__timeout__` is exclusively produced by `ButtonStore.sweepExpired`
 * for unresolved prompts past `expires_at`; a client supplying it
 * could fake a synthetic expiry against an active prompt.
 *
 * `__cancel__` IS a legitimate user action on app-socket (a UI
 * cancel button) — kept reachable so the documented non-Telegram
 * cancel path stays usable.
 *
 * Exported (PR #331 Argus r4 BLOCKER) so the chat-bridge can apply
 * the same reject at the WS button_choice handler — killing the
 * class of "client-supplied sentinel resolves a live prompt row"
 * lockout bugs at the gateway boundary instead of patching each
 * engine handler one variant at a time. See
 * `gateway/http/chat-bridge.ts` button_choice branch.
 */
export const FORBIDDEN_INBOUND_VALUES: ReadonlySet<string> = new Set([
  '__freeform__',
  '__timeout__',
])

/**
 * Outbound app-socket message — the wire envelope agent → user. P5's
 * polished WebSocket transport ships this verbatim.
 */
export interface AppSocketButtonPromptMessage {
  v: 1
  type: 'button_prompt'
  prompt_id: string
  body: string
  options: Array<{
    label: string
    body: string
    value: string
    decoration?: { icon_custom_emoji_id?: string; style?: 'default' | 'destructive' | 'primary' }
    /**
     * Sprint 28 Codex r4 P1 — per-option image URL for the image-
     * gallery picker. The app-socket client renders these as
     * tappable thumbnails when the prompt's `kind` is
     * `'image-gallery'`.
     */
    image_url?: string
  }>
  allow_freeform: boolean
  expires_at_ms: number
  idempotency_key?: string
  /** Sprint 28 Codex r4 P1 — render hint. See `ButtonPromptKind`. */
  kind?: 'buttons' | 'image-gallery'
}

/**
 * Inbound app-socket message — the wire envelope user → agent. The
 * mock `socket-server.ts` drives this shape into the cross-channel test;
 * production wires through the same `DefaultButtonRouter.routeChoice`
 * path the Telegram callback handler uses.
 */
export interface AppSocketButtonChoiceMessage {
  v: 1
  type: 'button_choice'
  prompt_id: string
  /** option.value | '__freeform__' | '__cancel__' */
  choice_value: string
  freeform_text?: string
  speaker_user_id: string
}

/**
 * Retained for backward compatibility — the S1 STUB threw this error.
 * The S5 full impl no longer throws on render; the type lives on so
 * old call sites that caught it still type-check. New callers should
 * not catch this; render errors surface as `ButtonPrimitiveError` now.
 */
export class AppSocketRenderNotWiredError extends Error {
  override readonly name = 'AppSocketRenderNotWiredError'
  constructor(message: string) {
    super(message)
  }
}

export interface RenderButtonPromptAppSocketInput {
  prompt: ButtonPrompt
  /**
   * Wall-clock ms to use for the envelope's `expires_at_ms`. Production
   * wires this from `ButtonStore.emit`'s `expires_at`; tests can pass a
   * stable number for determinism.
   */
  expires_at_ms: number
}

/**
 * Render a `ButtonPrompt` into the app-socket wire envelope.
 *
 * Throws:
 *   - `ButtonPrimitiveError(value_too_long)` when an option.value blows
 *     the cross-channel cap (37 bytes UTF-8 — same as the Telegram
 *     callback_data per § 2.1 Pass-2). This is intentional even though
 *     app-socket has no native byte-budget: an option that round-trips
 *     between channels must encode identically on both, so the
 *     adapter rejects oversize values up front.
 *   - `ButtonPrimitiveError` from `validateButtonPrompt` on any other
 *     malformed prompt shape (empty body, bad UUID, duplicate values).
 */
export function renderButtonPromptAppSocket(
  input: RenderButtonPromptAppSocketInput,
): AppSocketButtonPromptMessage {
  const { prompt, expires_at_ms } = input
  validateButtonPrompt(prompt)

  // Cross-channel byte budget — match the Telegram cap so an option that
  // ships on both transports can never diverge.
  for (const opt of prompt.options) {
    const byteLen = Buffer.byteLength(opt.value, 'utf8')
    if (byteLen > VALUE_BYTE_CAP) {
      throw new ButtonPrimitiveError(
        'value_too_long',
        `app-socket option.value=${JSON.stringify(opt.value)} is ${byteLen} bytes UTF-8; ` +
          `cap is ${VALUE_BYTE_CAP} (cross-channel parity with Telegram callback_data)`,
      )
    }
  }

  const envelope: AppSocketButtonPromptMessage = {
    v: 1,
    type: 'button_prompt',
    prompt_id: prompt.prompt_id,
    body: prompt.body,
    options: prompt.options.map((o) => {
      const out: AppSocketButtonPromptMessage['options'][number] = {
        label: o.label,
        body: o.body,
        value: o.value,
      }
      if (o.decoration !== undefined) {
        const dec: NonNullable<AppSocketButtonPromptMessage['options'][number]['decoration']> = {}
        if (o.decoration.icon_custom_emoji_id !== undefined) {
          dec.icon_custom_emoji_id = o.decoration.icon_custom_emoji_id
        }
        if (o.decoration.style !== undefined) {
          dec.style = o.decoration.style
        }
        if (Object.keys(dec).length > 0) out.decoration = dec
      }
      // Sprint 28 Codex r4 P1 — propagate per-option image_url for
      // image-gallery prompts.
      if (o.image_url !== undefined) out.image_url = o.image_url
      return out
    }),
    allow_freeform: prompt.allow_freeform,
    expires_at_ms,
  }
  if (prompt.idempotency_key !== undefined) {
    envelope.idempotency_key = prompt.idempotency_key
  }
  // Sprint 28 Codex r4 P1 — propagate kind so the client renders
  // image-gallery prompts as a thumbnail grid.
  if (prompt.kind !== undefined) envelope.kind = prompt.kind
  return envelope
}

/**
 * Decode an inbound app-socket button-choice envelope into the shape
 * `DefaultButtonRouter.routeChoice` consumes. Returns null on a
 * malformed envelope (wrong `v`, wrong `type`, missing required
 * fields, OR a `choice_value` that collides with a forbidden
 * inbound sentinel) so the caller can drop without crashing the
 * socket.
 *
 * Codex r7 P1 + r8 P2 — clients MUST NOT supply `__freeform__` or
 * `__timeout__` (router-internal sentinels that bypass option
 * matching for non-Telegram channels; allowing them lets a
 * malicious / buggy socket resolve any active prompt into a hidden
 * state never rendered to the user).
 *
 * `__cancel__` IS allowed — it's a legitimate user-initiated
 * action that the app-socket UX can surface as a cancel button.
 * The router treats it as an authorized control path; the prompt
 * resolves to "user cancelled".
 */
export function parseAppSocketButtonChoice(
  envelope: unknown,
): { prompt_id: string; raw_value: string; freeform_text?: string; speaker_user_id: string } | null {
  if (typeof envelope !== 'object' || envelope === null) return null
  const e = envelope as Record<string, unknown>
  if (e['v'] !== 1) return null
  if (e['type'] !== 'button_choice') return null
  const prompt_id = e['prompt_id']
  const choice_value = e['choice_value']
  const speaker_user_id = e['speaker_user_id']
  if (typeof prompt_id !== 'string' || prompt_id.length === 0) return null
  if (typeof choice_value !== 'string' || choice_value.length === 0) return null
  if (typeof speaker_user_id !== 'string' || speaker_user_id.length === 0) return null
  if (FORBIDDEN_INBOUND_VALUES.has(choice_value)) return null
  const out: { prompt_id: string; raw_value: string; freeform_text?: string; speaker_user_id: string } = {
    prompt_id,
    raw_value: choice_value,
    speaker_user_id,
  }
  const freeform = e['freeform_text']
  if (typeof freeform === 'string') out.freeform_text = freeform
  return out
}
