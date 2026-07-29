/**
 * @neutronai/doc-search — runtime wrapper.
 *
 * Binds a `DocSearchIndex` to an `owner_home` and exposes the three
 * operations the agent tools need: `search`, `read`, and `ensureFresh`.
 * `ensureFresh` is throttled (debounced by a min-interval) so calling
 * it before every search costs at most one incremental disk-diff per
 * interval, not a full re-walk per keystroke.
 *
 * The whole thing constructs synchronously (open the SQLite handle) so
 * it can be built inside the gateway's synchronous `tools` module init;
 * the first refresh happens lazily on the first `ensureFresh()` call.
 */

import { createLogger } from '@neutronai/logger'
import { readProjectDoc } from './walk.ts'
import { refreshIndex, type RefreshDeps, type RefreshStats } from './indexer.ts'

const runtimeLog = createLogger('doc-search')
import type { DocSearchHit, DocSearchIndex, SearchInput } from './store.ts'

export interface DocSearchRuntimeOptions {
  ownerHome: string
  index: DocSearchIndex
  /**
   * Minimum ms between disk refreshes triggered by `ensureFresh`.
   * Default 5000. A refresh is incremental (mtime-diff), so this just
   * caps churn under a burst of searches.
   */
  refreshIntervalMs?: number
  /** Test seams forwarded to `refreshIndex`. */
  enumerateProjects?: RefreshDeps['enumerateProjects']
  walk?: RefreshDeps['walk']
  maxChunkChars?: number
  log?: (msg: string) => void
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number
}

export class DocSearchRuntime {
  private readonly ownerHome: string
  private readonly index: DocSearchIndex
  private readonly intervalMs: number
  private readonly now: () => number
  private readonly refreshDeps: RefreshDeps
  private lastRefreshAt = 0
  private inFlight: Promise<RefreshStats> | null = null

  constructor(options: DocSearchRuntimeOptions) {
    this.ownerHome = options.ownerHome
    this.index = options.index
    this.intervalMs = options.refreshIntervalMs ?? 5000
    this.now = options.now ?? Date.now
    const deps: RefreshDeps = { ownerHome: options.ownerHome, index: options.index }
    if (options.enumerateProjects !== undefined) deps.enumerateProjects = options.enumerateProjects
    if (options.walk !== undefined) deps.walk = options.walk
    if (options.maxChunkChars !== undefined) deps.maxChunkChars = options.maxChunkChars
    deps.log = options.log ?? ((msg: string): void => runtimeLog.debug(msg))
    this.refreshDeps = deps
  }

  /**
   * Incrementally re-sync the index with disk, at most once per
   * `intervalMs`. Concurrent callers share the in-flight refresh.
   * `force` bypasses the throttle (used by an explicit reindex).
   */
  async ensureFresh(force = false): Promise<void> {
    if (this.inFlight !== null) {
      await this.inFlight
      return
    }
    const elapsed = this.now() - this.lastRefreshAt
    if (!force && this.lastRefreshAt !== 0 && elapsed < this.intervalMs) return
    this.inFlight = refreshIndex(this.refreshDeps)
    try {
      await this.inFlight
      this.lastRefreshAt = this.now()
    } finally {
      this.inFlight = null
    }
  }

  /** Search the corpus (refreshing first). */
  async search(input: SearchInput): Promise<DocSearchHit[]> {
    await this.ensureFresh()
    return this.index.search(input)
  }

  /** Read a single doc by (project, relpath), path-safe. */
  async read(
    project: string,
    path: string,
  ): Promise<{ project: string; path: string; content: string } | null> {
    return readProjectDoc(this.ownerHome, project, path)
  }
}
