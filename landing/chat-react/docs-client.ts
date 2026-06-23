/**
 * landing/chat-react — web DOCUMENTS API client (WAVE 3 PR-5).
 *
 * The web twin of the mobile `app/lib/docs-client.ts`. A thin fetch wrapper for
 * the gateway's project-scoped docs + inline-comments surface
 * (`gateway/http/app-docs-surface.ts`):
 *
 *   GET  /api/app/projects/<id>/docs/tree                       → list docs + folders
 *   GET  /api/app/projects/<id>/docs/file?path=<rel>            → read a markdown file
 *   PUT  /api/app/projects/<id>/docs/file                       → write a markdown file (PR-6)
 *   GET  /api/app/projects/<id>/docs/comments?path=<rel>        → list threads on a doc
 *   GET  /api/app/projects/<id>/docs/comments/<id>/thread       → one thread tree
 *   POST /api/app/projects/<id>/docs/comments                   → post a root comment
 *   POST /api/app/projects/<id>/docs/comments/<id>/reply        → reply to a thread
 *   POST /api/app/projects/<id>/docs/comments/<id>/resolve      → resolve a thread
 *   POST /api/app/projects/<id>/docs/comments/<id>/escalate     → escalate to chat
 *
 * WAVE 3 keeps the FILESYSTEM as the source of truth for doc bodies — there is
 * no new `documents` table; the web Documents tab reads, edits + comments over
 * these EXISTING handlers. PR-6 added `writeFile` (edit parity with mobile).
 *
 * ── comments_unavailable gate (plan §5 VERIFY) ──────────────────────────────
 * The comments substrate is OPTIONAL on the gateway: when it isn't wired the
 * four `/docs/comments…` routes return `503 comments_unavailable`
 * (`app-docs-surface.ts:193`). The web client treats that as a first-class,
 * NON-error state: `listComments` returns `{ unavailable: true, threads: [] }`
 * so the Documents tab can still list + view docs and simply hide the comment
 * affordances, instead of surfacing a scary error toast. Every mutating comment
 * call rethrows `comments_unavailable` as a typed `DocsClientError` the UI can
 * match on.
 *
 * Wire shapes mirror the gateway types byte-for-byte but are re-declared here
 * (rather than imported across the workspace boundary) so the browser bundle
 * stays free of a gateway dependency — the same convention the sibling
 * `tabs-client.ts` follows. Pure given an injected `fetchImpl`, so it
 * unit-tests without a DOM or a live server.
 */

/* ─── wire types (mirror gateway/http/doc-store.ts + comment-store.ts) ─── */

export type DocTreeKind = 'file' | 'folder' | 'binary'
export type DocTreeFolderOrigin = 'markdown' | 'binary'

export interface DocTreeNode {
  kind: DocTreeKind
  /** Relative path from the project's docs root. POSIX separators. */
  path: string
  /** Basename — last segment of `path`. */
  name: string
  size_bytes: number | null
  modified_at: number | null
  content_type: string | null
  referenced_by_count: number | null
  origin: DocTreeFolderOrigin | null
  children: DocTreeNode[]
}

export interface DocFile {
  path: string
  content: string
  size_bytes: number
  modified_at: number
}

/** Result of a successful `writeFile` — the server-authoritative post-write
 *  stat. `modified_at` becomes the next OCC baseline for a follow-up edit. */
export interface WriteResult {
  path: string
  size_bytes: number
  modified_at: number
}

export type CommentEventKind =
  | 'comment_posted'
  | 'anchor_relocated'
  | 'anchor_drifted'
  | 'anchor_dead'
  | 'escalate_to_chat'
  | 'agent_reply_skipped'
  | 'comment_resolved'

export type CommentAuthorKind = 'user' | 'agent' | 'system'
export type AnchorStatus = 'live' | 'drifted' | 'dead'

export interface CommentEvent {
  event_id: string
  event_kind: CommentEventKind
  doc_path: string
  thread_root_id: string | null
  parent_event_id: string | null
  anchor_start: number | null
  anchor_end: number | null
  anchor_text_excerpt: string | null
  anchor_ctx_before: string | null
  anchor_ctx_after: string | null
  based_on_modified_at: number | null
  author_kind: CommentAuthorKind
  author_id: string
  body: string | null
  metadata_json: string | null
  created_at: number
}

export interface ThreadSummary {
  thread_root_id: string
  doc_path: string
  anchor: {
    current_start: number | null
    current_end: number | null
    status: AnchorStatus
    drift_hint_start: number | null
    drift_hint_end: number | null
    excerpt: string | null
  }
  root: CommentEvent
  reply_count: number
  last_reply_at: number
  latest_event_kind?: CommentEventKind | null
}

export interface ThreadTree {
  root: CommentEvent
  anchor: {
    thread_root_id: string
    doc_path: string
    current_start: number | null
    current_end: number | null
    status: AnchorStatus
    drift_hint_start: number | null
    drift_hint_end: number | null
    last_rebuilt_from: string
    last_rebuilt_at: number
    reply_count: number
    last_reply_at: number
  }
  replies: CommentEvent[]
}

/** Byte caps enforced by the gateway (`comment-store.ts`). Kept in sync so the
 *  client clamps anchors BEFORE the round-trip rather than eating a 413. */
export const MAX_COMMENT_BODY_BYTES = 8 * 1024
export const MAX_ANCHOR_EXCERPT_BYTES = 1024
export const MAX_ANCHOR_CTX_BYTES = 256

/* ─── client ─── */

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export interface DocsClientOptions {
  /** Page origin (`https://host`); the surface lives at `/api/app/...`. */
  base_url: string
  /** App-ws bearer token (`config.token`). */
  token: string
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: FetchImpl
}

export class DocsClientError extends Error {
  readonly code: string
  readonly status: number
  /** Present on a `doc_changed_underfoot` / conflict 409. */
  readonly current_modified_at: number | null
  constructor(code: string, message: string, status: number, current_modified_at: number | null = null) {
    super(`${code}: ${message}`)
    this.name = 'DocsClientError'
    this.code = code
    this.status = status
    this.current_modified_at = current_modified_at
  }
}

interface TreeResponse {
  ok: boolean
  tree: DocTreeNode[]
  file_count: number
}
interface FileResponse {
  ok: boolean
  file: DocFile
}
interface WriteResponse {
  ok: boolean
  file: WriteResult
}
interface CommentsListResponse {
  ok: boolean
  threads: ThreadSummary[]
  next_cursor: string | null
}
interface CommentsPostResponse {
  ok: boolean
  event: CommentEvent
  thread_root_id: string
}
interface CommentsThreadResponse {
  ok: boolean
  thread: ThreadTree
}
interface ErrorBody {
  ok?: boolean
  code?: string
  message?: string
  current_modified_at?: number
}

/** Result of `listComments` — when the gateway has no comment substrate wired
 *  (`503 comments_unavailable`) this surfaces `unavailable: true` so the
 *  Documents tab degrades to list+view gracefully instead of erroring. */
export interface ListCommentsResult {
  threads: ThreadSummary[]
  next_cursor: string | null
  /** True when the gateway returned `503 comments_unavailable`. */
  unavailable: boolean
}

/** Anchor payload for a root comment, already clamped to the gateway's byte
 *  caps. Built from a raw-content text selection by {@link buildAnchor}. */
export interface AnchorInput {
  anchor_start: number
  anchor_end: number
  anchor_text_excerpt: string
  anchor_ctx_before: string
  anchor_ctx_after: string
  based_on_modified_at: number
}

export class WebDocsClient {
  private readonly base_url: string
  private readonly token: string
  private readonly fetchImpl: FetchImpl

  constructor(opts: DocsClientOptions) {
    this.base_url = opts.base_url.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  /** List every doc + folder under the project's docs root. */
  async tree(project_id: string): Promise<{ tree: DocTreeNode[]; file_count: number }> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/tree`
    const res = await this.req<TreeResponse>(path)
    return { tree: res.tree, file_count: res.file_count }
  }

  /** Read one markdown file's content (server-authoritative `modified_at`). */
  async readFile(project_id: string, rel_path: string): Promise<DocFile> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/file?path=${encodeURIComponent(rel_path)}`
    const res = await this.req<FileResponse>(path)
    return res.file
  }

  /**
   * Write a markdown file's full content (create or overwrite). Brings the web
   * Documents tab to edit parity with the mobile docs tab (WAVE 3 PR-6) over the
   * EXISTING `PUT .../docs/file` handler — filesystem stays the source of truth.
   *
   * Optimistic-concurrency: pass `expected_modified_at` (the open file's mtime)
   * so a concurrent write loses the race with a `409 doc_changed_underfoot`
   * instead of silently clobbering. The thrown {@link DocsClientError} carries
   * `current_modified_at` so the UI can prompt a reload. Omit it to force-write.
   */
  async writeFile(
    project_id: string,
    input: { path: string; content: string; expected_modified_at?: number },
  ): Promise<WriteResult> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/file`
    const body: Record<string, unknown> = { path: input.path, content: input.content }
    if (input.expected_modified_at !== undefined) {
      body.expected_modified_at = input.expected_modified_at
    }
    const res = await this.req<WriteResponse>(path, { method: 'PUT', body })
    return res.file
  }

  /**
   * List comment threads anchored on a doc. Degrades gracefully when the
   * gateway has no comment substrate: a `503 comments_unavailable` resolves to
   * `{ unavailable: true, threads: [], next_cursor: null }` rather than
   * throwing, so the doc still lists + views.
   */
  async listComments(
    project_id: string,
    doc_path: string,
    opts: { include_dead?: boolean; limit?: number; cursor?: string } = {},
  ): Promise<ListCommentsResult> {
    const params = new URLSearchParams({ path: doc_path })
    if (opts.include_dead === true) params.set('include_dead', 'true')
    if (opts.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts.cursor !== undefined && opts.cursor.length > 0) params.set('cursor', opts.cursor)
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/comments?${params.toString()}`
    try {
      const res = await this.req<CommentsListResponse>(path)
      return { threads: res.threads, next_cursor: res.next_cursor, unavailable: false }
    } catch (err) {
      if (err instanceof DocsClientError && err.code === 'comments_unavailable') {
        return { threads: [], next_cursor: null, unavailable: true }
      }
      throw err
    }
  }

  /** Fetch one thread's full reply tree. */
  async getThread(project_id: string, event_id: string): Promise<ThreadTree> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/comments/${encodeURIComponent(event_id)}/thread`
    const res = await this.req<CommentsThreadResponse>(path)
    return res.thread
  }

  /** Post a NEW root comment anchored to a text selection in the doc. */
  async postComment(
    project_id: string,
    doc_path: string,
    body: string,
    anchor: AnchorInput,
  ): Promise<{ event: CommentEvent; thread_root_id: string }> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/comments`
    const res = await this.req<CommentsPostResponse>(path, {
      method: 'POST',
      body: {
        path: doc_path,
        body,
        anchor_start: anchor.anchor_start,
        anchor_end: anchor.anchor_end,
        anchor_text_excerpt: anchor.anchor_text_excerpt,
        anchor_ctx_before: anchor.anchor_ctx_before,
        anchor_ctx_after: anchor.anchor_ctx_after,
        based_on_modified_at: anchor.based_on_modified_at,
      },
    })
    return { event: res.event, thread_root_id: res.thread_root_id }
  }

  /** Reply to an existing thread (anchor inherited from the parent). */
  async replyToComment(
    project_id: string,
    event_id: string,
    body: string,
  ): Promise<{ event: CommentEvent; thread_root_id: string }> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/comments/${encodeURIComponent(event_id)}/reply`
    const res = await this.req<CommentsPostResponse>(path, { method: 'POST', body: { body } })
    return { event: res.event, thread_root_id: res.thread_root_id }
  }

  /** Mark a thread resolved (moves it to the muted "Resolved" group). */
  async resolveComment(
    project_id: string,
    thread_root_id: string,
  ): Promise<{ resolve_event_id: string; resolved_at: number }> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/comments/${encodeURIComponent(thread_root_id)}/resolve`
    const res = await this.req<{ ok: boolean; resolve_event_id: string; resolved_at: number }>(path, {
      method: 'POST',
      body: {},
    })
    return { resolve_event_id: res.resolve_event_id, resolved_at: res.resolved_at }
  }

  /** Escalate a thread into the project's chat surface. */
  async escalateToChat(
    project_id: string,
    event_id: string,
    note?: string,
  ): Promise<{ escalate_event_id: string; escalated_at: number }> {
    const path = `/api/app/projects/${encodeURIComponent(project_id)}/docs/comments/${encodeURIComponent(event_id)}/escalate`
    const body: Record<string, unknown> = {}
    if (note !== undefined && note.length > 0) body.note = note
    const res = await this.req<{ ok: boolean; escalate_event_id: string; escalated_at: number }>(path, {
      method: 'POST',
      body,
    })
    return { escalate_event_id: res.escalate_event_id, escalated_at: res.escalated_at }
  }

  private async req<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const method = init.method ?? 'GET'
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` }
    let body: string | undefined
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(init.body)
    }
    let res: Response
    try {
      res = await this.fetchImpl(`${this.base_url}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
      })
    } catch (err) {
      throw new DocsClientError('network', err instanceof Error ? err.message : 'network error', 0)
    }
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      // fall through to the status-coded error below
    }
    if (!res.ok) {
      const errBody = (json ?? {}) as ErrorBody
      const code = errBody.code ?? 'request_failed'
      const message = errBody.message ?? `HTTP ${res.status}`
      const current =
        typeof errBody.current_modified_at === 'number' ? errBody.current_modified_at : null
      throw new DocsClientError(code, message, res.status, current)
    }
    return json as T
  }
}

/* ─── pure helpers ─── */

/**
 * Flatten a doc tree into an ordered list of MARKDOWN file leaves (folders +
 * binaries dropped). Folder order is preserved depth-first so the list reads
 * top-to-bottom like the tree. Used by the Documents tab's flat doc list.
 */
export function flattenDocFiles(nodes: readonly DocTreeNode[]): DocTreeNode[] {
  const out: DocTreeNode[] = []
  const walk = (ns: readonly DocTreeNode[]): void => {
    for (const n of ns) {
      if (n.kind === 'file') out.push(n)
      else if (n.kind === 'folder') walk(n.children)
      // binary leaves are not viewable as docs — skip
    }
  }
  walk(nodes)
  return out
}

/** Truncate `s` so its UTF-8 encoding is at most `maxBytes`, keeping whole code
 *  points. Trims from the END (keep-head) by default, or the START (keep-tail)
 *  when `keepTail` is set — used so ctx_before keeps the chars CLOSEST to the
 *  selection. */
export function clampUtf8(s: string, maxBytes: number, keepTail = false): string {
  if (byteLength(s) <= maxBytes) return s
  const chars = Array.from(s)
  if (keepTail) {
    let bytes = 0
    let i = chars.length
    while (i > 0) {
      const next = byteLength(chars[i - 1] as string)
      if (bytes + next > maxBytes) break
      bytes += next
      i -= 1
    }
    return chars.slice(i).join('')
  }
  let bytes = 0
  let i = 0
  while (i < chars.length) {
    const next = byteLength(chars[i] as string)
    if (bytes + next > maxBytes) break
    bytes += next
    i += 1
  }
  return chars.slice(0, i).join('')
}

/** UTF-8 byte length of a string. `TextEncoder` is present in browsers + Bun. */
export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

/**
 * Build a clamped root-comment anchor from a raw-content character selection.
 * Offsets are computed against the file's RAW content (the same bytes the
 * gateway re-anchors against), so the web viewer MUST present selectable raw
 * markdown for these offsets to stay honest.
 *
 * - excerpt = content[start, end), capped to 1024 bytes
 * - ctx_before = up to 256 bytes immediately before `start` (keep-tail)
 * - ctx_after  = up to 256 bytes immediately after `end`
 * - based_on_modified_at = the open file's mtime (the OCC baseline)
 *
 * Returns null for a collapsed / inverted selection — the caller disables the
 * "Comment" affordance in that case.
 */
export function buildAnchor(
  content: string,
  start: number,
  end: number,
  modified_at: number,
): AnchorInput | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  const lo = Math.max(0, Math.min(start, content.length))
  const hi = Math.max(0, Math.min(end, content.length))
  if (hi <= lo) return null
  const excerptRaw = content.slice(lo, hi)
  if (excerptRaw.trim().length === 0) return null
  const excerpt = clampUtf8(excerptRaw, MAX_ANCHOR_EXCERPT_BYTES)
  // Excerpt was clamped from the END, so the effective anchor end shrinks to
  // match what we actually send (keeps anchor_end consistent with the excerpt).
  const effectiveEnd = lo + excerpt.length
  const ctxBefore = clampUtf8(content.slice(0, lo), MAX_ANCHOR_CTX_BYTES, true)
  const ctxAfter = clampUtf8(content.slice(effectiveEnd), MAX_ANCHOR_CTX_BYTES)
  return {
    anchor_start: lo,
    anchor_end: effectiveEnd,
    anchor_text_excerpt: excerpt,
    anchor_ctx_before: ctxBefore,
    anchor_ctx_after: ctxAfter,
    based_on_modified_at: modified_at,
  }
}
