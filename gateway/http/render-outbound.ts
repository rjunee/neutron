/**
 * @neutronai/gateway/http — web button-prompt renderer.
 *
 * D3 (2026-07) — extracted out of `chat-bridge.ts` as a pure function move
 * (no behavior change). `chat-bridge.ts` re-exports `renderButtonPromptForWeb`
 * so existing internal + external `import ... from '.../chat-bridge.ts'`
 * callers keep resolving unchanged; new/repointed callers should import
 * directly from this sibling leaf module instead.
 */

import type { ChatOutbound } from '@neutronai/landing/chat-protocol.ts'
import type { ButtonPrompt } from '@neutronai/channels/button-primitive.ts'

/**
 * Convert a channel-agnostic ButtonPrompt into the locked web envelope
 * (Sprint 16 P2 S5 § 2.5). Adapters that emit on the web chat surface
 * (`/ws/app/chat`) use this shape so the cross-channel parity test stays
 * satisfied:
 *
 *   { v:1, type:'agent_message', body, prompt_id?, options[]?, allow_freeform? }
 *
 * The landing client (`landing/chat.ts`) parses `type:'agent_message'`
 * + `options` to render the keyboard locally.
 */
export function renderButtonPromptForWeb(prompt: ButtonPrompt, topic_id?: string): ChatOutbound {
  // Sprint 28 Codex r4 P1 — propagate `kind` + per-option `image_url`
  // so the image-gallery picker actually renders thumbnails on the
  // web client. Pre-Sprint-28 prompts have neither field set; the
  // ChatOutbound contract treats both as optional.
  //
  // P2 v2 § 6.2 (S4) — propagate the `upload_affordance` metadata bag
  // so the web client renders a file-picker + drag-drop overlay for
  // the `import_upload_pending` phase. Adapters that don't understand
  // the field (Telegram) skip it.
  const out: ChatOutbound = {
    type: 'agent_message',
    body: prompt.body,
    prompt_id: prompt.prompt_id,
    options: prompt.options.map((o) => {
      const opt: { label: string; body: string; value: string; image_url?: string } = {
        label: o.label,
        body: o.body,
        value: o.value,
      }
      if (o.image_url !== undefined) opt.image_url = o.image_url
      return opt
    }),
    allow_freeform: prompt.allow_freeform,
  }
  if (prompt.kind !== undefined) out.kind = prompt.kind
  const upload = normalizeUploadAffordance(prompt.metadata?.['upload_affordance'])
  if (upload !== null) {
    out.upload_affordance = upload
  }
  // P1a — stamp the owning topic so the per-topic client drop-guard routes this
  // prompt to ITS topic, not whatever is focused (notification misrouting).
  if (topic_id !== undefined) out.topic_id = topic_id
  return out
}

/**
 * Coerce a stored `upload_affordance` metadata bag into the narrowed
 * wire shape. Returns null for anything that doesn't carry a recognised
 * source.
 *
 * remove-both-import-option (2026-06-06, Codex r1): a prompt EMITTED
 * before this deploy in the (removed) two-upload 'both' flow persisted
 * `{source:'both'}`. On a post-deploy reconnect the gateway REPLAYS that
 * stored envelope verbatim via `reEmitActiveSeedPromptIfAny`. Dropping
 * the affordance for a stale 'both' would hide the upload bar while the
 * body still asks for a ZIP — a deploy-window dead-end. Instead we
 * NORMALIZE legacy 'both' to 'chatgpt' (the exact single-source fallback
 * the rebuild path `buildImportUploadPendingPromptSpec` uses for a stale
 * 'both'), so the user keeps a working upload affordance. The next engine
 * turn rebuilds the prompt fresh against the narrowed source.
 */
function normalizeUploadAffordance(
  value: unknown,
): { source: 'chatgpt' | 'claude' } | null {
  if (typeof value !== 'object' || value === null) return null
  const src = (value as { source?: unknown }).source
  if (src === 'chatgpt' || src === 'claude') return { source: src }
  if (src === 'both') return { source: 'chatgpt' }
  return null
}
