/**
 * @neutronai/app — persistent dedupe set for push-tap responses
 * (Argus r1 IMPORTANT — 2026-05-22 round 2 follow-up).
 *
 * The push-tap handler at `app/lib/push.ts:installPushTapHandler`
 * blocks duplicate dispatches by tracking `notification.request.identifier`
 * values it has already routed. Round 1 implemented this as a plain
 * module-level `Set<string>` — sufficient for warm-tap dedupe and the
 * cold-start-on-same-launch case, but force-quit + relaunch wipes the
 * module state. The next launch sees `getLastNotificationResponseAsync`
 * return the same response again (Expo keeps returning the most-recent
 * one until a fresher push arrives) and the dispatcher fires for a
 * second time. Argus filed this as I2.
 *
 * Fix: back the in-memory set with a persistent store using AsyncStorage
 * on native (`localStorage` on web — though web push is currently a
 * no-op, the symmetry keeps the test seam clean) and apply a 7-day
 * TTL so the persisted set doesn't grow unbounded over the lifetime
 * of the app install.
 *
 * Storage shape (single key, single JSON document — small bounded
 * payload, ~50 bytes per entry, bounded by 7-day window of unique
 * pushes the user actually tapped):
 *
 *   {
 *     "entries": {
 *       "<notification.request.identifier>": <unix_ms_at_seen>,
 *       ...
 *     }
 *   }
 *
 * The store self-heals on hydrate (drops malformed JSON, drops entries
 * older than the TTL, drops entries with non-string keys or non-number
 * timestamps) — a corrupted blob never crashes the listener.
 *
 * Tests inject a `KvBacking` directly to exercise hydrate / mark /
 * persistence; the default exported singleton picks AsyncStorage vs
 * `localStorage` at runtime via the same pattern as
 * `lib/last-tab-storage.ts`.
 */

/** Key/value backing — same shape Last-tab + token storage already use. */
export interface KvBacking {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

/** Storage key for the dedupe blob. Single key per device — tiny doc. */
export const PUSH_TAP_DEDUPE_KEY = 'neutron.push.seenTapIds';

/** TTL: drop entries older than 7 days at hydrate time. */
export const PUSH_TAP_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface PersistedDoc {
  entries: Record<string, number>;
}

/**
 * Persistent dedupe set with TTL pruning. NOT thread-safe across
 * processes — but the app runs single-process per device, so racing
 * writes are bounded by the dispatch handler's single-fire semantics.
 */
export class PushTapDedupeStore {
  private readonly memory = new Map<string, number>();
  private hydratedPromise: Promise<void> | null = null;

  constructor(
    private readonly backing: KvBacking,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = PUSH_TAP_DEDUPE_TTL_MS,
  ) {}

  /**
   * Lazily hydrate from the backing store. Idempotent: subsequent
   * calls return the same Promise. Cold-start dispatch awaits this
   * so a same-launch replay sees the just-hydrated entries.
   */
  hydrate(): Promise<void> {
    if (this.hydratedPromise !== null) return this.hydratedPromise;
    this.hydratedPromise = this.hydrateInternal();
    return this.hydratedPromise;
  }

  private async hydrateInternal(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await Promise.resolve(this.backing.getItem(PUSH_TAP_DEDUPE_KEY));
    } catch {
      // Storage unavailable → degrade gracefully. We still dedupe
      // in-memory for this launch; force-quit + relaunch loses it.
      return;
    }
    if (raw === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupted blob — best-effort wipe so we don't keep parsing
      // garbage on every launch.
      void this.backing.removeItem(PUSH_TAP_DEDUPE_KEY);
      return;
    }
    if (parsed === null || typeof parsed !== 'object') return;
    const entries = (parsed as Partial<PersistedDoc>).entries;
    if (entries === null || typeof entries !== 'object' || entries === undefined) {
      return;
    }
    const cutoff = this.now() - this.ttlMs;
    let mutated = false;
    for (const [id, ts] of Object.entries(entries)) {
      if (typeof id !== 'string' || id.length === 0) {
        mutated = true;
        continue;
      }
      if (typeof ts !== 'number' || !Number.isFinite(ts)) {
        mutated = true;
        continue;
      }
      if (ts < cutoff) {
        mutated = true;
        continue;
      }
      this.memory.set(id, ts);
    }
    // Persist the pruned shape so the next hydrate is cheap. Best-
    // effort — a failed write just means we'll re-prune next time.
    if (mutated) {
      void this.flush();
    }
  }

  /** Synchronous membership check — safe to call mid-dispatch. */
  has(id: string): boolean {
    return this.memory.has(id);
  }

  /**
   * Mark an id as seen + persist. Returns a Promise that resolves
   * once the backing write completes. Callers may choose to fire-
   * and-forget (warm-tap path) or await (test seam) — the in-memory
   * set is updated synchronously regardless so the next `has()` call
   * returns true immediately.
   */
  async markSeen(id: string): Promise<void> {
    if (id.length === 0) return;
    this.memory.set(id, this.now());
    await this.flush();
  }

  /** Test seam — clear in-memory + persisted state. */
  async reset(): Promise<void> {
    this.memory.clear();
    this.hydratedPromise = null;
    try {
      await Promise.resolve(this.backing.removeItem(PUSH_TAP_DEDUPE_KEY));
    } catch {
      // ignore
    }
  }

  private async flush(): Promise<void> {
    const entries: Record<string, number> = {}
    for (const [id, ts] of this.memory) {
      entries[id] = ts
    }
    const doc: PersistedDoc = { entries }
    try {
      await Promise.resolve(
        this.backing.setItem(PUSH_TAP_DEDUPE_KEY, JSON.stringify(doc)),
      )
    } catch {
      // Storage write failures are non-fatal — the in-memory set
      // still dedupes for this launch.
    }
  }
}

/**
 * In-memory backing — used when the runtime platform exposes no
 * persistent K/V (bun-test, SSR hydrate before browser globals exist,
 * RN modules unavailable). Tokens DO NOT persist across reloads, so
 * a force-quit + relaunch in this mode would still replay — but the
 * environments that fall into this branch don't have a real Expo
 * cold-start lifecycle to worry about.
 */
export class MemoryKvBacking implements KvBacking {
  private readonly map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) ?? null) : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

let _defaultInstance: PushTapDedupeStore | null = null

/**
 * Process-wide default store. Resolved lazily so unit tests can
 * inject their own `KvBacking` by constructing `PushTapDedupeStore`
 * directly. The runtime picks AsyncStorage on native + `localStorage`
 * on web via the same Platform / lazy-require pattern as
 * `lib/last-tab-storage.ts` and `lib/token-storage.ts`.
 */
export function pushTapDedupeStore(): PushTapDedupeStore {
  if (_defaultInstance !== null) return _defaultInstance
  let backing: KvBacking
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Platform } = require('react-native') as { Platform: { OS: string } }
    if (Platform.OS === 'web') {
      backing = getWebBacking()
    } else {
      backing = getNativeBacking()
    }
  } catch {
    // bun-test or SSR — fall back to in-memory.
    backing = new MemoryKvBacking()
  }
  _defaultInstance = new PushTapDedupeStore(backing)
  return _defaultInstance
}

/** Test-only — drop the cached instance. */
export function __resetPushTapDedupeStoreForTests(): void {
  _defaultInstance = null
}

function getWebBacking(): KvBacking {
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as { localStorage?: KvBacking }
    if (g.localStorage !== undefined) {
      return g.localStorage
    }
  }
  return new MemoryKvBacking()
}

function getNativeBacking(): KvBacking {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@react-native-async-storage/async-storage') as {
    default: KvBacking
  }
  return mod.default
}
