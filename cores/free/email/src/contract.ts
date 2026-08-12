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
  /**
   * PER-ACCOUNT resume cursors, keyed by `account_id` — the input twin of
   * `GmailListResult.next_page_tokens`. Each account resumes from its own
   * cursor; an account absent from the map starts from its newest page. The
   * multi-account fan-out reads this; single-backend clients ignore it and use
   * `page_token`.
   */
  page_tokens?: Readonly<Record<string, string>>
  /**
   * ACCOUNT ALLOW-LIST. When present, the multi-account fan-out reads ONLY
   * these accounts — the others are not queried at all, not queried-then-
   * filtered. That distinction is the whole point: the pipeline's per-account
   * enablement promises a disabled mailbox is untouched, and "we read it and
   * threw the rows away" is not untouched. It also means one disabled account
   * with a dead grant cannot contribute a read failure to a tick that never
   * wanted it.
   *
   * An EMPTY array means "no accounts", and the fan-out returns an empty page
   * rather than falling back to all — a caller that computed an empty allow-list
   * has said something specific, and the fail-open reading of it is the one that
   * posts a stranger's mail into the owner's chat.
   *
   * Absent ⇒ every connected account, the unchanged default. Single-backend
   * clients ignore it.
   */
  account_ids?: readonly string[]
  /**
   * ENUMERATION MODE. `max_results` is a PER-ACCOUNT request size, so a
   * fan-out across N accounts legitimately reads up to N×max_results rows.
   * Capping the merged set back to `max_results` while every account's cursor
   * advanced past everything it returned makes the dropped rows unreachable
   * FOREVER — the next page resumes after them. A caller that is enumerating
   * a whole mailbox (the pipeline's backlog sweep) sets this to receive every
   * row that was read; display callers leave it unset and get the cap, plus
   * `truncated: true` and NO cursor, because a cursor that skips dropped rows
   * is worse than no cursor at all. Single-backend clients never merge, so
   * they ignore this field.
   */
  exhaustive?: boolean
}

/**
 * The "this mailbox is finished" marker for `page_tokens`.
 *
 * ABSENT and EXHAUSTED are different states and cannot share a representation.
 * The fan-out returns a cursor only for accounts that have another page, so
 * once one account runs out the returned map names only the others — and a
 * caller resuming from that map restarts the finished account at its newest
 * page. With two mailboxes of unequal depth the maps then ALTERNATE: `{B:p2}`
 * restarts A, whose next map `{A:p1}` restarts B, forever. The backlog sweep
 * never completes and steady-state paging never converges.
 *
 * A caller paging a whole mailbox therefore carries finished accounts forward
 * with this sentinel, and the fan-out SKIPS them: no request, no rows, and
 * `ok: true`, because "already finished" is not a failure.
 */
export const PAGE_TOKEN_EXHAUSTED = '__neutron_exhausted__'

export interface GmailListResult {
  results: GmailMessageMeta[]
  /**
   * Opaque cursor — present when Gmail returned a `nextPageToken`.
   *
   * MEANINGFUL ONLY FOR A SINGLE-BACKEND READ. The fan-out cannot express one
   * cursor for N mailboxes, so it omits this whenever more than one account is
   * connected. ABSENCE THEREFORE DOES NOT MEAN "no more mail" — a caller that
   * must enumerate a whole mailbox has to use `next_page_tokens`. Treating a
   * missing `next_page_token` as completion silently truncates every
   * multi-account install to a single page.
   */
  next_page_token?: string
  /**
   * PER-ACCOUNT cursors keyed by `account_id`, for callers that must page an
   * entire mailbox rather than read its newest page. Only accounts that
   * returned a cursor appear, so an EMPTY map means "every account that
   * answered is exhausted" — the only safe completion signal when several
   * mailboxes are merged. Single-backend clients omit it.
   */
  next_page_tokens?: Readonly<Record<string, string>>
  /**
   * TRUE when the merged set was capped and rows were DROPPED — see
   * `GmailListInput.exhaustive`. Cursors are withheld on the same result,
   * because advancing past rows the caller never received is how mail goes
   * missing. An enumerating caller must treat this as a hard error rather
   * than as completion: with no cursor there is nothing to resume from, so
   * "capped" and "exhausted" would otherwise be indistinguishable.
   */
  truncated?: boolean
  /**
   * Per-account read outcomes, present only on the fan-out client. A caller
   * that must enumerate a whole mailbox has to know whether every account
   * actually ANSWERED: one failed account means the merged set is incomplete,
   * and concluding "exhausted" from it would skip that mailbox entirely.
   */
  accounts?: AccountReadOutcome[]
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
  /**
   * ACCOUNT ALLOW-LIST — same semantics as {@link GmailListInput.account_ids}:
   * the fan-out queries only these accounts, an empty array means none, and an
   * absent field means every connected account. Present on search too because
   * a scoped read that silently widens on one of the two read paths is not a
   * scope.
   */
  account_ids?: readonly string[]
}

export interface GmailGetInput {
  message_id: string
  /**
   * WHICH mailbox to read from. Gmail message ids are ACCOUNT-LOCAL, so the id
   * alone does not identify a message across a multi-account install: the
   * fan-out's by-id probe returns whichever account recognises it FIRST, which
   * on a collision reads account A's body for account B's row — classified from
   * the wrong message, while the label mutation correctly targets B. The poller
   * knows the account it listed from and names it here. Omitted ⇒ the by-id
   * probe, which is still correct when only one account is connected.
   */
  account_id?: string
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
  /**
   * The CONNECTED accounts, without reading a single message. Present only on
   * the fan-out client, where there is more than one to name.
   *
   * This exists because the pipeline's allow-list fails closed, and a
   * fail-closed allow-list has to be discoverable or it is a lock with no key:
   * nothing is polled until an `account_id` is enabled, and nothing reveals an
   * `account_id` until something polls. Enumerating the grants the owner has
   * ALREADY made is not reading their mail — it is the one question a
   * switched-off pipeline is still entitled to ask.
   */
  listConnectedAccounts?(): Promise<readonly ConnectedAccount[]>
}

/**
 * One connected mailbox, as the discovery path reports it. Deliberately
 * narrower than `GmailAccountDescriptor` — no token accessor — because the
 * caller is a settings surface, not a reader.
 */
export interface ConnectedAccount {
  account_id: string
  account_email: string | null
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
