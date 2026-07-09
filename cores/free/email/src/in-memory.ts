/**
 * @neutronai/email-managed-core — in-memory GmailClient fakes.
 *
 * Both reference fakes split out of `backend.ts` (D5):
 * `buildInMemoryGmailClient` and the seedable
 * `buildSeededInMemoryGmailClient`. Tests never hit the real Gmail
 * API — every Core test exercises the full tool wiring against these.
 * The fakes mirror the production wrapper method-for-method,
 * including `sendMessage`'s shared header-injection guard (see the
 * backend.ts header for the surface design notes).
 */

import { randomUUID } from 'node:crypto'

import {
  DEFAULT_DRAFT_LABEL_IDS,
  projectLabelName,
} from './manifest.ts'

import {
  DEFAULT_LABEL,
  DEFAULT_LIST_LIMIT,
  assembleThread,
  epochMsToIso,
} from './contract.ts'
import type {
  GmailClient,
  GmailDraftInput,
  GmailDraftResult,
  GmailGetInput,
  GmailLabelEnsureInput,
  GmailLabelEnsureResult,
  GmailListInput,
  GmailListResult,
  GmailMessageFull,
  GmailMessageMeta,
  GmailSearchInput,
  GmailSendInput,
  GmailSendResult,
  GmailThreadFull,
  GmailThreadGetInput,
  GmailThreadModifyInput,
  GmailThreadModifyResult,
} from './contract.ts'
import { MessageNotFoundError, ThreadNotFoundError } from './errors.ts'
import { buildRawMessage } from './mime.ts'

interface InMemoryGmailClientOptions {
  /** Id minter override for tests that need deterministic ids. */
  nextId?: () => string
  /** Wall-clock override for deterministic internal_date stamping. */
  now?: () => number
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
