/**
 * @neutronai/channels/app-ws — wire envelopes for the Expo-app / web-React
 * WebSocket surface (P5.1 + P5.2).
 *
 * ── L6 (2026-07): types moved to `@neutronai/wire-types` ──────────────────
 * The envelope UNION + all its member interfaces were extracted into the
 * node-free `@neutronai/wire-types` leaf so the pure clients (Expo app,
 * landing React) can import ONE source instead of the hand mirror that used
 * to live at `app/lib/ws-envelope.ts` (deleted in L6). This file is now the
 * channel-side barrel: it RE-EXPORTS those types (so every existing
 * server-side import specifier `channels/adapters/app-ws/envelope` stays
 * valid) and KEEPS the runtime decode/sanitize VALUE helpers + the wire caps,
 * which encode channel-side validation rather than the wire shape. The
 * `appWsTopicId` / `appWsProjectTopicId` / `parseAppWsTopicId` derivation also
 * moved to `@neutronai/wire-types` (`./topic-id.ts`) — re-exported below.
 *
 * The shape is a strict superset of the landing `ChatOutbound`. Versioning:
 * every envelope carries `v: 1`; a breaking field shape bumps `v` and ships a
 * new union member — the client drops envelopes whose `v` it doesn't understand.
 */

import type {
  AppWsInbound,
  AppWsInboundUserMessage,
  AppWsInboundResume,
  AppWsInboundReceipt,
  AppWsInboundReaction,
  AppWsInboundEdit,
  AppWsInboundButtonChoice,
} from '@neutronai/wire-types'

// L6 — re-export the full envelope wire-type union (owned by
// @neutronai/wire-types) so consumers of this module keep working unchanged.
export type {
  AppWsInbound,
  AppWsInboundUserMessage,
  AppWsInboundResume,
  AppWsInboundReceipt,
  AppWsInboundReaction,
  AppWsInboundEdit,
  AppWsInboundButtonChoice,
  AppWsOutbound,
  AppWsOutboundSessionReady,
  AppWsOutboundUserMessageEcho,
  AppWsOutboundAgentMessageOption,
  AppWsOutboundAgentMessageDocRef,
  AppWsOutboundAgentMessageUploadAffordance,
  AppWsOutboundAgentMessage,
  AppWsOutboundAgentMessagePartial,
  AppWsOutboundError,
  AppWsOutboundAgentTyping,
  AppWsOutboundProjectsChanged,
  AppWsOutboundReceiptUpdate,
  AppWsOutboundReactionUpdate,
  AppWsOutboundEditUpdate,
  AppWsWorkBoardItem,
  AppWsRunProgress,
  AppWsOutboundWorkBoardChanged,
  AppWsOutboundImportProgress,
  AppWsOutboundOnboardingCompleted,
  WireAgentMessageOption,
} from '@neutronai/wire-types'

// L6 — topic-id derivation moved to @neutronai/wire-types (killed the
// `landing/chat-react/config.ts` browser mirror); re-exported so existing
// server importers (gateway/projects/sqlite-store, open tests) stay valid.
export { appWsTopicId, appWsProjectTopicId, parseAppWsTopicId } from '@neutronai/wire-types'

/**
 * Decode an inbound envelope. Returns `null` on a wrong-shape envelope
 * (wrong `v`, wrong `type`, body-not-a-string, oversize body, or "no
 * payload at all" — see {@link payloadIsEmpty}) so the caller can drop
 * the frame without crashing the socket.
 *
 * P5.1 — `body` may now be the empty string when `attachments` is
 * non-empty. The composer enables Send on `draft.trim().length > 0 ||
 * attachments.length > 0` (InputComposer.tsx) — before this change the
 * gateway hard-rejected the attachments-only case, dropping the send
 * silently. Closes Argus r1 BLOCKING #2.
 */
export function decodeAppWsInbound(raw: unknown): AppWsInbound | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['v'] !== 1) return null
  if (e['type'] !== 'user_message') return null
  const body = e['body']
  if (typeof body !== 'string') return null
  if (body.length > MAX_USER_MESSAGE_LEN) return null
  const cleaned_attachments = sanitizeAttachments(e['attachments'])
  // P5.1 — require at least one of body or attachments. The composer
  // gates Send on (body.trim().length > 0 || attachments.length > 0)
  // so allowing both empty here would re-enable the original "missing
  // body" 1006 the bubble-failed regression rode in on.
  if (payloadIsEmpty(body, cleaned_attachments)) return null
  const out: AppWsInboundUserMessage = { v: 1, type: 'user_message', body }
  const client_msg_id = e['client_msg_id']
  if (typeof client_msg_id === 'string' && client_msg_id.length > 0 && client_msg_id.length <= 128) {
    out.client_msg_id = client_msg_id
  }
  const cleaned_project_id = sanitizeProjectId(e['project_id'])
  if (cleaned_project_id !== null) {
    out.project_id = cleaned_project_id
  }
  if (cleaned_attachments !== null) {
    out.attachments = cleaned_attachments
  }
  return out
}

/**
 * Chat-sync foundation — decode a `{ v:1, type:'resume', after_seq:N }`
 * gap-fill control frame. Kept SEPARATE from {@link decodeAppWsInbound} (the
 * message decoder) so message-path consumers keep their narrow
 * `AppWsInboundUserMessage` type. Returns `null` for anything that isn't a
 * well-formed resume; `after_seq` is clamped to a non-negative integer so a
 * malformed cursor can't drive a negative / fractional replay query.
 */
export function decodeAppWsResume(raw: unknown): AppWsInboundResume | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['v'] !== 1) return null
  if (e['type'] !== 'resume') return null
  const raw_after = e['after_seq']
  if (typeof raw_after !== 'number' || !Number.isFinite(raw_after)) return null
  return { v: 1, type: 'resume', after_seq: Math.max(0, Math.trunc(raw_after)) }
}

/**
 * Track B Phase 4 — decode a `{ v:1, type:'receipt', message_id, state:'read' }`
 * read-receipt control frame. SEPARATE from the message + resume decoders so
 * each path keeps its narrow type. Returns `null` for anything malformed. Only
 * `read` is accepted from clients (delivery is server-tracked). The device id
 * is intentionally NOT read from the frame — the surface attributes the receipt
 * to the socket's own device id, so a client can't forge another device's ack.
 */
export function decodeAppWsReceipt(raw: unknown): AppWsInboundReceipt | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['v'] !== 1) return null
  if (e['type'] !== 'receipt') return null
  if (e['state'] !== 'read') return null
  const message_id = e['message_id']
  if (typeof message_id !== 'string' || message_id.length === 0 || message_id.length > 256) {
    return null
  }
  const out: AppWsInboundReceipt = { v: 1, type: 'receipt', message_id, state: 'read' }
  const raw_seq = e['seq']
  if (typeof raw_seq === 'number' && Number.isFinite(raw_seq)) {
    out.seq = Math.max(0, Math.trunc(raw_seq))
  }
  return out
}

/**
 * Track B Phase 4 — decode a
 * `{ v:1, type:'reaction', message_id, emoji, action:'add'|'remove' }` frame.
 * SEPARATE from the message / resume / receipt decoders so each path keeps its
 * narrow type. Returns `null` for anything malformed. The device id is
 * intentionally NOT read from the frame — the surface attributes the reaction
 * to the socket's own device id, so a client can't forge another device's
 * reaction. The emoji is validated by {@link sanitizeReactionEmoji}.
 */
export function decodeAppWsReaction(raw: unknown): AppWsInboundReaction | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['v'] !== 1) return null
  if (e['type'] !== 'reaction') return null
  if (e['action'] !== 'add' && e['action'] !== 'remove') return null
  const message_id = e['message_id']
  if (typeof message_id !== 'string' || message_id.length === 0 || message_id.length > 256) {
    return null
  }
  const emoji = sanitizeReactionEmoji(e['emoji'])
  if (emoji === null) return null
  const out: AppWsInboundReaction = { v: 1, type: 'reaction', message_id, emoji, action: e['action'] }
  const raw_seq = e['seq']
  if (typeof raw_seq === 'number' && Number.isFinite(raw_seq)) {
    out.seq = Math.max(0, Math.trunc(raw_seq))
  }
  return out
}

/** Track B Phase 4 — max bytes for a reaction emoji. Generous enough for any
 *  single grapheme cluster (flags, skin-tone + ZWJ sequences) while bounding a
 *  malformed client from shipping arbitrary text as a "reaction". */
export const MAX_REACTION_EMOJI_LEN = 64

/**
 * Validate a reaction emoji from an untrusted source. Returns the cleaned value
 * or `null` (absent / malformed). Accepts a non-empty string up to
 * {@link MAX_REACTION_EMOJI_LEN} chars with NO ASCII control chars or
 * whitespace — i.e. a single emoji/grapheme, not a sentence. Deliberately does
 * NOT enforce a fixed allowlist: the client picks the palette, and a future
 * emoji shouldn't require a server change.
 */
export function sanitizeReactionEmoji(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length === 0 || raw.length > MAX_REACTION_EMOJI_LEN) return null
  // Reject control chars (C0/C1) and any whitespace — a reaction is one glyph,
  // never multi-token text. Char-code scan avoids fiddly char-class ranges.
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x20 || (code >= 0x7f && code <= 0xa0)) return null
    if (/\s/u.test(ch)) return null
  }
  return raw
}

/**
 * Track B Phase 4 (edit/delete) — decode a
 * `{ v:1, type:'edit', message_id, action:'edit'|'delete', body? }` frame.
 * SEPARATE from the message / resume / receipt / reaction decoders so each path
 * keeps its narrow type. Returns `null` for anything malformed. The editor
 * device id is intentionally NOT read from the frame — the surface attributes
 * the mutation to the socket's own device id and authorizes it against the
 * message's author, so a client can't forge an edit as another party. An `edit`
 * REQUIRES a non-empty body bounded by {@link MAX_USER_MESSAGE_LEN}; a `delete`
 * ignores any body.
 */
export function decodeAppWsEdit(raw: unknown): AppWsInboundEdit | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['v'] !== 1) return null
  if (e['type'] !== 'edit') return null
  if (e['action'] !== 'edit' && e['action'] !== 'delete') return null
  const message_id = e['message_id']
  if (typeof message_id !== 'string' || message_id.length === 0 || message_id.length > 256) {
    return null
  }
  const action = e['action']
  const out: AppWsInboundEdit = { v: 1, type: 'edit', message_id, action }
  if (action === 'edit') {
    const body = e['body']
    if (typeof body !== 'string') return null
    if (body.length === 0 || body.length > MAX_USER_MESSAGE_LEN) return null
    out.body = body
  }
  const raw_seq = e['seq']
  if (typeof raw_seq === 'number' && Number.isFinite(raw_seq)) {
    out.seq = Math.max(0, Math.trunc(raw_seq))
  }
  return out
}

/**
 * Onboarding consolidation (2026-06-26) — decode a
 * `{ v:1, type:'button_choice', prompt_id, choice_value, freeform_text? }` frame.
 * SEPARATE from the message / resume / receipt / reaction / edit decoders so each
 * path keeps its narrow type. Returns `null` for anything malformed. Lengths are
 * bounded so a malformed client can't push huge strings through the engine's
 * choice-resolution path; `freeform_text` reuses the user-message cap.
 */
export function decodeAppWsButtonChoice(raw: unknown): AppWsInboundButtonChoice | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (e['v'] !== 1) return null
  if (e['type'] !== 'button_choice') return null
  const prompt_id = e['prompt_id']
  if (typeof prompt_id !== 'string' || prompt_id.length === 0 || prompt_id.length > 256) {
    return null
  }
  const choice_value = e['choice_value']
  if (typeof choice_value !== 'string' || choice_value.length === 0 || choice_value.length > 512) {
    return null
  }
  const out: AppWsInboundButtonChoice = { v: 1, type: 'button_choice', prompt_id, choice_value }
  const freeform_text = e['freeform_text']
  if (typeof freeform_text === 'string' && freeform_text.length > 0) {
    if (freeform_text.length > MAX_USER_MESSAGE_LEN) return null
    out.freeform_text = freeform_text
  }
  return out
}

/**
 * P5.1 — predicate shared by the WS decoder and the HTTP `/api/app/chat/send`
 * handler so the empty-payload check has identical semantics on both
 * transports. A send is "empty" when the body has no non-whitespace content AND
 * no valid attachments rode along. Either one being non-empty is
 * sufficient to forward to the agent loop.
 *
 * TRIM PARITY (M1 E2E Round 2, 2026-06-29): the gate used raw `body.length`, so
 * a whitespace-only body ("   " / "\n") read as non-empty and was forwarded — but
 * the agent worker then trims it to '' and silently returns (no reply, no error),
 * leaving the user's whitespace bubble a dead-end. The official client gates Send
 * on `draft.trim()`, but the HTTP `/api/app/chat/send` endpoint and any malformed
 * / third-party client could hit it. Trim here so both transports reject exactly
 * the shape the worker rejects, keeping decode ⇄ worker parity.
 */
export function payloadIsEmpty(
  body: string,
  attachments: ReadonlyArray<string> | null | undefined,
): boolean {
  if (body.trim().length > 0) return false
  if (attachments !== null && attachments !== undefined && attachments.length > 0) {
    return false
  }
  return true
}

/** Conservative cap. Matches the landing chat's practical client behaviour. */
export const MAX_USER_MESSAGE_LEN = 16_384

/** P5.1 — max attachments per user_message envelope. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8
/** P5.1 — per-attachment URL byte cap (matches the gateway echo). */
export const MAX_ATTACHMENT_URL_LEN = 512

/**
 * P5.1 — sanitize `attachments` from an untrusted source. Returns the
 * cleaned array (always frozen) or `null` to mean "absent / malformed".
 * Rejects on: non-array, > MAX_ATTACHMENTS_PER_MESSAGE entries,
 * non-string entries, entries > MAX_ATTACHMENT_URL_LEN chars, or
 * entries that don't start with `https?://` or `/`. The "starts with
 * /" form is reserved for gateway-relative URLs returned by the
 * upload endpoint (`/api/app/upload/<id>`).
 */
export function sanitizeAttachments(raw: unknown): ReadonlyArray<string> | null {
  if (!Array.isArray(raw)) return null
  if (raw.length === 0) return null
  if (raw.length > MAX_ATTACHMENTS_PER_MESSAGE) return null
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') return null
    if (entry.length === 0 || entry.length > MAX_ATTACHMENT_URL_LEN) return null
    if (!/^(https?:\/\/|\/)/.test(entry)) return null
    out.push(entry)
  }
  return Object.freeze(out)
}

/**
 * P5.2 — bound the project_id field so a malformed client (or attacker)
 * can't push huge strings through the gateway's per-message state.
 * Project ids in the gateway are instance-scoped uuids (or short slugs);
 * 128 chars is generous.
 */
export const MAX_PROJECT_ID_LEN = 128

/**
 * Validate a project_id from an untrusted source (query string or
 * HTTP body). Returns the cleaned value or `null` to mean "absent or
 * malformed". Callers treat both the same — the surface stashes
 * `undefined` on the session, so subsequent echoes omit project_id.
 */
export function sanitizeProjectId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length === 0 || raw.length > MAX_PROJECT_ID_LEN) return null
  // Allow letters, digits, underscores, hyphens, and dots so slug and
  // uuid forms both pass. Reject control chars, quotes, slashes, etc.
  if (!/^[A-Za-z0-9_.-]+$/.test(raw)) return null
  return raw
}

/**
 * Validate a client `platform` flag from the WS upgrade query string
 * or HTTP send body. Used by the surface to route per-session
 * doc-link rendering ('web' → https://app.example.test/projects/
 * <id>/docs?path=..., 'native' → neutron://docs/...). Argus BLOCKING #2.
 */
export function sanitizePlatform(raw: unknown): 'web' | 'native' | null {
  if (raw === 'web' || raw === 'native') return raw
  return null
}

/** Track B Phase 4 — bound the device_id reported on the WS upgrade query
 *  string. Client-minted (a uuid or short opaque token); 128 chars is ample. */
export const MAX_DEVICE_ID_LEN = 128

/**
 * Validate a device_id from the untrusted upgrade query string. Returns the
 * cleaned value or `null` (absent / malformed → the surface mints a synthetic
 * per-connection id so receipt attribution still works, it just isn't stable
 * across reconnects for that client). Same charset as project ids.
 */
export function sanitizeDeviceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.length === 0 || raw.length > MAX_DEVICE_ID_LEN) return null
  if (!/^[A-Za-z0-9_.-]+$/.test(raw)) return null
  return raw
}

/** Track B Phase 4 — synthetic device id the gateway attributes to the agent
 *  loop when it reads (picks up) an inbound user message. Lets a single-device
 *  sender see the read tick the moment the agent acts, with no second device.
 *  Mirrors `@neutronai/chat-core`'s `AGENT_DEVICE_ID`; the wire value is the bare
 *  string `agent`. */
export const AGENT_DEVICE_ID = 'agent'
