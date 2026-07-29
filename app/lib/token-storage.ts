/**
 * @neutronai/app — persistent token + user storage (P5.0).
 *
 * Per `docs/plans/P5.0-app-scaffolding-sprint-brief.md` § 4.5:
 *
 *   AsyncStorage on iOS + Android (`@react-native-async-storage/async-storage`);
 *   `window.localStorage` on web. Detection via `Platform.OS === 'web'`.
 *   `expo-secure-store` is the upgrade path for the credential keys.
 *
 * Session keys:
 *
 *   - `neutron.session.token`   — the gateway bearer (an instance-scoped JWT
 *     from login-first discovery, or a `dev:<id>` opaque token self-hosting).
 *   - `neutron.session.user`    — JSON `AuthUser` (id, email, displayName,
 *     provider).
 *   - `neutron.identity.session` — JSON `PersistedIdentitySession`: the account
 *     id/email, the instance slug, and the refresh token that renews the
 *     bearer above without asking the owner for credentials again.
 *
 * The session provider (`lib/session.tsx`) hydrates both on mount and
 * persists both on `setUser`. `signOut` clears both + the in-memory
 * context.
 *
 * ISSUES #385 adds two MORE keys — the runtime server configuration:
 *
 *   - `neutron.server.gateway_base_url` — the owner's own Neutron
 *     instance origin. Written by login-first discovery, or typed into the
 *     self-host form on `/login` (or changed later in Settings).
 *   - `neutron.server.auth_base_url` — optional identity-service origin.
 *     Blank unless the operator runs a separate OAuth identity service.
 *
 * These are deliberately OUTSIDE `clearAll()`: signing out must not make
 * the app forget which server it belongs to. Changing the server DOES
 * wipe the session (see `commitServerConfig` in `lib/server-url.ts`).
 *
 * Remote diagnostics adds ONE more key:
 *
 *   - `neutron.diagnostics.queue` — JSON array of undelivered
 *     `ClientReport`s. This is the whole point of the feature: a report
 *     produced during a FAILED LAUNCH has to survive the process dying,
 *     so it is written here immediately and POSTed on the next
 *     successful, authenticated run. See `lib/diagnostic-queue.ts`.
 *
 * It is also OUTSIDE `clearAll()`. A crash report is evidence about the
 * app, not about the session, and losing it on sign-out would silently
 * defeat the one case the queue exists for (a launch that fails before,
 * or while, the session is established). It carries no credential by
 * construction — `lib/diagnostic-redact.ts` scrubs before anything is
 * enqueued.
 *
 * Test surface: the `WebTokenStorage` class is exported so unit tests
 * exercise it directly with an injectable `Storage`-shaped backend
 * (no React Native imports, no `Platform`). The default exported
 * `tokenStorage` picks AsyncStorage vs localStorage at runtime.
 */

import type { AuthUser } from './auth';

export const TOKEN_KEY = 'neutron.session.token';
export const USER_KEY = 'neutron.session.user';
export const SERVER_GATEWAY_KEY = 'neutron.server.gateway_base_url';
export const SERVER_AUTH_KEY = 'neutron.server.auth_base_url';
export const DIAGNOSTICS_QUEUE_KEY = 'neutron.diagnostics.queue';

/** Login-first: what it takes to RENEW the session without asking again. */
export const IDENTITY_SESSION_KEY = 'neutron.identity.session';

/**
 * The identity-service side of a login-first session, kept next to (not inside)
 * `AuthUser` because it is about the ACCOUNT, not about the signed-in instance
 * user: the bearer under `TOKEN_KEY` is instance-scoped and short-lived, and
 * this is what buys a fresh one.
 *
 * `refresh_token` is `null` when the service issued none — the app then simply
 * cannot renew silently and the owner signs in again, which is honest rather
 * than a broken retry loop.
 *
 * Cleared by `clearAll()` along with the rest of the session: signing out must
 * not leave a credential behind that could mint a new one.
 */
export interface PersistedIdentitySession {
  user_id: string;
  email: string;
  refresh_token: string | null;
  /** The instance this device adopted, so renewal re-routes to the SAME one. */
  slug: string;
}

/**
 * The persisted runtime server configuration. `null` on a field means
 * "not persisted" — the resolver then falls through to the build-time
 * config (`extra.neutron_*` → `EXPO_PUBLIC_NEUTRON_*`) rather than
 * fabricating a URL. See `lib/server-url.ts:resolveServerBases`.
 */
export interface PersistedServerConfig {
  gateway_base_url: string | null;
  auth_base_url: string | null;
}

export const EMPTY_SERVER_CONFIG: PersistedServerConfig = {
  gateway_base_url: null,
  auth_base_url: null,
};

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
  /** The renewal material for a login-first session; `null` when absent. */
  getIdentitySession(): Promise<PersistedIdentitySession | null>;
  setIdentitySession(session: PersistedIdentitySession): Promise<void>;
  /**
   * Convenience — clears the token + user + identity session, used by sign-out.
   * Does NOT touch the server configuration (see the header note).
   */
  clearAll(): Promise<void>;
  /** Runtime server config. Both fields `null` when nothing is persisted. */
  getServerConfig(): Promise<PersistedServerConfig>;
  /** Writes non-null fields; removes a field passed as `null`. */
  setServerConfig(config: PersistedServerConfig): Promise<void>;
  clearServerConfig(): Promise<void>;
  /**
   * The raw serialized undelivered-diagnostics queue, or `null` when empty.
   * Deliberately string-in / string-out: this layer stays a dumb key-value
   * seam and `lib/diagnostic-queue.ts` owns the JSON shape + the caps.
   */
  getDiagnosticsQueue(): Promise<string | null>;
  /** Writes the queue; `null` removes the key entirely. */
  setDiagnosticsQueue(raw: string | null): Promise<void>;
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

  async getIdentitySession(): Promise<PersistedIdentitySession | null> {
    return parseIdentitySession(this.backing.getItem(IDENTITY_SESSION_KEY), () =>
      this.backing.removeItem(IDENTITY_SESSION_KEY),
    );
  }

  async setIdentitySession(session: PersistedIdentitySession): Promise<void> {
    this.backing.setItem(IDENTITY_SESSION_KEY, JSON.stringify(session));
  }

  async clearAll(): Promise<void> {
    this.backing.removeItem(TOKEN_KEY);
    this.backing.removeItem(USER_KEY);
    this.backing.removeItem(IDENTITY_SESSION_KEY);
  }

  async getServerConfig(): Promise<PersistedServerConfig> {
    return {
      gateway_base_url: this.backing.getItem(SERVER_GATEWAY_KEY),
      auth_base_url: this.backing.getItem(SERVER_AUTH_KEY),
    };
  }

  async setServerConfig(config: PersistedServerConfig): Promise<void> {
    writeOrRemoveSync(this.backing, SERVER_GATEWAY_KEY, config.gateway_base_url);
    writeOrRemoveSync(this.backing, SERVER_AUTH_KEY, config.auth_base_url);
  }

  async clearServerConfig(): Promise<void> {
    this.backing.removeItem(SERVER_GATEWAY_KEY);
    this.backing.removeItem(SERVER_AUTH_KEY);
  }

  async getDiagnosticsQueue(): Promise<string | null> {
    return this.backing.getItem(DIAGNOSTICS_QUEUE_KEY);
  }

  async setDiagnosticsQueue(raw: string | null): Promise<void> {
    writeOrRemoveSync(this.backing, DIAGNOSTICS_QUEUE_KEY, raw);
  }
}

/**
 * Shared parse for the persisted identity session. Storage drift (an older
 * shape, a hand edit) is treated as "nothing persisted" and the bad row is
 * dropped, exactly as `getUser` does — a half-read session must never be handed
 * to the renewal path, which would spend a garbage refresh token and get the
 * whole token family revoked as suspected theft.
 */
function parseIdentitySession(
  raw: string | null,
  drop: () => void,
): PersistedIdentitySession | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedIdentitySession>;
    if (typeof parsed.user_id !== 'string' || parsed.user_id.length === 0) throw new Error('shape');
    if (typeof parsed.slug !== 'string' || parsed.slug.length === 0) throw new Error('shape');
    return {
      user_id: parsed.user_id,
      email: typeof parsed.email === 'string' ? parsed.email : '',
      refresh_token: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : null,
      slug: parsed.slug,
    };
  } catch {
    drop();
    return null;
  }
}

function writeOrRemoveSync(
  backing: SyncKeyValueStore,
  key: string,
  value: string | null,
): void {
  if (value === null) backing.removeItem(key);
  else backing.setItem(key, value);
}

async function writeOrRemoveAsync(
  backing: AsyncKeyValueStore,
  key: string,
  value: string | null,
): Promise<void> {
  if (value === null) await backing.removeItem(key);
  else await backing.setItem(key, value);
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

  async getIdentitySession(): Promise<PersistedIdentitySession | null> {
    const raw = await this.backing.getItem(IDENTITY_SESSION_KEY);
    let drop: Promise<void> | null = null;
    const parsed = parseIdentitySession(raw, () => {
      drop = this.backing.removeItem(IDENTITY_SESSION_KEY);
    });
    if (drop !== null) await drop;
    return parsed;
  }

  async setIdentitySession(session: PersistedIdentitySession): Promise<void> {
    await this.backing.setItem(IDENTITY_SESSION_KEY, JSON.stringify(session));
  }

  async clearAll(): Promise<void> {
    await this.backing.removeItem(TOKEN_KEY);
    await this.backing.removeItem(USER_KEY);
    await this.backing.removeItem(IDENTITY_SESSION_KEY);
  }

  async getServerConfig(): Promise<PersistedServerConfig> {
    const [gateway, auth] = await Promise.all([
      this.backing.getItem(SERVER_GATEWAY_KEY),
      this.backing.getItem(SERVER_AUTH_KEY),
    ]);
    return { gateway_base_url: gateway, auth_base_url: auth };
  }

  async setServerConfig(config: PersistedServerConfig): Promise<void> {
    await writeOrRemoveAsync(this.backing, SERVER_GATEWAY_KEY, config.gateway_base_url);
    await writeOrRemoveAsync(this.backing, SERVER_AUTH_KEY, config.auth_base_url);
  }

  async clearServerConfig(): Promise<void> {
    await this.backing.removeItem(SERVER_GATEWAY_KEY);
    await this.backing.removeItem(SERVER_AUTH_KEY);
  }

  async getDiagnosticsQueue(): Promise<string | null> {
    return this.backing.getItem(DIAGNOSTICS_QUEUE_KEY);
  }

  async setDiagnosticsQueue(raw: string | null): Promise<void> {
    await writeOrRemoveAsync(this.backing, DIAGNOSTICS_QUEUE_KEY, raw);
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
 * `/login` after a refresh. Acceptable degraded mode: both cases are
 * environments with no durable store to write to in the first place.
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
