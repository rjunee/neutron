/**
 * landing/chat-react — pure mapping from a {@link RenderMessage} (controller
 * view-model) to assistant-ui's {@link ThreadMessageLike}.
 *
 * Kept free of React + side effects so it unit-tests directly. The two shape
 * constraints `fromThreadMessageLike` enforces are encoded here:
 *   - `status` is ONLY valid on assistant messages (so we set the `running`
 *     status only for a streaming agent bubble);
 *   - image parts must carry an absolute `https://` / `data:` / `blob:` URL —
 *     gateway-relative upload URLs (`/api/app/upload/...`) are absolutized
 *     against the page origin so they render instead of being dropped.
 */

import type { ThreadMessageLike } from '@assistant-ui/react'
import type { RenderMessage } from './controller.ts'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i

/** Absolutize a possibly-relative URL against the page origin. */
export function absolutize(url: string, origin: string): string {
  if (/^(https?:\/\/|data:|blob:)/i.test(url)) return url
  if (url.startsWith('/')) return `${origin}${url}`
  return url
}

/**
 * True when an attachment URL points at a raster image (by `data:image/` prefix
 * or an image file extension). The bubble renderer ({@link AttachmentImage})
 * uses the SAME predicate to decide between an `<img>` and a downloadable file
 * chip, so a non-image attachment (e.g. a PDF) never renders as a broken image.
 */
export function isImageAttachmentUrl(url: string): boolean {
  if (/^data:image\//i.test(url)) return true
  return IMAGE_EXT.test(url)
}

const AUDIO_EXT = /\.(mp3|m4a|wav)(\?|#|$)/i

/**
 * True when an attachment URL points at an AUDIO voice note (by `data:audio/`
 * prefix or an audio file extension). The non-image chip renderer uses this to
 * show a 🎵 icon instead of the generic 📎, so a voice note reads as one at a
 * glance (M2 task 5).
 */
export function isAudioAttachmentUrl(url: string): boolean {
  if (/^data:audio\//i.test(url)) return true
  return AUDIO_EXT.test(url)
}

/**
 * Strip the stray leading/trailing NEWLINES that make a one-line bubble render
 * ~2x tall. Both bubble paths preserve newlines — the user `<p class="car-text">`
 * renders `white-space: pre-line` and the agent `.car-bubble` has
 * `white-space: pre-wrap` — so a trailing (or leading) `\n` on a one-line message
 * shows as an extra EMPTY line.
 *
 * Deliberately narrow: only leading newlines and all trailing whitespace are
 * removed. Leading horizontal whitespace (spaces) is PRESERVED so a Markdown
 * agent message that opens with an indented code block (e.g. `"    npm test"`)
 * still renders as code. Internal blank lines (a real multi-line message) are
 * untouched, so intentional line breaks still render.
 */
export function normalizeBody(text: string): string {
  return text.replace(/^\n+/, '').replace(/\s+$/, '')
}

type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly image: string }

/**
 * Convert a controller message to a `ThreadMessageLike`. `origin` absolutizes
 * relative attachment URLs (defaults to empty — relative URLs then pass through
 * unchanged, which is fine in tests).
 */
export function toThreadMessage(m: RenderMessage, origin = ''): ThreadMessageLike {
  const role: 'assistant' | 'user' = m.role === 'agent' ? 'assistant' : 'user'
  const parts: ContentPart[] = []
  // Track B Phase 4 (edit/delete) — a tombstoned message renders a deleted
  // placeholder instead of its (cleared) body + attachments.
  if (m.deleted) {
    const tomb = { id: m.id, role, content: [{ type: 'text', text: '🚫 This message was deleted' }] } as const
    return role === 'assistant' ? { ...tomb, status: { type: 'complete', reason: 'stop' } } : tomb
  }
  const body = normalizeBody(m.text)
  if (body.length > 0) parts.push({ type: 'text', text: body })
  if (m.attachments !== null) {
    // Route EVERY attachment through the `image` content part — the bubble's
    // authed renderer ({@link AttachmentImage}) branches on {@link
    // isImageAttachmentUrl}: an image renders as `<img>`, a non-image (PDF)
    // renders as a downloadable file chip using the SAME bearer-authed fetch.
    for (const raw of m.attachments) {
      parts.push({ type: 'image', image: absolutize(raw, origin) })
    }
  }
  // An empty content array is valid (assistant-ui filters empty parts); but for
  // a brand-new streaming bubble with no tokens yet, seed an empty text part so
  // the bubble exists to render the "running" indicator into.
  if (parts.length === 0) parts.push({ type: 'text', text: '' })

  const base = { id: m.id, role, content: parts } as const
  if (role === 'assistant') {
    return {
      ...base,
      status: m.streaming ? { type: 'running' } : { type: 'complete', reason: 'stop' },
    }
  }
  return base
}
