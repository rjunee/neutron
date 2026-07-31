/**
 * @neutronai/app — per-project last-tab persistence (P5.2).
 *
 * Per `docs/plans/P5.2-project-view-shell-sprint-brief.md` § 4.6 —
 * stores the last tab the user had open on a per-project basis so
 * revisiting `/projects/<id>` (no tab segment) lands on the previously
 * selected tab instead of always defaulting to `chat`.
 *
 * Storage shape:
 *   - Key prefix: `neutron.project.<projectId>.lastTab`
 *   - Project ids are sanitized via the shared `sanitizeProjectId`
 *     helper (channels/adapters/app-ws/envelope.ts) — invalid ids
 *     fall through to the default-chat path.
 *   - Tab values are validated against the locked LEGAL_TABS set;
 *     anything else is treated as "no preference" so a stale or
 *     corrupted value can't break the redirect.
 *
 * Per-device, NOT per-user / cross-device. Local AsyncStorage on
 * native, `localStorage` on web. The brief explicitly rejects gateway
 * persistence — different devices want different muscle-memory
 * defaults (the owner's phone vs their laptop).
 */

const STORAGE_KEY_PREFIX = 'neutron.project.';
const STORAGE_KEY_SUFFIX = '.lastTab';

export type LastTabValue = 'chat' | 'launcher' | 'tasks' | 'reminders' | 'docs' | 'settings';

export const LEGAL_TABS: readonly LastTabValue[] = [
  'chat',
  'launcher',
  'tasks',
  'reminders',
  'docs',
  'settings',
];

/**
 * Char-set validation matches `sanitizeProjectId` in
 * channels/adapters/app-ws/envelope.ts. We don't import that module
 * directly so this file stays free of cross-package deps and can be
 * loaded from pure-TS tests under bun test.
 */
const PROJECT_ID_RE = /^[A-Za-z0-9_.-]+$/;
const MAX_PROJECT_ID_LEN = 128;

export function sanitizeProjectId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_PROJECT_ID_LEN) return null;
  if (!PROJECT_ID_RE.test(raw)) return null;
  return raw;
}

export function isLegalTab(value: unknown): value is LastTabValue {
  return (
    typeof value === 'string' && (LEGAL_TABS as readonly string[]).includes(value)
  );
}

function keyFor(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}${projectId}${STORAGE_KEY_SUFFIX}`;
}

/** Shape we accept for the backing key/value store. Matches both
 *  `window.localStorage` (sync) and an AsyncStorage adapter (async)
 *  by returning Promises everywhere — sync stores wrap their results
 *  in resolved promises. */
export interface LastTabBacking {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

export class LastTabStore {
  /**
   * Every answer this store has already given or written, so a rail tap can be
   * turned into a route WITHOUT awaiting anything (instant-switch, 2026-07-31).
   *
   * On native the backing is AsyncStorage — a bridge round-trip. `onRailSelect`
   * awaited one before it navigated at all, which put a variable, feedback-free
   * pause between the finger coming off the glass and the first pixel changing:
   * measured at 70–130 ms typically and 470 ms in one observed case, all of it
   * spent looking at the project the owner had just left. The value is a
   * per-device preference that only this process writes, so once it is known it
   * is known — re-reading it across the bridge on every tap buys nothing.
   *
   * A miss is not a failure: {@link knows} reports it and the caller falls back
   * to the async read. Nothing here invents a preference it was never told.
   */
  private readonly mirror = new Map<string, LastTabValue | null>();

  constructor(private readonly backing: LastTabBacking) {}

  async get(rawProjectId: string): Promise<LastTabValue | null> {
    const projectId = sanitizeProjectId(rawProjectId);
    if (projectId === null) return null;
    try {
      const raw = await Promise.resolve(this.backing.getItem(keyFor(projectId)));
      if (raw === null) {
        this.mirror.set(projectId, null);
        return null;
      }
      if (isLegalTab(raw)) {
        this.mirror.set(projectId, raw);
        return raw;
      }
      // Stale / corrupted value — proactively self-heal.
      await Promise.resolve(this.backing.removeItem(keyFor(projectId)));
      this.mirror.set(projectId, null);
      return null;
    } catch {
      // A backing that threw has told us nothing, so the mirror must not claim
      // to know: leave it untouched rather than caching a guess.
      return null;
    }
  }

  async set(rawProjectId: string, tab: LastTabValue): Promise<void> {
    const projectId = sanitizeProjectId(rawProjectId);
    if (projectId === null) return;
    if (!isLegalTab(tab)) return;
    this.mirror.set(projectId, tab);
    try {
      await Promise.resolve(this.backing.setItem(keyFor(projectId), tab));
    } catch {
      // Best-effort. Storage quota errors or web-SSR shouldn't break
      // navigation.
    }
  }

  async clear(rawProjectId: string): Promise<void> {
    const projectId = sanitizeProjectId(rawProjectId);
    if (projectId === null) return;
    this.mirror.set(projectId, null);
    try {
      await Promise.resolve(this.backing.removeItem(keyFor(projectId)));
    } catch {
      // ignore
    }
  }

  /** True when {@link peek} can answer for this project without I/O. */
  knows(rawProjectId: string): boolean {
    const projectId = sanitizeProjectId(rawProjectId);
    return projectId !== null && this.mirror.has(projectId);
  }

  /**
   * The known preference, synchronously. `null` means BOTH "no preference
   * stored" and "never asked" — always gate on {@link knows} first.
   */
  peek(rawProjectId: string): LastTabValue | null {
    const projectId = sanitizeProjectId(rawProjectId);
    if (projectId === null) return null;
    return this.mirror.get(projectId) ?? null;
  }

  /**
   * Read these projects' preferences once, so a later tap on any of them
   * resolves synchronously. Called with the rail's own project list; failures
   * are swallowed by `get`, which simply leaves that id unknown.
   */
  async prime(projectIds: readonly string[]): Promise<void> {
    await Promise.all(
      projectIds.filter((id) => !this.knows(id)).map(async (id) => {
        await this.get(id);
      }),
    );
  }
}

/**
 * Process-wide default instance. Resolved lazily so the tests can
 * inject their own backing via `LastTabStore` directly. The runtime
 * picks `window.localStorage` on web and AsyncStorage on native via
 * the same Platform / lazy-require pattern as `lib/token-storage.ts`.
 */
let _defaultInstance: LastTabStore | null = null;

interface SyncBacking {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface AsyncBacking {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

class MemoryBacking implements SyncBacking {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) ?? null) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function getWebBacking(): SyncBacking {
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as { localStorage?: SyncBacking };
    if (g.localStorage !== undefined) {
      return g.localStorage;
    }
  }
  return new MemoryBacking();
}

function getNativeBacking(): AsyncBacking {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@react-native-async-storage/async-storage') as {
    default: AsyncBacking;
  };
  return mod.default;
}

export function lastTabStorage(): LastTabStore {
  if (_defaultInstance !== null) return _defaultInstance;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Platform } = require('react-native') as { Platform: { OS: string } };
  if (Platform.OS === 'web') {
    _defaultInstance = new LastTabStore(getWebBacking());
  } else {
    _defaultInstance = new LastTabStore(getNativeBacking());
  }
  return _defaultInstance;
}

/** Test-only — wipe the cached instance. Real builds never call this. */
export function __resetLastTabStorageForTests(): void {
  _defaultInstance = null;
}

/**
 * Test-only — install a specific store, so a test can supply a backing that
 * behaves like the device's: slow, broken, or one that never answers at all.
 * There is no other seam; `lastTabStorage()` resolves the platform backing
 * through a `require`, and reaching into that module from a test file breaks
 * the require itself. Real builds never call this.
 */
export function __setLastTabStorageForTests(store: LastTabStore): void {
  _defaultInstance = store;
}
