/**
 * @neutronai/onboarding/history-import — Gmail OAuth importer (P2 S3).
 *
 * Per docs/plans/P2-onboarding.md § 6 S3. The runner re-uses the
 * identity service's existing Google OAuth flow; this module only adds
 * the gmail.readonly scope on top and pulls the last 90 days of
 * threads.
 *
 * The Gmail-side fetch logic is split out so tests can mock the API
 * without spinning up a full OAuth handshake. `fetchGmailThreads` takes
 * a tiny `GmailClient` interface and returns an `AsyncIterable<
 * ConversationRecord>` ready for the chunker.
 *
 * The real Anthropic+Google integration in production wires through
 * the identity service's `oauth/google/exchange` flow. That hookup
 * lands in S4 alongside the wow-moment dispatch — S3 only needs the
 * importer surface + tests.
 */

import {
  ImportError,
  type ConversationMessage,
  type ConversationRecord,
  type OAuthRefs,
} from './types.ts'

/**
 * Minimal Gmail API surface this importer needs. Scope = gmail.readonly.
 * The production wrapper around `googleapis` ships in S4; this file only
 * defines the contract so unit tests can exercise the conversion logic
 * without a real Google round-trip.
 */
export interface GmailClient {
  /** List thread metadata since `after_ms`. Returns thread ids + snippets. */
  listThreads(input: {
    /** OAuth refs threaded from `fetchGmailThreads.oauth`. The production
     *  client (`googleapis`) attaches these to every Gmail API call so
     *  the request authenticates as the signed-in user. */
    oauth: OAuthRefs
    after_ms: number
    max_results: number
  }): AsyncIterable<{ thread_id: string; snippet?: string }>
  /** Fetch one thread's full message payloads. */
  getThread(input: {
    oauth: OAuthRefs
    thread_id: string
  }): Promise<{
    thread_id: string
    subject?: string
    messages: Array<{
      message_id: string
      from?: string
      to?: string
      date_ms: number
      snippet?: string
      body_text?: string
    }>
  }>
}

export interface FetchGmailThreadsInput {
  oauth: OAuthRefs
  client: GmailClient
  /** Default 90 days. */
  window_days?: number
  /** Bot-only safety cap; default 5_000 threads even if more are eligible. */
  max_threads?: number
  /**
   * The signed-in user's exact Gmail address (e.g. `user@example.com`).
   * Codex r2 P2 fix: needed so `From: ...` headers can be matched
   * exactly against the user. The identity service knows this from
   * the OAuth profile and threads it through to the importer.
   *
   * If absent, the importer falls back to a relaxed heuristic that
   * matches the literal placeholder `me` (Gmail's UI uses this for
   * the user's own messages but the API does not), which degrades
   * speaker classification for real imports.
   */
  user_email_address?: string
  /** For testing — fixed wall-clock. */
  now?: () => number
}

const DAY_MS = 24 * 60 * 60 * 1_000
const DEFAULT_WINDOW_DAYS = 90
const DEFAULT_MAX_THREADS = 5_000

/**
 * Iterate Gmail threads as conversation records suitable for the
 * chunker. Each thread → one ConversationRecord. The OAuthRefs payload
 * is forwarded to the GmailClient implementation; we don't crack the
 * access_token here.
 *
 * Throws `ImportError{code:'oauth_scope_missing'}` if the access token
 * is empty (the identity service should always set one before calling
 * here, so this is a defense-in-depth check, not a happy-path branch).
 */
export async function* fetchGmailThreads(
  input: FetchGmailThreadsInput,
): AsyncIterable<ConversationRecord> {
  if (input.oauth.access_token.length === 0) {
    throw new ImportError(
      'oauth_scope_missing',
      'gmail-oauth',
      'Gmail OAuth access_token is empty; user has not granted the gmail.readonly scope',
    )
  }
  const now = input.now?.() ?? Date.now()
  const window_days = input.window_days ?? DEFAULT_WINDOW_DAYS
  const max_threads = input.max_threads ?? DEFAULT_MAX_THREADS
  const after_ms = now - window_days * DAY_MS
  const userAddr = input.user_email_address?.toLowerCase()
  let count = 0
  for await (const meta of input.client.listThreads({
    oauth: input.oauth,
    after_ms,
    max_results: max_threads,
  })) {
    if (count >= max_threads) break
    const full = await input.client.getThread({ oauth: input.oauth, thread_id: meta.thread_id })
    const messages: ConversationMessage[] = full.messages.map((m) => {
      const role: ConversationMessage['role'] = isUserSent(m, userAddr) ? 'user' : 'event'
      const text = renderGmailMessage(m, full.subject)
      const out: ConversationMessage = { role, text }
      if (Number.isFinite(m.date_ms)) out.created_at = m.date_ms
      return out
    })
    const rec: ConversationRecord = {
      conversation_id: `gmail:${full.thread_id}`,
      title: full.subject ?? '(no subject)',
      messages,
      meta: { source: 'gmail', thread_id: full.thread_id },
    }
    if (full.messages.length > 0) {
      const first = full.messages[0]!
      if (Number.isFinite(first.date_ms)) rec.created_at = first.date_ms
    }
    yield rec
    count += 1
  }
}

function isUserSent(m: { from?: string }, userAddr?: string): boolean {
  if (typeof m.from !== 'string') return false
  // Codex r3 P2 fix: parse the email address out of the From header
  // and compare exactly. RFC 5322 `From:` may be either a bare
  // address (`user@example.com`) or a name-addr form
  // (`Sam <user@example.com>`); both reduce to the same canonical
  // address via the angle-bracket / strip pattern. Substring
  // matching mis-classified e.g. `joann@example.com` as the user
  // when userAddr was `ann@example.com`.
  if (userAddr !== undefined && userAddr.length > 0) {
    const extracted = extractEmailAddress(m.from)
    return extracted === userAddr.toLowerCase()
  }
  return /\bme\b/i.test(m.from)
}

/**
 * Parse the `addr-spec` out of an RFC 5322 From header. Returns the
 * lowercased local-part@domain. Returns the lowercased input verbatim
 * if no angle brackets are present (bare-address case).
 */
function extractEmailAddress(from: string): string {
  const match = from.match(/<([^>]+)>/)
  if (match !== null && match[1] !== undefined) return match[1].trim().toLowerCase()
  return from.trim().toLowerCase()
}

function renderGmailMessage(
  m: {
    from?: string
    to?: string
    snippet?: string
    body_text?: string
  },
  subject?: string,
): string {
  const parts: string[] = []
  if (subject !== undefined) parts.push(`Subject: ${subject}`)
  if (m.from !== undefined) parts.push(`From: ${m.from}`)
  if (m.to !== undefined) parts.push(`To: ${m.to}`)
  const body = m.body_text ?? m.snippet ?? ''
  if (body.length > 0) parts.push('', body.trim())
  return parts.join('\n')
}
