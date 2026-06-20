/**
 * @neutronai/app — persistent token + user storage (P5.0).
 *
 * Per `docs/plans/P5.0-app-scaffolding-sprint-brief.md` § 4.5:
 *
 *   AsyncStorage on iOS + Android (`@react-native-async-storage/async-storage`);
 *   `window.localStorage` on web. Detection via `Platform.OS === 'web'`.
 *   `expo-secure-store` is the upgrade path when refresh-tokens land —
 *   NOT this sprint.
 *
 * Two stored keys per the brief:
 *
 *   - `neutron.session.token` — multi-aud JWT (or `dev:<id>` opaque token).
 *   - `neutron.session.user`  — JSON `AuthUser` (id, email, displayName,
 *     provider).
 *
 * The session provider (`lib/session.tsx`) hydrates both on mount and
 * persists both on `setUser`. `signOut` clears both + the in-memory
 * context.
 *
 * Test surface: the `WebTokenStorage` class is exported so unit tests
 * exercise it directly with an injectable `Storage`-shaped backend
 * (no React Native imports, no `Platform`). The default exported
 * `tokenStorage` picks AsyncStorage vs localStorage at runtime.
 */

import type { AuthUser } from './auth';

export const TOKEN_KEY = 'neutron.session.token';
export const USER_KEY = 'neutron.session.user';

/** A `Storage`-shaped subset; `window.localStorage` matches exactly. */
export interface SyncKeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** AsyncStorage-shape. The real module is lazy-imported on native. */
interface AsyncKeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface TokenStorage {
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  getUser(): Promise<AuthUser | null>;
  setUser(user: AuthUser): Promise<void>;
  clearUser(): Promise<void>;
  /** Convenience — clears both, used by sign-out. */
  clearAll(): Promise<void>;
}

/**
 * Sync-backed storage adapter. Web uses `window.localStorage`; tests
 * can pass any object that matches `SyncKeyValueStore` (e.g. an
 * in-memory Map shim).
 */
export class WebTokenStorage implements TokenStorage {
  constructor(private readonly backing: SyncKeyValueStore) {}

  async getToken(): Promise<string | null> {
    return this.backing.getItem(TOKEN_KEY);
  }

  async setToken(token: string): Promise<void> {
    this.backing.setItem(TOKEN_KEY, token);
  }

  async clearToken(): Promise<void> {
    this.backing.removeItem(TOKEN_KEY);
  }

  async getUser(): Promise<AuthUser | null> {
    const raw = this.backing.getItem(USER_KEY);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as AuthUser;
    } catch {
      // Storage drift (older shape, manual edit) — treat as logged-out.
      this.backing.removeItem(USER_KEY);
      return null;
    }
  }

  async setUser(user: AuthUser): Promise<void> {
    this.backing.setItem(USER_KEY, JSON.stringify(user));
  }

  async clearUser(): Promise<void> {
    this.backing.removeItem(USER_KEY);
  }

  async clearAll(): Promise<void> {
    this.backing.removeItem(TOKEN_KEY);
    this.backing.removeItem(USER_KEY);
  }
}

/**
 * Async-backed storage adapter. Native uses AsyncStorage; tests can
 * inject any object matching `AsyncKeyValueStore` (e.g. an in-memory
 * Map shim with Promise wrappers).
 */
export class NativeTokenStorage implements TokenStorage {
  constructor(private readonly backing: AsyncKeyValueStore) {}

  async getToken(): Promise<string | null> {
    return this.backing.getItem(TOKEN_KEY);
  }

  async setToken(token: string): Promise<void> {
    await this.backing.setItem(TOKEN_KEY, token);
  }

  async clearToken(): Promise<void> {
    await this.backing.removeItem(TOKEN_KEY);
  }

  async getUser(): Promise<AuthUser | null> {
    const raw = await this.backing.getItem(USER_KEY);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as AuthUser;
    } catch {
      await this.backing.removeItem(USER_KEY);
      return null;
    }
  }

  async setUser(user: AuthUser): Promise<void> {
    await this.backing.setItem(USER_KEY, JSON.stringify(user));
  }

  async clearUser(): Promise<void> {
    await this.backing.removeItem(USER_KEY);
  }

  async clearAll(): Promise<void> {
    await this.backing.removeItem(TOKEN_KEY);
    await this.backing.removeItem(USER_KEY);
  }
}

/**
 * In-memory fallback. Used in two cases:
 *
 *   - Web build where `window.localStorage` is unavailable (e.g.
 *     SSR-rendered static export at hydrate-time before the browser
 *     globals exist).
 *   - Bun-test environment where neither AsyncStorage nor
 *     `localStorage` is wired.
 *
 * Tokens DO NOT persist across reloads — the user will land back on
 * `/login` after a refresh. That's an acceptable degraded mode for
 * P5.0 (the brief explicitly defers refresh-token rotation).
 */
class MemoryKeyValueStore implements SyncKeyValueStore {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function getWebBacking(): SyncKeyValueStore {
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as { localStorage?: SyncKeyValueStore };
    if (g.localStorage !== undefined) {
      return g.localStorage;
    }
  }
  return new MemoryKeyValueStore();
}

function getNativeBacking(): AsyncKeyValueStore {
  // Lazy `require` so the web bundle never pulls AsyncStorage's
  // native module shim; Metro's tree-shaking respects this in
  // managed-workflow builds.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@react-native-async-storage/async-storage') as {
    default: AsyncKeyValueStore;
  };
  return mod.default;
}

let _instance: TokenStorage | null = null;

/**
 * The runtime-detected token storage. Constructed lazily so a test
 * harness can stub `Platform.OS` + the storage backings before the
 * first call (or, more commonly, just import `WebTokenStorage` /
 * `NativeTokenStorage` directly and pass a known backing).
 *
 * `react-native` is imported via `require` so this file can be
 * loaded under `bun test` without pulling the RN bridge — tests
 * exercise `WebTokenStorage` / `NativeTokenStorage` directly with
 * an injected backing and never touch this function.
 */
export function tokenStorage(): TokenStorage {
  if (_instance !== null) return _instance;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Platform } = require('react-native') as { Platform: { OS: string } };
  if (Platform.OS === 'web') {
    _instance = new WebTokenStorage(getWebBacking());
  } else {
    _instance = new NativeTokenStorage(getNativeBacking());
  }
  return _instance;
}

/**
 * Test-only — wipe the cached instance. Real builds never call this.
 */
export function __resetTokenStorageForTests(): void {
  _instance = null;
}
