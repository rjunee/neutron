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

function looksLikeImage(url: string): boolean {
  if (/^data:image\//i.test(url)) return true
  return IMAGE_EXT.test(url)
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
  if (m.text.length > 0) parts.push({ type: 'text', text: m.text })
  if (m.attachments !== null) {
    for (const raw of m.attachments) {
      const url = absolutize(raw, origin)
      if (looksLikeImage(url)) parts.push({ type: 'image', image: url })
      else parts.push({ type: 'text', text: `📎 ${url}` })
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
