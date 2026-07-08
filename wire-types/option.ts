/**
 * @neutronai/wire-types — THE canonical agent-message OPTION shape (L6).
 *
 * Before L6 there were FIVE near-identical option declarations scattered
 * across the transport + clients (audit §"option-shape unification"):
 *
 *   1. `ButtonOption`                       `channels/button-primitive.ts`
 *   2. `AppWsOutboundAgentMessageOption`    `channels/adapters/app-ws/envelope.ts`
 *   3. the Expo mirror                      `app/lib/ws-envelope.ts`
 *   4. `ChatMessageOption`                  `chat-core/types.ts`
 *   5. `InlineChoice`                       `channels/types.ts`
 *
 * Shapes 2, 3 and 4 were byte-for-byte identical — `{ label, body, value,
 * image_url?, decoration? }`. This module makes that shape the ONE
 * canonical `WireAgentMessageOption`; those three sites now re-export /
 * alias it (the Expo mirror #3 is deleted outright). The two remaining
 * shapes are KEPT as EXPLICIT projections because their semantics genuinely
 * differ — do NOT collapse them into this type:
 *
 *   - `ButtonOption` (#1) is the CHANNEL-AGNOSTIC INPUT primitive. It is a
 *     structural SUPERSET of this wire shape: it adds an open `metadata`
 *     bag (Telegram Bot-API decoration hints) that is dropped when the
 *     option is projected onto the app-ws wire. It therefore `extends
 *     WireAgentMessageOption` in `channels/button-primitive.ts` — the added
 *     `metadata` field is the lossy edge, preserved explicitly there.
 *
 *   - `InlineChoice` (#5) is the TELEGRAM RENDER projection — `{ label,
 *     callback_data }`. It carries neither `body` nor `value`; its `label`
 *     MUST carry the human-readable DISPLAY text (see
 *     `channels/adapters/app-ws/adapter.ts` `optionsToInlineChoices` — the
 *     "label must carry display text" contract, Codex P2 2026-06-30), and
 *     `callback_data` is the routing `value`. It stays a distinct type in
 *     `channels/types.ts`; the mapping to/from this wire shape is the
 *     explicit, asymmetric projection the adapter owns.
 *
 * Node-free (this whole leaf is a bottom band): a pure structural type with
 * no imports.
 */

/**
 * THE canonical option attached to an agent message on the wire.
 *
 *   - `label`      — the visible button face (an "A"/"B" legend OR display
 *                    text, depending on the producing surface).
 *   - `body`       — the canonical human-readable copy the web/mobile client
 *                    actually paints under the button (`body || label`).
 *   - `value`      — the ROUTING key the client posts back on tap (NOT
 *                    `label`). On Telegram this becomes `InlineChoice.callback_data`.
 *   - `image_url`  — optional thumbnail for the `image-gallery` render mode.
 *   - `decoration` — optional Bot-API 9.6 style/emoji polish; ignored by
 *                    non-Telegram surfaces.
 *
 * This is the shape that rides `AppWsOutboundAgentMessage.options[]`, lands
 * in `chat-core`'s `ChatMessage.options[]`, and is rendered by both web
 * (React) and mobile (RN). It is the SUBSET common to all wire surfaces —
 * the `ButtonOption` input primitive's `metadata` bag is intentionally NOT
 * here (it never reaches the wire).
 */
export interface WireAgentMessageOption {
  label: string
  body: string
  value: string
  image_url?: string
  decoration?: {
    style?: 'default' | 'destructive' | 'primary'
    icon_custom_emoji_id?: string
  }
}
