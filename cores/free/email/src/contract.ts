/**
 * @neutronai/email-managed-core — GmailClient contract.
 *
 * Types, interfaces, shared defaults and the pure cross-backend
 * derivation helpers for the Email-Managed Core's Gmail client
 * surface. Split out of `backend.ts` (D5); `backend.ts` remains the
 * barrel — see its header for the design notes (newest-first
 * ordering; draft + send surface, see manifest.ts).
 */

/**
 * Gmail message metadata row returned by list / search. Body is NOT
 * populated on these paths — use `getMessage` for the full body.
 */
export interface GmailMessageMeta {
  id: string
  thread_id: string
  subject: string
  /** From header value, full RFC 5322 (e.g. `"Alice" <alice@x.com>`). */
  from: string
  snippet: string
  /** ISO-8601 datetime derived from Gmail's epoch-ms `internalDate`. */
  internal_date: string
  label_ids: string[]
  /**
   * WHICH connected account this message was read from. Stamped by the fan-out
   * client (`buildMultiAccountGmailClient`) on every row it returns. A merged
   * inbox is unusable without it — an owner cannot tell a client email from a
   * personal one, and cannot tell which account a reply would come from.
   * Absent on single-backend clients that never fan out (the in-memory fake).
   */
  account_id?: string
  /** Address of the account in `account_id`, when known. */
  account_email?: string
}

/**
 * Full Gmail message — extends the metadata shape with body + to / cc
 * + optional HTML body.
 *
 * `body_text` is always populated (extracted from the message MIME
 * tree). `body_html` is optional — only populated when the source
 * message had a `text/html` part. Most automated email is HTML-first
 * with a generated plaintext alternative; user-typed mail is often
 * plaintext-only.
 */
export interface GmailMessageFull extends GmailMessageMeta {
  to: string[]
  cc: string[]
  body_text: string
  body_html?: string
}

export interface GmailListInput {
  /** Defaults to `INBOX` at the client layer when omitted. */
  label?: string
  max_results?: number
  page_token?: string
  /**
   * Optional project scope. When supplied, the result set is filtered
   * to messages also carrying the `Neutron/<project_id>` user label.
   * Identical semantics across the in-memory and Google backends —
   * the in-memory client filters its local row store; the Google
   * client adds a second `labelIds=...` query parameter so Gmail
   * AND-s the project label with the inbox label server-side.
   */
  project_id?: string
}

export interface GmailListResult {
  results: GmailMessageMeta[]
  /** Opaque cursor — present when Gmail returned a `nextPageToken`. */
  next_page_token?: string
}

export interface GmailSearchInput {
  /** Gmail-style query (e.g. `from:alice@x.com is:unread`). */
  query: string
  max_results?: number
  /**
   * Optional project scope. When supplied, `label:Neutron/<project_id>`
   * is AND-ed into the query before dispatch. Identical semantics
   * across the in-memory and Google backends.
   */
  project_id?: string
}

export interface GmailGetInput {
  message_id: string
}

export interface GmailThreadGetInput {
  thread_id: string
}

/**
 * Full Gmail thread — the conversation-level read surface (Gmail's
 * `users.threads.get`). Carries every message in the thread plus
 * derived thread metadata.
 *
 * Ordering: `messages` is OLDEST-FIRST (ascending by `internalDate`)
 * — the natural conversation reading order, top-to-bottom. This is
 * the INVERSE of `listMessages` / `search`, which are newest-first
 * (inboxes face backward; a thread you're reading faces forward).
 */
export interface GmailThreadFull {
  thread_id: string
  /** Subject of the thread — taken from the FIRST (oldest) message. */
  subject: string
  /** Number of messages in the thread. */
  message_count: number
  /** ISO-8601 datetime of the most recent message in the thread. */
  last_message_date: string
  /**
   * Distinct From / To / Cc participants across every message in the
   * thread, in first-seen order. Raw RFC 5322 mailbox specs (e.g.
   * `"Alice" <alice@x.com>`) — downstream consumers extract the bare
   * address themselves when they want one.
   */
  participants: string[]
  /** Union of label ids across all messages in the thread. */
  label_ids: string[]
  /** Full messages, OLDEST-FIRST (ascending by internalDate). */
  messages: GmailMessageFull[]
}

export interface GmailDraftInput {
  to: string[]
  subject: string
  body: string
  reply_to_message_id?: string
  cc?: string[]
  /**
   * Optional project scope. When supplied, the per-project Gmail
   * user-label `Neutron/<project_id>` is applied to the resulting
   * draft's thread alongside the owner 4-point labels (INBOX +
   * IMPORTANT + UNREAD). The label is auto-created on first use via
   * `ensureProjectLabel` (idempotent).
   */
  project_id?: string
}

/**
 * Result of `drafts.create` + the post-create threads.modify step.
 * Gmail returns BOTH a draft-resource id AND the id of the underlying
 * message resource (drafts.message.id). The `applied_labels` array
 * echoes the labels applied to the draft's thread after the atomic
 * post-create labels-apply step — always includes
 * `INBOX + IMPORTANT + UNREAD` per the owner's 4-point requirement, plus
 * `Neutron/<project_id>` when `project_id` was supplied.
 */
export interface GmailDraftResult {
  draft_id: string
  message_id: string
  thread_id: string
  applied_labels: string[]
}

export interface GmailSendInput {
  to: string[]
  subject: string
  body: string
  reply_to_message_id?: string
  cc?: string[]
  /**
   * Optional project scope. When supplied, the per-project Gmail
   * user-label `Neutron/<project_id>` is applied to the sent thread
   * alongside the owner visibility labels.
   */
  project_id?: string
}

/**
 * Result of `messages.send` + the post-send threads.modify step.
 * Gmail returns the sent message id + its threadId. `applied_labels`
 * echoes the owner visibility labels applied to the sent thread after
 * the post-send labels-apply step — always includes `INBOX +
 * IMPORTANT + UNREAD` (the owner's "every Neutron-touched thread
 * surfaces in the inbox" rule; the DRAFT label is N/A for a sent
 * message), plus `Neutron/<project_id>` when `project_id` was supplied.
 */
export interface GmailSendResult {
  message_id: string
  thread_id: string
  applied_labels: string[]
}

export interface GmailLabelEnsureInput {
  project_id: string
}

export interface GmailLabelEnsureResult {
  /** The Gmail-side label id (typically of the form `Label_4567890`).
   *  The in-memory client returns a deterministic synthetic id.       */
  label_id: string
  /** The label name (`Neutron/<project_id>`). */
  label_name: string
  /** True when the label was just created; false when it already
   *  existed (the `users.labels.create` idempotency case). */
  created: boolean
}

/**
 * Thread-label mutation input. Mirrors Gmail's
 * `users.threads.modify({addLabelIds, removeLabelIds})` surface.
 * v1 only uses addLabelIds (the 4-point draft policy never removes
 * labels); `removeLabelIds` is reserved for a future tier of
 * policies (e.g. archive-on-draft).
 */
export interface GmailThreadModifyInput {
  thread_id: string
  add_label_ids: readonly string[]
  remove_label_ids?: readonly string[]
}

export interface GmailThreadModifyResult {
  thread_id: string
  /** Final label set on the thread after the modify call. */
  label_ids: string[]
}

/**
 * MESSAGE-label mutation input (Gmail's `users.messages.modify`). Distinct
 * from `GmailThreadModifyInput` on purpose: the pipeline archives / labels ONE
 * message, and applying that to the whole thread would archive a conversation
 * because one of its messages was bulk mail.
 *
 * `account_id` names WHICH connected account owns the message — a merged inbox
 * has no other way to route a write, since Gmail ids are per-account. Ignored
 * by single-account clients.
 */
export interface GmailMessageModifyInput {
  message_id: string
  add_label_ids: readonly string[]
  remove_label_ids?: readonly string[]
  account_id?: string
}

export interface GmailMessageModifyResult {
  message_id: string
  /** Final label set on the message after the modify call. */
  label_ids: string[]
}

/**
 * Generalized label-ensure input: any label NAME, not just the per-project
 * `Neutron/<project_id>` shape `ensureProjectLabel` mints. The pipeline's
 * processed label (`Neutron/processed`) is instance-level and belongs to no
 * project.
 */
export interface GmailEnsureLabelInput {
  name: string
  account_id?: string
}

/**
 * The label the pipeline stamps on every message it has handled. Instance-
 * level (no project segment) — it marks "Neutron has seen this", which is a
 * property of the mailbox, not of a project.
 */
export const PROCESSED_LABEL_NAME = 'Neutron/processed'

/**
 * Backend contract every GmailClient implementation satisfies. The
 * shape mirrors the MCP tool inputs the manifest declares (list /
 * read / search / draft / send) — `summarize` is implemented at the
 * tool layer because it composes a `getMessage` round-trip with a
 * separate `EmailSummarizer` call (not part of Gmail's REST surface).
 */
export interface GmailClient {
  listMessages(input: GmailListInput): Promise<GmailListResult>
  /** Throws `MessageNotFoundError` on unknown id. */
  getMessage(input: GmailGetInput): Promise<GmailMessageFull>
  /**
   * Fetch a whole Gmail conversation by thread id (`users.threads.get`)
   * — every message in the thread plus derived thread metadata
   * (subject, participants, message_count, last_message_date). Messages
   * come back OLDEST-FIRST (conversation reading order). Throws
   * `ThreadNotFoundError` on an unknown / empty thread.
   */
  getThread(input: GmailThreadGetInput): Promise<GmailThreadFull>
  search(input: GmailSearchInput): Promise<GmailListResult>
  /**
   * Atomic two-call sequence: drafts.create → threads.modify
   * (addLabelIds=['INBOX','IMPORTANT','UNREAD'] + Neutron/<project_id>
   * when supplied). On partial completion (drafts.create OK but
   * threads.modify failed) throws `DraftLabelingError` carrying the
   * orphaned draft_id so the caller can retry the labelling step
   * idempotently.
   */
  createDraft(input: GmailDraftInput): Promise<GmailDraftResult>
  /**
   * Send a NEW message (or a reply when `reply_to_message_id` is set)
   * via `messages.send`, then atomically apply the owner visibility
   * labels (INBOX + IMPORTANT + UNREAD, + `Neutron/<project_id>` when
   * supplied) to the sent thread via `threads.modify` so the
   * conversation surfaces in the owner's inbox — the send-path
   * counterpart to the 4-point draft policy. Header-injection is
   * blocked at the `buildRawMessage` MIME layer (shared with the draft
   * path). On partial completion (send OK but threads.modify failed)
   * throws `DraftLabelingError` carrying the sent message id so the
   * caller can retry the labelling step idempotently.
   */
  sendMessage(input: GmailSendInput): Promise<GmailSendResult>
  /**
   * Ensure the per-project Gmail user-label `Neutron/<project_id>`
   * exists; create it via `users.labels.create` on first use.
   * Idempotent — calling twice with the same `project_id` returns the
   * same `label_id` on the second call with `created:false`.
   */
  ensureProjectLabel(input: GmailLabelEnsureInput): Promise<GmailLabelEnsureResult>
  /**
   * Ensure an ARBITRARY Gmail user-label exists, by name. Same create-first /
   * list-and-match idempotency `ensureProjectLabel` has (which now delegates
   * here); `label_name` in the result echoes `input.name`. The pipeline uses
   * it for the instance-level `Neutron/processed` label.
   */
  ensureLabel(input: GmailEnsureLabelInput): Promise<GmailLabelEnsureResult>
  /**
   * Apply / remove labels on a Gmail thread. Used by the draft-policy
   * layer to atomically add `INBOX + IMPORTANT + UNREAD` (+ optionally
   * `Neutron/<project_id>`) to a freshly-created draft's thread.
   */
  modifyThread(input: GmailThreadModifyInput): Promise<GmailThreadModifyResult>
  /**
   * Apply / remove labels on a single MESSAGE (`users.messages.modify`). The
   * pipeline's archive step is `add Neutron/processed, remove INBOX` on the
   * one message — never on its thread.
   */
  modifyMessage(input: GmailMessageModifyInput): Promise<GmailMessageModifyResult>
  /**
   * `listMessages`, plus the per-account outcome of the read. Present ONLY on
   * the fan-out client — a single-backend client has nothing to report.
   *
   * `listMessages` alone cannot distinguish "that inbox is quiet" from "that
   * inbox could not be read". Callers that render for a human (the `/email`
   * filter, the `email_list` tool) use this to name the account that failed.
   */
  listMessagesAcrossAccounts?(
    input: GmailListInput,
  ): Promise<GmailListAcrossAccounts>
}

/**
 * Outcome of reading ONE account during a fan-out. `ok:false` carries the
 * reason so a broken grant reaches the owner instead of being absorbed into a
 * quieter-looking inbox.
 */
export interface AccountReadOutcome {
  account_id: string
  account_email: string | null
  ok: boolean
  /** Failure reason when `ok` is false. */
  error?: string
}

export interface GmailListAcrossAccounts {
  /** Merged messages across every account that answered, newest first. */
  results: GmailMessageMeta[]
  /** One entry per connected account, in fan-out order. */
  accounts: AccountReadOutcome[]
}

/**
 * Assemble a `GmailThreadFull` from the messages of a single thread.
 * Pure — shared by the in-memory fakes and the Google wrapper so the
 * thread-metadata derivation (ordering, participant union, label
 * union, subject/last-date) is identical across backends.
 *
 * Messages are returned OLDEST-FIRST (ascending by internalDate) — the
 * natural conversation reading order. Subject is taken from the oldest
 * message; participants are the first-seen union of From/To/Cc across
 * the whole thread.
 */
export function assembleThread(
  thread_id: string,
  msgs: GmailMessageFull[],
): GmailThreadFull {
  const ordered = [...msgs].sort(
    (a, b) => Date.parse(a.internal_date) - Date.parse(b.internal_date),
  )
  const participants: string[] = []
  const seen = new Set<string>()
  const labels = new Set<string>()
  for (const m of ordered) {
    for (const addr of [m.from, ...m.to, ...m.cc]) {
      const v = addr.trim()
      if (v.length > 0 && !seen.has(v)) {
        seen.add(v)
        participants.push(v)
      }
    }
    for (const l of m.label_ids) labels.add(l)
  }
  const first = ordered[0]
  const last = ordered[ordered.length - 1]
  return {
    thread_id,
    subject: first?.subject ?? '',
    message_count: ordered.length,
    last_message_date: last?.internal_date ?? '',
    participants,
    label_ids: Array.from(labels),
    messages: ordered,
  }
}

/**
 * Default page size when callers omit `max_results`. Gmail's
 * `messages.list` default is 100 / max 500; we cap tighter for the
 * Tier 1 surface — most launcher / chat queries want ~25 results.
 *
 * Exported so the Google-backed adapter can pass the same default
 * into the `maxResults` query parameter; otherwise an omitted
 * `max_results` would return Gmail's 100-row default and the two
 * backends would disagree.
 */
export const DEFAULT_LIST_LIMIT = 25

/** Default label when callers omit one — Gmail's "main inbox" id. */
export const DEFAULT_LABEL = 'INBOX' as const

/**
 * Convert an epoch-ms timestamp to an ISO-8601 string. Mirrors the
 * production wrapper's coercion of Gmail's `internalDate` (a
 * string-encoded epoch-ms) into the Core's `internal_date` field.
 */
export function epochMsToIso(ms: number): string {
  return new Date(ms).toISOString()
}
