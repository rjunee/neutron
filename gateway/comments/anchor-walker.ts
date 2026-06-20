/**
 * @neutronai/gateway/comments — re-anchor walker (P7.2 S2).
 *
 * Per docs/plans/P7.2-inline-comments-sprint-brief.md § 4.2 / § 4.3.
 *
 * Fires from `DocStore.writeDoc` / `deleteDoc` / `moveDoc` AFTER the
 * atomic write succeeds. Reads the live + drifted anchors on the
 * touched path, attempts to relocate each, and appends one walker
 * event per anchor (`anchor_relocated` / `anchor_drifted` /
 * `anchor_dead`) into the per-project comments sidecar. The materialiser
 * folds those events into the `doc_comment_anchors` projection on the
 * next read.
 *
 * The walker NEVER mutates the originating `comment_posted` row. It
 * appends new events; the row stays immutable; full history is
 * recoverable (audit trail: "this anchor was originally at line 12,
 * drifted to 14 after edit X, dead after edit Y").
 *
 * Optimistic concurrency (brief § 2.3 / § 4.2):
 *   Two doc edits landing in quick succession trigger two walker
 *   runs against the same path. A per-project async mutex serialises
 *   them. Each walker tags every event with
 *   `based_on_modified_at = <new mtime at walker start>`. If a slow
 *   walker still emits events after a newer walker has finished, the
 *   materialiser drops them via the stale-event filter in
 *   `anchor-materialiser.ts:computeWalkerMtimeMax`.
 *
 * Forward-compat with P7.4 git revert (brief § 4.4):
 *   The walker doesn't care what triggered the write. A revert is
 *   just-another-write; the new body might be an OLDER version of
 *   the doc, and anchors relocate against it cleanly (likely flipping
 *   `dead` → `live` when the prior version still contained the
 *   excerpt). No special revert path.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { sanitizeProjectId } from '../../channels/adapters/app-ws/envelope.ts'
import {
  CommentStore,
  defaultUlid,
  type AppendEventInput,
  type WalkerAnchor,
} from './comment-store.ts'
import {
  allIndicesOf,
  bestFuzzyWindow,
  pickClosest,
} from './lev.ts'

/**
 * Discriminated event kinds the walker emits. Surfaced as a type so
 * the boot composer can wire structured-log hooks against specific
 * kinds without re-parsing strings.
 */
export type WalkerEventKind =
  | 'anchor_relocated'
  | 'anchor_drifted'
  | 'anchor_dead'
  | 'anchor_dead_moved'

/** Result of `relocateAnchor` — the kind + metadata for the appended event. */
export interface RelocateResult {
  kind: WalkerEventKind
  metadata: Record<string, unknown>
}

export interface RelocateInput {
  excerpt: string
  ctx_before: string
  ctx_after: string
  previous_start: number
  /** The full new body to relocate inside of. */
  new_body: string
}

/**
 * Levenshtein tolerance per brief § 4.3 ("0.25 — better to mark
 * drifted than to confidently relocate to the wrong place"). Constant
 * exported so the test suite can build expectations against the
 * exact threshold the production code uses.
 */
export const RELOCATE_TOLERANCE = 0.25

/**
 * Minimum + multiplier for the local search radius. Per brief § 4.3:
 * "search radius = max(2000, anchored.length * 4)".
 */
const SEARCH_RADIUS_MIN = 2000
const SEARCH_RADIUS_MULT = 4

/**
 * Argus r1 IMPORTANT — step 4 (global fuzzy widen) is the expensive
 * tail of `relocateAnchor`. For a 5 MB doc with a ~1 KB anchor that
 * fell outside the local radius, an unbounded sliding-window scan
 * would call `bandedLevenshtein` over millions of (winLen, start)
 * pairs while the walker hook holds open the awaited `writeDoc`
 * response. Two guards bound the cost:
 *
 *   1. Skip step 4 entirely when the body exceeds
 *      `GLOBAL_WIDEN_MAX_BODY_BYTES`. The anchor falls through to
 *      step 5 (`anchor_dead`) — best-effort matching only — instead
 *      of hanging the writer. Set well below `MAX_DOC_BYTES` (5 MB)
 *      so a single large doc cannot stall every comment write that
 *      follows.
 *   2. Pass a stride proportional to needle length so the scanner
 *      samples positions instead of sliding by 1. The slack window
 *      (±20%) still catches matches near a sampled offset; a match
 *      whose start falls strictly between strides is missed and
 *      flips dead, which the brief explicitly accepts ("better to
 *      mark drifted/dead than confidently relocate to the wrong
 *      place"). `GLOBAL_WIDEN_STRIDE_DIVISOR = 4` gives roughly 4×
 *      coverage per needle length — a reasonable recall/perf tradeoff
 *      for the global-only fallback.
 */
const GLOBAL_WIDEN_MAX_BODY_BYTES = 256 * 1024
const GLOBAL_WIDEN_STRIDE_DIVISOR = 4

/**
 * Implementation of the brief's 5-step matcher. Pure function; the
 * walker calls it once per anchor on the touched path. Return value
 * tells the walker which event_kind to append + the metadata payload
 * the materialiser will fold.
 */
export function relocateAnchor(input: RelocateInput): RelocateResult {
  const { excerpt, ctx_before, ctx_after, previous_start, new_body } = input
  const previous_end = previous_start + excerpt.length
  // Step 1 — exact-match fast path. anchored = ctx_before + excerpt + ctx_after.
  const anchored = ctx_before + excerpt + ctx_after
  if (anchored.length > 0) {
    const exact = new_body.indexOf(anchored)
    if (exact >= 0) {
      const start = exact + ctx_before.length
      return {
        kind: 'anchor_relocated',
        metadata: {
          from_start: previous_start,
          from_end: previous_end,
          to_start: start,
          to_end: start + excerpt.length,
          lev_distance: 0,
        },
      }
    }
  }
  // Step 2 — excerpt-exact-match (context drifted; excerpt intact).
  const excerptMatches = allIndicesOf(new_body, excerpt)
  if (excerptMatches.length === 1) {
    const start = excerptMatches[0] ?? 0
    return {
      kind: 'anchor_relocated',
      metadata: {
        from_start: previous_start,
        from_end: previous_end,
        to_start: start,
        to_end: start + excerpt.length,
        lev_distance: 0,
      },
    }
  }
  if (excerptMatches.length > 1) {
    const closest = pickClosest(excerptMatches, previous_start)
    return {
      kind: 'anchor_relocated',
      metadata: {
        from_start: previous_start,
        from_end: previous_end,
        to_start: closest,
        to_end: closest + excerpt.length,
        lev_distance: 0,
      },
    }
  }
  // Step 3 — fuzzy match within a bounded local radius.
  const radius = Math.max(SEARCH_RADIUS_MIN, anchored.length * SEARCH_RADIUS_MULT)
  const lo = Math.max(0, previous_start - radius)
  const hi = Math.min(new_body.length, previous_start + radius)
  if (anchored.length > 0 && hi > lo) {
    const localSlice = new_body.slice(lo, hi)
    const best = bestFuzzyWindow(localSlice, anchored, {
      tolerance: RELOCATE_TOLERANCE,
    })
    if (best !== null) {
      const start = lo + best.window_start + ctx_before.length
      return {
        kind: 'anchor_drifted',
        metadata: {
          hint_start: start,
          hint_end: start + excerpt.length,
          search_window: { lo, hi },
          confidence: 1 - best.lev_distance / Math.max(1, anchored.length),
          lev_distance: best.lev_distance,
        },
      }
    }
  }
  // Step 4 — widen to the whole body. Skip on bodies > GLOBAL_WIDEN_MAX_BODY_BYTES
  // and stride the scanner (see GLOBAL_WIDEN constants above) so a
  // multi-MB doc edit cannot hang the walker hook.
  if (
    anchored.length > 0 &&
    new_body.length > 0 &&
    new_body.length <= GLOBAL_WIDEN_MAX_BODY_BYTES
  ) {
    const stride = Math.max(
      1,
      Math.floor(anchored.length / GLOBAL_WIDEN_STRIDE_DIVISOR),
    )
    const global = bestFuzzyWindow(new_body, anchored, {
      tolerance: RELOCATE_TOLERANCE,
      stride,
    })
    if (global !== null) {
      const start = global.window_start + ctx_before.length
      return {
        kind: 'anchor_drifted',
        metadata: {
          hint_start: start,
          hint_end: start + excerpt.length,
          search_window: { lo: 0, hi: new_body.length },
          confidence: 1 - global.lev_distance / Math.max(1, anchored.length),
          lev_distance: global.lev_distance,
        },
      }
    }
  }
  // Step 5 — dead. The `walker_run_id` is a Crockford-base32 ULID (Argus
  // r1 MINOR #4 — replaces the prior `${Date.now()}-${Math.random()}`
  // shape) so the audit trail sorts monotonically and groups events that
  // landed in the same walker run by lexicographic prefix instead of by
  // a fragile clock-and-random concatenation.
  return {
    kind: 'anchor_dead',
    metadata: {
      last_known_start: previous_start,
      last_known_end: previous_end,
      last_known_text: excerpt,
      walker_run_id: walkerRunId(),
    },
  }
}

/**
 * Mutation operation that triggered the walker. Threaded through the
 * `onMutationSuccess` callback so the walker knows whether to read
 * the new body, emit anchor_dead for every anchor, or relocate
 * across a rename.
 */
export type MutationOp = 'write' | 'delete' | 'move'

export interface MutationSuccessInput {
  op: MutationOp
  project_id: string
  /** The doc path that's NOW canonical — destination on move, the touched path otherwise. */
  path: string
  /** Only set on `op === 'move'`. The source path before the rename. */
  from_path?: string
  /**
   * The new mtime on disk in ms-epoch. Null on delete (the file is
   * gone). The walker stamps every event with this so the
   * materialiser can suppress stale events from a slower concurrent
   * walker (brief § 2.3 / § 4.2).
   */
  new_modified_at: number | null
}

/**
 * Boot-time wiring contract — the gateway constructs an
 * `AnchorWalker` and passes its `handle` method into
 * `DocStoreOptions.onMutationSuccess`. The walker takes ownership of
 * the per-project mutex, the file read, and the event-append.
 */
export type OnMutationSuccess = (input: MutationSuccessInput) => Promise<void>

export interface AnchorWalkerOptions {
  commentStore: CommentStore
  /** Absolute path to `<owner_home>`. The walker reads doc bodies
   *  from `<owner_home>/Projects/<project_id>/docs/<rel>`. */
  owner_home: string
  /** Override the per-project docs root for tests. */
  resolveProjectDocsRoot?: (project_id: string) => string
  /**
   * Structured logger. The boot composer wires
   * `(msg, fields) => console.warn(msg + ' ' + JSON.stringify(fields))`
   * or the gateway's structured-log helper. Defaults to a no-op so
   * tests don't have to inject one.
   */
  log?: (msg: string, fields: Record<string, unknown>) => void
}

/** Author identity stamped on every walker-appended event. */
export const WALKER_AUTHOR_KIND = 'system' as const
export const WALKER_AUTHOR_ID = 'reanchor-walker' as const

export class AnchorWalker {
  private readonly comments: CommentStore
  private readonly owner_home: string
  private readonly resolveProjectDocsRoot: (project_id: string) => string
  private readonly log: (msg: string, fields: Record<string, unknown>) => void
  /** Per-project chained-promise mutex. Mirrors DocVersionStore's
   *  `withCommitLock` so writeDoc → walker → commit-store stay serialised
   *  within a single project. Different projects run concurrently. */
  private readonly projectMutexes = new Map<string, Promise<void>>()

  constructor(opts: AnchorWalkerOptions) {
    this.comments = opts.commentStore
    this.owner_home = opts.owner_home
    this.resolveProjectDocsRoot =
      opts.resolveProjectDocsRoot ??
      ((project_id) => join(opts.owner_home, 'Projects', project_id, 'docs'))
    this.log = opts.log ?? (() => {})
  }

  /**
   * The `onMutationSuccess` entry point. Safe to call from inside
   * `DocStore.writeDoc` / `deleteDoc` / `moveDoc` after the atomic
   * write succeeds. NEVER throws — the doc mutation has already
   * landed; failing the walker would surface as a confusing 500 to
   * the user even though their write succeeded. Every error path is
   * logged + swallowed.
   */
  readonly handle: OnMutationSuccess = async (input) => {
    const project_id = sanitizeProjectId(input.project_id)
    if (project_id === null) {
      this.log('anchor-walker.invalid_project_id', { project_id: input.project_id })
      return
    }
    await this.withProjectLock(project_id, async () => {
      try {
        if (input.op === 'delete') {
          await this.handleDelete(project_id, input.path, input.new_modified_at)
          return
        }
        if (input.op === 'move') {
          if (input.from_path === undefined) {
            this.log('anchor-walker.move_missing_from_path', {
              project_id,
              to: input.path,
            })
            return
          }
          await this.handleMove(
            project_id,
            input.from_path,
            input.path,
            input.new_modified_at,
          )
          return
        }
        await this.handleWrite(project_id, input.path, input.new_modified_at)
      } catch (err) {
        this.log('anchor-walker.unhandled_error', {
          project_id,
          path: input.path,
          op: input.op,
          error: stringifyError(err),
        })
      }
    })
  }

  /**
   * For tests + the future Cores integration. Walks every live +
   * drifted + DEAD anchor on `doc_path` against the supplied
   * `new_body` and appends events. Returns the count of events
   * appended per kind so tests can assert specific shapes without
   * poking the DB.
   *
   * Why include dead: a previously-dead anchor can flip back to
   * `live` when the underlying excerpt re-appears in the doc body
   * (e.g. P7.4 revert restores prior content per brief § 9.3). We
   * re-evaluate every anchor on every write; the matcher will
   * naturally emit `anchor_dead` again if the excerpt is still gone.
   */
  async reanchorAfterEdit(
    project_id: string,
    doc_path: string,
    new_body: string,
    new_modified_at: number,
  ): Promise<{ relocated: number; drifted: number; dead: number }> {
    const anchors = await this.comments.listWalkerAnchors(project_id, doc_path, {
      include_dead: true,
    })
    const counts = { relocated: 0, drifted: 0, dead: 0 }
    for (const a of anchors) {
      const result = relocateAnchor({
        excerpt: a.excerpt,
        ctx_before: a.ctx_before,
        ctx_after: a.ctx_after,
        previous_start: a.previous_start,
        new_body,
      })
      await this.appendWalkerEvent(project_id, {
        event_kind: result.kind,
        doc_path,
        thread_root_id: a.thread_root_id,
        based_on_modified_at: new_modified_at,
        metadata_json: JSON.stringify(result.metadata),
      })
      if (result.kind === 'anchor_relocated') counts.relocated += 1
      else if (result.kind === 'anchor_drifted') counts.drifted += 1
      else counts.dead += 1
    }
    return counts
  }

  /* ─── per-op handlers ───────────────────────────────────────── */

  private async handleWrite(
    project_id: string,
    doc_path: string,
    new_modified_at: number | null,
  ): Promise<void> {
    if (new_modified_at === null) {
      // Write op with no mtime — defensive, would only happen if
      // DocStore wired the callback wrong. Treat as a noop rather
      // than emitting bogus events.
      this.log('anchor-walker.write_missing_mtime', { project_id, doc_path })
      return
    }
    let body: string
    try {
      const abs = join(this.resolveProjectDocsRoot(project_id), doc_path)
      body = await readFile(abs, 'utf8')
    } catch (err) {
      // Race: the doc was deleted between the write success and the
      // walker entering. Treat as delete so anchors flip dead instead
      // of stranding. The write's `new_modified_at` is the effective
      // stamp because the file *was* alive at that time; using it
      // keeps the stale-event filter monotonic if a later writer
      // re-creates the doc on the same path.
      this.log('anchor-walker.write_read_failed', {
        project_id,
        doc_path,
        error: stringifyError(err),
      })
      await this.handleDelete(project_id, doc_path, new_modified_at)
      return
    }
    await this.reanchorAfterEdit(project_id, doc_path, body, new_modified_at)
  }

  private async handleDelete(
    project_id: string,
    doc_path: string,
    new_modified_at: number | null,
  ): Promise<void> {
    // Argus r1 IMPORTANT — stamp delete events with a finite "effective
    // mtime" (wall clock at delete time) so the materialiser's
    // stale-event filter can suppress a slow deleter whose `anchor_dead`
    // lands AFTER a quicker writer's `anchor_relocated` for the same
    // thread. With the prior `null` stamp, the deleter's event was
    // pinned in the fold by the "null = always keep" rule and could
    // permanently clobber a write that semantically happened later.
    // DocStore passes `Date.now()` on delete; tests can pass a
    // deterministic finite value via the `new_modified_at` field. When
    // truly null (legacy fixture / hand-authored event) we fall back to
    // the wall clock so the event still participates in the stale
    // filter instead of becoming a black hole. A shared `walker_run_id`
    // groups every event emitted by this run.
    const effective_modified_at = new_modified_at ?? Date.now()
    const anchors = await this.comments.listWalkerAnchors(project_id, doc_path)
    const run_id = walkerRunId()
    for (const a of anchors) {
      await this.appendWalkerEvent(project_id, {
        event_kind: 'anchor_dead',
        doc_path,
        thread_root_id: a.thread_root_id,
        based_on_modified_at: effective_modified_at,
        metadata_json: JSON.stringify({
          last_known_start: a.previous_start,
          last_known_end: a.previous_end,
          last_known_text: a.excerpt,
          walker_run_id: run_id,
          reason: 'doc_deleted',
        }),
      })
    }
  }

  private async handleMove(
    project_id: string,
    from_path: string,
    to_path: string,
    new_modified_at: number | null,
  ): Promise<void> {
    // ISSUE #20 — per-anchor revalidation across renames.
    //
    // The previous shape unconditionally emitted `anchor_relocated` for
    // every anchor on `from_path`, which produced two bugs:
    //   1. `listWalkerAnchors` defaulted to `include_dead=false`, so dead
    //      anchors on `from_path` were silently orphaned.
    //   2. Drifted anchors (and live anchors whose excerpt was concurrently
    //      erased between the rename and the walker entry) were forcibly
    //      flipped back to LIVE on `to_path` because the materialiser folds
    //      `anchor_relocated` to `status='live'` unconditionally.
    //
    // Fix: list with `include_dead=true` so dead anchors carry over to the
    // new home (as `anchor_dead_moved`), then for every still-relocatable
    // anchor re-run the matcher against the body at `to_path` to confirm
    // the excerpt is still present. Emit `anchor_relocated` / `anchor_drifted`
    // / `anchor_dead_moved` based on the matcher's verdict + the prior
    // status.
    const anchors = await this.comments.listWalkerAnchors(
      project_id,
      from_path,
      { include_dead: true },
    )

    // Read the new body defensively. For a pure rename the bytes don't
    // change; for a rename that races a concurrent overwrite, the body we
    // observe reflects whichever write landed last on disk. The
    // matcher operates on the body we observed — same shape as
    // `handleWrite`.
    let new_body: string
    try {
      const abs = join(this.resolveProjectDocsRoot(project_id), to_path)
      new_body = await readFile(abs, 'utf8')
    } catch (err) {
      this.log('anchor-walker.move_read_failed', {
        project_id,
        from_path,
        to_path,
        error: stringifyError(err),
      })
      // Fall back to "carry over status as-is" with an empty body —
      // the matcher will declare every excerpt dead, which the
      // dead-handler branch below converts to `anchor_dead_moved` so
      // the dead row at least follows the rename.
      new_body = ''
    }

    for (const a of anchors) {
      if (a.status === 'dead') {
        // Previously dead — there's no live excerpt to match, but we
        // want the dead row to live with the file at its new home so
        // the dead-threads side-pane on `to_path` (rather than the
        // stale `from_path`) surfaces it.
        await this.appendWalkerEvent(project_id, {
          event_kind: 'anchor_dead_moved',
          doc_path: to_path,
          thread_root_id: a.thread_root_id,
          based_on_modified_at: new_modified_at,
          metadata_json: JSON.stringify({
            from_doc_path: from_path,
            to_doc_path: to_path,
            last_known_start: a.previous_start,
            last_known_end: a.previous_end,
            last_known_text: a.excerpt,
            reason: 'doc_moved',
          }),
        })
        continue
      }
      // Live or drifted — re-run the matcher against the new body.
      const result = relocateAnchor({
        excerpt: a.excerpt,
        ctx_before: a.ctx_before,
        ctx_after: a.ctx_after,
        previous_start: a.previous_start,
        new_body,
      })
      if (result.kind === 'anchor_relocated') {
        await this.appendWalkerEvent(project_id, {
          event_kind: 'anchor_relocated',
          doc_path: to_path,
          thread_root_id: a.thread_root_id,
          based_on_modified_at: new_modified_at,
          metadata_json: JSON.stringify({
            ...result.metadata,
            from_doc_path: from_path,
            to_doc_path: to_path,
            reason: 'doc_moved',
          }),
        })
      } else if (result.kind === 'anchor_drifted') {
        await this.appendWalkerEvent(project_id, {
          event_kind: 'anchor_drifted',
          doc_path: to_path,
          thread_root_id: a.thread_root_id,
          based_on_modified_at: new_modified_at,
          metadata_json: JSON.stringify({
            ...result.metadata,
            from_doc_path: from_path,
            to_doc_path: to_path,
            reason: 'doc_moved',
          }),
        })
      } else {
        // `anchor_dead` — the rename raced a concurrent edit that
        // erased the excerpt from `to_path`. Emit `anchor_dead_moved`
        // so the dead row lives at `to_path` instead of orphaning on
        // `from_path`.
        await this.appendWalkerEvent(project_id, {
          event_kind: 'anchor_dead_moved',
          doc_path: to_path,
          thread_root_id: a.thread_root_id,
          based_on_modified_at: new_modified_at,
          metadata_json: JSON.stringify({
            from_doc_path: from_path,
            to_doc_path: to_path,
            last_known_start: a.previous_start,
            last_known_end: a.previous_end,
            last_known_text: a.excerpt,
            reason: 'doc_moved_excerpt_lost',
          }),
        })
      }
    }
    // The appendEvent path materialiseForPath(to_path) only walks
    // threads with at least one event on `to_path`. After this loop
    // every moved thread has an event on `to_path`, so the chain
    // pulls in the original `comment_posted` on `from_path` via the
    // involved-threads CTE. No additional materialise pass needed.
  }

  /* ─── plumbing ──────────────────────────────────────────────── */

  private async appendWalkerEvent(
    project_id: string,
    fields: {
      event_kind: WalkerEventKind
      doc_path: string
      thread_root_id: string
      based_on_modified_at: number | null
      metadata_json: string
    },
  ): Promise<void> {
    const input: AppendEventInput = {
      event_kind: fields.event_kind,
      doc_path: fields.doc_path,
      thread_root_id: fields.thread_root_id,
      parent_event_id: null,
      anchor_start: null,
      anchor_end: null,
      anchor_text_excerpt: null,
      anchor_ctx_before: null,
      anchor_ctx_after: null,
      based_on_modified_at: fields.based_on_modified_at,
      author_kind: WALKER_AUTHOR_KIND,
      author_id: WALKER_AUTHOR_ID,
      body: null,
      metadata_json: fields.metadata_json,
    }
    await this.comments.appendEvent(project_id, input)
  }

  private async withProjectLock<T>(
    project_id: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.projectMutexes.get(project_id) ?? Promise.resolve()
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => released)
    this.projectMutexes.set(project_id, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.projectMutexes.get(project_id) === tail) {
        this.projectMutexes.delete(project_id)
      }
    }
  }

  /**
   * P7.2 S3 — public delegate of `withProjectLock` so the per-instance
   * agent watcher (`gateway/comments/agent-watcher.ts`) can share the
   * SAME per-project chained-promise mutex. The walker and watcher
   * must serialise their `appendEvent` + cursor-write critical
   * sections; both grabbing the same mutex via this method guarantees
   * strict ordering between walker `anchor_*` events and watcher
   * `comment_posted` / `agent_reply_skipped` / `escalate_to_chat`
   * events on the same project.
   */
  public withProjectLockExternal<T>(
    project_id: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.withProjectLock(project_id, fn)
  }
}

function walkerRunId(): string {
  // Argus r1 MINOR #4 — ULID instead of `${Date.now()}-${Math.random()}`.
  // ULIDs sort lexicographically by creation time, so an operator
  // grepping the comments-sidecar event log can group all events from a
  // single walker run by their shared `walker_run_id` prefix and see
  // monotonic ordering across runs without parsing two component strings.
  return defaultUlid()
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return String(err)
  } catch {
    return '<unstringifiable>'
  }
}
