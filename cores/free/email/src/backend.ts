/**
 * @neutronai/email-managed-core — GmailClient interface + reference
 * adapters + EmailSummarizer abstraction.
 *
 * The Tier 1 Email-Managed Core programs against a narrow `GmailClient`
 * (listMessages / getMessage / search / createDraft). Production: a
 * thin Gmail API v1 REST wrapper backed by an OAuth bearer token
 * resolved lazily from the per-Core SecretsAccessor + a refresh-token
 * exchange (handled at the runtime composition layer — for v1 the
 * access token persisted at install time is what we use).
 *
 * Tests never hit the real Gmail API. The Core ships an in-memory
 * `buildInMemoryGmailClient()` that matches the same contract, so the
 * `__tests__/tools.test.ts` suite exercises the full tool wiring
 * end-to-end without network.
 *
 * Why this interface lives in the Core (not under a shared
 * `email/` substrate yet):
 * - There is no canonical `email/` workspace package today. The
 *   Tier 2 Email-Private variant would justify one when send + non-
 *   Gmail providers ship. Until then the Core owns its own client
 *   surface; the substrate-side email package can layer on later.
 *
 * Ordering: list / search return MESSAGES NEWEST-FIRST by Gmail
 * `internalDate` DESCENDING — the natural inbox semantic ("most
 * recent at the top"). Distinct from the Calendar Core's chronological-
 * ascending ordering (meetings face forward; inboxes face backward).
 *
 * SEND IS NOT SUPPORTED. The Core deliberately omits `messages.send` /
 * `drafts.send` from the client surface AND from the manifest's
 * declared capabilities AND from the OAuth scope grant (the
 * 3-scope split is gmail.readonly + gmail.modify + gmail.compose;
 * gmail.send is excluded). A Tier 2 paid Email-Private Core will
 * ship that surface; this one prepares drafts only. Drafts land in
 * the user's Gmail Drafts label and require an explicit human
 * action to send.
 */

import { randomUUID } from 'node:crypto'

import {
  PROJECT_LABEL_PREFIX,
  DEFAULT_DRAFT_LABEL_IDS,
  projectLabelName,
} from './manifest.ts'

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
 * Backend contract every GmailClient implementation satisfies. The
 * shape mirrors the five MCP tool inputs the manifest declares (list
 * / read / search / draft) — `summarize` is implemented at the
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
   * Apply / remove labels on a Gmail thread. Used by the draft-policy
   * layer to atomically add `INBOX + IMPORTANT + UNREAD` (+ optionally
   * `Neutron/<project_id>`) to a freshly-created draft's thread.
   */
  modifyThread(input: GmailThreadModifyInput): Promise<GmailThreadModifyResult>
}

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
function assembleThread(
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

interface InMemoryGmailClientOptions {
  /** Id minter override for tests that need deterministic ids. */
  nextId?: () => string
  /** Wall-clock override for deterministic internal_date stamping. */
  now?: () => number
}

/**
 * Convert an epoch-ms timestamp to an ISO-8601 string. Mirrors the
 * production wrapper's coercion of Gmail's `internalDate` (a
 * string-encoded epoch-ms) into the Core's `internal_date` field.
 */
function epochMsToIso(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * Reference in-memory `GmailClient`. Used by every Core test in
 * `cores/free/email/__tests__/` so the suite never reaches
 * Gmail. The production wrapper is `buildGoogleGmailClient` below.
 *
 * Ordering: `listMessages` / `search` return NEWEST-FIRST by
 * internalDate (the natural inbox semantic — most recent at the top).
 *
 * SEND IS NOT SUPPORTED — the in-memory client has no `send` method
 * BY DESIGN, mirroring the production wrapper. Adding one would
 * compromise the Tier 1 "drafts only" guarantee.
 */
export function buildInMemoryGmailClient(
  options: InMemoryGmailClientOptions = {},
): GmailClient {
  const nextId = options.nextId ?? ((): string => randomUUID())
  const now = options.now ?? ((): number => Date.now())
  // The store is keyed by message id (id space is global per owner
  // mailbox; Gmail message ids are globally unique within a mailbox).
  const messages = new Map<string, GmailMessageFull>()
  // Drafts are keyed by draft_id and carry their own message id; the
  // mock surfaces drafts as ordinary messages in the `DRAFT`-labeled
  // result set so tests can verify the draft landed.
  const drafts = new Map<string, GmailDraftResult>()
  // Gmail user-label registry. Tracks the per-project Neutron labels
  // (`Neutron/<project_id>`) the in-memory client has minted via
  // `ensureProjectLabel`. Keyed by label_name → label_id.
  const labels = new Map<string, string>()

  function matchesQuery(msg: GmailMessageFull, query: string): boolean {
    // Best-effort Gmail query parser for the in-memory fake. v1
    // recognises the most common operators:
    //   `from:<addr-substring>` (substring against the From header)
    //   `to:<addr-substring>` (substring against the To header)
    //   `subject:<substring>` (substring against subject)
    //   `label:<name>` / `is:<name>` (label_ids contains <name>,
    //     case-insensitive — Gmail's web UI uses LOWERCASE `is:unread`
    //     against the UPPERCASE `UNREAD` label id, so we match
    //     case-insensitively)
    //   bare words → substring against subject OR snippet OR
    //     body_text (the Gmail "everything" fallback)
    //
    // Multiple terms AND together. This is intentionally narrow —
    // a Tier 1 Core's fake doesn't need to reproduce Gmail's full
    // query grammar; production hits Gmail server-side. We document
    // the supported subset in README + AGENTS.md.
    if (query.trim().length === 0) return true
    const terms = query.trim().split(/\s+/)
    for (const term of terms) {
      if (term.startsWith('from:')) {
        const needle = term.slice('from:'.length).toLowerCase()
        if (!msg.from.toLowerCase().includes(needle)) return false
        continue
      }
      if (term.startsWith('to:')) {
        const needle = term.slice('to:'.length).toLowerCase()
        const hit = msg.to.some((addr) => addr.toLowerCase().includes(needle))
        if (!hit) return false
        continue
      }
      if (term.startsWith('subject:')) {
        const needle = term.slice('subject:'.length).toLowerCase()
        if (!msg.subject.toLowerCase().includes(needle)) return false
        continue
      }
      if (term.startsWith('label:') || term.startsWith('is:')) {
        const needle = term.split(':', 2)[1]?.toLowerCase() ?? ''
        const hit = msg.label_ids.some((l) => l.toLowerCase() === needle)
        if (!hit) return false
        continue
      }
      // Fallback "everything" match.
      const needle = term.toLowerCase()
      const hay = [msg.subject, msg.snippet, msg.body_text].join('\n').toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  }

  function sortNewestFirst(rows: GmailMessageMeta[]): GmailMessageMeta[] {
    return [...rows].sort((a, b) => {
      // Parse the ISO strings back to instants. NaN guard would only
      // fire for malformed rows; the fake never produces those.
      const aMs = Date.parse(a.internal_date)
      const bMs = Date.parse(b.internal_date)
      return bMs - aMs
    })
  }

  function applyLabelsToThread(thread_id: string, add: readonly string[]): string[] {
    const final = new Set<string>()
    for (const msg of messages.values()) {
      if (msg.thread_id !== thread_id) continue
      for (const l of msg.label_ids) final.add(l)
    }
    for (const l of add) final.add(l)
    // Re-stamp every message in the thread so the in-memory store
    // reflects the Gmail-side thread-scoped label semantics. (Gmail's
    // `users.threads.modify` adds the label to EVERY message in the
    // thread; we mirror that.)
    for (const msg of messages.values()) {
      if (msg.thread_id !== thread_id) continue
      const next = Array.from(final)
      msg.label_ids = next
    }
    return Array.from(final)
  }

  function matchesProjectFilter(
    row: GmailMessageFull,
    project_id: string | undefined,
  ): boolean {
    if (project_id === undefined) return true
    const wanted = projectLabelName(project_id)
    return row.label_ids.includes(wanted)
  }

  return {
    async listMessages(input: GmailListInput): Promise<GmailListResult> {
      const limit = input.max_results ?? DEFAULT_LIST_LIMIT
      const label = input.label ?? DEFAULT_LABEL
      const matching: GmailMessageMeta[] = []
      for (const row of messages.values()) {
        if (!row.label_ids.includes(label)) continue
        if (!matchesProjectFilter(row, input.project_id)) continue
        matching.push(toMeta(row))
      }
      const ordered = sortNewestFirst(matching)
      return { results: ordered.slice(0, limit) }
    },

    async getMessage(input: GmailGetInput): Promise<GmailMessageFull> {
      const row = messages.get(input.message_id)
      if (row === undefined) throw new MessageNotFoundError(input.message_id)
      return { ...row }
    },

    async getThread(input: GmailThreadGetInput): Promise<GmailThreadFull> {
      const msgs: GmailMessageFull[] = []
      for (const row of messages.values()) {
        if (row.thread_id === input.thread_id) msgs.push({ ...row })
      }
      if (msgs.length === 0) throw new ThreadNotFoundError(input.thread_id)
      return assembleThread(input.thread_id, msgs)
    },

    async search(input: GmailSearchInput): Promise<GmailListResult> {
      const limit = input.max_results ?? DEFAULT_LIST_LIMIT
      const matching: GmailMessageMeta[] = []
      for (const row of messages.values()) {
        if (!matchesQuery(row, input.query)) continue
        if (!matchesProjectFilter(row, input.project_id)) continue
        matching.push(toMeta(row))
      }
      const ordered = sortNewestFirst(matching)
      return { results: ordered.slice(0, limit) }
    },

    async createDraft(input: GmailDraftInput): Promise<GmailDraftResult> {
      const draft_id = `draft-${nextId()}`
      const message_id = nextId()
      // When replying, Gmail threads the draft onto the existing
      // thread of the source message. The fake mirrors that — the
      // draft's thread_id equals the source message's thread_id.
      // An unknown `reply_to_message_id` MUST throw
      // `MessageNotFoundError` so the fake matches the production
      // Google client's 404 behaviour.
      let thread_id: string
      if (input.reply_to_message_id !== undefined) {
        const src = messages.get(input.reply_to_message_id)
        if (src === undefined) {
          throw new MessageNotFoundError(input.reply_to_message_id)
        }
        thread_id = src.thread_id
      } else {
        thread_id = `thread-${nextId()}`
      }
      const draftMsg: GmailMessageFull = {
        id: message_id,
        thread_id,
        subject: input.subject,
        from: 'me',
        to: [...input.to],
        cc: input.cc !== undefined ? [...input.cc] : [],
        snippet: input.body.slice(0, 200),
        internal_date: epochMsToIso(now()),
        label_ids: ['DRAFT'],
        body_text: input.body,
      }
      messages.set(message_id, draftMsg)
      // owner 4-point: atomically apply INBOX + IMPORTANT + UNREAD to
      // the draft's thread. Plus Neutron/<project_id> when supplied.
      const addLabels: string[] = [...DEFAULT_DRAFT_LABEL_IDS]
      if (input.project_id !== undefined) {
        // Auto-ensure the project label exists.
        const labelName = projectLabelName(input.project_id)
        if (!labels.has(labelName)) {
          labels.set(labelName, `Label_${nextId()}`)
        }
        addLabels.push(labelName)
      }
      const finalLabels = applyLabelsToThread(thread_id, addLabels)
      const result: GmailDraftResult = {
        draft_id,
        message_id,
        thread_id,
        applied_labels: finalLabels.filter((l) => addLabels.includes(l)),
      }
      drafts.set(draft_id, result)
      return result
    },

    async sendMessage(input: GmailSendInput): Promise<GmailSendResult> {
      // Validate the MIME header inputs through the shared sanitizer —
      // the send path inherits the same header-injection guard the
      // draft path uses (a CRLF in `to`/`subject` throws before send).
      buildRawMessage({
        to: input.to,
        subject: input.subject,
        body: input.body,
        ...(input.cc !== undefined ? { cc: input.cc } : {}),
      })
      const message_id = nextId()
      let thread_id: string
      if (input.reply_to_message_id !== undefined) {
        const src = messages.get(input.reply_to_message_id)
        if (src === undefined) {
          throw new MessageNotFoundError(input.reply_to_message_id)
        }
        thread_id = src.thread_id
      } else {
        thread_id = `thread-${nextId()}`
      }
      const sentMsg: GmailMessageFull = {
        id: message_id,
        thread_id,
        subject: input.subject,
        from: 'me',
        to: [...input.to],
        cc: input.cc !== undefined ? [...input.cc] : [],
        snippet: input.body.slice(0, 200),
        internal_date: epochMsToIso(now()),
        label_ids: ['SENT'],
        body_text: input.body,
      }
      messages.set(message_id, sentMsg)
      const addLabels: string[] = [...DEFAULT_DRAFT_LABEL_IDS]
      if (input.project_id !== undefined) {
        const labelName = projectLabelName(input.project_id)
        if (!labels.has(labelName)) labels.set(labelName, `Label_${nextId()}`)
        addLabels.push(labelName)
      }
      const finalLabels = applyLabelsToThread(thread_id, addLabels)
      return {
        message_id,
        thread_id,
        applied_labels: finalLabels.filter((l) => addLabels.includes(l)),
      }
    },

    async ensureProjectLabel(
      input: GmailLabelEnsureInput,
    ): Promise<GmailLabelEnsureResult> {
      const labelName = projectLabelName(input.project_id)
      const cached = labels.get(labelName)
      if (cached !== undefined) {
        return { label_id: cached, label_name: labelName, created: false }
      }
      const label_id = `Label_${nextId()}`
      labels.set(labelName, label_id)
      return { label_id, label_name: labelName, created: true }
    },

    async modifyThread(
      input: GmailThreadModifyInput,
    ): Promise<GmailThreadModifyResult> {
      const finalLabels = applyLabelsToThread(input.thread_id, input.add_label_ids)
      return { thread_id: input.thread_id, label_ids: finalLabels }
    },
  }

  function toMeta(m: GmailMessageFull): GmailMessageMeta {
    return {
      id: m.id,
      thread_id: m.thread_id,
      subject: m.subject,
      from: m.from,
      snippet: m.snippet,
      internal_date: m.internal_date,
      label_ids: [...m.label_ids],
    }
  }
}

/**
 * Test helper — seeds the in-memory client with a pre-built
 * message. Exposed as a top-level helper so tests don't have to
 * stuff messages through `createDraft` (which forces a `DRAFT`
 * label). The fake's internal `messages` map is captured via a
 * closure so callers can mutate it without breaking the contract.
 *
 * Why this lives in the backend module (not in the test file): the
 * `__tests__/tools.test.ts` suite needs deterministic message
 * fixtures for `listMessages` / `getMessage` / `search`, and the
 * Calendar Core uses `create()` (which exists in its CRUD shape) as
 * the seeding mechanism. Email-Managed only ships `createDraft`
 * (drafts only), so seeding inbox messages needs a separate hook —
 * exposed here so tools.test can build realistic fixtures without
 * fighting the no-send guarantee.
 *
 * IMPORTANT: this helper is purely a TEST SEAM. Production runtime
 * never calls it — only the GmailClient interface methods do. The
 * helper is exported so external integration tests in the gateway
 * composer can seed inboxes too, but the production wrapper
 * `buildGoogleGmailClient` ignores it.
 */
export interface InMemoryGmailSeed {
  id?: string
  thread_id?: string
  subject: string
  from: string
  to?: string[]
  cc?: string[]
  snippet?: string
  internal_date?: string
  label_ids?: string[]
  body_text?: string
  body_html?: string
}

export interface SeededInMemoryGmailClient extends GmailClient {
  /** Insert a synthetic message into the fake's inbox. Returns the
   *  message id (auto-generated when caller omits it). */
  seed(input: InMemoryGmailSeed): string
}

/**
 * Convenience wrapper around `buildInMemoryGmailClient` that exposes
 * a `seed()` method. The fake is the same object — tests can use
 * `seed()` to build fixtures and still call list / get / search /
 * createDraft via the GmailClient surface.
 */
export function buildSeededInMemoryGmailClient(
  options: InMemoryGmailClientOptions = {},
): SeededInMemoryGmailClient {
  const nextId = options.nextId ?? ((): string => randomUUID())
  const now = options.now ?? ((): number => Date.now())
  // Internal store is a `Map<string, GmailMessageFull>` — the same
  // shape `buildInMemoryGmailClient` uses. We rebuild the client
  // here against a captured store reference so `seed()` can mutate
  // it without the closure boundary.
  const messages = new Map<string, GmailMessageFull>()
  const labels = new Map<string, string>()

  function matchesQuery(msg: GmailMessageFull, query: string): boolean {
    if (query.trim().length === 0) return true
    const terms = query.trim().split(/\s+/)
    for (const term of terms) {
      if (term.startsWith('from:')) {
        const needle = term.slice('from:'.length).toLowerCase()
        if (!msg.from.toLowerCase().includes(needle)) return false
        continue
      }
      if (term.startsWith('to:')) {
        const needle = term.slice('to:'.length).toLowerCase()
        const hit = msg.to.some((addr) => addr.toLowerCase().includes(needle))
        if (!hit) return false
        continue
      }
      if (term.startsWith('subject:')) {
        const needle = term.slice('subject:'.length).toLowerCase()
        if (!msg.subject.toLowerCase().includes(needle)) return false
        continue
      }
      if (term.startsWith('label:') || term.startsWith('is:')) {
        const needle = term.split(':', 2)[1]?.toLowerCase() ?? ''
        const hit = msg.label_ids.some((l) => l.toLowerCase() === needle)
        if (!hit) return false
        continue
      }
      const needle = term.toLowerCase()
      const hay = [msg.subject, msg.snippet, msg.body_text].join('\n').toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  }

  function sortNewestFirst(rows: GmailMessageMeta[]): GmailMessageMeta[] {
    return [...rows].sort((a, b) => {
      const aMs = Date.parse(a.internal_date)
      const bMs = Date.parse(b.internal_date)
      return bMs - aMs
    })
  }

  function toMeta(m: GmailMessageFull): GmailMessageMeta {
    return {
      id: m.id,
      thread_id: m.thread_id,
      subject: m.subject,
      from: m.from,
      snippet: m.snippet,
      internal_date: m.internal_date,
      label_ids: [...m.label_ids],
    }
  }

  function applyLabelsToThread(thread_id: string, add: readonly string[]): string[] {
    const final = new Set<string>()
    for (const msg of messages.values()) {
      if (msg.thread_id !== thread_id) continue
      for (const l of msg.label_ids) final.add(l)
    }
    for (const l of add) final.add(l)
    for (const msg of messages.values()) {
      if (msg.thread_id !== thread_id) continue
      msg.label_ids = Array.from(final)
    }
    return Array.from(final)
  }

  function matchesProjectFilter(
    row: GmailMessageFull,
    project_id: string | undefined,
  ): boolean {
    if (project_id === undefined) return true
    return row.label_ids.includes(projectLabelName(project_id))
  }

  return {
    seed(input: InMemoryGmailSeed): string {
      const id = input.id ?? nextId()
      const row: GmailMessageFull = {
        id,
        thread_id: input.thread_id ?? `thread-${id}`,
        subject: input.subject,
        from: input.from,
        to: input.to !== undefined ? [...input.to] : [],
        cc: input.cc !== undefined ? [...input.cc] : [],
        snippet: input.snippet ?? '',
        internal_date: input.internal_date ?? epochMsToIso(now()),
        label_ids: input.label_ids !== undefined ? [...input.label_ids] : [DEFAULT_LABEL],
        body_text: input.body_text ?? '',
      }
      if (input.body_html !== undefined) row.body_html = input.body_html
      messages.set(id, row)
      return id
    },

    async listMessages(input: GmailListInput): Promise<GmailListResult> {
      const limit = input.max_results ?? DEFAULT_LIST_LIMIT
      const label = input.label ?? DEFAULT_LABEL
      const matching: GmailMessageMeta[] = []
      for (const row of messages.values()) {
        if (!row.label_ids.includes(label)) continue
        if (!matchesProjectFilter(row, input.project_id)) continue
        matching.push(toMeta(row))
      }
      const ordered = sortNewestFirst(matching)
      return { results: ordered.slice(0, limit) }
    },

    async getMessage(input: GmailGetInput): Promise<GmailMessageFull> {
      const row = messages.get(input.message_id)
      if (row === undefined) throw new MessageNotFoundError(input.message_id)
      return { ...row }
    },

    async getThread(input: GmailThreadGetInput): Promise<GmailThreadFull> {
      const msgs: GmailMessageFull[] = []
      for (const row of messages.values()) {
        if (row.thread_id === input.thread_id) msgs.push({ ...row })
      }
      if (msgs.length === 0) throw new ThreadNotFoundError(input.thread_id)
      return assembleThread(input.thread_id, msgs)
    },

    async search(input: GmailSearchInput): Promise<GmailListResult> {
      const limit = input.max_results ?? DEFAULT_LIST_LIMIT
      const matching: GmailMessageMeta[] = []
      for (const row of messages.values()) {
        if (!matchesQuery(row, input.query)) continue
        if (!matchesProjectFilter(row, input.project_id)) continue
        matching.push(toMeta(row))
      }
      const ordered = sortNewestFirst(matching)
      return { results: ordered.slice(0, limit) }
    },

    async createDraft(input: GmailDraftInput): Promise<GmailDraftResult> {
      const draft_id = `draft-${nextId()}`
      const message_id = nextId()
      let thread_id: string
      if (input.reply_to_message_id !== undefined) {
        const src = messages.get(input.reply_to_message_id)
        if (src === undefined) {
          throw new MessageNotFoundError(input.reply_to_message_id)
        }
        thread_id = src.thread_id
      } else {
        thread_id = `thread-${nextId()}`
      }
      const draftMsg: GmailMessageFull = {
        id: message_id,
        thread_id,
        subject: input.subject,
        from: 'me',
        to: [...input.to],
        cc: input.cc !== undefined ? [...input.cc] : [],
        snippet: input.body.slice(0, 200),
        internal_date: epochMsToIso(now()),
        label_ids: ['DRAFT'],
        body_text: input.body,
      }
      messages.set(message_id, draftMsg)
      const addLabels: string[] = [...DEFAULT_DRAFT_LABEL_IDS]
      if (input.project_id !== undefined) {
        const labelName = projectLabelName(input.project_id)
        if (!labels.has(labelName)) {
          labels.set(labelName, `Label_${nextId()}`)
        }
        addLabels.push(labelName)
      }
      const finalLabels = applyLabelsToThread(thread_id, addLabels)
      return {
        draft_id,
        message_id,
        thread_id,
        applied_labels: finalLabels.filter((l) => addLabels.includes(l)),
      }
    },

    async sendMessage(input: GmailSendInput): Promise<GmailSendResult> {
      buildRawMessage({
        to: input.to,
        subject: input.subject,
        body: input.body,
        ...(input.cc !== undefined ? { cc: input.cc } : {}),
      })
      const message_id = nextId()
      let thread_id: string
      if (input.reply_to_message_id !== undefined) {
        const src = messages.get(input.reply_to_message_id)
        if (src === undefined) {
          throw new MessageNotFoundError(input.reply_to_message_id)
        }
        thread_id = src.thread_id
      } else {
        thread_id = `thread-${nextId()}`
      }
      const sentMsg: GmailMessageFull = {
        id: message_id,
        thread_id,
        subject: input.subject,
        from: 'me',
        to: [...input.to],
        cc: input.cc !== undefined ? [...input.cc] : [],
        snippet: input.body.slice(0, 200),
        internal_date: epochMsToIso(now()),
        label_ids: ['SENT'],
        body_text: input.body,
      }
      messages.set(message_id, sentMsg)
      const addLabels: string[] = [...DEFAULT_DRAFT_LABEL_IDS]
      if (input.project_id !== undefined) {
        const labelName = projectLabelName(input.project_id)
        if (!labels.has(labelName)) labels.set(labelName, `Label_${nextId()}`)
        addLabels.push(labelName)
      }
      const finalLabels = applyLabelsToThread(thread_id, addLabels)
      return {
        message_id,
        thread_id,
        applied_labels: finalLabels.filter((l) => addLabels.includes(l)),
      }
    },

    async ensureProjectLabel(
      input: GmailLabelEnsureInput,
    ): Promise<GmailLabelEnsureResult> {
      const labelName = projectLabelName(input.project_id)
      const cached = labels.get(labelName)
      if (cached !== undefined) {
        return { label_id: cached, label_name: labelName, created: false }
      }
      const label_id = `Label_${nextId()}`
      labels.set(labelName, label_id)
      return { label_id, label_name: labelName, created: true }
    },

    async modifyThread(
      input: GmailThreadModifyInput,
    ): Promise<GmailThreadModifyResult> {
      const finalLabels = applyLabelsToThread(input.thread_id, input.add_label_ids)
      return { thread_id: input.thread_id, label_ids: finalLabels }
    },
  }
}

/**
 * Production Gmail v1 REST client.
 *
 * Talks to `https://gmail.googleapis.com/gmail/v1/users/me/...` via
 * global `fetch`. No SDK dependency by design — the v1 surface this
 * Core uses is small (5 endpoints) and a hand-rolled REST wrapper
 * avoids pulling `googleapis` and its ~5MB transitive tree into the
 * Tier 1 Core. The wrapper accepts an `access_token` accessor
 * closure so the runtime composer can refresh tokens out-of-band
 * without the client caching stale credentials.
 *
 * The five endpoints this wrapper calls:
 *   GET /messages              — listMessages / search
 *   GET /messages/<id>?format=full — getMessage
 *   POST /drafts               — createDraft
 *
 * v1 limitations (deliberate — flagged in README + AGENTS.md):
 * - No automatic refresh-token exchange here. The runtime composer
 *   resolves a live access token via the per-Core SecretsAccessor
 *   before each invocation; the OAuth flow itself (consent screen +
 *   token exchange) is handled outside the Core.
 * - No batch endpoint. v1 sends one HTTP request per call.
 * - No attachment handling. Attachments come back as MIME parts the
 *   wrapper currently ignores; surface lands in a follow-up sprint.
 * - No send. Intentional Tier 1 limitation — paid Email-Private
 *   Core ships send.
 */
export type FetchLike = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>

export interface GoogleGmailClientOptions {
  /** Lazy access-token resolver. Called before each request so the
   *  runtime can refresh out-of-band. Returns `null` to signal a
   *  permanent OAuth failure — the wrapper throws
   *  `OAuthMissingError` in that case. */
  accessToken: () => Promise<string | null>
  /** Override for tests / local dev — defaults to the public Gmail
   *  v1 base URL. */
  baseUrl?: string
  /** Override fetch — tests inject a stub. Defaults to
   *  globalThis.fetch. */
  fetchImpl?: FetchLike
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

interface GmailHeader {
  name?: string
  value?: string
}

interface GmailMessagePart {
  mimeType?: string
  body?: { data?: string }
  parts?: GmailMessagePart[]
  headers?: GmailHeader[]
}

interface GmailMessagePayload {
  headers?: GmailHeader[]
  parts?: GmailMessagePart[]
  body?: { data?: string }
  mimeType?: string
}

interface GmailMessageResource {
  id?: string
  threadId?: string
  snippet?: string
  internalDate?: string
  labelIds?: string[]
  payload?: GmailMessagePayload
}

interface GmailListMessageRef {
  id?: string
  threadId?: string
}

interface GmailListResponse {
  messages?: GmailListMessageRef[]
  nextPageToken?: string
}

interface GmailDraftResource {
  id?: string
  message?: GmailMessageResource
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

function headerValue(
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

function fullFromResource(r: GmailMessageResource): GmailMessageFull {
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

function metaFromResource(r: GmailMessageResource): GmailMessageMeta {
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
function encodeGmailBase64Url(s: string): string {
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
 * Thrown when a header-field input contains CR / LF / NUL bytes that
 * would let the caller inject arbitrary RFC 5322 headers (extra Bcc,
 * From-spoof, attachments) into the raw MIME before drafts.create.
 *
 * The Tier 1 Core does not send mail, but the same `buildRawMessage`
 * primitive will be inherited by the Tier 2 paid Email-Private Core's
 * send path — sanitising at the MIME-build layer kills the injection
 * surface for both Cores in one place. Argus r1 BLOCKING.
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

export function buildGoogleGmailClient(
  options: GoogleGmailClientOptions,
): GmailClient {
  const baseUrl =
    options.baseUrl ?? 'https://gmail.googleapis.com/gmail/v1/users/me'
  const f: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init))

  async function authHeaders(): Promise<Record<string, string>> {
    const token = await options.accessToken()
    if (token === null) throw new OAuthMissingError()
    return { Authorization: `Bearer ${token}` }
  }

  async function call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    options: {
      message_id_for_not_found?: string
      thread_id_for_not_found?: string
    } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = await authHeaders()
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const init: RequestInit = {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }
    const res = await f(`${baseUrl}${path}`, init)
    if (res.status === 204) return null
    if (!res.ok) {
      // 404 on a single-message endpoint maps to MessageNotFoundError
      // so callers branch on the typed error consistently across the
      // in-memory and Google backends. List endpoints never map 404
      // — a 404 on `messages.list` (e.g. unknown user) is a generic
      // API error.
      if (res.status === 404 && options.message_id_for_not_found !== undefined) {
        throw new MessageNotFoundError(options.message_id_for_not_found)
      }
      if (res.status === 404 && options.thread_id_for_not_found !== undefined) {
        throw new ThreadNotFoundError(options.thread_id_for_not_found)
      }
      const text = await res.text().catch(() => '')
      throw new GoogleGmailApiError(res.status, text)
    }
    return res.json()
  }

  async function fetchFull(message_id: string): Promise<GmailMessageFull> {
    const raw = (await call(
      'GET',
      `/messages/${encodeURIComponent(message_id)}?format=full`,
      undefined,
      { message_id_for_not_found: message_id },
    )) as GmailMessageResource
    return fullFromResource(raw)
  }

  return {
    async listMessages(input: GmailListInput): Promise<GmailListResult> {
      const limit = input.max_results ?? DEFAULT_LIST_LIMIT
      const label = input.label ?? DEFAULT_LABEL
      const params = new URLSearchParams()
      params.append('labelIds', label)
      // Gmail accepts multiple `labelIds` query parameters and AND-s
      // them server-side. Adding the per-project label intersects the
      // inbox label with the project label.
      if (input.project_id !== undefined) {
        params.append('labelIds', projectLabelName(input.project_id))
      }
      params.set('maxResults', String(limit))
      if (input.page_token !== undefined) {
        params.set('pageToken', input.page_token)
      }
      const raw = (await call(
        'GET',
        `/messages?${params.toString()}`,
      )) as GmailListResponse
      const refs = raw.messages ?? []
      // Gmail's `messages.list` returns ONLY (id, threadId) refs —
      // no headers, no snippet. To populate the Core's full
      // GmailMessageMeta shape we have to GET each message
      // individually with `format=metadata` (which returns headers
      // + snippet + internalDate + labels but NOT bodies). One
      // round-trip per result up to `limit`.
      //
      // For Tier 1 we accept the N+1 cost — list payloads are
      // typically small (< 25 messages) and the latency hit is
      // ~150ms per round-trip. A batch GET endpoint would help; we
      // defer it to a follow-up sprint when the surface needs it.
      const results: GmailMessageMeta[] = []
      for (const ref of refs) {
        if (results.length >= limit) break
        if (ref.id === undefined) continue
        const meta = (await call(
          'GET',
          `/messages/${encodeURIComponent(ref.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
        )) as GmailMessageResource
        results.push(metaFromResource(meta))
      }
      // Already newest-first from Gmail (its list is internalDate
      // DESC), but resort for defensiveness — a stable contract
      // beats trusting an upstream ordering invariant we don't own.
      const sorted = [...results].sort((a, b) => {
        const aMs = Date.parse(a.internal_date)
        const bMs = Date.parse(b.internal_date)
        return bMs - aMs
      })
      const result: GmailListResult = { results: sorted }
      if (typeof raw.nextPageToken === 'string' && raw.nextPageToken.length > 0) {
        result.next_page_token = raw.nextPageToken
      }
      return result
    },

    async getMessage(input: GmailGetInput): Promise<GmailMessageFull> {
      return fetchFull(input.message_id)
    },

    async getThread(input: GmailThreadGetInput): Promise<GmailThreadFull> {
      // `users.threads.get?format=full` returns the thread resource
      // with every message's full payload inline — one round-trip for
      // the whole conversation (NO N+1, unlike list/search which only
      // get message refs). 404 maps to ThreadNotFoundError so callers
      // branch on the typed error consistently across backends.
      const raw = (await call(
        'GET',
        `/threads/${encodeURIComponent(input.thread_id)}?format=full`,
        undefined,
        { thread_id_for_not_found: input.thread_id },
      )) as { id?: string; messages?: GmailMessageResource[] }
      const msgs = (raw.messages ?? []).map((m) => fullFromResource(m))
      if (msgs.length === 0) throw new ThreadNotFoundError(input.thread_id)
      return assembleThread(raw.id ?? input.thread_id, msgs)
    },

    async search(input: GmailSearchInput): Promise<GmailListResult> {
      const limit = input.max_results ?? DEFAULT_LIST_LIMIT
      const q =
        input.project_id !== undefined
          ? `${input.query} label:${projectLabelName(input.project_id)}`
          : input.query
      const params = new URLSearchParams({
        q,
        maxResults: String(limit),
      })
      const raw = (await call(
        'GET',
        `/messages?${params.toString()}`,
      )) as GmailListResponse
      const refs = raw.messages ?? []
      const results: GmailMessageMeta[] = []
      for (const ref of refs) {
        if (results.length >= limit) break
        if (ref.id === undefined) continue
        const meta = (await call(
          'GET',
          `/messages/${encodeURIComponent(ref.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
        )) as GmailMessageResource
        results.push(metaFromResource(meta))
      }
      const sorted = [...results].sort((a, b) => {
        const aMs = Date.parse(a.internal_date)
        const bMs = Date.parse(b.internal_date)
        return bMs - aMs
      })
      return { results: sorted }
    },

    async createDraft(input: GmailDraftInput): Promise<GmailDraftResult> {
      // For reply drafts we need BOTH the source message's RFC
      // `Message-ID` header (to populate In-Reply-To + References in
      // the raw MIME) AND the source message's Gmail `threadId` (to
      // attach the draft to the existing conversation server-side).
      let inReplyTo: string | undefined
      let sourceThreadId: string | undefined
      if (input.reply_to_message_id !== undefined) {
        const raw = (await call(
          'GET',
          `/messages/${encodeURIComponent(input.reply_to_message_id)}?format=metadata&metadataHeaders=Message-ID`,
          undefined,
          { message_id_for_not_found: input.reply_to_message_id },
        )) as GmailMessageResource
        const headers = raw.payload?.headers ?? []
        inReplyTo = headerValue(headers, 'Message-ID')
        if (typeof raw.threadId === 'string' && raw.threadId.length > 0) {
          sourceThreadId = raw.threadId
        }
      }
      const rawMessage = buildRawMessage({
        to: input.to,
        subject: input.subject,
        body: input.body,
        ...(input.cc !== undefined ? { cc: input.cc } : {}),
        ...(inReplyTo !== undefined ? { in_reply_to: inReplyTo } : {}),
      })
      const payload = {
        message: {
          raw: encodeGmailBase64Url(rawMessage),
          ...(sourceThreadId !== undefined ? { threadId: sourceThreadId } : {}),
        },
      }
      const raw = (await call('POST', '/drafts', payload)) as GmailDraftResource
      const message_id = raw.message?.id ?? ''
      const thread_id = raw.message?.threadId ?? ''
      const draft_id = raw.id ?? ''
      // owner 4-point: atomically apply INBOX + IMPORTANT + UNREAD to
      // the draft's thread via users.threads.modify. When
      // project_id is supplied, ALSO resolve / create the
      // Neutron/<project_id> user-label and apply that too.
      //
      // If threads.modify fails, throw DraftLabelingError with the
      // orphaned draft_id so the caller can retry idempotently —
      // threads.modify with the same addLabelIds is a no-op when the
      // labels are already present.
      const addLabels: string[] = [...DEFAULT_DRAFT_LABEL_IDS]
      if (input.project_id !== undefined) {
        // Resolve / create the per-project label before the modify
        // call; threads.modify wants a label_id, NOT a label_name.
        // Idempotent.
        const ensure = await ensureLabelImpl(input.project_id)
        addLabels.push(ensure.label_id)
      }
      try {
        const modify = (await call(
          'POST',
          `/threads/${encodeURIComponent(thread_id)}/modify`,
          { addLabelIds: addLabels },
        )) as { id?: string; labelIds?: string[] }
        // Build the human-readable applied_labels echo. For the
        // 3-base labels we return their literal ids; the project
        // label rides in via the resolved Gmail label_id so the
        // applied_labels list reflects EXACTLY what landed on the
        // thread.
        const applied = modify.labelIds ?? addLabels
        // Filter to the labels we explicitly asked for (drops any
        // user-set labels Gmail returned alongside).
        const echoed = addLabels.filter((l) => applied.includes(l))
        return {
          draft_id,
          message_id,
          thread_id,
          applied_labels: echoed,
        }
      } catch (err) {
        const underlying = err instanceof Error ? err : new Error(String(err))
        throw new DraftLabelingError(draft_id, thread_id, message_id, underlying)
      }
    },

    async sendMessage(input: GmailSendInput): Promise<GmailSendResult> {
      // Mirror the draft path's reply handling: resolve the source
      // message's RFC Message-ID (for In-Reply-To/References) + Gmail
      // threadId so the sent message threads onto the conversation.
      let inReplyTo: string | undefined
      let sourceThreadId: string | undefined
      if (input.reply_to_message_id !== undefined) {
        const src = (await call(
          'GET',
          `/messages/${encodeURIComponent(input.reply_to_message_id)}?format=metadata&metadataHeaders=Message-ID`,
          undefined,
          { message_id_for_not_found: input.reply_to_message_id },
        )) as GmailMessageResource
        const headers = src.payload?.headers ?? []
        inReplyTo = headerValue(headers, 'Message-ID')
        if (typeof src.threadId === 'string' && src.threadId.length > 0) {
          sourceThreadId = src.threadId
        }
      }
      const rawMessage = buildRawMessage({
        to: input.to,
        subject: input.subject,
        body: input.body,
        ...(input.cc !== undefined ? { cc: input.cc } : {}),
        ...(inReplyTo !== undefined ? { in_reply_to: inReplyTo } : {}),
      })
      const sendPayload = {
        raw: encodeGmailBase64Url(rawMessage),
        ...(sourceThreadId !== undefined ? { threadId: sourceThreadId } : {}),
      }
      const sent = (await call('POST', '/messages/send', sendPayload)) as GmailMessageResource
      const message_id = sent.id ?? ''
      const thread_id = sent.threadId ?? ''
      // Apply the owner visibility labels (INBOX + IMPORTANT + UNREAD,
      // + Neutron/<project_id> when supplied) to the sent thread so the
      // conversation surfaces in the owner's inbox — the send-path
      // counterpart to the 4-point draft policy. On failure throw
      // DraftLabelingError carrying the sent message id for idempotent
      // retry.
      const addLabels: string[] = [...DEFAULT_DRAFT_LABEL_IDS]
      if (input.project_id !== undefined) {
        const ensure = await ensureLabelImpl(input.project_id)
        addLabels.push(ensure.label_id)
      }
      try {
        const modify = (await call(
          'POST',
          `/threads/${encodeURIComponent(thread_id)}/modify`,
          { addLabelIds: addLabels },
        )) as { id?: string; labelIds?: string[] }
        const applied = modify.labelIds ?? addLabels
        const echoed = addLabels.filter((l) => applied.includes(l))
        return { message_id, thread_id, applied_labels: echoed }
      } catch (err) {
        const underlying = err instanceof Error ? err : new Error(String(err))
        throw new DraftLabelingError(message_id, thread_id, message_id, underlying)
      }
    },

    async ensureProjectLabel(
      input: GmailLabelEnsureInput,
    ): Promise<GmailLabelEnsureResult> {
      return ensureLabelImpl(input.project_id)
    },

    async modifyThread(
      input: GmailThreadModifyInput,
    ): Promise<GmailThreadModifyResult> {
      const body: Record<string, unknown> = {
        addLabelIds: [...input.add_label_ids],
      }
      if (input.remove_label_ids !== undefined && input.remove_label_ids.length > 0) {
        body['removeLabelIds'] = [...input.remove_label_ids]
      }
      const raw = (await call(
        'POST',
        `/threads/${encodeURIComponent(input.thread_id)}/modify`,
        body,
      )) as { id?: string; labelIds?: string[] }
      return {
        thread_id: input.thread_id,
        label_ids: raw.labelIds ?? [...input.add_label_ids],
      }
    },
  }

  /**
   * Resolve the Gmail user-label `Neutron/<project_id>` to its
   * Gmail-side `Label_*` id; create the label via
   * `users.labels.create` if it doesn't exist. Idempotent — Gmail
   * returns 409 / 400 on duplicate name, in which case we list
   * labels and find the existing one.
   */
  async function ensureLabelImpl(project_id: string): Promise<GmailLabelEnsureResult> {
    const labelName = projectLabelName(project_id)
    // Try create first (one round-trip when the label is new). On
    // duplicate, fall back to list + match.
    try {
      const created = (await call('POST', '/labels', {
        name: labelName,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
      })) as { id?: string; name?: string }
      if (typeof created.id === 'string' && created.id.length > 0) {
        return { label_id: created.id, label_name: labelName, created: true }
      }
    } catch (err) {
      if (
        !(err instanceof GoogleGmailApiError) ||
        // Gmail returns 409 Conflict OR 400 with "Label name exists or
        // conflicts" — both are "already exists" signals.
        (err.http_status !== 409 && err.http_status !== 400)
      ) {
        throw err
      }
      // fall through to list-and-match
    }
    const listed = (await call('GET', '/labels')) as {
      labels?: Array<{ id?: string; name?: string }>
    }
    for (const l of listed.labels ?? []) {
      if (l.name === labelName && typeof l.id === 'string' && l.id.length > 0) {
        return { label_id: l.id, label_name: labelName, created: false }
      }
    }
    throw new GoogleGmailApiError(
      500,
      `failed to resolve or create gmail label ${labelName}`,
    )
  }
}

/**
 * Structured email summary shape — what `email_summarize` returns.
 *
 * Why structured and not free-form prose: the Core's downstream
 * consumers (launcher's inbox triage UI, "is this important"
 * batch flows, planner reminders) need stable fields they can route
 * on. A free-form summary would force every consumer to re-extract
 * intent / urgency / ask-or-response, defeating the point of
 * pre-summarisation. Future LLM passes can layer prose on top of
 * this structured base.
 */
export interface EmailSummary {
  message_id: string
  from: string
  subject: string
  key_points: string[]
  sentiment: 'positive' | 'neutral' | 'negative' | 'urgent'
  ask_or_response: 'ask' | 'response' | 'informational'
}

/**
 * Pluggable LLM caller for email summarization. The Core's tool
 * layer composes this with `GmailClient.getMessage` — fetch the full
 * body, hand it to the summarizer, return the structured object.
 *
 * Production: `buildSubstrateEmailSummarizer(...)` dispatches against
 * the gateway's `Substrate` (Haiku 4.5 default per CLAUDE.md
 * "default to the latest and most capable Claude models" + the
 * sprint roadmap's "cheap, fast" guidance — pricing $1/MTok input
 * / $5/MTok output). Tests use `buildStubEmailSummarizer(...)`,
 * which returns a deterministic shape so the test suite never reaches
 * an LLM. Wiring the substrate-backed implementation is a runtime
 * composition concern that lands when the gateway boots this Core;
 * the abstraction lives in the Core so the tool layer doesn't depend
 * on substrate internals.
 */
export interface EmailSummarizer {
  summarize(input: { message: GmailMessageFull }): Promise<EmailSummary>
}

/**
 * Deterministic stub summarizer. The body-derived fields are
 * computed by extremely cheap heuristics:
 *
 * - `key_points` — the first 3 sentences of `body_text` (split on
 *   `.`/`!`/`?`), trimmed, empty entries dropped.
 * - `sentiment` — `urgent` when the body contains any of
 *   {urgent, asap, immediately, deadline} (case-insensitive),
 *   `negative` for {issue, problem, fail, broken, sorry}, `positive`
 *   for {thanks, great, congrats, awesome, glad}, otherwise
 *   `neutral`.
 * - `ask_or_response` — `ask` when body ends with `?` or contains
 *   `please` / `could you` / `can you`, `response` when body opens
 *   with `Re:` (subject line) or `yes,` / `no,`, otherwise
 *   `informational`.
 *
 * The stub exists so tests can assert structural shape without
 * pulling in a substrate. Production summarisation lives in
 * `buildSubstrateEmailSummarizer` (deferred — wired at gateway-
 * composition time). Both implementations conform to the
 * `EmailSummarizer` interface.
 */
export function buildStubEmailSummarizer(): EmailSummarizer {
  function classifySentiment(body: string): EmailSummary['sentiment'] {
    const lower = body.toLowerCase()
    if (/\b(urgent|asap|immediately|deadline)\b/.test(lower)) return 'urgent'
    if (/\b(issue|problem|fail|broken|sorry)\b/.test(lower)) return 'negative'
    if (/\b(thanks|great|congrats|awesome|glad)\b/.test(lower)) return 'positive'
    return 'neutral'
  }

  function classifyAskOrResponse(
    body: string,
    subject: string,
  ): EmailSummary['ask_or_response'] {
    const lower = body.toLowerCase()
    if (/\b(please|could you|can you)\b/.test(lower)) return 'ask'
    if (body.trim().endsWith('?')) return 'ask'
    if (subject.startsWith('Re:')) return 'response'
    if (/^(yes|no)[,.]/i.test(body.trim())) return 'response'
    return 'informational'
  }

  function extractKeyPoints(body: string): string[] {
    const sentences = body
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    return sentences.slice(0, 3)
  }

  return {
    async summarize(input): Promise<EmailSummary> {
      return {
        message_id: input.message.id,
        from: input.message.from,
        subject: input.message.subject,
        key_points: extractKeyPoints(input.message.body_text),
        sentiment: classifySentiment(input.message.body_text),
        ask_or_response: classifyAskOrResponse(
          input.message.body_text,
          input.message.subject,
        ),
      }
    },
  }
}
