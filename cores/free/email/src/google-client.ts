/**
 * @neutronai/email-managed-core — production Gmail v1 REST client.
 *
 * Split out of `backend.ts` (D5). See the doc block on
 * `buildGoogleGmailClient`'s preamble below for the endpoint surface
 * + v1 limitations.
 */

import {
  DEFAULT_DRAFT_LABEL_IDS,
  projectLabelName,
} from './manifest.ts'

import {
  DEFAULT_LABEL,
  DEFAULT_LIST_LIMIT,
  assembleThread,
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
import {
  DraftLabelingError,
  GoogleGmailApiError,
  MessageNotFoundError,
  OAuthMissingError,
  ThreadNotFoundError,
} from './errors.ts'
import {
  buildRawMessage,
  encodeGmailBase64Url,
  fullFromResource,
  headerValue,
  metaFromResource,
} from './mime.ts'
import type { GmailMessageResource } from './mime.ts'

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
 * - Send IS supported: `messages.send` (the `email_send` tool),
 *   alongside drafts.create. See manifest.ts for the scope grant
 *   (incl. gmail.send).
 */
export type FetchLike = (
  input: URL | Request | string,
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
