/**
 * @neutronai/app — server-URL resolution, normalisation + validation (pure).
 *
 * ISSUES #385. The mobile app is a client of the owner's OWN Neutron
 * instance: a machine on their LAN, or their own server behind a domain.
 * Before this module the app had NO way to learn that address: the only
 * sources were build-time (`extra.neutron_base_url` /
 * `EXPO_PUBLIC_NEUTRON_BASE_URL`), neither was ever set, and
 * `lib/config.ts` silently substituted `http://127.0.0.1:8080` — which
 * on a phone IS the phone. Every request failed, quietly.
 *
 * The fix: a RUNTIME server URL the owner types once, persisted in the
 * same storage layer as the session (`lib/token-storage.ts`), so a
 * single APK works for any self-hoster. This file holds the pure parts
 * so they are unit-testable under `bun test` — no `expo-constants`, no
 * React Native bridge, no `URL` (React Native's polyfill is partial;
 * parsing here is explicit string work).
 *
 * PRECEDENCE (resolveServerBases, per field):
 *
 *   persisted runtime value  >  extra.neutron_*  >  EXPO_PUBLIC_NEUTRON_*  >  unconfigured
 *
 * The user's explicit in-app choice wins over a baked-in build default —
 * a build shipped pointing at the wrong host must be recoverable on the
 * device without a rebuild. "Unconfigured" resolves to the EMPTY string
 * and `configured: false`; it NEVER fabricates a URL.
 *
 * EVERY source is normalised through `normalizeServerUrl` before it can
 * win, and `configured` is derived from the NORMALISED result (Argus r1
 * MAJOR). A build-time value that can't be an origin (`'/'`, `'https://'`,
 * `'ftp://bad host'`, `'javascript:alert(1)'`) is therefore treated as
 * ABSENT — it falls through to the next source and, if nothing else
 * supplies one, leaves the app unconfigured, which holds the owner on
 * `/login` (`app/app/index.tsx`) until discovery or the self-host form
 * names a real server. The alternative (`configured: true` with an
 * unusable base) would mount the app tree and re-introduce the
 * schemeless-relative-URL failure `requireAuthBaseUrl`
 * (`app/lib/auth-helpers.ts`) exists to kill.
 */

import type { PersistedServerConfig } from './token-storage';

/**
 * Prefill suggestion for the setup form ONLY — a visible, editable
 * hint for the local-dev loop. It is never applied implicitly: the
 * resolver below has no default, so an un-submitted form leaves the
 * app unconfigured. This is the whole point of #385.
 *
 * The PORT has to be the port a real install actually listens on, or
 * the mandatory gate fails on its own default (Argus r2 MAJOR — it
 * used to say `:8080`, which nothing in this repo ever binds). 7800
 * is the harness default, verified in three places:
 * `gateway/boot-listener-registry.ts:30` (`DEFAULT_LISTEN_PORT =
 * 7_800`, returned at `:195` when neither `--port` nor `NEUTRON_PORT`
 * is set), `install.sh:82` (`CHAT_PORT=7800`) and `bin/neutron:76`
 * (`[ -n "$_p" ] || _p=7800`, the port `neutron url` prints).
 */
export const LOCAL_DEV_SUGGESTION = 'http://127.0.0.1:7800';

/**
 * Health endpoint every Neutron gateway serves unauthenticated. The
 * handler is `gateway/index.ts:771-804` (the default `/healthz` handler,
 * which is ALSO the terminal fallback of the composed precedence chain —
 * see its header at `gateway/index.ts:743-762`, and the ladder fallback
 * wiring at `gateway/http/compose.ts`). It answers HTTP 200 with a JSON
 * body `{ status, project_slug, uptime_ms, … }` (`gateway/index.ts:786-789`;
 * keys asserted by `gateway/listener.test.ts:228-245`), and DELIBERATELY
 * returns 200 even when `status: 'degraded'` (`gateway/index.ts:755-757`,
 * `:800`) — a degraded gateway is still your gateway, so the gate must
 * not reject it.
 */
export const HEALTH_PATH = '/healthz';

const DEFAULT_VALIDATE_TIMEOUT_MS = 8000;

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;
/**
 * DNS hostname label — letters/digits/hyphen, no leading or trailing
 * hyphen. An underscore is NOT legal in a hostname (RFC 1123) and is
 * rejected, as is an empty label (`host..example.com`).
 */
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.?$/;
/** Bracketed IPv6 literal, e.g. `[::1]`. */
const IPV6_RE = /^\[[0-9a-f:.]+\]$/;

export interface ResolvedServerBases {
  gateway_base_url: string;
  auth_base_url: string;
  /**
   * `false` when NO source supplied a gateway URL. Callers must treat this as
   * "hold on /login until a server is discovered or named", never as
   * "try loopback".
   */
  configured: boolean;
}

export interface ServerBaseSources {
  /** Runtime value the owner entered in-app. Highest precedence. */
  persisted?: PersistedServerConfig | null;
  /** `Constants.expoConfig.extra` values (unknown-typed on purpose). */
  extra?: { gateway_base_url?: unknown; auth_base_url?: unknown };
  /** `process.env.EXPO_PUBLIC_NEUTRON_*` values. */
  env?: { gateway_base_url?: string | undefined; auth_base_url?: string | undefined };
}

export function resolveServerBases(sources: ServerBaseSources): ResolvedServerBases {
  const gateway = firstUsableOrigin(
    sources.persisted?.gateway_base_url,
    sources.extra?.gateway_base_url,
    sources.env?.gateway_base_url,
  );
  const auth = firstUsableOrigin(
    sources.persisted?.auth_base_url,
    sources.extra?.auth_base_url,
    sources.env?.auth_base_url,
  );
  return {
    gateway_base_url: gateway,
    auth_base_url: auth,
    // Derived from the NORMALISED value, so a degenerate source ('/', '   ',
    // 'https://') can never report a configured install (Argus r1 MAJOR).
    configured: gateway.length > 0,
  };
}

/**
 * First candidate that normalises to a usable origin. A non-string
 * (`Constants.extra` is untyped JSON), a blank string, and anything
 * `normalizeServerUrl` rejects all count as ABSENT — the next source
 * gets its turn, and '' (unconfigured) is the floor.
 */
function firstUsableOrigin(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = normalizeServerUrl(candidate);
    if (normalized !== null) return normalized;
  }
  return '';
}

export function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Normalise a hand-typed instance URL into a canonical origin (+ any
 * sub-path the operator reverse-proxies under):
 *
 *   - trims surrounding whitespace
 *   - adds `https://` when no scheme is present (the safe default for a
 *     typed hostname; `http://` must be spelled out)
 *   - lower-cases the scheme + authority
 *   - drops any `?query` / `#fragment`
 *   - strips trailing slashes
 *
 * Returns `null` when the input can't be a Neutron origin (empty, a
 * non-http(s) scheme, whitespace or illegal chars in the authority).
 */
export function normalizeServerUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const match = SCHEME_RE.exec(trimmed);
  const scheme = match === null ? 'https' : match[1]!.toLowerCase();
  const afterScheme = match === null ? trimmed : trimmed.slice(match[0].length);
  if (scheme !== 'http' && scheme !== 'https') return null;

  const withoutFragment = afterScheme.split('#')[0]!;
  const withoutQuery = withoutFragment.split('?')[0]!;
  const firstSlash = withoutQuery.indexOf('/');
  const authority = (firstSlash === -1 ? withoutQuery : withoutQuery.slice(0, firstSlash)).toLowerCase();
  const path = firstSlash === -1 ? '' : withoutQuery.slice(firstSlash);
  if (authority.length === 0) return null;
  if (!isUsableAuthority(authority)) return null;

  return `${scheme}://${authority}${stripTrailingSlashes(path)}`;
}

/**
 * `host[:port]` — a hostname / IPv4 literal / bracketed IPv6 with an
 * optional IN-RANGE port. Deliberately strict, and strict about the port
 * too: `:0` and `:99999` are not reachable ports, and rejecting them here
 * yields "that isn't a server address" instead of an opaque transport
 * error later (Argus r1 NIT). Also rejects a scheme-like prefix that
 * lacks `//` (`javascript:alert(1)`, `mailto:x`) — after the implicit
 * `https://` is prepended those would otherwise read as a hostname.
 */
function isUsableAuthority(authority: string): boolean {
  const split = splitAuthority(authority);
  if (split.port !== null) {
    if (!/^\d{1,5}$/.test(split.port)) return false;
    const portNum = Number(split.port);
    if (portNum < 1 || portNum > 65535) return false;
  }
  if (split.host.startsWith('[')) return IPV6_RE.test(split.host);
  return HOSTNAME_RE.test(split.host);
}

/**
 * Split `host[:port]`. A colon inside a bracketed IPv6 literal is part
 * of the host, not a port separator — only a colon AFTER the `]`
 * delimits the port.
 */
function splitAuthority(authority: string): { host: string; port: string | null } {
  const lastColon = authority.lastIndexOf(':');
  if (lastColon > authority.lastIndexOf(']')) {
    return { host: authority.slice(0, lastColon), port: authority.slice(lastColon + 1) };
  }
  return { host: authority, port: null };
}

/** The host part of an already-normalised origin, lower-case, port stripped. */
export function hostOfOrigin(url: string): string {
  const match = SCHEME_RE.exec(url);
  const afterScheme = match === null ? url : url.slice(match[0].length);
  const firstSlash = afterScheme.indexOf('/');
  const authority = firstSlash === -1 ? afterScheme : afterScheme.slice(0, firstSlash);
  return splitAuthority(authority).host;
}

/**
 * Loopback / link-local / RFC-1918 / `.local` — the hosts where plain
 * `http://` is a normal self-host setup rather than an exposure. IPv6
 * unique-local (`fc00::/7` → `fc`/`fd` prefix) counts too.
 */
function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local')) return true;
  if (host === '[::1]' || host === '::1') return true;
  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  if (/^f[cd][0-9a-f]{0,2}:/.test(bare)) return true;
  if (/^fe80:/.test(bare)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (v4 === null) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * Warn when the entered origin would send the session bearer over
 * plaintext to a PUBLIC host (Argus r2 MINOR). Android permits cleartext
 * to any host (`app/app.json` `expo-build-properties`
 * `android.usesCleartextTraffic: true` — unavoidable, since the host is
 * user-supplied at runtime so no domain-scoped `networkSecurityConfig`
 * can be authored ahead of the build), while iOS only relaxes ATS for
 * the LAN (`NSAllowsLocalNetworking`, `NSAllowsArbitraryLoads` left
 * unset). So `http://public-host` is blocked on iOS and silently allowed
 * on Android; the gate has to say so out loud rather than let a token
 * leave in the clear unremarked.
 *
 * Returns `null` for https and for private/loopback/`.local` hosts,
 * where http is the ordinary self-host case. NON-BLOCKING by design —
 * an owner who really does run plain http on a public box is still
 * allowed to; they are just told.
 */
export function describeInsecureOrigin(url: string): string | null {
  if (!url.toLowerCase().startsWith('http://')) return null;
  const host = hostOfOrigin(url);
  if (host.length === 0 || isPrivateHost(host)) return null;
  return `Heads up: ${host} is not on a private network and this is plain http, so your access token would travel unencrypted. Use https:// unless you know this link is private.`;
}

export type ServerCheckResult =
  | { ok: true; url: string }
  | { ok: false; url: string | null; message: string };

/**
 * Prove the entered origin is really a Neutron gateway by requesting
 * `/healthz` on it. Failing LOUDLY here is the point — a silent default
 * is what let a broken build ship undetected.
 *
 * A 200 alone is NOT proof (Argus r1): a captive portal, a router admin
 * page, or an unrelated reverse-proxy catch-all all answer 200 to
 * anything. The body has to parse as the gateway's health JSON
 * (`{ status, project_slug, … }`) before we accept the host. `status:
 * 'degraded'` still passes — see the `HEALTH_PATH` note.
 */
/**
 * The origin a `/healthz` probe actually SETTLED on, after any redirects the
 * proxy performed. Falls back to `typed` whenever the final URL is unusable or
 * unavailable — `fetch` implementations that don't populate `res.url`, and test
 * doubles returning a bare `Response`, both leave it empty, and a redirect we
 * cannot read must never downgrade a working answer.
 *
 * Only the ORIGIN is taken; the health path is discarded, so this yields the
 * base the client should store.
 */
function settledOrigin(res: { url?: string }, typed: string): string {
  const final = typeof res.url === 'string' ? res.url.trim() : '';
  if (final.length === 0) return typed;
  const normalized = normalizeServerUrl(final.replace(/\/healthz\/*$/i, ''));
  return normalized ?? typed;
}

export async function checkServerUrl(input: {
  raw: string;
  fetchFn?: typeof globalThis.fetch;
  timeout_ms?: number;
}): Promise<ServerCheckResult> {
  const url = normalizeServerUrl(input.raw);
  if (url === null) {
    return {
      ok: false,
      url: null,
      message: "That doesn't look like a server address. Try https://neutron.example.com",
    };
  }
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  const timeoutMs = input.timeout_ms ?? DEFAULT_VALIDATE_TIMEOUT_MS;
  const target = `${url}${HEALTH_PATH}`;

  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  // Tracked so the failure path can tell "we gave up waiting" from a
  // transport error: an aborted fetch throws an AbortError whose raw
  // message ("signal is aborted without reason") is meaningless to the
  // owner, and a blackholed host / firewalled port is the most likely
  // real LAN failure (Argus r1).
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The deadline is armed UNCONDITIONALLY and RACED, not just wired to
  // an AbortController (Argus r2 NIT). Aborting only works where
  // `AbortController` exists; where it doesn't — and, more importantly,
  // when a `fetchFn` ignores the signal — nothing else made this
  // promise settle, so the form sat `busy` forever with no Cancel and
  // no escape. Racing a rejecting timer makes `checkServerUrl` TOTAL.
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      if (controller !== null) controller.abort();
      reject(new Error('neutron_healthz_timeout'));
    }, timeoutMs);
  });
  // The race is over as soon as the fetch resolves, but the timer can
  // still fire while the BODY is being read. Register a handler now so
  // that late rejection is never an unhandled promise rejection.
  void deadline.catch(() => undefined);

  const timeoutResult = (): ServerCheckResult => ({
    ok: false,
    url,
    message: `${url} did not answer ${HEALTH_PATH} within ${formatDuration(timeoutMs)}. Check the port is open and this device is on the same network as the server.`,
  });

  try {
    const res = await Promise.race([
      fetchFn(target, {
        method: 'GET',
        ...(controller === null ? {} : { signal: controller.signal }),
      }),
      deadline,
    ]);
    if (!res.ok) {
      return {
        ok: false,
        url,
        message: `${url} answered ${res.status} on ${HEALTH_PATH}. Is that your Neutron gateway?`,
      };
    }
    const healthy = await isNeutronHealthBody(res);
    // Check the deadline BEFORE blaming the body shape (Argus r2 NIT).
    // `isNeutronHealthBody` is total, so an abort landing mid-`res.text()`
    // on a lossy LAN link comes back as `false` — reporting that as "not
    // like a Neutron gateway" points the owner at the wrong problem.
    if (timedOut) return timeoutResult();
    if (!healthy) {
      return {
        ok: false,
        url,
        message: `${url} answered ${HEALTH_PATH}, but not like a Neutron gateway. Check you have the right host and port (a router page or Wi-Fi login page also answers here).`,
      };
    }
    // Persist the origin the probe ACTUALLY landed on, not the one that was
    // typed (ISSUES #394). A redirect here is silently fatal later: entering
    // `http://<host>` for a TLS-terminated install makes the proxy 301 to
    // https, this probe follows it and reports healthy — but every subsequent
    // authenticated request also redirects, and the platform STRIPS the
    // `Authorization` header across a scheme/host change. The gateway then
    // answers `missing_bearer` and the Projects screen looks broken while the
    // token is perfectly valid.
    //
    // Observed live 2026-07-27, one token against one host:
    //   https://<host>/api/app/projects       → 200
    //   http://<host>/api/app/projects  (301) → 401  ← header did not survive
    //
    // Taking the post-redirect origin fixes the whole class (http→https,
    // apex→www, any 30x the proxy performs), not just the scheme case. It is
    // also why the connect form's local-dev prefill was a trap: editing only
    // the host left `http://` in place.
    return { ok: true, url: settledOrigin(res, url) };
  } catch (err) {
    if (timedOut) return timeoutResult();
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      url,
      message: `Could not reach ${target} — ${detail}. Check the address, the port, and that the gateway is running.`,
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Human-readable duration for the timeout copy. Sub-second budgets
 * (only the tests use them) used to render as "within 0s" (Argus r2
 * NIT); below 1s we say milliseconds.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * `true` when the response body is the gateway's health JSON. Total —
 * an unreadable body / non-JSON / wrong shape is a `false`, never a throw.
 * Shape verified at `gateway/index.ts:786-789`.
 */
async function isNeutronHealthBody(res: { text(): Promise<string> }): Promise<boolean> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const body = parsed as Record<string, unknown>;
  return typeof body['status'] === 'string' && typeof body['project_slug'] === 'string';
}

/** The storage surface `commitServerConfig` needs — a `TokenStorage` satisfies it. */
export interface ServerConfigStore {
  /** Read back for the rollback path — see `commitServerConfig`'s ORDER note. */
  getServerConfig(): Promise<PersistedServerConfig>;
  setServerConfig(config: PersistedServerConfig): Promise<void>;
  /**
   * Read the persisted session token, so a session wipe is reported
   * (and performed) only when there was actually a session.
   */
  getToken(): Promise<string | null>;
  /** Session wipe (token + user). Fired when the host doesn't match. */
  clearAll(): Promise<void>;
}

export type CommitServerConfigResult =
  | {
      ok: true;
      config: PersistedServerConfig;
      session_cleared: boolean;
      /**
       * `true` when the committed host differs from the previously
       * resolved one. Callers MUST route back to `/login` on a host
       * change even when `session_cleared` is false (there may have been
       * no token to clear) — a token from the old instance is worthless
       * on the new one either way.
       */
      host_changed: boolean;
    }
  | { ok: false; message: string };

/**
 * The single normalise → validate → persist path. THREE callers, one
 * implementation — there is deliberately no second writer:
 *   - `lib/identity-client.ts:adoptDiscoveredInstance` — the login-first happy
 *     path, adopting the `publicUrl` discovery returned;
 *   - `components/ServerConnectForm.tsx` — the self-host typed-URL form, which
 *     is mounted on `/login` (session-free) and in Settings;
 *   - `app/app/settings.tsx` — changing server later, via that same form.
 * A discovered host is therefore health-checked exactly like a typed one.
 *
 * Whenever the committed host does NOT match the previously resolved one
 * the session is wiped: a token minted by the old instance is meaningless
 * on the new one, and leaving it in place would leave the app
 * authenticated-looking while every request 401s.
 *
 * That INCLUDES first run, where the previous host is '' by
 * definition (Argus r1 MAJOR). An install can hold a session with no
 * server key — e.g. an OTA update (`app/app.json` `updates.url`) lands
 * this change on a build that already signed in against the old loopback
 * default — and 'no persisted host' must never be read as 'this token
 * belongs here'. Nothing is cleared when there is no token, so a genuine
 * first run reports `session_cleared: false`.
 *
 * ORDER: persist the new config FIRST, then clear. If the persist
 * rejects (AsyncStorage quota / IO error on native) the caller surfaces
 * the failure with the session still intact and the OLD host still
 * persisted — a consistent state. Clearing first would destroy the
 * session while leaving the stale host behind (Argus r1 MINOR).
 *
 * And if the WIPE rejects after the persist succeeded, the persisted
 * config is ROLLED BACK to what it was (Argus r2 MINOR). Without the
 * rollback that partial-IO case left storage pointing at the new host
 * while the running process still used the old one, and the next launch
 * booted the new server holding the old server's token. Rolling back
 * makes the failure a clean no-op the owner can simply retry.
 */
export async function commitServerConfig(input: {
  gateway_raw: string;
  auth_raw?: string | null;
  /** Currently RESOLVED gateway base (from `loadAppConfig`), '' when unconfigured. */
  previous_gateway_base_url: string;
  store: ServerConfigStore;
  fetchFn?: typeof globalThis.fetch;
  timeout_ms?: number;
}): Promise<CommitServerConfigResult> {
  const authRaw = input.auth_raw ?? '';
  let authBase: string | null = null;
  if (authRaw.trim().length > 0) {
    authBase = normalizeServerUrl(authRaw);
    if (authBase === null) {
      return {
        ok: false,
        message:
          "That identity-service address doesn't look like a URL. Try https://auth.example.com or leave it blank.",
      };
    }
  }

  const check = await checkServerUrl({
    raw: input.gateway_raw,
    fetchFn: input.fetchFn,
    timeout_ms: input.timeout_ms,
  });
  if (!check.ok) return { ok: false, message: check.message };

  const previous = stripTrailingSlashes(input.previous_gateway_base_url.trim());
  const hostChanged = previous !== check.url;

  const config: PersistedServerConfig = {
    gateway_base_url: check.url,
    auth_base_url: authBase,
  };
  const rollbackTo = await input.store.getServerConfig();
  await input.store.setServerConfig(config);

  let sessionCleared = false;
  try {
    if (hostChanged && (await input.store.getToken()) !== null) {
      await input.store.clearAll();
      sessionCleared = true;
    }
  } catch (err) {
    // Best-effort rollback — if this ALSO fails there is nothing left to
    // try, and the message still tells the owner the change did not take.
    try {
      await input.store.setServerConfig(rollbackTo);
    } catch (rollbackErr) {
      console.warn('[server-url] rollback after failed sign-out also failed:', rollbackErr);
    }
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Saved nothing: could not sign out of the previous server first (${detail}). Nothing changed — try again.`,
    };
  }
  return { ok: true, config, session_cleared: sessionCleared, host_changed: hostChanged };
}
