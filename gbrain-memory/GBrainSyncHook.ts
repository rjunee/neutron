/**
 * @neutronai/gbrain-memory — GBrain `SyncHook` adapter.
 *
 * Wires the entity-writer (`runtime/entity-writer.ts`) to GBrain, the sole
 * per-project memory store:
 *   1. Persist the page body as a GBrain page (`put_page`).
 *   2. Remove edges that were dropped from the compiled truth on this rewrite
 *      (`remove_link` per removed edge) so the graph mirrors the writer's
 *      "compiled truth is the only source of truth" invariant rather than
 *      accumulating a superset of past assertions. This runs BEFORE the add
 *      pass because `remove_link` is predicate-blind (it deletes ALL link_types
 *      for the `{from,to}` pair) — running it first lets step 3 re-assert any
 *      survivor predicate on a pair that also lost a different predicate.
 *   3. Forward each NEW typed triple to the GBrain graph as a typed edge
 *      (`add_link` — `from`=subject, `to`=object, `link_type`=predicate,
 *      `context`=source), deduped against the existing graph (`get_links` per
 *      subject) so re-writes that surface the same (subject, predicate, object)
 *      tuple don't generate duplicate edges.
 *
 * This is the sole memory-sync hook (it replaced the prior in-tree adapter
 * 1:1) over the same `SyncHook` interface (`runtime/entity-writer.ts:168`) —
 * the entity-writer and auto-link core logic do not change.
 *
 * **Failure model.** The writer guarantees this hook only runs after the
 * canonical entity page is committed to disk. The hook MAY safely throw
 * partway through a batch — the writer catches + logs and the canonical page
 * survives. Downstream-store drift is recoverable by re-writing the page
 * (idempotent — `get_links` dedupe will skip the already-stored edges).
 *
 * **Cross-instance safety.** The constructor accepts an `McpClient` the caller
 * has already scoped to the instance (per-instance systemd unit sets
 * `GBRAIN_BRAIN_ID` / `GBRAIN_SOURCE` before launching `gbrain serve`). The
 * hook does NOT cross-check instance identity — it trusts the client it's
 * handed.
 */

import type { Triple } from '../runtime/auto-link.ts'
import type { SyncHook } from '../runtime/entity-writer.ts'
import { GBrainUnavailableError, type McpClient, type MemoryStore } from './memory-store.ts'

/**
 * Map the on-disk `entities/<dir>/` subdirectory name back to the entity kind
 * that produced it. Mirrors `KIND_TO_DIR` in `runtime/entity-writer.ts` —
 * duplicated by design because the sync hook treats the writer output path as
 * ground truth (the writer is upstream, not a peer module).
 */
const DIR_TO_KIND: Readonly<Record<string, string>> = Object.freeze({
  people: 'person',
  companies: 'company',
  projects: 'project',
  meetings: 'meeting',
  concepts: 'concept',
  originals: 'original',
})

export interface GBrainSyncHookOptions {
  /**
   * Per-project memory store (today: a GBrain-backed `MemoryStore`). Persists
   * the page body via `put_page`.
   */
  memoryStore: MemoryStore
  /**
   * Per-instance GBrain MCP client. MUST already be scoped to the instance — the
   * hook does not verify scoping. Reaches the typed-edge graph that
   * `MemoryStore` does not expose.
   */
  gbrainMcp: McpClient
  /**
   * Optional structured-log sink for non-fatal failures. Defaults to
   * `console.error`. Tests pass a capturing sink.
   */
  logFailure?: (event: SyncHookFailureEvent) => void
  /**
   * Cap on the deferred-edge retry queue (ISSUES #102). When a new deferral
   * would exceed this, the oldest deferred edge is abandoned (single warning).
   * Bounds memory for targets that never land. Default 500.
   */
  maxDeferredEdges?: number
  /**
   * Max number of drain re-attempts a single deferred edge may accrue before
   * it is abandoned (single warning). Bounds a re-drain loop where an edge is
   * re-attempted on every write of its target slug but is never satisfiable
   * (e.g. its OTHER endpoint never lands). Default 5.
   */
  maxDeferredAttempts?: number
}

export interface SyncHookFailureEvent {
  stage:
    | 'gbrain_put_page'
    | 'gbrain_link_query'
    | 'gbrain_add_link'
    | 'gbrain_remove_link'
    // 2026-06-10 wow-hang-resilience: the gbrain binary is missing on this
    // host — sync is disabled for the process lifetime. Logged exactly ONCE;
    // all subsequent entity writes short-circuit silently.
    | 'gbrain_unavailable'
    // ISSUES #102 deferred-edge retry queue: an add_link to a not-yet-written
    // target was enqueued for retry (not dropped) …
    | 'gbrain_add_link_deferred'
    // … or abandoned (queue cap exceeded, or the per-edge attempt cap reached).
    | 'gbrain_add_link_abandoned'
  path: string
  /**
   * When the stage is `gbrain_link_query` / `gbrain_add_link` /
   * `gbrain_remove_link` / `gbrain_add_link_deferred` /
   * `gbrain_add_link_abandoned`, the triple that failed/deferred. Absent for
   * `gbrain_put_page`.
   */
  triple?: Triple
  err: unknown
}

const DEFAULT_MAX_DEFERRED_EDGES = 500
const DEFAULT_MAX_DEFERRED_ATTEMPTS = 5

interface DeferredEdge {
  triple: Triple
  path: string
  /** Number of drain re-attempts already spent on this edge. */
  attempts: number
}

export class GBrainSyncHook implements SyncHook {
  private readonly memoryStore: MemoryStore
  private readonly mcp: McpClient
  private readonly logFailure: (event: SyncHookFailureEvent) => void
  private readonly maxDeferredEdges: number
  private readonly maxDeferredAttempts: number

  /**
   * ISSUES #102 deferred-edge retry queue, keyed by the edge's TARGET slug
   * (`triple.object`) — the endpoint that typically isn't written yet. After a
   * page lands via `put_page`, the bucket for that slug is drained and its
   * edges re-attempted. `deferredCount` mirrors the total across buckets so the
   * cap check is O(1).
   */
  private readonly deferred = new Map<string, DeferredEdge[]>()
  private deferredCount = 0

  /**
   * 2026-06-10 wow-hang-resilience — true once any GBrain op failed with
   * `GBrainUnavailableError` (binary missing; latched permanently by the
   * stdio client). Every subsequent `onEntityWrite` returns immediately:
   * the canonical pages on disk stay authoritative, the degradation was
   * logged once, and there is no per-page/per-edge failure storm.
   */
  private gbrainUnavailable = false

  constructor(opts: GBrainSyncHookOptions) {
    this.memoryStore = opts.memoryStore
    this.mcp = opts.gbrainMcp
    this.logFailure = opts.logFailure ?? defaultLogFailure
    this.maxDeferredEdges = opts.maxDeferredEdges ?? DEFAULT_MAX_DEFERRED_EDGES
    this.maxDeferredAttempts = opts.maxDeferredAttempts ?? DEFAULT_MAX_DEFERRED_ATTEMPTS
  }

  /** Total edges currently held in the deferred-retry queue (test/observability). */
  get deferredEdgeCount(): number {
    return this.deferredCount
  }

  async onEntityWrite(input: {
    path: string
    body: string
    newLinks: Triple[]
    removedLinks: Triple[]
  }): Promise<void> {
    if (this.gbrainUnavailable) return
    const meta = parseEntityPath(input.path)

    // 1. Persist the page body as a GBrain page. The slug is the entity slug;
    //    GBrain stores the full markdown (frontmatter + compiled-truth +
    //    timeline) and chunks/indexes it. We surface entity metadata so the
    //    admin browse + future filters can scope cheaply.
    let pageLanded = false
    try {
      await this.memoryStore.add({
        content: input.body,
        metadata: {
          entity_kind: meta.kind,
          entity_slug: meta.slug,
          path: input.path,
          slug: meta.slug,
        },
      })
      pageLanded = true
    } catch (err) {
      // Binary-missing → log ONCE + stop. Every other op in this write (and
      // every future write) would fail identically; the storm is noise.
      if (this.latchIfUnavailable(input.path, err)) return
      // Per the writer's failure model, we MUST NOT crash here — the
      // canonical page is already committed. Log + continue so the graph half
      // of the sync still happens (typed edges are independently useful even
      // if the body didn't land).
      this.logFailure({ stage: 'gbrain_put_page', path: input.path, err })
    }

    // 2. Remove edges the new compiled truth no longer asserts. This MUST run
    //    BEFORE the add pass (step 3). GBrain's `remove_link` is
    //    predicate-blind — it takes only `{from,to}` and the engine
    //    soft-deletes ALL `link_type`s between the pair (the DB is the derived
    //    index; the page markdown is the system of record), so the removed edge
    //    falls out of present-time graph queries while history stays intact.
    //
    //    The ordering matters for the multi-predicate-same-pair case: when a
    //    page keeps one predicate but drops another for the SAME
    //    (subject,object) pair, `removedLinks` carries only the dropped
    //    predicate, yet remove_link nukes BOTH. Running removals first lets the
    //    add pass below RE-ASSERT the survivor (its get_links dedupe probe now
    //    sees the pair gone, so it re-adds). The reverse order would add the
    //    survivor, then the predicate-blind remove would silently delete it.
    for (const triple of input.removedLinks) {
      // ISSUES #102 (Codex P2): also purge any DEFERRED edge for this pair. If
      // an edge was deferred (target absent) and a later rewrite drops it from
      // compiled truth BEFORE the target lands, the queued edge must not be
      // resurrected when the target eventually arrives — that would reintroduce
      // a link the page no longer asserts, violating the compiled-truth-is-
      // source-of-record invariant. Predicate-blind, mirroring remove_link.
      this.purgeDeferred(triple)
      try {
        await this.mcp.call('remove_link', {
          from: triple.subject,
          to: triple.object,
        })
      } catch (err) {
        if (this.latchIfUnavailable(input.path, err)) return
        this.logFailure({
          stage: 'gbrain_remove_link',
          path: input.path,
          triple,
          err,
        })
        // Continue the batch — same best-effort policy as add_link.
      }
    }

    // 3. Dedupe + forward triples to the GBrain graph as typed edges. Runs
    //    AFTER the remove pass so survivors of a predicate-blind removal (a
    //    kept predicate on a pair that also lost a predicate) are re-asserted.
    for (const triple of input.newLinks) {
      await this.addLinkOrDefer(triple, input.path, 0)
      if (this.gbrainUnavailable) return
    }

    // 4. ISSUES #102 — drain the deferred-edge retry queue for the slug that
    //    just landed. An earlier write may have produced an add_link whose
    //    target was this page (then absent); now that the page exists, the
    //    edge can land. Only drain when the page actually persisted, otherwise
    //    the target still doesn't exist and the re-attempt would just re-defer.
    //    This complements (does NOT replace) gbrain's auto_link reconciliation
    //    backstop — it closes the order-dependence on the auto_link-disabled
    //    path where nothing re-derives dropped edges.
    if (pageLanded) {
      await this.drainDeferredFor(meta.slug)
    }
  }

  /**
   * Forward one typed triple to the GBrain graph, deduped against the existing
   * graph. On a missing-page failure (the target slug — or, rarely, the source
   * — isn't written yet) the edge is DEFERRED for retry rather than dropped
   * (ISSUES #102). Any other add_link failure keeps the prior best-effort
   * log-and-drop behaviour. `attempts` is the number of drain re-attempts this
   * edge has already accrued (0 on the first, primary-pass call).
   */
  private async addLinkOrDefer(triple: Triple, path: string, attempts: number): Promise<void> {
    let exists = false
    try {
      exists = await linkExists(this.mcp, triple)
    } catch (err) {
      if (this.latchIfUnavailable(path, err)) return
      // A failed dedupe query is recoverable — re-running the write will
      // re-dedupe. Log + skip this triple rather than risk a duplicate edge.
      this.logFailure({ stage: 'gbrain_link_query', path, triple, err })
      return
    }
    if (exists) return
    try {
      await this.mcp.call('add_link', {
        from: triple.subject,
        to: triple.object,
        link_type: triple.predicate,
        context: triple.source,
      })
    } catch (err) {
      if (this.latchIfUnavailable(path, err)) return
      if (isMissingPageError(err)) {
        // ISSUES #102: the endpoint page isn't written yet. Defer + retry on a
        // later put_page rather than silently dropping the edge.
        this.enqueueDeferred(triple, path, attempts, err)
      } else {
        this.logFailure({ stage: 'gbrain_add_link', path, triple, err })
        // Continue the batch — best-effort fan-out, don't abort on first
        // failure.
      }
    }
  }

  /**
   * 2026-06-10 wow-hang-resilience — when `err` means the gbrain binary is
   * missing (a `GBrainUnavailableError` from the latched stdio client), set
   * the hook-level latch and emit exactly ONE `gbrain_unavailable` event.
   * Returns true when latched so callers can short-circuit their batch.
   */
  private latchIfUnavailable(path: string, err: unknown): boolean {
    if (!(err instanceof GBrainUnavailableError)) return false
    if (!this.gbrainUnavailable) {
      this.gbrainUnavailable = true
      this.logFailure({ stage: 'gbrain_unavailable', path, err })
    }
    return true
  }

  /**
   * Enqueue an edge for deferred retry, keyed by its target slug. Bounded two
   * ways so it can never grow without limit or churn forever:
   *   - per-edge: an edge that has already spent `maxDeferredAttempts` drain
   *     re-attempts is abandoned (its OTHER endpoint never landed).
   *   - global: when the queue is full, the OLDEST deferred edge is evicted and
   *     abandoned so the newcomer fits (targets that never land age out).
   * Either abandonment emits exactly one `gbrain_add_link_abandoned` warning.
   */
  private enqueueDeferred(triple: Triple, path: string, attempts: number, err: unknown): void {
    if (attempts >= this.maxDeferredAttempts) {
      this.logFailure({ stage: 'gbrain_add_link_abandoned', path, triple, err })
      return
    }
    const bucket = this.deferred.get(triple.object) ?? []
    // Dedupe against the queue: a page rewritten repeatedly while its target is
    // still missing must not stack N copies of the same edge. (The drain's
    // get_links probe would collapse them at add time, but bounding the queue
    // here keeps the cap meaningful.) Same (subject,predicate,object) already
    // queued → no-op (keep the earliest, lower attempt count).
    if (bucket.some((e) => e.triple.subject === triple.subject && e.triple.predicate === triple.predicate)) {
      return
    }
    if (this.deferredCount >= this.maxDeferredEdges) {
      this.evictOldestDeferred()
    }
    bucket.push({ triple, path, attempts })
    this.deferred.set(triple.object, bucket)
    this.deferredCount += 1
    this.logFailure({ stage: 'gbrain_add_link_deferred', path, triple, err })
  }

  /**
   * Purge every deferred edge for a removed (subject,object) pair — called when
   * a rewrite drops the edge from compiled truth. Predicate-blind, mirroring
   * GBrain's `remove_link`: an edge no longer asserted by the page must not be
   * resurrected by a later drain once its target finally lands (Codex P2).
   */
  private purgeDeferred(removed: Triple): void {
    const bucket = this.deferred.get(removed.object)
    if (bucket === undefined) return
    const kept = bucket.filter((e) => e.triple.subject !== removed.subject)
    const dropped = bucket.length - kept.length
    if (dropped === 0) return
    this.deferredCount -= dropped
    if (kept.length === 0) this.deferred.delete(removed.object)
    else this.deferred.set(removed.object, kept)
  }

  /** Evict + abandon the oldest deferred edge (FIFO across insertion order). */
  private evictOldestDeferred(): void {
    for (const [key, bucket] of this.deferred) {
      const victim = bucket.shift()
      if (bucket.length === 0) this.deferred.delete(key)
      if (victim !== undefined) {
        this.deferredCount -= 1
        this.logFailure({
          stage: 'gbrain_add_link_abandoned',
          path: victim.path,
          triple: victim.triple,
          err: new Error('deferred-edge queue cap exceeded; oldest edge abandoned'),
        })
      }
      return
    }
  }

  /**
   * Re-attempt every deferred edge whose target slug just landed. Pulls the
   * bucket out first (so a re-defer doesn't re-process within the same drain),
   * then re-runs each through `addLinkOrDefer` with an incremented attempt
   * count — a still-unsatisfiable edge re-defers (or is abandoned at the cap).
   */
  private async drainDeferredFor(slug: string): Promise<void> {
    const bucket = this.deferred.get(slug)
    if (bucket === undefined || bucket.length === 0) return
    this.deferred.delete(slug)
    this.deferredCount -= bucket.length
    for (const edge of bucket) {
      await this.addLinkOrDefer(edge.triple, edge.path, edge.attempts + 1)
    }
  }
}

/**
 * Derive `(kind, slug)` from a writer-produced absolute path
 * (`<ownerDataDir>/entities/<kind-dir>/<slug>.md`). Throws if the path shape
 * is unrecognised — the writer guarantees the shape, so any mismatch
 * indicates a contract violation worth surfacing.
 */
function parseEntityPath(absPath: string): { kind: string; slug: string } {
  const parts = absPath.split('/')
  if (parts.length < 3) {
    throw new Error(`unrecognised entity path shape: ${absPath}`)
  }
  const fname = parts[parts.length - 1] ?? ''
  const dir = parts[parts.length - 2] ?? ''
  if (!fname.endsWith('.md')) {
    throw new Error(`entity path does not end in .md: ${absPath}`)
  }
  const slug = fname.slice(0, -3)
  const kind = DIR_TO_KIND[dir]
  if (kind === undefined) {
    throw new Error(`unrecognised entity subdir "${dir}" in path: ${absPath}`)
  }
  return { kind, slug }
}

/**
 * Probe the GBrain graph for an existing edge matching (subject, predicate,
 * object). Returns true if `get_links(subject)` already contains an edge to
 * `object` with the same `predicate`.
 *
 * GBrain's `get_links` returns rows shaped `{ from_slug, to_slug, link_type,
 * context, … }`. We also accept the generic `{ from, to, predicate }` shape so
 * the dedupe is independent of minor GBrain response-shape drift.
 */
async function linkExists(mcp: McpClient, t: Triple): Promise<boolean> {
  const res = await mcp.call('get_links', { slug: t.subject })
  const rows = extractRows(res)
  return rows.some((row) => isEdgeMatch(row, t))
}

function isEdgeMatch(row: unknown, t: Triple): boolean {
  if (row === null || typeof row !== 'object') return false
  const o = row as Record<string, unknown>
  const to = o['to_slug'] ?? o['to'] ?? o['object']
  const predicate = o['link_type'] ?? o['predicate']
  if (to !== t.object) return false
  // A row without a typed predicate is treated as a match on the endpoint
  // alone (conservative: avoids a duplicate edge when GBrain stored an
  // untyped link). When the predicate is present it must match.
  return predicate === undefined || predicate === t.predicate
}

function extractRows(res: unknown): unknown[] {
  if (Array.isArray(res)) return res
  if (res === null || res === undefined) return []
  if (typeof res !== 'object') return []
  const obj = res as Record<string, unknown>
  for (const key of ['links', 'rows', 'results', 'result', 'data', 'edges']) {
    const v = obj[key]
    if (Array.isArray(v)) return v
  }
  // An object envelope without an enumerable list of rows is treated as "no
  // match" — the conservative choice. The alternative (treat any truthy
  // envelope as "exists") would suppress legitimate add_link calls.
  return []
}

/**
 * Detect GBrain's "endpoint page does not exist yet" add_link failure (ISSUES
 * #102). GBrain's `addLink` pre-checks both endpoints and throws
 * `addLink failed: page "<from>" (...) or "<to>" (...) not found` when either is
 * absent (`pglite-engine.ts` addLink). We match on the stable `not found`
 * marker so a not-yet-written target slug defers + retries instead of dropping,
 * while genuinely-different add_link errors (transient DB / transport) keep the
 * prior log-and-drop best-effort behaviour.
 */
function isMissingPageError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /not found/i.test(msg)
}

function defaultLogFailure(event: SyncHookFailureEvent): void {
  const msg = event.err instanceof Error ? event.err.message : String(event.err)
  const tripleSuffix =
    event.triple !== undefined
      ? ` triple=${event.triple.subject}|${event.triple.predicate}|${event.triple.object}`
      : ''
  console.error(
    `[gbrain-sync-hook] stage=${event.stage} path=${event.path}${tripleSuffix} err=${msg}`,
  )
}

export {
  parseEntityPath as _parseEntityPath,
  extractRows as _extractRows,
  isEdgeMatch as _isEdgeMatch,
  isMissingPageError as _isMissingPageError,
  // G3 (mirror-parity guardrail): expose the dir→kind map so a golden-
  // roundtrip test can pin it as the exact inverse of `KIND_TO_DIR` in
  // `runtime/entity-writer.ts` / `scribe/write-to-gbrain.ts`.
  DIR_TO_KIND as _DIR_TO_KIND,
}
