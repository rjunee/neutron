/**
 * @neutronai/email-managed-core — typed error classes.
 *
 * Every error the Gmail client surface throws, split out of
 * `backend.ts` (D5). Includes the security-relevant
 * `EmailHeaderInjectionError` thrown by the MIME builder in
 * `mime.ts`.
 */

/**
 * Thrown by the post-create labels-apply step when the underlying
 * `users.threads.modify` call failed but `drafts.create` already
 * succeeded — the draft sits in Gmail's `DRAFT` label without the
 * load-bearing INBOX + IMPORTANT + UNREAD set the owner's contract
 * requires. The orphaned `draft_id` + `thread_id` are surfaced so
 * the caller can retry the labelling step idempotently
 * (threads.modify with the same addLabelIds is a no-op when the
 * labels are already present).
 *
 * Per docs/plans/email-managed-core-tier1-brief.md § 3.6.
 */
export class DraftLabelingError extends Error {
  readonly code = 'draft_labeling_failed' as const
  readonly draft_id: string
  readonly thread_id: string
  readonly message_id: string
  readonly underlying: Error

  constructor(
    draft_id: string,
    thread_id: string,
    message_id: string,
    underlying: Error,
  ) {
    super(
      `drafts.create succeeded (draft_id=${draft_id}, thread_id=${thread_id}) but threads.modify failed: ${underlying.message}`,
    )
    this.name = 'DraftLabelingError'
    this.draft_id = draft_id
    this.thread_id = thread_id
    this.message_id = message_id
    this.underlying = underlying
  }
}

/**
 * Thrown when `getMessage` references a message id that doesn't
 * exist. The Core's tool layer surfaces this as an `error` outcome
 * via the CapabilityGuard wrapper — the audit log records the
 * failure and the caller sees the message.
 */
export class MessageNotFoundError extends Error {
  readonly code = 'message_not_found' as const
  readonly message_id: string

  constructor(message_id: string) {
    super(`gmail message not found: ${message_id}`)
    this.name = 'MessageNotFoundError'
    this.message_id = message_id
  }
}

/**
 * Thrown when `getThread` references a thread id that doesn't exist (or
 * a thread with no messages). Mirrors `MessageNotFoundError` so the
 * tool layer surfaces it as an `unknown_id` outcome consistently across
 * the in-memory and Google backends.
 */
export class ThreadNotFoundError extends Error {
  readonly code = 'thread_not_found' as const
  readonly thread_id: string

  constructor(thread_id: string) {
    super(`gmail thread not found: ${thread_id}`)
    this.name = 'ThreadNotFoundError'
    this.thread_id = thread_id
  }
}

/**
 * Thrown when the access-token accessor returns null. The runtime
 * composer can interpret this as "re-prompt the user for OAuth
 * consent" — surfaced separately from a generic API error so the
 * caller doesn't conflate "transient API failure" with "user revoked
 * access".
 */
export class OAuthMissingError extends Error {
  readonly code = 'oauth_missing' as const
  constructor() {
    super('Gmail OAuth token is unavailable — re-prompt for consent')
    this.name = 'OAuthMissingError'
  }
}

export class GoogleGmailApiError extends Error {
  readonly code = 'google_gmail_api_error' as const
  readonly http_status: number
  constructor(http_status: number, message: string) {
    super(`Gmail API ${http_status}: ${message}`)
    this.name = 'GoogleGmailApiError'
    this.http_status = http_status
  }
}

/**
 * Thrown when a header-field input contains CR / LF / NUL bytes that
 * would let the caller inject arbitrary RFC 5322 headers (extra Bcc,
 * From-spoof, attachments) into the raw MIME before drafts.create.
 *
 * This Core both prepares drafts (drafts.create) AND sends mail
 * (messages.send, the `email_send` tool), and the same `buildRawMessage`
 * primitive feeds both paths — sanitising at the MIME-build layer kills
 * the injection surface for every raw-message path in one place. Argus
 * r1 BLOCKING.
 */
export class EmailHeaderInjectionError extends Error {
  readonly code = 'email_header_injection' as const
  readonly field: string
  constructor(field: string) {
    super(
      `Header value for "${field}" contains CR/LF/NUL — refusing to build a draft that could smuggle additional headers (Bcc / From-spoof / attachments) past the MIME boundary.`,
    )
    this.name = 'EmailHeaderInjectionError'
    this.field = field
  }
}
