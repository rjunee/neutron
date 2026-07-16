/**
 * @neutronai/gateway/http — slug-history lookup + LRU cache for the JWT shim.
 *
 * D3 (2026-07) — extracted out of `chat-bridge.ts` as a pure type/impl move
 * (no behavior change). `chat-bridge.ts` re-exports these symbols so existing
 * internal + external `import ... from '.../chat-bridge.ts'` callers keep
 * resolving unchanged; new/repointed callers should import directly from this
 * sibling leaf module instead.
 */

/**
 * P1.5 § 1.5.5 — slug-history lookup for the JWT shim. Caches positive
 * matches in an LRU; on rename the renameUrlSlug orchestrator pushes a
 * cache-invalidate so the entry refreshes from the DB on next access.
 */
export interface SlugHistoryShimStore {
  /**
   * Returns the row matching (`old_slug`, `owner_handle`) when
   * present and non-expired, else null.
   */
  lookup(input: {
    old_slug: string
    owner_handle: string
    now_ms: number
  }): Promise<{ expires_at_ms: number } | null>
}

export class InMemorySlugHistoryCache implements SlugHistoryShimStore {
  private readonly cache = new Map<string, { expires_at_ms: number; cached_at_ms: number }>()
  private readonly inner: SlugHistoryShimStore
  private readonly ttl_ms: number
  private readonly now: () => number

  constructor(input: {
    inner: SlugHistoryShimStore
    /** Pull-style TTL fallback if push-invalidate misses. Default 5min. */
    ttl_ms?: number
    now?: () => number
  }) {
    this.inner = input.inner
    this.ttl_ms = input.ttl_ms ?? 5 * 60 * 1000
    this.now = input.now ?? ((): number => Date.now())
  }

  async lookup(input: {
    old_slug: string
    owner_handle: string
    now_ms: number
  }): Promise<{ expires_at_ms: number } | null> {
    const key = `${input.old_slug}::${input.owner_handle}`
    const cached = this.cache.get(key)
    if (cached !== undefined && this.now() - cached.cached_at_ms < this.ttl_ms) {
      if (cached.expires_at_ms >= input.now_ms) {
        return { expires_at_ms: cached.expires_at_ms }
      }
      // Expired during cache validity — drop.
      this.cache.delete(key)
      return null
    }
    const fresh = await this.inner.lookup(input)
    if (fresh !== null) {
      this.cache.set(key, {
        expires_at_ms: fresh.expires_at_ms,
        cached_at_ms: this.now(),
      })
    }
    return fresh
  }

  /** Push-style invalidate fired by the rename orchestrator. */
  invalidateOwnerHandle(owner_handle: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.endsWith(`::${owner_handle}`)) {
        this.cache.delete(key)
      }
    }
  }

  invalidateAll(): void {
    this.cache.clear()
  }
}

/**
 * Adapter from the registry's SlugHistoryStore (sync, returns expires_at
 * in unix-seconds) to the shim's async expires_at_ms shape.
 */
export function buildSlugHistoryShimFromRegistry(input: {
  /** Function returning a slug_history row (sync, like SlugHistoryStore.lookup). */
  lookup: (
    old_slug: string,
    owner_handle: string,
  ) => { expires_at: number } | undefined
}): SlugHistoryShimStore {
  return {
    async lookup({ old_slug, owner_handle, now_ms }) {
      const row = input.lookup(old_slug, owner_handle)
      if (row === undefined) return null
      const expires_at_ms = row.expires_at * 1000
      if (expires_at_ms < now_ms) return null
      return { expires_at_ms }
    },
  }
}
