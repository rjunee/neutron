/**
 * @neutronai/gateway/comments — per-project comments sidecar (P7.2 S1 + S2).
 *
 * Per docs/plans/P7.2-inline-comments-sprint-brief.md § 3 / § 4.
 *
 * Wraps a per-project SQLite sidecar at
 *   `<owner_home>/Projects/<project_id>/.comments/comments.db`
 * with `appendEvent` / `listThreads` / `getThread` / `materialise`.
 *
 * Why a sidecar (per brief § 0.1, Sam locked 2026-05-20):
 *   - Project delete is `rm -rf <project>/` — the comment history goes
 *     with it, no foreign-key cleanup pass.
 *   - The comment write-rate is bursty + project-scoped, so isolating
 *     it from the cross-cutting `project.db` means heavy commenting on
 *     one project never contends on the busy-retry mutex with reminder
 *     ticks.
 *   - Matches the Tier 1 Core sidecar convention.
 *
 * S2 adds the re-anchor walker substrate:
 *   - `listWalkerAnchors(project_id, doc_path)` returns the live /
 *     drifted anchor rows for a path, joined with the originating
 *     `comment_posted` event's excerpt + context window so the walker
 *     can call `relocateAnchor` without a second round-trip.
 *   - `materialiseForPath` now walks events by THREAD-ROOT chain (not
 *     strictly by doc_path) so a `moveDoc` that emits
 *     `anchor_relocated` with `to_doc_path` correctly moves the
 *     materialised anchor row to the new path.
 *   - `appendEvent` stays the single write surface — walker events
 *     land with `author_kind='system'` / `author_id='reanchor-walker'`
 *     and no body, exactly like comment events but with the anchor_*
 *     event_kind and the walker's metadata payload.
 *
 * S1 anchors are STATIC at write time — `appendEvent` stores the
 * `anchor_start / anchor_end / anchor_text_excerpt / anchor_ctx_before
 * / anchor_ctx_after / based_on_modified_at` columns as supplied; the
 * S2 walker never mutates those originating rows, it only appends
 * `anchor_*` events. The schema is forward-compatible (§ 3.4).
 *
 * Concurrency: every write is wrapped in `BEGIN IMMEDIATE` so two
 * concurrent appends serialise cleanly even when they target the same
 * thread. ULIDs guarantee unique event_ids without coordination, and
 * the per-event INSERT is atomic.
 */

import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sanitizeProjectId } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import { applyProjectScopedMigrations } from '@neutronai/migrations/runner.ts'
import { openSidecar, resolveNow } from '@neutronai/persistence/index.ts'
import {
  materialiseAnchors,
  type AnchorRow,
  type AnchorStatus,
  type CommentAuthorKind,
  type CommentEventKind,
  type DocCommentEvent,
} from './anchor-materialiser.ts'

// Re-export the materialiser's public types so downstream modules
// (anchor-walker, app-docs-surface, tests) can pull both the store +
// the underlying shapes from a single import. Helps callers stay on
// one canonical entry point.
export type {
  AnchorRow,
  AnchorStatus,
  CommentAuthorKind,
  CommentEventKind,
  DocCommentEvent,
}

const HERE = dirname(fileURLToPath(import.meta.url))

/** Default per-project sidecar dir name (sibling of `.docs-blobs/` /
 *  `.docs-versions/`). The leading dot keeps it invisible to the
 *  docs surface — `validateRelativePath` rejects hidden segments. */
const COMMENTS_DIR = '.comments'
const COMMENTS_DB = 'comments.db'

/** Hard cap on a comment body per § 5.2 ("validate body length cap
 *  (8 KB raw)"). */
export const MAX_COMMENT_BODY_BYTES = 8 * 1024

/** Hard cap on the anchored excerpt — § 4.3 "Excerpt size cap — capped
 *  at 1 KB at write time." */
export const MAX_ANCHOR_EXCERPT_BYTES = 1024

/** Cap on the context window strings — § 5.2 ("256 chars ctx each
 *  side"). The brief recommends ~64 chars; 256 is the hard server
 *  enforcement so clients have headroom. */
export const MAX_ANCHOR_CTX_BYTES = 256

/**
 * Cap on `metadata_json` (Argus r1 MINOR #5). Walker events stamp
 * structured re-anchor metadata (from_start/to_start/lev_distance/
 * search_window/last_known_text/...) here. The largest current
 * payload is `anchor_dead` carrying `last_known_text` (capped at
 * MAX_ANCHOR_EXCERPT_BYTES=1 KB) plus ~256 B of bookkeeping, so 4 KB
 * leaves the schema room to widen forward without rewriting events
 * but keeps a malformed (or malicious) appender from blowing up the
 * row size. CommentStore.appendEvent rejects oversize payloads with
 * a `CommentStoreError` so the surface returns 4xx instead of
 * silently truncating.
 */
export const MAX_METADATA_JSON_BYTES = 4 * 1024

/** Default location of the per-project comments migration tree. The
 *  CommentStore looks here at init time. Tests override via the
 *  constructor option. */
export const DEFAULT_MIGRATIONS_DIR = join(HERE, '..', '..', 'migrations', 'comments')

export class CommentStoreError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CommentStoreError'
    this.code = code
  }
}

export class CommentNotFoundError extends Error {
  readonly code = 'thread_not_found' as const
  constructor(message: string) {
    super(message)
    this.name = 'CommentNotFoundError'
  }
}

export class CommentBodyTooLargeError extends Error {
  readonly code = 'comment_too_large' as const
  constructor(message: string) {
    super(message)
    this.name = 'CommentBodyTooLargeError'
  }
}

/**
 * Input to `appendEvent`. Mirrors the schema; nullable fields stay
 * nullable. The store fills in `event_id` (ULID) + `created_at`
 * (ms-epoch) so callers don't have to.
 */
export interface AppendEventInput {
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
}

export interface AppendEventResult {
  event: DocCommentEvent
  thread_root_id: string
}

/** Summary shape returned by `listThreads` — one row per thread root,
 *  plus a small preview of the root event. */
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
  root: DocCommentEvent
  reply_count: number
  last_reply_at: number
  /**
   * P7.2 S3 — kind of the latest event in this thread (root + every
   * reply, including system events like `comment_resolved`,
   * `agent_reply_skipped`, `escalate_to_chat`, and anchor_*). The
   * side-pane uses this to drive the Resolved tab + the skipped-
   * comment badge so they survive a refetch (Argus r2 BLOCKER 2).
   *
   * Null for rows materialised before the column existed —
   * `materialiseAll(project_id)` repopulates them.
   */
  latest_event_kind: CommentEventKind | null
}

export interface ListThreadsOptions {
  doc_path: string
  include_dead?: boolean
  limit?: number
  /** Pagination cursor — last-reply-at ms epoch from a prior page. The
   *  WHERE predicate is composite: rows where `last_reply_at < cursor`
   *  OR `(last_reply_at = cursor AND thread_root_id < cursor_thread_root_id)`.
   *  Without the secondary key, rows sharing a ms timestamp with the
   *  cursor are silently dropped across pages (Argus r1 IMPORTANT). */
  cursor_last_reply_at?: number
  /** Pagination tie-breaker — thread_root_id from the cursor row. When
   *  omitted but `cursor_last_reply_at` is supplied, the listing
   *  degrades to the pre-fix `STRICTLY_LESS_THAN` behaviour (legacy
   *  clients that only echo the numeric cursor still page, they just
   *  lose the tie-break). */
  cursor_thread_root_id?: string
}

export interface NextCursor {
  last_reply_at: number
  thread_root_id: string
}

export interface ListThreadsResult {
  threads: ThreadSummary[]
  next_cursor: NextCursor | null
}

export interface ThreadTree {
  root: DocCommentEvent
  anchor: AnchorRow
  replies: DocCommentEvent[]
}

/**
 * S2 — walker-facing anchor projection. Returned by
 * `CommentStore.listWalkerAnchors`. The walker calls `relocateAnchor`
 * (in `gateway/comments/anchor-walker.ts`) against each of these to
 * compute a re-anchor result, then appends the corresponding
 * `anchor_*` event via `CommentStore.appendEvent`.
 */
export interface WalkerAnchor {
  thread_root_id: string
  doc_path: string
  status: AnchorStatus
  /** Last known start offset (current_start, falling back to drift_hint_start). */
  previous_start: number
  /** Last known end offset (current_end, falling back to drift_hint_end). */
  previous_end: number
  /** The originating comment's highlighted excerpt. */
  excerpt: string
  /** Up to 256 chars BEFORE the anchor at compose time. */
  ctx_before: string
  /** Up to 256 chars AFTER the anchor at compose time. */
  ctx_after: string
}

export interface CommentStoreOptions {
  /** Absolute path to the per-instance `<owner_home>` dir. */
  owner_home: string
  /** Override per-project root resolution (default:
   *  `<owner_home>/Projects/<project_id>/`). */
  resolveProjectRoot?: (project_id: string) => string
  /** Override the comments migration dir. Defaults to the
   *  `migrations/comments/` tree shipped with the gateway. */
  migrations_dir?: string
  /** Override the ULID factory. Tests inject a deterministic generator
   *  so event_ids are stable. */
  ulid?: () => string
  /** Override the wall clock. Tests inject a monotonic stub so
   *  `created_at` is deterministic. */
  now?: () => number
}

interface ProjectHandle {
  db: Database
  comments_db_path: string
}

export class CommentStore {
  private readonly owner_home: string
  private readonly resolveProjectRoot: (project_id: string) => string
  private readonly migrations_dir: string
  private readonly ulid: () => string
  private readonly now: () => number
  private readonly handles = new Map<string, ProjectHandle>()
  private readonly initPromises = new Map<string, Promise<ProjectHandle>>()

  constructor(opts: CommentStoreOptions) {
    this.owner_home = opts.owner_home
    this.resolveProjectRoot =
      opts.resolveProjectRoot ??
      ((project_id) => join(opts.owner_home, 'Projects', project_id))
    this.migrations_dir = opts.migrations_dir ?? DEFAULT_MIGRATIONS_DIR
    this.ulid = opts.ulid ?? defaultUlid
    this.now = resolveNow(opts.now)
  }

  /** Force-close every per-project DB handle. Useful for tests that
   *  swap fixture roots between cases. */
  closeAll(): void {
    for (const handle of this.handles.values()) {
      try {
        handle.db.close()
      } catch {
        /* ignore */
      }
    }
    this.handles.clear()
    this.initPromises.clear()
  }

  /**
   * Idempotent lazy-init for `<project>/.comments/`. Creates the dir,
   * opens the sidecar SQLite, applies migrations. The
   * `initPromises` cache mirrors the P7.4 `ensureInit` shape so two
   * concurrent first-writes both wait on the same init promise.
   */
  async ensureInit(project_id: string): Promise<void> {
    await this.openHandle(project_id)
  }

  /**
   * Append one event. Returns the canonical row + the thread_root_id
   * the materialiser will project it onto.
   *
   * Server-side guarantees:
   *   - `event_id` is freshly minted (ULID).
   *   - `created_at` is server-clock `Date.now()`.
   *   - Body / excerpt / ctx size caps are enforced.
   *   - When `parent_event_id` is set, the store looks up the parent,
   *     derives the canonical `thread_root_id` (parent's
   *     `thread_root_id` OR parent's `event_id` if parent is a root),
   *     and rejects an orphan reply.
   *   - The materialised view is rebuilt for the touched doc_path
   *     before returning so the next list/get reflects this write.
   */
  async appendEvent(
    project_id: string,
    input: AppendEventInput,
  ): Promise<AppendEventResult> {
    const handle = await this.openHandle(project_id)
    this.assertSizes(input)
    const event_id = this.ulid()
    const created_at = this.now()

    let canonical_thread_root_id: string | null = input.thread_root_id
    if (input.parent_event_id !== null) {
      const parent = handle.db
        .prepare<
          { event_id: string; thread_root_id: string | null },
          [string]
        >('SELECT event_id, thread_root_id FROM doc_comment_events WHERE event_id = ?')
        .get(input.parent_event_id)
      if (parent === null) {
        throw new CommentNotFoundError(
          `parent_event_id=${input.parent_event_id} not found`,
        )
      }
      canonical_thread_root_id = parent.thread_root_id ?? parent.event_id
    }

    const row: DocCommentEvent = {
      event_id,
      event_kind: input.event_kind,
      doc_path: input.doc_path,
      thread_root_id: canonical_thread_root_id,
      parent_event_id: input.parent_event_id,
      anchor_start: input.anchor_start,
      anchor_end: input.anchor_end,
      anchor_text_excerpt: input.anchor_text_excerpt,
      anchor_ctx_before: input.anchor_ctx_before,
      anchor_ctx_after: input.anchor_ctx_after,
      based_on_modified_at: input.based_on_modified_at,
      author_kind: input.author_kind,
      author_id: input.author_id,
      body: input.body,
      metadata_json: input.metadata_json,
      created_at,
    }

    const db = handle.db
    db.exec('BEGIN IMMEDIATE')
    try {
      db.run(
        `INSERT INTO doc_comment_events (
           event_id, event_kind, doc_path,
           thread_root_id, parent_event_id,
           anchor_start, anchor_end, anchor_text_excerpt,
           anchor_ctx_before, anchor_ctx_after,
           based_on_modified_at,
           author_kind, author_id, body, metadata_json, created_at
         ) VALUES (?, ?, ?,  ?, ?,  ?, ?, ?,  ?, ?,  ?,  ?, ?, ?, ?, ?)`,
        [
          row.event_id,
          row.event_kind,
          row.doc_path,
          row.thread_root_id,
          row.parent_event_id,
          row.anchor_start,
          row.anchor_end,
          row.anchor_text_excerpt,
          row.anchor_ctx_before,
          row.anchor_ctx_after,
          row.based_on_modified_at,
          row.author_kind,
          row.author_id,
          row.body,
          row.metadata_json,
          row.created_at,
        ],
      )
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }

    // Re-materialise the projection for this doc_path so the next
    // read sees the just-written event. Materialise is pure +
    // idempotent; we wipe + re-insert atomically.
    this.materialiseForPath(handle, row.doc_path)

    const thread_root_id = canonical_thread_root_id ?? event_id
    return { event: row, thread_root_id }
  }

  /**
   * List thread summaries for one doc_path, joined with the
   * materialised anchor row. Filters out `status='dead'` rows by
   * default (the side-pane shows them in a separate "Dead threads"
   * section in S3). Paginated by `last_reply_at` desc.
   */
  async listThreads(
    project_id: string,
    opts: ListThreadsOptions,
  ): Promise<ListThreadsResult> {
    const handle = await this.openHandle(project_id)
    const include_dead = opts.include_dead ?? false
    const limit = clampLimit(opts.limit, 50, 200)
    const cursor = opts.cursor_last_reply_at ?? null
    const cursor_thread_root_id = opts.cursor_thread_root_id ?? null

    const conditions: string[] = ['a.doc_path = ?']
    const params: Array<string | number> = [opts.doc_path]
    if (!include_dead) {
      conditions.push("a.status != 'dead'")
    }
    if (cursor !== null) {
      // Argus r1 IMPORTANT — composite key. `(last_reply_at, thread_root_id)`
      // matches the ORDER BY tuple, so rows sharing a ms timestamp with
      // the cursor still surface across pages (the secondary key
      // disambiguates). When the legacy single-key cursor is supplied
      // we fall back to the strict-less-than predicate.
      if (cursor_thread_root_id !== null) {
        conditions.push(
          '(a.last_reply_at < ? OR (a.last_reply_at = ? AND a.thread_root_id < ?))',
        )
        params.push(cursor, cursor, cursor_thread_root_id)
      } else {
        conditions.push('a.last_reply_at < ?')
        params.push(cursor)
      }
    }

    type Row = AnchorRow & { excerpt: string | null }
    // Fetch the materialised anchor rows + the root excerpt in one
    // query. Excerpt comes from the originating comment_posted event
    // (thread_root_id NULL on the root → join on event_id). The +1 in
    // the LIMIT param lets us detect whether another page exists
    // without a second round-trip.
    const allParams: Array<string | number> = [...params, limit + 1]
    const rows = handle.db
      .prepare<Row, Array<string | number>>(
        `SELECT a.thread_root_id, a.doc_path,
                a.current_start, a.current_end, a.status,
                a.drift_hint_start, a.drift_hint_end,
                a.last_rebuilt_from, a.last_rebuilt_at,
                a.reply_count, a.last_reply_at,
                a.latest_event_kind,
                e.anchor_text_excerpt AS excerpt
           FROM doc_comment_anchors a
           JOIN doc_comment_events  e ON e.event_id = a.thread_root_id
          WHERE ${conditions.join(' AND ')}
          ORDER BY a.last_reply_at DESC, a.thread_root_id DESC
          LIMIT ?`,
      )
      .all(...allParams)

    const slice = rows.slice(0, limit)
    let next_cursor: NextCursor | null = null
    if (rows.length > limit) {
      const lastVisible = slice[slice.length - 1]
      if (lastVisible !== undefined) {
        next_cursor = {
          last_reply_at: lastVisible.last_reply_at,
          thread_root_id: lastVisible.thread_root_id,
        }
      }
    }

    const threads: ThreadSummary[] = []
    for (const r of slice) {
      const root = this.fetchEventById(handle, r.thread_root_id)
      if (root === null) continue
      threads.push({
        thread_root_id: r.thread_root_id,
        doc_path: r.doc_path,
        anchor: {
          current_start: r.current_start,
          current_end: r.current_end,
          status: r.status,
          drift_hint_start: r.drift_hint_start,
          drift_hint_end: r.drift_hint_end,
          excerpt: r.excerpt,
        },
        root,
        reply_count: r.reply_count,
        last_reply_at: r.last_reply_at,
        latest_event_kind: r.latest_event_kind,
      })
    }
    return { threads, next_cursor }
  }

  /**
   * Return the full thread tree rooted at `event_id` (or, if
   * `event_id` is a reply, the thread rooted at the reply's
   * `thread_root_id`). Replies returned in `(created_at, event_id)`
   * ascending order; the consuming client renders flat OR nests by
   * `parent_event_id` per its UX choice.
   */
  async getThread(
    project_id: string,
    event_id: string,
  ): Promise<ThreadTree> {
    const handle = await this.openHandle(project_id)
    const seed = this.fetchEventById(handle, event_id)
    if (seed === null) {
      throw new CommentNotFoundError(`event_id=${event_id} not found`)
    }
    const root_id = seed.thread_root_id ?? seed.event_id
    const root = this.fetchEventById(handle, root_id)
    if (root === null) {
      throw new CommentNotFoundError(`thread_root_id=${root_id} not found`)
    }
    const anchor = handle.db
      .prepare<AnchorRow, [string]>(
        `SELECT thread_root_id, doc_path,
                current_start, current_end, status,
                drift_hint_start, drift_hint_end,
                last_rebuilt_from, last_rebuilt_at,
                reply_count, last_reply_at,
                latest_event_kind
           FROM doc_comment_anchors
          WHERE thread_root_id = ?`,
      )
      .get(root_id)
    if (anchor === null) {
      // Materialised view missing — re-materialise + retry.
      this.materialiseForPath(handle, root.doc_path)
      const reread = handle.db
        .prepare<AnchorRow, [string]>(
          `SELECT thread_root_id, doc_path,
                  current_start, current_end, status,
                  drift_hint_start, drift_hint_end,
                  last_rebuilt_from, last_rebuilt_at,
                  reply_count, last_reply_at,
                  latest_event_kind
             FROM doc_comment_anchors
            WHERE thread_root_id = ?`,
        )
        .get(root_id)
      if (reread === null) {
        throw new CommentNotFoundError(
          `anchor row for thread_root_id=${root_id} missing after materialise`,
        )
      }
      return {
        root,
        anchor: reread,
        replies: this.fetchReplies(handle, root_id),
      }
    }
    return { root, anchor, replies: this.fetchReplies(handle, root_id) }
  }

  /**
   * S3 — execute `fn` against the per-project sidecar's underlying
   * `bun:sqlite` Database. The lazy-init contract is preserved: the
   * sidecar dir + DB are opened + migrated before `fn` runs.
   *
   * Intended for `gateway/wiring/escalation-loader.ts`, which
   * needs a single `BEGIN IMMEDIATE` transaction to SELECT pending
   * escalations + atomically INSERT consumption-markers in one round-
   * trip. Adding a dedicated `loadPendingEscalations` method on the
   * store would couple the store to a composer-side concern; this
   * narrow seam keeps the store generic.
   */
  async withProjectDb<T>(
    project_id: string,
    fn: (db: Database) => T | Promise<T>,
  ): Promise<T> {
    const handle = await this.openHandle(project_id)
    return await fn(handle.db)
  }

  /**
   * S3 — list user-authored `comment_posted` events newer than the
   * watcher cursor. The agent watcher
   * (`gateway/comments/agent-watcher.ts`) calls this once per tick per
   * project to pick up new user comments and dispatch agent replies.
   *
   * Filters:
   *   - `event_kind = 'comment_posted'` — anchor_* / escalate_to_chat /
   *     agent_reply_skipped are ignored.
   *   - `author_kind = 'user'` — agent self-replies and walker events
   *     never re-fire the watcher pipeline.
   *   - `event_id > last_event_id` lexicographic ULIDs sort by
   *     creation time, so `>` is "newer than".
   *
   * `last_event_id === null` means "from the very beginning" — the
   * watcher uses this on first boot per project (no cursor file yet).
   */
  async listUserCommentsAfter(
    project_id: string,
    last_event_id: string | null,
    opts: { limit?: number } = {},
  ): Promise<DocCommentEvent[]> {
    const handle = await this.openHandle(project_id)
    const limit = clampLimit(opts.limit, 20, 200)
    if (last_event_id === null) {
      return handle.db
        .prepare<DocCommentEvent, [number]>(
          `SELECT event_id, event_kind, doc_path,
                  thread_root_id, parent_event_id,
                  anchor_start, anchor_end, anchor_text_excerpt,
                  anchor_ctx_before, anchor_ctx_after,
                  based_on_modified_at,
                  author_kind, author_id, body, metadata_json, created_at
             FROM doc_comment_events
            WHERE event_kind = 'comment_posted'
              AND author_kind = 'user'
            ORDER BY event_id ASC
            LIMIT ?`,
        )
        .all(limit)
    }
    return handle.db
      .prepare<DocCommentEvent, [string, number]>(
        `SELECT event_id, event_kind, doc_path,
                thread_root_id, parent_event_id,
                anchor_start, anchor_end, anchor_text_excerpt,
                anchor_ctx_before, anchor_ctx_after,
                based_on_modified_at,
                author_kind, author_id, body, metadata_json, created_at
           FROM doc_comment_events
          WHERE event_kind = 'comment_posted'
            AND author_kind = 'user'
            AND event_id > ?
          ORDER BY event_id ASC
          LIMIT ?`,
      )
      .all(last_event_id, limit)
  }

  /**
   * S3 — return the maximum `event_id` in the events log strictly
   * greater than `last_event_id` (or the absolute maximum if
   * `last_event_id === null`). Used by the agent watcher to advance
   * its cursor past events that did NOT trigger an LLM call
   * (agent-authored comments, anchor walker events, system events).
   * Without this, a long backlog of non-user events would be
   * re-scanned every tick.
   *
   * Returns `null` when no events exist past the cursor.
   */
  async maxEventIdAfter(
    project_id: string,
    last_event_id: string | null,
  ): Promise<string | null> {
    const handle = await this.openHandle(project_id)
    if (last_event_id === null) {
      const row = handle.db
        .prepare<{ max_id: string | null }, []>(
          'SELECT MAX(event_id) AS max_id FROM doc_comment_events',
        )
        .get()
      return row?.max_id ?? null
    }
    const row = handle.db
      .prepare<{ max_id: string | null }, [string]>(
        'SELECT MAX(event_id) AS max_id FROM doc_comment_events WHERE event_id > ?',
      )
      .get(last_event_id)
    return row?.max_id ?? null
  }

  /**
   * S3 — list `agent_reply_skipped` events for one `doc_path`. The
   * side-pane reads these to render a "Skipped" badge on the latest
   * event in any thread where the watcher gave up (timeout / API
   * error / doc-missing / etc.).
   *
   * No materialised column → zero S1/S2 regression risk. Cost is one
   * indexed lookup per pane load (the existing
   * `idx_events_kind_doc_path` index covers the WHERE clause).
   */
  async listSkippedSince(
    project_id: string,
    doc_path: string,
    opts: { limit?: number } = {},
  ): Promise<DocCommentEvent[]> {
    const handle = await this.openHandle(project_id)
    const limit = clampLimit(opts.limit, 100, 500)
    return handle.db
      .prepare<DocCommentEvent, [string, number]>(
        `SELECT event_id, event_kind, doc_path,
                thread_root_id, parent_event_id,
                anchor_start, anchor_end, anchor_text_excerpt,
                anchor_ctx_before, anchor_ctx_after,
                based_on_modified_at,
                author_kind, author_id, body, metadata_json, created_at
           FROM doc_comment_events
          WHERE event_kind = 'agent_reply_skipped'
            AND doc_path   = ?
          ORDER BY created_at DESC, event_id DESC
          LIMIT ?`,
      )
      .all(doc_path, limit)
  }

  /**
   * Fully rebuild the materialised view from the event log for one
   * doc_path. Used by `appendEvent`; exposed for tests that want to
   * verify wipe-and-rebuild idempotency (the canonical Atlas-claim
   * property — § 3.2 last paragraph + § 10.1).
   */
  async materialise(project_id: string, doc_path: string): Promise<AnchorRow[]> {
    const handle = await this.openHandle(project_id)
    return this.materialiseForPath(handle, doc_path)
  }

  /**
   * S2 — list the live + drifted anchor rows for one `doc_path`
   * joined with the originating `comment_posted` event's excerpt +
   * surrounding context. The walker (`gateway/comments/anchor-walker.ts`)
   * needs these fields to call `relocateAnchor` after a doc edit —
   * the anchor row alone doesn't carry the excerpt / context window.
   *
   * Dead anchors are excluded by default (the walker has nothing to
   * relocate them against once the underlying excerpt is gone); set
   * `include_dead = true` if the caller wants the full set anyway
   * (useful for P7.4 revert flows where the file is being restored
   * and previously-dead anchors might flip back to live).
   *
   * Returns at most `limit` rows (default 5000 — the anchor count per
   * doc is bounded by user attention, not by instance scale; the cap is
   * a defensive guard against a runaway loop).
   */
  async listWalkerAnchors(
    project_id: string,
    doc_path: string,
    opts: { include_dead?: boolean; limit?: number } = {},
  ): Promise<WalkerAnchor[]> {
    const handle = await this.openHandle(project_id)
    const include_dead = opts.include_dead ?? false
    const limit = clampLimit(opts.limit, 5000, 5000)
    type Row = {
      thread_root_id: string
      doc_path: string
      status: AnchorStatus
      current_start: number | null
      current_end: number | null
      drift_hint_start: number | null
      drift_hint_end: number | null
      anchor_start: number | null
      anchor_end: number | null
      anchor_text_excerpt: string | null
      anchor_ctx_before: string | null
      anchor_ctx_after: string | null
    }
    const statusClause = include_dead
      ? ''
      : "AND a.status != 'dead'"
    const rows = handle.db
      .prepare<Row, [string, number]>(
        `SELECT a.thread_root_id,
                a.doc_path,
                a.status,
                a.current_start, a.current_end,
                a.drift_hint_start, a.drift_hint_end,
                e.anchor_start, e.anchor_end,
                e.anchor_text_excerpt,
                e.anchor_ctx_before,
                e.anchor_ctx_after
           FROM doc_comment_anchors a
           JOIN doc_comment_events  e ON e.event_id = a.thread_root_id
          WHERE a.doc_path = ? ${statusClause}
          ORDER BY a.thread_root_id ASC
          LIMIT ?`,
      )
      .all(doc_path, limit)
    const out: WalkerAnchor[] = []
    for (const r of rows) {
      // Walker can only relocate anchors that carry an excerpt to
      // search for. The previous position falls through three
      // sources in priority order:
      //   1. `current_start/end`   — live anchors
      //   2. `drift_hint_start/end` — drifted anchors
      //   3. The originating comment_posted's `anchor_start/end`  —
      //      dead anchors (no live position; use the original to
      //      seed the local-radius fuzzy search so a revert that
      //      restores content nearby can flip the anchor back to
      //      live; brief § 9.3).
      if (r.anchor_text_excerpt === null) continue
      const previous_start =
        r.current_start ?? r.drift_hint_start ?? r.anchor_start
      const previous_end =
        r.current_end ?? r.drift_hint_end ?? r.anchor_end
      if (previous_start === null || previous_end === null) continue
      out.push({
        thread_root_id: r.thread_root_id,
        doc_path: r.doc_path,
        status: r.status,
        previous_start,
        previous_end,
        excerpt: r.anchor_text_excerpt,
        ctx_before: r.anchor_ctx_before ?? '',
        ctx_after: r.anchor_ctx_after ?? '',
      })
    }
    return out
  }

  /**
   * Wipe + rebuild the materialised view for ALL doc_paths in the
   * project. Tests use this to assert
   * "materialised view == fresh-rebuild from events". Production
   * callers should rely on the auto-rebuild path triggered by
   * `appendEvent`.
   */
  async materialiseAll(project_id: string): Promise<AnchorRow[]> {
    const handle = await this.openHandle(project_id)
    const paths = handle.db
      .prepare<{ doc_path: string }, []>(
        'SELECT DISTINCT doc_path FROM doc_comment_events',
      )
      .all()
    const all: AnchorRow[] = []
    for (const p of paths) {
      all.push(...this.materialiseForPath(handle, p.doc_path))
    }
    return all
  }

  /* ─── internals ──────────────────────────────────────────────── */

  private async openHandle(project_id: string): Promise<ProjectHandle> {
    const cleaned = sanitizeProjectId(project_id)
    if (cleaned === null) {
      throw new CommentStoreError(
        'invalid_project_id',
        'project_id must be 1-128 chars from [A-Za-z0-9_.-]',
      )
    }
    const cached = this.handles.get(cleaned)
    if (cached !== undefined) return cached
    const inflight = this.initPromises.get(cleaned)
    if (inflight !== undefined) return inflight
    const promise = this.initHandle(cleaned)
    this.initPromises.set(cleaned, promise)
    try {
      const handle = await promise
      this.handles.set(cleaned, handle)
      return handle
    } finally {
      this.initPromises.delete(cleaned)
    }
  }

  private async initHandle(project_id: string): Promise<ProjectHandle> {
    const dir = join(this.resolveProjectRoot(project_id), COMMENTS_DIR)
    mkdirSync(dir, { recursive: true })
    const comments_db_path = join(dir, COMMENTS_DB)
    let db: Database
    try {
      // P3 shared open — previously NO pragmas set here at all; now gains
      // WAL/synchronous/busy_timeout/temp_store/cache_size (strictly more
      // tolerant, no semantic change). foreign_keys is already ON in today's
      // behavior — `applyProjectScopedMigrations` below asserts
      // `PRAGMA foreign_keys = ON` on this connection — so openSidecar's
      // FK=ON is behavior-preserving, not new enforcement.
      db = openSidecar(comments_db_path)
    } catch (err) {
      throw new CommentStoreError(
        'comments_unavailable',
        `failed to open ${comments_db_path}: ${stringifyError(err)}`,
      )
    }
    try {
      applyProjectScopedMigrations(db, this.migrations_dir)
    } catch (err) {
      try {
        db.close()
      } catch {
        /* ignore */
      }
      throw new CommentStoreError(
        'comments_unavailable',
        `failed to apply comments migrations: ${stringifyError(err)}`,
      )
    }
    return { db, comments_db_path }
  }

  private materialiseForPath(handle: ProjectHandle, doc_path: string): AnchorRow[] {
    const db = handle.db
    // S2 — walk by thread-root chain, not strictly by doc_path. A
    // thread's events can span paths once `moveDoc` lands (the walker
    // emits anchor_relocated with `to_doc_path` so the row moves with
    // the file). Collecting every thread that has ANY event on `doc_path`
    // and then walking ALL of those threads' events guarantees the
    // materialiser sees the full history regardless of which path the
    // events were originally written to. The query collapses to a
    // single round-trip via a CTE.
    const events = db
      .prepare<DocCommentEvent, [string]>(
        `WITH involved_threads AS (
           SELECT DISTINCT COALESCE(thread_root_id, event_id) AS thread_id
             FROM doc_comment_events
            WHERE doc_path = ?
         )
         SELECT event_id, event_kind, doc_path,
                thread_root_id, parent_event_id,
                anchor_start, anchor_end, anchor_text_excerpt,
                anchor_ctx_before, anchor_ctx_after,
                based_on_modified_at,
                author_kind, author_id, body, metadata_json, created_at
           FROM doc_comment_events
          WHERE event_id      IN (SELECT thread_id FROM involved_threads)
             OR thread_root_id IN (SELECT thread_id FROM involved_threads)
          ORDER BY created_at ASC, event_id ASC`,
      )
      .all(doc_path)
    const projected = materialiseAnchors(events, { now: this.now })
    db.exec('BEGIN IMMEDIATE')
    try {
      // S2 — DELETE by `thread_root_id`, not by `doc_path`. After a
      // move the same thread may have stale rows on both the old and
      // the new path; wiping by thread_root_id catches both. Threads
      // not present in `projected` (because their events are absent
      // from this path's involved-threads set) are untouched.
      if (projected.length > 0) {
        const placeholders = projected.map(() => '?').join(',')
        db.run(
          `DELETE FROM doc_comment_anchors WHERE thread_root_id IN (${placeholders})`,
          projected.map((a) => a.thread_root_id),
        )
      }
      // Edge case: a path with NO surviving threads (e.g. every
      // anchor turned dead AND we want the empty list back). Wipe the
      // path-scoped rows defensively in case the prior materialisation
      // had survivors on this path.
      db.run('DELETE FROM doc_comment_anchors WHERE doc_path = ?', [doc_path])
      for (const a of projected) {
        db.run(
          `INSERT INTO doc_comment_anchors (
             thread_root_id, doc_path,
             current_start, current_end, status,
             drift_hint_start, drift_hint_end,
             last_rebuilt_from, last_rebuilt_at,
             reply_count, last_reply_at,
             latest_event_kind
           ) VALUES (?, ?,  ?, ?, ?,  ?, ?,  ?, ?,  ?, ?,  ?)`,
          [
            a.thread_root_id,
            a.doc_path,
            a.current_start,
            a.current_end,
            a.status,
            a.drift_hint_start,
            a.drift_hint_end,
            a.last_rebuilt_from,
            a.last_rebuilt_at,
            a.reply_count,
            a.last_reply_at,
            a.latest_event_kind,
          ],
        )
      }
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      throw err
    }
    return projected
  }

  private fetchEventById(
    handle: ProjectHandle,
    event_id: string,
  ): DocCommentEvent | null {
    const row = handle.db
      .prepare<DocCommentEvent, [string]>(
        `SELECT event_id, event_kind, doc_path,
                thread_root_id, parent_event_id,
                anchor_start, anchor_end, anchor_text_excerpt,
                anchor_ctx_before, anchor_ctx_after,
                based_on_modified_at,
                author_kind, author_id, body, metadata_json, created_at
           FROM doc_comment_events
          WHERE event_id = ?`,
      )
      .get(event_id)
    return row
  }

  private fetchReplies(
    handle: ProjectHandle,
    thread_root_id: string,
  ): DocCommentEvent[] {
    return handle.db
      .prepare<DocCommentEvent, [string, string]>(
        `SELECT event_id, event_kind, doc_path,
                thread_root_id, parent_event_id,
                anchor_start, anchor_end, anchor_text_excerpt,
                anchor_ctx_before, anchor_ctx_after,
                based_on_modified_at,
                author_kind, author_id, body, metadata_json, created_at
           FROM doc_comment_events
          WHERE thread_root_id = ?
            AND event_id != ?
            AND event_kind = 'comment_posted'
          ORDER BY created_at ASC, event_id ASC`,
      )
      .all(thread_root_id, thread_root_id)
  }

  private assertSizes(input: AppendEventInput): void {
    if (input.body !== null && byteLen(input.body) > MAX_COMMENT_BODY_BYTES) {
      throw new CommentBodyTooLargeError(
        `body exceeds ${MAX_COMMENT_BODY_BYTES} bytes`,
      )
    }
    if (
      input.anchor_text_excerpt !== null &&
      byteLen(input.anchor_text_excerpt) > MAX_ANCHOR_EXCERPT_BYTES
    ) {
      throw new CommentStoreError(
        'anchor_excerpt_too_large',
        `anchor_text_excerpt exceeds ${MAX_ANCHOR_EXCERPT_BYTES} bytes`,
      )
    }
    if (
      input.anchor_ctx_before !== null &&
      byteLen(input.anchor_ctx_before) > MAX_ANCHOR_CTX_BYTES
    ) {
      throw new CommentStoreError(
        'anchor_ctx_too_large',
        `anchor_ctx_before exceeds ${MAX_ANCHOR_CTX_BYTES} bytes`,
      )
    }
    if (
      input.anchor_ctx_after !== null &&
      byteLen(input.anchor_ctx_after) > MAX_ANCHOR_CTX_BYTES
    ) {
      throw new CommentStoreError(
        'anchor_ctx_too_large',
        `anchor_ctx_after exceeds ${MAX_ANCHOR_CTX_BYTES} bytes`,
      )
    }
    if (
      input.metadata_json !== null &&
      byteLen(input.metadata_json) > MAX_METADATA_JSON_BYTES
    ) {
      throw new CommentStoreError(
        'metadata_json_too_large',
        `metadata_json exceeds ${MAX_METADATA_JSON_BYTES} bytes`,
      )
    }
  }
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function clampLimit(
  raw: number | undefined,
  fallback: number,
  cap: number,
): number {
  if (raw === undefined) return fallback
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.floor(raw), cap)
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return String(err)
  } catch {
    return '<unstringifiable>'
  }
}

/* ─── ULID ────────────────────────────────────────────────────── */

/**
 * Minimal Crockford-base32 ULID generator. 26 chars: 10 timestamp chars
 * (48-bit ms-since-epoch) + 16 randomness chars (80 bits). Monotonic
 * within a single ms tick — when called twice in the same ms, the
 * randomness section is incremented to preserve lexicographic order.
 *
 * Lightweight inline implementation rather than a third-party dep so
 * the comments substrate doesn't pull a new top-level package for ~50
 * LOC of logic.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // 32 chars
let last_ulid_ms = -1
let last_ulid_random: Uint8Array = new Uint8Array(10)

export function defaultUlid(): string {
  const ms = Date.now()
  let randomBytes: Uint8Array
  if (ms === last_ulid_ms) {
    randomBytes = incrementBytes(last_ulid_random)
  } else {
    randomBytes = randomTen()
  }
  last_ulid_ms = ms
  last_ulid_random = randomBytes
  return encodeTimestamp(ms) + encodeRandom(randomBytes)
}

function randomTen(): Uint8Array {
  const out: Uint8Array = new Uint8Array(10)
  // Use the global crypto where available (Bun + modern Node + browsers).
  // Falls back to Math.random for the (currently impossible) absence case
  // so the function is total — ULIDs from non-crypto entropy are still
  // unique-enough within a single process for the comments substrate's
  // single-writer-per-thread workload.
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(out)
    return out
  }
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.floor(Math.random() * 256)
  }
  return out
}

function incrementBytes(prev: Uint8Array): Uint8Array {
  const out: Uint8Array = new Uint8Array(prev)
  for (let i = out.length - 1; i >= 0; i--) {
    const current = out[i] ?? 0
    if (current < 255) {
      out[i] = current + 1
      return out
    }
    out[i] = 0
  }
  // Overflow — caller's monotonicity invariant breaks, but the next
  // ms tick will reset; this only matters when 2^80 ULIDs land in the
  // same ms, which is not a real workload.
  return randomTen()
}

function encodeTimestamp(ms: number): string {
  let n = ms
  const chars = new Array<string>(10)
  for (let i = 9; i >= 0; i--) {
    chars[i] = CROCKFORD[n & 31] ?? '0'
    n = Math.floor(n / 32)
  }
  return chars.join('')
}

function encodeRandom(bytes: Uint8Array): string {
  // 10 random bytes → 80 bits → 16 base32 chars.
  let bits = 0
  let value = 0
  const out: string[] = []
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out.push(CROCKFORD[(value >>> bits) & 31] ?? '0')
    }
  }
  if (bits > 0) {
    out.push(CROCKFORD[(value << (5 - bits)) & 31] ?? '0')
  }
  // Two-byte tail produces 16 chars exactly; truncate to be safe.
  return out.slice(0, 16).join('')
}
