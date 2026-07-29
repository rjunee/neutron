/**
 * @neutronai/gateway/diagnostics — inbound client-report sanitiser.
 *
 * WHY THIS EXISTS
 * ---------------
 * The mobile app ships crash/error reports to the owner's OWN gateway
 * (`POST /api/app/admin/diagnostics/reports`). Everything in such a report is
 * attacker-adjacent by construction: it is free-form text and free-form nested
 * JSON assembled on a device, from stack traces, thrown values, and whatever
 * `context` a call site attached. Two things follow.
 *
 *   1. BOUNDS. An unbounded body would let one device fill the operator's disk
 *      through an authenticated endpoint. Every axis is capped here — batch
 *      size, events per report, string length, object depth, key count.
 *
 *   2. REDACTION. ISSUES #395 shipped a bug where the session bearer was
 *      rendered as the account display name and walked into a screenshot. A
 *      diagnostics pipeline that wrote that same token into a file on the host
 *      would be a worse version of that bug — the token would be at rest, in
 *      plain text, in a file whose whole purpose is to be read and pasted
 *      around. So no credential-shaped value is ever persisted.
 *
 * TWO INDEPENDENT REDACTION LAYERS, ON PURPOSE
 * --------------------------------------------
 * The app redacts before a report ever leaves the device
 * (`app/lib/diagnostic-redact.ts`) so a token never sits in the phone's
 * persisted queue and never crosses the wire. This module redacts AGAIN on
 * arrival. That is not accidental duplication: the two layers defend different
 * things. The client layer protects the wire and the device; this layer
 * protects the operator's host from a client that is older than the server, has
 * been modified, or is simply buggy. The gateway must not depend on a client
 * being correct to keep credentials off disk.
 *
 * This module is PURE — no IO, no clock, no process state — so the redaction
 * invariant is exhaustively testable. See
 * `gateway/diagnostics/__tests__/client-report-redaction.test.ts`.
 */

/** One recorded app event. Mirrors `app/lib/diagnostic-buffer.ts`. */
export interface StoredClientEvent {
  at: number
  level: string
  kind: string
  message: string
  stack?: string
  context?: Record<string, unknown>
}

/** One report as PERSISTED. Mirrors `app/lib/diagnostic-report.ts`. */
export interface StoredClientReport {
  schema: number
  report_id: string
  created_at: number
  reason: string
  app: {
    version: string
    build: string | null
    platform: string
    os_version: string | null
  }
  session: { signed_in: boolean }
  events: StoredClientEvent[]
  /** The device trimmed the event window to fit the request ceiling. Preserved
   *  so a reader knows the window is partial — a silently shortened report is
   *  how a diagnosis goes wrong. */
  truncated?: boolean
}

/** Caps. Every one of these is a hard truncation, never a rejection: a report
 *  that is too big is TRIMMED and kept, because a dropped report is a blind
 *  spot and blind spots are the thing this feature exists to remove. The one
 *  exception is the raw body size, enforced by the surface BEFORE parsing. */
export const MAX_REPORTS_PER_BATCH = 10
export const MAX_EVENTS_PER_REPORT = 100
export const MAX_STRING_CHARS = 2_000
export const MAX_STACK_CHARS = 8_000
export const MAX_CONTEXT_KEYS = 24
export const MAX_CONTEXT_DEPTH = 4
export const MAX_ARRAY_ITEMS = 24
export const MAX_ID_CHARS = 128

/** The placeholder every redacted value collapses to. */
export const REDACTED = '[redacted]'

/**
 * Keys whose VALUE is a credential regardless of what it looks like. Matched
 * case-insensitively as a substring, so `Authorization`, `x-api-key`,
 * `refreshToken`, `session_secret` and `Cookie` all hit.
 */
const SECRET_KEY_RE =
  /(authorization|bearer|token|secret|password|passwd|api[-_]?key|apikey|credential|cookie|session[-_]?id|jwt|signature|private[-_]?key)/i

/** `Authorization: Bearer <x>` / `bearer <x>` anywhere in free text. */
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi

/** A three-segment JWT. */
const JWT_RE = /\b[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g

/** A base64url JSON header — the leading segment of a JWT, even when the rest
 *  of the token was already truncated by something upstream. */
const JWT_SEGMENT_RE = /\beyJ[A-Za-z0-9_-]{6,}/g

/** The dev-lane opaque token shape the app mints (`dev:<user_id>`), which IS a
 *  working bearer against a dev gateway. */
const DEV_TOKEN_RE = /\bdev:[A-Za-z0-9._~-]+/g

/** `token=<x>` / `"secret": "<x>"` / `api_key: <x>` inside free text — the shape
 *  a serialised request or a query string takes once it is inside an error
 *  message and no longer a structured object. */
const KEYED_VALUE_RE =
  /((?:authorization|bearer|token|secret|password|passwd|api[-_]?key|apikey|credential|cookie|jwt)"?\s*[:=]\s*"?)([^\s",;&}]+)/gi

/** An opaque high-entropy run. The last net: a credential format nothing above
 *  anticipated. 40 chars is deliberately long — real stack frames, file paths
 *  and identifiers stay under it, so this does not shred useful diagnostics. */
const OPAQUE_RUN_RE = /\b[A-Za-z0-9_-]{40,}\b/g

/**
 * Scrub a single string. `secrets` are EXACT values known to be credentials
 * (the presented bearer) — they are removed first and unconditionally, which is
 * the one rule that cannot produce a false negative regardless of token format.
 * The pattern rules then catch credentials this request never saw (a token from
 * an earlier session that the device captured into a stack trace).
 */
export function redactString(input: string, secrets: readonly string[] = []): string {
  let out = input
  for (const secret of secrets) {
    // Below 8 chars a "secret" is not distinguishable from ordinary prose and
    // blanket-replacing it would corrupt the report for no security gain.
    if (secret.length < 8) continue
    out = out.split(secret).join(REDACTED)
  }
  out = out.replace(BEARER_RE, `bearer ${REDACTED}`)
  out = out.replace(KEYED_VALUE_RE, (_m, prefix: string) => `${prefix}${REDACTED}`)
  out = out.replace(JWT_RE, REDACTED)
  out = out.replace(JWT_SEGMENT_RE, REDACTED)
  out = out.replace(DEV_TOKEN_RE, REDACTED)
  out = out.replace(OPAQUE_RUN_RE, REDACTED)
  return out
}

/** Truncate with an explicit marker, so a reader never mistakes a trimmed
 *  value for the whole value. */
export function truncate(input: string, max: number): string {
  if (input.length <= max) return input
  return `${input.slice(0, max)}…[truncated ${input.length - max} chars]`
}

/**
 * Recursively sanitise an arbitrary JSON-ish value: redact by key, redact by
 * content, and bound depth / breadth / length. Anything that is not JSON-ish
 * (a function, a symbol) is dropped.
 */
export function redactValue(
  value: unknown,
  secrets: readonly string[],
  depth = 0,
): unknown {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return truncate(redactString(value, secrets), MAX_STRING_CHARS)
  if (Array.isArray(value)) {
    if (depth >= MAX_CONTEXT_DEPTH) return REDACTED
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, secrets, depth + 1))
  }
  if (typeof value === 'object') {
    if (depth >= MAX_CONTEXT_DEPTH) return REDACTED
    const out: Record<string, unknown> = {}
    let seen = 0
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (seen >= MAX_CONTEXT_KEYS) break
      seen += 1
      const safeKey = truncate(key, 64)
      // A secret KEY is redacted whatever its value looks like — this is the
      // rule that catches a captured `authorization` header, whose value is a
      // perfectly ordinary-looking string once the token is short.
      out[safeKey] = SECRET_KEY_RE.test(key) ? REDACTED : redactValue(item, secrets, depth + 1)
    }
    return out
  }
  // undefined, function, symbol, bigint — not representable, and never
  // something a diagnostics reader needs.
  return undefined
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Sanitise one inbound event. Total — never throws, never returns undefined. */
export function sanitizeEvent(raw: unknown, secrets: readonly string[]): StoredClientEvent {
  const src = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const event: StoredClientEvent = {
    at: asNumber(src['at'], 0),
    level: truncate(asString(src['level'], 'error'), 16),
    kind: truncate(asString(src['kind'], 'unknown'), 64),
    message: truncate(redactString(asString(src['message'], ''), secrets), MAX_STRING_CHARS),
  }
  const stack = src['stack']
  if (typeof stack === 'string' && stack.length > 0) {
    event.stack = truncate(redactString(stack, secrets), MAX_STACK_CHARS)
  }
  const context = src['context']
  if (context !== null && typeof context === 'object' && !Array.isArray(context)) {
    event.context = redactValue(context, secrets, 0) as Record<string, unknown>
  }
  return event
}

/**
 * Sanitise one inbound report. Returns `null` ONLY when the payload is not an
 * object at all — everything else is coerced into the stored shape, because a
 * report that arrives slightly malformed is still evidence.
 */
export function sanitizeReport(raw: unknown, secrets: readonly string[]): StoredClientReport | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const src = raw as Record<string, unknown>
  const appSrc = (src['app'] !== null && typeof src['app'] === 'object'
    ? src['app']
    : {}) as Record<string, unknown>
  const sessionSrc = (src['session'] !== null && typeof src['session'] === 'object'
    ? src['session']
    : {}) as Record<string, unknown>
  const eventsSrc = Array.isArray(src['events']) ? src['events'] : []

  const eventsTruncated = eventsSrc.length > MAX_EVENTS_PER_REPORT
  return {
    ...(src['truncated'] === true || eventsTruncated ? { truncated: true } : {}),
    schema: asNumber(src['schema'], 1),
    report_id: truncate(redactString(asString(src['report_id'], 'unknown'), secrets), MAX_ID_CHARS),
    created_at: asNumber(src['created_at'], 0),
    reason: truncate(asString(src['reason'], 'unknown'), 64),
    app: {
      version: truncate(asString(appSrc['version'], 'unknown'), 64),
      build: nullableTruncate(asNullableString(appSrc['build']), 64),
      platform: truncate(asString(appSrc['platform'], 'unknown'), 32),
      os_version: nullableTruncate(asNullableString(appSrc['os_version']), 64),
    },
    session: { signed_in: sessionSrc['signed_in'] === true },
    events: eventsSrc
      .slice(0, MAX_EVENTS_PER_REPORT)
      .map((event) => sanitizeEvent(event, secrets)),
  }
}

function nullableTruncate(value: string | null, max: number): string | null {
  return value === null ? null : truncate(value, max)
}

/** The result of sanitising a whole inbound batch. */
export interface SanitizedBatch {
  reports: StoredClientReport[]
  /** How many entries the batch caps discarded — surfaced to the client so a
   *  drop is visible rather than silent. */
  dropped: number
}

/**
 * Sanitise `{ reports: [...] }`. Over-long batches are TRUNCATED (and the drop
 * count reported), not rejected: the app clears its queue on a 2xx, so
 * rejecting a batch outright would make an over-full queue permanently
 * undeliverable.
 */
export function sanitizeBatch(raw: unknown, secrets: readonly string[]): SanitizedBatch {
  const src = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const list = Array.isArray(src['reports']) ? src['reports'] : []
  const kept = list.slice(0, MAX_REPORTS_PER_BATCH)
  const reports: StoredClientReport[] = []
  for (const entry of kept) {
    const report = sanitizeReport(entry, secrets)
    if (report !== null) reports.push(report)
  }
  return { reports, dropped: list.length - reports.length }
}
