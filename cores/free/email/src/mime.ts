/**
 * @neutronai/email-managed-core — MIME / RFC 5322 parsing + building.
 *
 * Security-relevant block split out of `backend.ts` (D5): Gmail wire
 * resource shapes, base64url decode/encode, MIME-tree body
 * extraction, address-list parsing, and the header-injection-guarded
 * `buildRawMessage` raw-MIME builder (Argus r1 BLOCKING history).
 * Own test file: `__tests__/mime.test.ts`.
 */

import { epochMsToIso } from './contract.ts'
import type { GmailMessageFull, GmailMessageMeta } from './contract.ts'
import { EmailHeaderInjectionError } from './errors.ts'

export interface GmailHeader {
  name?: string
  value?: string
}

export interface GmailMessagePart {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailMessagePart[]
  headers?: GmailHeader[]
}

export interface GmailMessagePayload {
  headers?: GmailHeader[]
  parts?: GmailMessagePart[]
  body?: { data?: string }
  mimeType?: string
}

export interface GmailMessageResource {
  id?: string
  threadId?: string
  snippet?: string
  internalDate?: string
  labelIds?: string[]
  payload?: GmailMessagePayload
}

/**
 * Decode a Gmail base64url-encoded body chunk to a UTF-8 string.
 * Gmail uses URL-safe base64 (`-`/`_` instead of `+`/`/`) without
 * padding; we normalise + use globalThis.atob (Bun + browsers both
 * provide it). Returns the empty string on missing input so callers
 * can compose decoded bodies without null-checks.
 */
function decodeGmailBase64Url(data: string | undefined): string {
  if (data === undefined || data.length === 0) return ''
  let s = data.replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4
  if (pad === 2) s += '=='
  else if (pad === 3) s += '='
  else if (pad === 1) {
    // Malformed input — Gmail never returns length-1 mod 4, but
    // defensive: drop the trailing char.
    s = s.slice(0, -1)
  }
  try {
    const bin = atob(s)
    // Convert latin-1 binary string to UTF-8. Gmail bodies are
    // RFC 5322 / MIME — UTF-8-encoded when the part declares it.
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return ''
  }
}

/**
 * Strip HTML tags + decode the small set of named entities Gmail
 * bodies use, so an HTML-only message degrades to a readable
 * plaintext body for downstream consumers (`email_read` UI,
 * `email_summarize` LLM input). Naive on purpose — a proper
 * HTML-to-text pass would pull in `htmlparser2` / `parse5`, and
 * Tier 1 doesn't justify the dep tree. The output is "good enough
 * to summarise" rather than "publication-quality".
 *
 * Steps:
 *   1. Drop `<script>` / `<style>` blocks entirely (body text inside
 *      is not user-readable).
 *   2. Replace `<br>` / `<p>` / `<li>` boundaries with newlines so
 *      paragraph structure survives.
 *   3. Strip remaining `<...>` tags.
 *   4. Decode the half-dozen named entities Gmail-rendered HTML
 *      actually emits, plus numeric `&#NN;` / `&#xNN;`.
 *   5. Collapse runs of whitespace to single spaces, preserve newlines.
 */
function stripHtmlToText(html: string): string {
  if (html.length === 0) return ''
  let s = html
  // Remove script + style blocks (content + tags).
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
  // Insert newlines for common block boundaries before stripping.
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n')
  s = s.replace(/<\s*\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
  // Strip remaining tags.
  s = s.replace(/<[^>]+>/g, '')
  // Decode the small set of entities that show up in Gmail HTML.
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
  // Collapse runs of spaces/topline (preserve newlines), trim line ends.
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    // Collapse 3+ blank lines to a single blank line.
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return s
}

/**
 * Walk a Gmail message MIME tree and pull out the best plaintext
 * and HTML bodies. Gmail's structure:
 *   payload (multipart/alternative or multipart/mixed)
 *     parts[]
 *       parts[]  (nested multipart for replies / attachments)
 *
 * We do a depth-first walk and:
 *   - capture the FIRST `text/plain` part as `body_text`
 *   - capture the FIRST `text/html` part as `body_html`
 *   - ignore everything else (attachments, multipart wrappers)
 *
 * If no `text/plain` is found but `text/html` is, derive a
 * stripped-HTML plaintext fallback so `email_read` / `email_summarize`
 * still have something to surface — common for transactional /
 * automated mail (Argus r1 IMPORTANT).
 */
function extractBodies(payload: GmailMessagePayload | undefined): {
  body_text: string
  body_html: string | undefined
} {
  if (payload === undefined) return { body_text: '', body_html: undefined }
  let body_text = ''
  let body_html: string | undefined

  function visit(part: GmailMessagePart): void {
    if (part.mimeType === 'text/plain' && body_text.length === 0) {
      body_text = decodeGmailBase64Url(part.body?.data)
      return
    }
    if (part.mimeType === 'text/html' && body_html === undefined) {
      body_html = decodeGmailBase64Url(part.body?.data)
      return
    }
    if (part.parts !== undefined) {
      for (const p of part.parts) visit(p)
    }
  }

  // The top-level payload is itself a "part" in Gmail's shape — it
  // can carry headers + a body directly when the message is
  // non-multipart, or carry a `parts[]` array when it's multipart.
  if (payload.mimeType === 'text/plain' && payload.body?.data !== undefined) {
    body_text = decodeGmailBase64Url(payload.body.data)
  } else if (payload.mimeType === 'text/html' && payload.body?.data !== undefined) {
    body_html = decodeGmailBase64Url(payload.body.data)
  }
  if (payload.parts !== undefined) {
    for (const p of payload.parts) visit(p)
  }

  // HTML-only fallback. When the message ships text/html but no
  // text/plain alternative, derive a stripped-tag plaintext so the
  // downstream summarizer has something to chew on.
  if (body_text.length === 0 && body_html !== undefined) {
    body_text = stripHtmlToText(body_html)
  }

  return { body_text, body_html }
}

export function headerValue(
  headers: GmailHeader[] | undefined,
  name: string,
): string {
  if (headers === undefined) return ''
  const lower = name.toLowerCase()
  for (const h of headers) {
    if (h.name?.toLowerCase() === lower) return h.value ?? ''
  }
  return ''
}

/**
 * Parse a comma-separated address-list header into individual
 * addresses. Gmail's `To` / `Cc` headers come as `"Alice"
 * <alice@x.com>, bob@y.com` — we split on top-level commas (NOT
 * commas inside `< >` or `" "`) and trim. The output is the raw
 * RFC 5322 mailbox specs; downstream consumers extract `local@
 * domain` themselves when they want a bare address.
 */
function splitAddresses(raw: string): string[] {
  if (raw.length === 0) return []
  const out: string[] = []
  let cur = ''
  let inAngle = 0
  let inQuote = false
  for (const ch of raw) {
    if (ch === '"' && inAngle === 0) {
      inQuote = !inQuote
      cur += ch
      continue
    }
    if (ch === '<') {
      inAngle++
      cur += ch
      continue
    }
    if (ch === '>') {
      inAngle = Math.max(0, inAngle - 1)
      cur += ch
      continue
    }
    if (ch === ',' && inAngle === 0 && !inQuote) {
      const trimmed = cur.trim()
      if (trimmed.length > 0) out.push(trimmed)
      cur = ''
      continue
    }
    cur += ch
  }
  const last = cur.trim()
  if (last.length > 0) out.push(last)
  return out
}

export function fullFromResource(r: GmailMessageResource): GmailMessageFull {
  const headers = r.payload?.headers ?? []
  const subject = headerValue(headers, 'Subject')
  const from = headerValue(headers, 'From')
  const to = splitAddresses(headerValue(headers, 'To'))
  const cc = splitAddresses(headerValue(headers, 'Cc'))
  const { body_text, body_html } = extractBodies(r.payload)
  const internal_date =
    r.internalDate !== undefined && r.internalDate.length > 0
      ? epochMsToIso(Number.parseInt(r.internalDate, 10))
      : ''
  const full: GmailMessageFull = {
    id: r.id ?? '',
    thread_id: r.threadId ?? '',
    subject,
    from,
    to,
    cc,
    snippet: r.snippet ?? '',
    internal_date,
    label_ids: r.labelIds ?? [],
    body_text,
  }
  if (body_html !== undefined) full.body_html = body_html
  return full
}

export function metaFromResource(r: GmailMessageResource): GmailMessageMeta {
  const headers = r.payload?.headers ?? []
  const internal_date =
    r.internalDate !== undefined && r.internalDate.length > 0
      ? epochMsToIso(Number.parseInt(r.internalDate, 10))
      : ''
  return {
    id: r.id ?? '',
    thread_id: r.threadId ?? '',
    subject: headerValue(headers, 'Subject'),
    from: headerValue(headers, 'From'),
    snippet: r.snippet ?? '',
    internal_date,
    label_ids: r.labelIds ?? [],
  }
}

/**
 * Encode a UTF-8 string into Gmail's URL-safe base64 (no padding).
 * Used for the `drafts.create` payload — the raw RFC 5322 message
 * gets URL-safe-base64 encoded and stuffed into `message.raw`.
 */
export function encodeGmailBase64Url(s: string): string {
  // Encode UTF-8 → binary string for atob/btoa.
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Build a minimal RFC 5322 message body for `drafts.create`. We
 * intentionally keep this narrow:
 *   - `To:`, optional `Cc:`, `Subject:`, `Content-Type: text/plain;
 *     charset=utf-8`, then the body.
 *   - `In-Reply-To:` + `References:` populated to the source
 *     message's RFC `Message-ID` header when the caller passed
 *     `reply_to_message_id`. We don't fetch the source message
 *     headers from inside the wrapper — that's a round-trip the
 *     caller can do (the tools layer does), passing in the
 *     resolved `in_reply_to` header verbatim.
 */
export interface BuildRawMessageInput {
  to: string[]
  subject: string
  body: string
  cc?: string[]
  /** Optional Message-ID header value (with angle brackets) of the
   *  source message — populates In-Reply-To + References. */
  in_reply_to?: string
}

/**
 * Reject header values containing CR (\r), LF (\n), or NUL (\0).
 * RFC 5322 uses CRLF as the header / body delimiter, so any of these
 * three bytes in a model-supplied subject or address line would let
 * an attacker break out of the intended header and inject arbitrary
 * additional headers ahead of the body. We reject rather than strip:
 * silently mangling the value would hide the attack from logs and
 * make the failure mode (the user's email going to the wrong place)
 * harder to debug.
 */
function sanitizeHeaderValue(field: string, value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new EmailHeaderInjectionError(field)
  }
  return value
}

export function buildRawMessage(input: BuildRawMessageInput): string {
  const toClean = input.to.map((addr) => sanitizeHeaderValue('to', addr))
  const ccClean =
    input.cc !== undefined
      ? input.cc.map((addr) => sanitizeHeaderValue('cc', addr))
      : undefined
  const subjectClean = sanitizeHeaderValue('subject', input.subject)
  const inReplyToClean =
    input.in_reply_to !== undefined
      ? sanitizeHeaderValue('in_reply_to', input.in_reply_to)
      : undefined

  const lines: string[] = []
  lines.push(`To: ${toClean.join(', ')}`)
  if (ccClean !== undefined && ccClean.length > 0) {
    lines.push(`Cc: ${ccClean.join(', ')}`)
  }
  // Subject is encoded as-is. RFC 2047 encoded-word support is a
  // follow-up — for now ASCII-only subjects round-trip correctly.
  lines.push(`Subject: ${subjectClean}`)
  if (inReplyToClean !== undefined && inReplyToClean.length > 0) {
    lines.push(`In-Reply-To: ${inReplyToClean}`)
    lines.push(`References: ${inReplyToClean}`)
  }
  lines.push('Content-Type: text/plain; charset=utf-8')
  lines.push('MIME-Version: 1.0')
  lines.push('')
  lines.push(input.body)
  return lines.join('\r\n')
}
