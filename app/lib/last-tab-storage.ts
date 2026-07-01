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
  constructor(private readonly backing: LastTabBacking) {}

  async get(rawProjectId: string): Promise<LastTabValue | null> {
    const projectId = sanitizeProjectId(rawProjectId);
    if (projectId === null) return null;
    try {
      const raw = await Promise.resolve(this.backing.getItem(keyFor(projectId)));
      if (raw === null) return null;
      if (isLegalTab(raw)) return raw;
      // Stale / corrupted value — proactively self-heal.
      await Promise.resolve(this.backing.removeItem(keyFor(projectId)));
      return null;
    } catch {
      return null;
    }
  }

  async set(rawProjectId: string, tab: LastTabValue): Promise<void> {
    const projectId = sanitizeProjectId(rawProjectId);
    if (projectId === null) return;
    if (!isLegalTab(tab)) return;
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
    try {
      await Promise.resolve(this.backing.removeItem(keyFor(projectId)));
    } catch {
      // ignore
    }
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
