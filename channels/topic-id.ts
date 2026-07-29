/**
 * @neutronai/channels/topic-id — shared `channel_topic_id` parsers.
 *
 * The engine's state-store + sendButtonPrompt routing both key on the
 * `topic_id` string. Three shapes are in production today:
 *
 *   - `app:<user_id>`               — AppWs (Expo) surface
 *   - `web:<user_id>`               — web-chat surface (landing/chat.ts)
 *   - `<chat_id>[:<thread_id>]`     — Telegram raw shape (webhook-server)
 *
 * Some downstream call sites (chat-bridge `sendButtonPrompt` routing,
 * upload-handler header validation) also accept a `tg:<chat_id>[:<thread_id>]`
 * synthetic shape — these never reach state-store user_id lookup paths,
 * because no user_id is encoded in the Telegram topic_id.
 *
 * The upload handler at `gateway/upload/import-upload-handler.ts` needs
 * to derive the engine's `user_id` from the inbound `X-Neutron-Topic-Id`
 * header so `notifyImportUpload` finds the per-project onboarding-state
 * row (migration 0034 keyed lookup on `(project_slug, user_id)`). Pre-fix,
 * only `app:<user_id>` was parsed; the production web client sends
 * `web:<sub>` and was silently dropping into the empty-string fallback
 * → `outcome=noop_no_state` → user stuck in `import_upload_pending`
 * after a 200 OK. {@link parseAnyTopicId} is the single seam every
 * caller must use so both shapes resolve correctly.
 */

/**
 * Parsed shape of a channel topic_id. `kind` discriminates the surface
 * the topic id came from; `user_id` is populated for shapes that
 * directly encode it (`app:`, `web:`). Telegram shapes carry no user_id
 * — the bridge resolves user from the Telegram update separately —
 * so `user_id` is undefined and callers needing user-keyed lookups
 * must fall through to channel-specific logic.
 */
export interface ParsedTopicId {
  kind: 'app' | 'web' | 'tg'
  user_id?: string
}

/**
 * Parse a `channel_topic_id` into its discriminated shape. Returns null
 * when no production shape matches (e.g. legacy `'chat'` placeholder, or
 * a malformed/empty string). For shapes that carry a user_id (`app:`,
 * `web:`) the parsed `user_id` is guaranteed non-empty when the function
 * returns non-null.
 *
 * Telegram shapes are recognised in two forms:
 *   - explicit `tg:<chat_id>[:<thread_id>]` — used by the engine's
 *     `sendButtonPrompt` routing prefix; not currently emitted by the
 *     Telegram webhook decoder but accepted here for symmetry.
 *   - bare `<digits>[:<digits>]` — the actual `renderTopicId` output
 *     from `channels/adapters/telegram/webhook-server.ts`.
 *
 * Returning a `kind` discriminator lets callers handle each surface
 * without re-scanning the prefix.
 */
export function parseAnyTopicId(topic_id: string): ParsedTopicId | null {
  if (typeof topic_id !== 'string' || topic_id.length === 0) return null
  if (topic_id.startsWith('app:')) {
    const user_id = topic_id.slice('app:'.length)
    if (user_id.length === 0) return null
    return { kind: 'app', user_id }
  }
  if (topic_id.startsWith('web:')) {
    const user_id = topic_id.slice('web:'.length)
    if (user_id.length === 0) return null
    return { kind: 'web', user_id }
  }
  if (topic_id.startsWith('tg:')) {
    const rest = topic_id.slice('tg:'.length)
    if (rest.length === 0) return null
    return { kind: 'tg' }
  }
  // Bare numeric `<chat_id>[:<thread_id>]` — the actual Telegram shape
  // emitted by `renderTopicId`. The dispatch table below stays narrow:
  // any non-prefixed string that is at least one digit + optional
  // `:<digits>` is treated as a Telegram topic id.
  if (/^[0-9]+(:[0-9]+)?$/.test(topic_id)) {
    return { kind: 'tg' }
  }
  return null
}
