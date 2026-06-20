/**
 * start-token-topic-id.ts — dependency-free leaf that derives the
 * `X-Neutron-Topic-Id` upload header value from a start-token.
 *
 * The upload client (`landing/chat.ts:resolveUploadTopicId`) sends this
 * header on every `POST /api/upload/<source>` so the upload handler's
 * post-upload engine emit (`engine.notifyImportUpload`) routes the
 * follow-up button/prompt back through THIS socket. Without it the gateway
 * falls back to a hardcoded `topic_id='chat'` with no registered sender —
 * the import never correlates to the active onboarding session and the
 * engine never advances out of `import_upload_pending`.
 *
 * TWO start-token shapes flow through the SAME client, so resolution must
 * handle BOTH:
 *
 *   - Open single-owner HMAC start-token (`open/local-start-token.ts`):
 *     wire format `<base64url(JSON payload)>.<base64url(HMAC-SHA256)>` —
 *     exactly 2 segments. The identity field is `user_id`, carried in the
 *     FIRST segment's JSON payload. The SECOND segment is the HMAC
 *     signature (raw base64url bytes), NOT a JSON payload — reading a `sub`
 *     claim out of it (the prior bug) always failed, so the header was
 *     never sent and onboarding stuck.
 *   - Managed JWT start-token (`signup/start-token.ts`):
 *     wire format `header.payload.signature` — 3 segments. The identity is
 *     the `sub` claim in the SECOND (payload) segment.
 *
 * Both decode WITHOUT signature verification — that already happened
 * server-side at the WebSocket-upgrade boundary; the client only needs the
 * routing identity. We deliberately do NOT reuse the Open verifier
 * (`buildLocalStartTokenAuth`): it needs the shared HMAC secret (absent in
 * the browser) and pulls `node:crypto` into the browser bundle. Decoding
 * the payload (the same thing the verifier does after the signature check)
 * is sufficient and dependency-free.
 *
 * The result is shaped `web:<identity>` to match `webTopicId(...)` in
 * gateway/http/web-topic-id.ts. Returns null on any parse failure (caller
 * falls back to no header).
 *
 * Extracted out of landing/chat.ts so the Open composition + server-side
 * tests can exercise the SAME resolution the browser client runs without
 * importing the chat.ts browser monolith (and its window self-bootstrap).
 */

/**
 * Resolve the `web:<identity>` upload topic id from a start-token of either
 * shape, or null when the token can't be parsed.
 */
export function startTokenTopicId(token: string): string | null {
  const id = decodeStartTokenUserId(token)
  return id === null ? null : `web:${id}`
}

/**
 * Decode the routing identity from a start-token, branching on shape:
 *   - 2 segments → Open HMAC start-token → `user_id` in the FIRST segment.
 *   - 3+ segments → Managed JWT → `sub` claim in the SECOND segment.
 * Returns null on any parse failure (malformed token, non-base64 segment,
 * non-JSON payload, missing/empty identity field).
 */
export function decodeStartTokenUserId(token: string): string | null {
  if (typeof token !== 'string' || token.length === 0) return null
  const parts = token.split('.')
  if (parts.length < 2) return null
  if (parts.length === 2) {
    // Open single-owner HMAC start-token — identity is `user_id` in the
    // base64url-JSON payload (segment 0). Segment 1 is the HMAC signature.
    const payloadSeg = parts[0]
    if (payloadSeg === undefined) return null
    return readBase64UrlJsonStringField(payloadSeg, 'user_id')
  }
  // Managed JWT — identity is the `sub` claim in the payload (segment 1).
  const payloadSeg = parts[1]
  if (payloadSeg === undefined) return null
  return readBase64UrlJsonStringField(payloadSeg, 'sub')
}

/**
 * Decode the `sub` claim from a Managed-JWT payload without verifying the
 * signature. Kept as a named export (it predates the Open token shape and
 * is consumed directly by `switchTopic` + the managed test suite); reads
 * the SECOND segment's `sub` regardless of segment count, preserving its
 * original semantics.
 *
 * Exported for unit testing.
 */
export function decodeJwtSubClaim(token: string): string | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  const payloadSeg = parts[1]
  if (payloadSeg === undefined || payloadSeg.length === 0) return null
  return readBase64UrlJsonStringField(payloadSeg, 'sub')
}

/**
 * Decode a base64url segment as JSON and return a non-empty string field,
 * or null on any failure. `atob` + `TextDecoder` are available in browsers
 * and Bun alike; UTF-8 decode preserves non-ASCII identities.
 */
function readBase64UrlJsonStringField(seg: string, field: string): string | null {
  if (seg.length === 0) return null
  let json: string
  try {
    // base64url → base64: `-` → `+`, `_` → `/`, re-pad with `=`.
    const padded = seg.replace(/-/g, '+').replace(/_/g, '/')
    const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
    const decoded = atob(padded + padding)
    // atob yields a binary string; decode UTF-8 so non-ASCII survives.
    const bytes = new Uint8Array(decoded.length)
    for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i)
    json = new TextDecoder().decode(bytes)
  } catch {
    return null
  }
  let claims: unknown
  try {
    claims = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof claims !== 'object' || claims === null) return null
  const v = (claims as Record<string, unknown>)[field]
  if (typeof v !== 'string' || v.length === 0) return null
  return v
}
