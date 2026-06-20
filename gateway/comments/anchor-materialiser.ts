/**
 * @neutronai/gateway/comments — anchor materialiser (P7.2 S1 + S2).
 *
 * Per docs/plans/P7.2-inline-comments-sprint-brief.md § 4.1.
 *
 * Pure function: given the ordered event stream for one or more
 * `doc_path` values, returns the expected rows for `doc_comment_anchors`.
 * Idempotent — re-running on the same event stream produces identical
 * output. The materialised view is NEVER the source of truth; the
 * events log is. This lets the gateway rebuild the view on demand
 * without ever needing to reconcile "two parallel views".
 *
 * S1 shipped the comment_posted fold and stubs for anchor_*. S2 adds:
 *   - Stale walker-event suppression via `based_on_modified_at`
 *     (brief § 2.3 / § 4.2). A slow walker can never permanently
 *     corrupt the materialised view — its events get superseded by
 *     the next walker run's events for the same thread.
 *   - `to_doc_path` support in `anchor_relocated` metadata so a
 *     `moveDoc` walk preserves comment threads across the rename.
 *     The originating `comment_posted` event keeps its original
 *     `doc_path`; the anchor row's `doc_path` advances to whatever
 *     the latest walker event says.
 *
 * The escalate_to_chat / agent_reply_skipped event kinds are no-ops in
 * the anchor projection — they don't move anchors. S3 surfaces them
 * via separate reads against the events table.
 */

/**
 * Locked vocabulary — see brief § 3.3. Forge: add new kinds here as
 * S2 / S3 / S4 work lands; the schema column is plain TEXT so the
 * type widens without migration.
 */
export type CommentEventKind =
  | 'comment_posted'
  | 'anchor_relocated'
  | 'anchor_drifted'
  | 'anchor_dead'
  | 'anchor_dead_moved'
  | 'escalate_to_chat'
  | 'agent_reply_skipped'
  // P7.2 S3 — `comment_resolved` is the side-pane's resolve-button
  // event. The materialiser treats it as a no-op for anchor projection
  // (same as `escalate_to_chat` / `agent_reply_skipped`); the side-pane
  // detects resolved state by walking the event log directly.
  | 'comment_resolved'

export type CommentAuthorKind = 'user' | 'agent' | 'system'

export type AnchorStatus = 'live' | 'drifted' | 'dead'

/**
 * Shape of a row read from `doc_comment_events`. Mirrors the migration
 * schema exactly; the SQLite driver hands us numeric / string columns
 * with `null` for missing values.
 */
export interface DocCommentEvent {
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

/** Shape of a row in `doc_comment_anchors`. */
export interface AnchorRow {
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
  /**
   * P7.2 S3 — kind of the latest event in this thread (root +
   * every reply, including system events like `comment_resolved` /
   * `agent_reply_skipped` / `escalate_to_chat` / anchor_*). The
   * side-pane uses this to decide whether to render in the Resolved
   * tab, show a "Skipped" badge, or treat the row as active.
   *
   * Nullable for rows materialised by older schema versions that
   * predate the column; once `materialiseAll` runs, every row has a
   * non-null value (every thread has at least one `comment_posted`
   * event by construction).
   */
  latest_event_kind: CommentEventKind | null
}

export interface MaterialiseOptions {
  /** Override `Date.now()` for deterministic tests. */
  now?: () => number
}

/**
 * Fold an ordered event stream into the set of materialised anchor
 * rows. Pure: same input → same output, no I/O.
 *
 * Sort is `(created_at ASC, event_id ASC)` — ULIDs sort by creation
 * time but two concurrent inserts in the same ms tick can produce
 * (event_id) lexicographic disagreement with the ms-level
 * `created_at`. Two-key sort makes the fold deterministic regardless
 * of how the caller already ordered the events.
 *
 * S2 stale walker-event suppression (brief § 2.3 / § 4.2):
 *   When two walker runs race against quick-succession doc edits,
 *   the slower one's events still land in the log (append-only) but
 *   carry an older `based_on_modified_at` than the faster (newer)
 *   walker's events. The pre-pass computes per-thread the highest
 *   walker mtime; any walker event with a strictly older mtime is
 *   dropped from the fold. Comment_posted events are untouched —
 *   their `based_on_modified_at` records the client's compose-time
 *   mtime, not a walker stamp.
 */
export function materialiseAnchors(
  events: ReadonlyArray<DocCommentEvent>,
  opts: MaterialiseOptions = {},
): AnchorRow[] {
  const now = opts.now ?? Date.now
  const sorted = [...events].sort(byCreatedAtAndEventId)
  const walkerMax = computeWalkerMtimeMax(sorted)
  const anchors = new Map<string, AnchorRow>()

  for (const ev of sorted) {
    if (ev.event_kind === 'comment_posted') {
      foldCommentPosted(anchors, ev, now)
      updateLatestEventKind(anchors, ev)
      continue
    }
    if (isWalkerKind(ev.event_kind)) {
      if (isStaleWalkerEvent(ev, walkerMax)) continue
      if (ev.event_kind === 'anchor_relocated') {
        foldAnchorRelocated(anchors, ev)
        updateLatestEventKind(anchors, ev)
        continue
      }
      if (ev.event_kind === 'anchor_drifted') {
        foldAnchorDrifted(anchors, ev)
        updateLatestEventKind(anchors, ev)
        continue
      }
      if (ev.event_kind === 'anchor_dead') {
        foldAnchorDead(anchors, ev)
        updateLatestEventKind(anchors, ev)
        continue
      }
      if (ev.event_kind === 'anchor_dead_moved') {
        foldAnchorDeadMoved(anchors, ev)
        updateLatestEventKind(anchors, ev)
        continue
      }
    }
    // escalate_to_chat / agent_reply_skipped / comment_resolved —
    // no anchor mutation, but DO update `latest_event_kind` so the
    // side-pane's Resolved tab + skipped-comment badge see the new
    // state after refetch (Argus r2 BLOCKER 2). The skipped-event
    // detail tooltip still reads `listSkippedSince` for full event
    // metadata; the materialised column drives only the badge.
    updateLatestEventKind(anchors, ev)
  }
  return [...anchors.values()]
}

/**
 * Stamp `latest_event_kind` on the materialised anchor row for the
 * event's thread. Events are folded in (created_at ASC, event_id ASC)
 * order, so the last event to call this for a given thread wins —
 * exactly the "most recent" semantics the side-pane needs.
 *
 * Orphan events (whose thread_root_id is missing from the anchors map)
 * are dropped silently — same defensive posture as foldCommentPosted's
 * reply-without-root case.
 */
function updateLatestEventKind(
  anchors: Map<string, AnchorRow>,
  ev: DocCommentEvent,
): void {
  // Thread root rows store the event_id as their key; reply / system
  // events carry thread_root_id pointing at the root.
  const key = ev.thread_root_id ?? ev.event_id
  const row = anchors.get(key)
  if (row === undefined) return
  row.latest_event_kind = ev.event_kind
}

/**
 * Walker-authored event kinds. The materialiser's stale-event filter
 * only inspects events of these kinds; comment_posted is always folded
 * (it carries the user's compose-time mtime, not a walker stamp).
 */
function isWalkerKind(kind: CommentEventKind): boolean {
  return (
    kind === 'anchor_relocated' ||
    kind === 'anchor_drifted' ||
    kind === 'anchor_dead' ||
    kind === 'anchor_dead_moved'
  )
}

/**
 * Per-thread walker-mtime-max boundary. Tracks BOTH the highest
 * observed stamp AND the highest event_id at that stamp tier. The
 * event_id is the secondary key so two walker events landing at the
 * SAME `based_on_modified_at` (e.g. a deleter + a writer racing on
 * the same wall-clock millisecond — ISSUE #19) get deterministically
 * triaged: exactly one survives the stale filter (the higher-
 * event_id one), the other is dropped.
 */
interface WalkerMaxEntry {
  stamp: number
  event_id: string
}

/**
 * Pre-pass: per thread, the highest `based_on_modified_at` observed
 * across all walker events PLUS the highest event_id at that max stamp.
 * Walker events that lose on either dimension (older stamp, OR equal
 * stamp + lower event_id) are stale and get dropped by the fold.
 * Threads with NO walker mtime stamp at all stay absent from the map
 * and their walker events fall through untouched (defensive — happens
 * in hand-authored fixture sequences but never in production data).
 *
 * ISSUE #19 fix (option b): widen the stale filter on the event_id
 * axis at equal stamps. Without this, two walker events at the same
 * `based_on_modified_at` both survived the stale filter and the fold
 * outcome depended on processing order — a race condition. With it,
 * exactly one event survives at the max-stamp tier, so the fold has
 * one event to process and the outcome is deterministic.
 */
function computeWalkerMtimeMax(
  sorted: ReadonlyArray<DocCommentEvent>,
): Map<string, WalkerMaxEntry> {
  const max = new Map<string, WalkerMaxEntry>()
  for (const ev of sorted) {
    if (!isWalkerKind(ev.event_kind)) continue
    if (ev.thread_root_id === null) continue
    if (
      ev.based_on_modified_at === null ||
      !Number.isFinite(ev.based_on_modified_at)
    ) {
      continue
    }
    const prev = max.get(ev.thread_root_id)
    if (prev === undefined) {
      max.set(ev.thread_root_id, {
        stamp: ev.based_on_modified_at,
        event_id: ev.event_id,
      })
      continue
    }
    if (ev.based_on_modified_at > prev.stamp) {
      max.set(ev.thread_root_id, {
        stamp: ev.based_on_modified_at,
        event_id: ev.event_id,
      })
      continue
    }
    if (
      ev.based_on_modified_at === prev.stamp &&
      ev.event_id > prev.event_id
    ) {
      max.set(ev.thread_root_id, {
        stamp: ev.based_on_modified_at,
        event_id: ev.event_id,
      })
    }
  }
  return max
}

function isStaleWalkerEvent(
  ev: DocCommentEvent,
  walkerMax: Map<string, WalkerMaxEntry>,
): boolean {
  if (ev.thread_root_id === null) return false
  if (
    ev.based_on_modified_at === null ||
    !Number.isFinite(ev.based_on_modified_at)
  ) {
    // Hand-authored walker events without a mtime stamp are kept —
    // dropping them would silently bury test fixtures.
    return false
  }
  const max = walkerMax.get(ev.thread_root_id)
  if (max === undefined) return false
  if (ev.based_on_modified_at < max.stamp) return true
  if (
    ev.based_on_modified_at === max.stamp &&
    ev.event_id < max.event_id
  ) {
    return true
  }
  return false
}

function foldCommentPosted(
  anchors: Map<string, AnchorRow>,
  ev: DocCommentEvent,
  now: () => number,
): void {
  // Thread root: thread_root_id IS NULL on the row itself; the
  // event_id becomes the thread identity.
  if (ev.thread_root_id === null) {
    if (anchors.has(ev.event_id)) return
    anchors.set(ev.event_id, {
      thread_root_id: ev.event_id,
      doc_path: ev.doc_path,
      current_start: ev.anchor_start,
      current_end: ev.anchor_end,
      status: 'live',
      drift_hint_start: null,
      drift_hint_end: null,
      last_rebuilt_from: ev.event_id,
      last_rebuilt_at: now(),
      reply_count: 0,
      last_reply_at: ev.created_at,
      latest_event_kind: 'comment_posted',
    })
    return
  }
  // Reply: bump the root's reply_count + last_reply_at. Orphan
  // replies (root absent from the stream) are skipped — the brief
  // (§ 4.1) notes this as a defensive guard against malformed event
  // sequences.
  const root = anchors.get(ev.thread_root_id)
  if (root === undefined) return
  root.reply_count += 1
  root.last_reply_at = Math.max(root.last_reply_at, ev.created_at)
  root.last_rebuilt_from = ev.event_id
}

function foldAnchorRelocated(
  anchors: Map<string, AnchorRow>,
  ev: DocCommentEvent,
): void {
  if (ev.thread_root_id === null) return
  const root = anchors.get(ev.thread_root_id)
  if (root === undefined) return
  const meta = parseMetadata(ev.metadata_json)
  const toStart = meta?.['to_start']
  const toEnd = meta?.['to_end']
  if (typeof toStart !== 'number' || typeof toEnd !== 'number') return
  root.current_start = toStart
  root.current_end = toEnd
  root.status = 'live'
  root.drift_hint_start = null
  root.drift_hint_end = null
  root.last_rebuilt_from = ev.event_id
  // S2 — moveDoc walker emits anchor_relocated events with
  // `to_doc_path` in the metadata so the materialised anchor row
  // moves with the file. Absent → in-place edit (no rename).
  const toDocPath = meta?.['to_doc_path']
  if (typeof toDocPath === 'string' && toDocPath.length > 0) {
    root.doc_path = toDocPath
  }
}

function foldAnchorDrifted(
  anchors: Map<string, AnchorRow>,
  ev: DocCommentEvent,
): void {
  if (ev.thread_root_id === null) return
  const root = anchors.get(ev.thread_root_id)
  if (root === undefined) return
  const meta = parseMetadata(ev.metadata_json)
  root.current_start = null
  root.current_end = null
  root.status = 'drifted'
  const hintStart = meta?.['hint_start']
  const hintEnd = meta?.['hint_end']
  root.drift_hint_start = typeof hintStart === 'number' ? hintStart : null
  root.drift_hint_end = typeof hintEnd === 'number' ? hintEnd : null
  root.last_rebuilt_from = ev.event_id
  // ISSUE #20 — symmetric with `foldAnchorRelocated`: when handleMove
  // emits an `anchor_drifted` carrying `to_doc_path` in the metadata
  // (per-anchor revalidation across a rename), the materialised anchor
  // row's doc_path advances to the new home. Absent → in-place edit.
  const toDocPath = meta?.['to_doc_path']
  if (typeof toDocPath === 'string' && toDocPath.length > 0) {
    root.doc_path = toDocPath
  }
}

function foldAnchorDead(
  anchors: Map<string, AnchorRow>,
  ev: DocCommentEvent,
): void {
  if (ev.thread_root_id === null) return
  const root = anchors.get(ev.thread_root_id)
  if (root === undefined) return
  root.current_start = null
  root.current_end = null
  root.status = 'dead'
  root.drift_hint_start = null
  root.drift_hint_end = null
  root.last_rebuilt_from = ev.event_id
}

/**
 * ISSUE #20 fold handler for `anchor_dead_moved` — a previously-dead
 * anchor carried across a doc rename (or a live/drifted anchor whose
 * excerpt was concurrently erased during the rename). Status stays
 * `dead`, but the anchor row's `doc_path` advances to the new home so
 * the dead-threads side-pane on `to_path` (rather than the now-stale
 * `from_path`) surfaces the thread.
 */
function foldAnchorDeadMoved(
  anchors: Map<string, AnchorRow>,
  ev: DocCommentEvent,
): void {
  if (ev.thread_root_id === null) return
  const root = anchors.get(ev.thread_root_id)
  if (root === undefined) return
  const meta = parseMetadata(ev.metadata_json)
  root.current_start = null
  root.current_end = null
  root.status = 'dead'
  root.drift_hint_start = null
  root.drift_hint_end = null
  root.last_rebuilt_from = ev.event_id
  const toDocPath = meta?.['to_doc_path']
  if (typeof toDocPath === 'string' && toDocPath.length > 0) {
    root.doc_path = toDocPath
  }
}

function byCreatedAtAndEventId(a: DocCommentEvent, b: DocCommentEvent): number {
  if (a.created_at !== b.created_at) return a.created_at - b.created_at
  if (a.event_id < b.event_id) return -1
  if (a.event_id > b.event_id) return 1
  return 0
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw.length === 0) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* fall through */
  }
  return null
}
