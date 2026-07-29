/**
 * Unified project list — the shared-project LISTER (connect-spec §1.7). A user
 * sees a single flattened list of (their own instance's private projects) ∪
 * (the shared projects they can access on other people's instances). This is a
 * thin cross-instance LISTING (metadata only, name/id) — NOT content
 * aggregation: a collaborator participates LIVE against the host, and the
 * content-sync mesh that used to back this was ripped (connect-spec §2.1).
 *
 * Surface: returns a `ProjectRef[]` deduplicated by `(owning_instance_slug,
 * project_id)`. Sources:
 *   - the user's own instance — local private projects
 *   - each host instance the user has a shared-project membership on — the
 *     project list metadata fetched via that host's connect API
 *     (`GET /connect/v1/projects`)
 *
 * Caching: 30s TTL per (user_id, base_url) pair. Per-process, not shared.
 * Aggressive enough to absorb a UI poll every few seconds; loose enough
 * to pick up a freshly-shared project within half a minute.
 */

import type { ProjectRef } from './api/server.ts'

export interface UnifiedProjectListSource {
  /** Slug of the workspace instance we're querying. */
  instance_slug: string
  /** Base URL of that workspace instance's cross-instance API. */
  base_url: string
  /** Bearer token authorized for `aud=connect.<workspace_slug>`. */
  bearer_token: string
}

export interface UnifiedProjectListInput {
  /** The querying owner's instance slug. */
  user_instance_slug: string
  /** Local solo projects from the owner's own instance DB. P1 ships this as
   *  a caller-provided list because the per-instance projects table is
   *  introduced in P3 alongside Cores; the cross-instance API surface is
   *  what's load-bearing right now. */
  local_solo_projects: ReadonlyArray<ProjectRef>
  /** Workspace instances the user belongs to. */
  instance_sources: ReadonlyArray<UnifiedProjectListSource>
  /** Override the wall clock + fetch (tests). */
  now?: () => number
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  /** Per-workspace fetch deadline in ms. Defaults to
   *  `PER_INSTANCE_TIMEOUT_MS` (5s). Overridable so tests can exercise the
   *  abort path without a 5s wall-clock wait — production never sets it. */
  timeout_ms?: number
  /** Override the cache (tests / server reuse a long-lived instance). */
  cache?: ProjectListCache
}

export interface UnifiedProjectListResult {
  projects: ProjectRef[]
  /**
   * Per-source health — non-2xx fetches do NOT throw because partial
   * results are still useful UX (one degraded workspace shouldn't blank
   * the user's whole project list). The caller can render an "X workspaces
   * unreachable" badge from this field.
   */
  source_errors: Array<{ instance_slug: string; error: string }>
}

const DEFAULT_CACHE_TTL_MS = 30_000

/**
 * Per-workspace fetch deadline (brief § graceful-degradation). A workspace
 * that's mid-provisioning can accept the TCP connection but never respond
 * (process up, HTTP listener not yet serving). Without a deadline that one
 * hung socket stalls the whole fan-out — the user's entire project list
 * blanks behind a single sick workspace. 5s is generous for a healthy
 * loopback / same-DC round-trip and short enough that a hung workspace
 * degrades to a `timeout` source_error while every other workspace returns
 * normally.
 */
const PER_INSTANCE_TIMEOUT_MS = 5_000

interface CacheEntry {
  projects: ProjectRef[]
  expires_at: number
}

/**
 * Per-process per-(user, source) project list cache. Distinct from the
 * JWKS cache — that cache covers identity-service round-trips; this one
 * covers cross-instance API round-trips.
 */
export class ProjectListCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly ttlMs: number

  constructor(ttlMs: number = DEFAULT_CACHE_TTL_MS) {
    this.ttlMs = ttlMs
  }

  private key(user: string, base_url: string): string {
    return `${user}|${base_url}`
  }

  get(user: string, base_url: string, now: number): ProjectRef[] | null {
    const k = this.key(user, base_url)
    const entry = this.entries.get(k)
    if (entry === undefined) return null
    if (now >= entry.expires_at) {
      this.entries.delete(k)
      return null
    }
    return entry.projects
  }

  set(user: string, base_url: string, now: number, projects: ProjectRef[]): void {
    this.entries.set(this.key(user, base_url), {
      projects,
      expires_at: now + this.ttlMs,
    })
  }

  invalidate(user?: string): void {
    if (user === undefined) {
      this.entries.clear()
      return
    }
    for (const k of [...this.entries.keys()]) {
      if (k.startsWith(`${user}|`)) this.entries.delete(k)
    }
  }

  size(): number {
    return this.entries.size
  }
}

const realFetch: (input: string, init?: RequestInit) => Promise<Response> = (
  input,
  init,
) => globalThis.fetch(input, init)

/**
 * Map a non-timeout fetch failure to a stable, client-safe code. Raw
 * `err.message` for a loopback fan-out leaks the workspace's internal
 * address + port (e.g. `ECONNREFUSED 127.0.0.1:53187`) straight into the
 * client-facing `source_errors[].error` — an information leak and an
 * unstable string the UI can't switch on. We classify by the standard
 * Node/undici error code (`err.code`, also embedded in `err.cause`) into a
 * small closed set; anything unrecognised collapses to `fetch_failed` so
 * we never echo a raw message.
 */
function normalizeFetchError(err: unknown): string {
  const code = extractErrorCode(err)
  switch (code) {
    case 'ECONNREFUSED':
      return 'connection_refused'
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
      return 'network_unreachable'
    case 'ECONNRESET':
    case 'EPIPE':
      return 'connection_reset'
    case 'ETIMEDOUT':
      return 'timeout'
    default:
      return 'fetch_failed'
  }
}

/** Pull a `code` string off an error or its `cause` (undici nests it). */
function extractErrorCode(err: unknown): string | undefined {
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      'code' in candidate &&
      typeof (candidate as { code?: unknown }).code === 'string'
    ) {
      return (candidate as { code: string }).code
    }
  }
  return undefined
}

/**
 * Resolve the user's unified project list. Solo projects are caller-
 * provided (local DB); group projects are fetched from each
 * workspace instance's cross-instance API in parallel + cached for 30s.
 */
export async function getUnifiedProjects(
  input: UnifiedProjectListInput,
): Promise<UnifiedProjectListResult> {
  const now = (input.now ?? Date.now)()
  const cache = input.cache ?? new ProjectListCache()
  const fetchImpl = input.fetch ?? realFetch
  const timeoutMs = input.timeout_ms ?? PER_INSTANCE_TIMEOUT_MS

  type SourceResult =
    | { kind: 'ok'; projects: ProjectRef[]; src: UnifiedProjectListSource }
    | { kind: 'err'; src: UnifiedProjectListSource; error: string }

  const perSource = async (
    src: UnifiedProjectListSource,
  ): Promise<SourceResult> => {
    const cached = cache.get(input.user_instance_slug, src.base_url, now)
    if (cached !== null) return { kind: 'ok', projects: cached, src }
    // One signal for the WHOLE round-trip (headers AND body). A workspace
    // that's mid-provisioning can return 200 + headers immediately then
    // stall the body forever; binding the timeout only to the header phase
    // would let that hung body hang past the deadline — the exact failure
    // mode the per-workspace deadline exists to kill. We thread this same
    // signal into the body read and re-check `signal.aborted` after it so
    // a stalled body degrades to a `timeout` source_error like a stalled
    // header does.
    const signal = AbortSignal.timeout(timeoutMs)
    try {
      const res = await fetchImpl(
        `${src.base_url.replace(/\/+$/, '')}/connect/v1/projects`,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${src.bearer_token}`,
            'x-origin-instance': input.user_instance_slug,
          },
          // Per-workspace deadline — a hung workspace aborts here instead of
          // stalling the whole fan-out. See PER_INSTANCE_TIMEOUT_MS.
          signal,
        },
      )
      if (!res.ok) {
        return { kind: 'err', src, error: `http_${res.status}` }
      }
      // `res.json()` consumes the body stream, which the same `signal`
      // aborts when the deadline fires (undici/Bun reject the read). The
      // explicit post-read `signal.aborted` check is belt-and-suspenders for
      // any fetch impl that resolves the read without honouring the signal:
      // we refuse to cache or return a body we raced past the deadline.
      const body = (await res.json()) as { projects?: ProjectRef[] }
      if (signal.aborted) return { kind: 'err', src, error: 'timeout' }
      const projects = Array.isArray(body.projects) ? body.projects : []
      cache.set(input.user_instance_slug, src.base_url, now, projects)
      return { kind: 'ok', projects, src }
    } catch (err) {
      // AbortSignal.timeout rejects with a DOMException named 'TimeoutError'
      // (a DOMException IS an Error in modern runtimes); surface it as a
      // stable `timeout` code so the UI can distinguish a slow/hung
      // workspace from an outright connection failure. A signal that has
      // already fired but threw some other shape still reads as a timeout.
      const isTimeout =
        (err instanceof Error && err.name === 'TimeoutError') || signal.aborted
      return {
        kind: 'err',
        src,
        error: isTimeout ? 'timeout' : normalizeFetchError(err),
      }
    }
  }

  // Promise.allSettled per the brief's graceful-degradation contract: one
  // workspace failing (even in a way that escapes `perSource`'s own catch)
  // must NEVER reject the whole aggregate. `perSource` resolves to ok|err
  // for every expected failure; allSettled is the safety net for anything
  // unforeseen, mapped back to a source_error by index so we never lose the
  // `src` association.
  const settled = await Promise.allSettled(input.instance_sources.map(perSource))
  const fromInstances: SourceResult[] = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value
    const src = input.instance_sources[i]!
    return {
      kind: 'err',
      src,
      error: r.reason instanceof Error ? r.reason.message : 'fetch_failed',
    }
  })

  const seen = new Set<string>()
  const projects: ProjectRef[] = []
  const pushUnique = (p: ProjectRef): void => {
    const k = `${p.owning_instance_slug}|${p.project_id}`
    if (seen.has(k)) return
    seen.add(k)
    projects.push(p)
  }
  for (const p of input.local_solo_projects) pushUnique(p)
  for (const r of fromInstances) {
    if (r.kind === 'ok') for (const p of r.projects) pushUnique(p)
  }
  const source_errors = fromInstances
    .filter((r): r is { kind: 'err'; src: UnifiedProjectListSource; error: string } => r.kind === 'err')
    .map((r) => ({ instance_slug: r.src.instance_slug, error: r.error }))
  return { projects, source_errors }
}
