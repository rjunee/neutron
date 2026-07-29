/**
 * @neutronai/app — server-URL resolution / normalisation / validation
 * unit tests (ISSUES #385).
 *
 * Covers the pure surface of `lib/server-url.ts` — the precedence chain,
 * normalisation, `/healthz` validation and the persist path.
 * `lib/config.ts`'s WIRING of that resolver (hydrate → module cache →
 * synchronous `loadAppConfig()`) is covered separately in
 * `server-config-wiring.test.ts`, which virtualizes `expo-constants`.
 *
 * Storage is exercised through the real `WebTokenStorage` with an
 * in-memory `SyncKeyValueStore` backing, same pattern as
 * `token-storage.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AuthUser } from '../lib/auth';
import {
  checkServerUrl,
  commitServerConfig,
  describeInsecureOrigin,
  LOCAL_DEV_SUGGESTION,
  normalizeServerUrl,
  resolveServerBases,
  stripTrailingSlashes,
} from '../lib/server-url';
import {
  SERVER_AUTH_KEY,
  SERVER_GATEWAY_KEY,
  TOKEN_KEY,
  USER_KEY,
  WebTokenStorage,
  type SyncKeyValueStore,
} from '../lib/token-storage';

function makeBacking(): SyncKeyValueStore & { snapshot(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
    removeItem(key) {
      map.delete(key);
    },
    snapshot() {
      return Object.fromEntries(map);
    },
  };
}

const USER: AuthUser = {
  id: 'sam',
  email: 'sam@example.com',
  displayName: 'Sam',
  provider: 'google',
  token: 'dev:sam',
};

/** The real gateway health body — `gateway/index.ts:786-789`. */
function healthBody(status: 'ok' | 'degraded' = 'ok'): string {
  return JSON.stringify({ status, project_slug: 'general', uptime_ms: 1234 });
}

function okFetch(): typeof globalThis.fetch {
  return (async () =>
    new Response(healthBody(), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

describe('resolveServerBases — precedence', () => {
  it('(a) honours the env var when nothing is persisted', () => {
    const resolved = resolveServerBases({
      persisted: { gateway_base_url: null, auth_base_url: null },
      extra: {},
      env: {
        gateway_base_url: 'https://env.neutron.example.com',
        auth_base_url: 'https://env-auth.example.com',
      },
    });
    expect(resolved.gateway_base_url).toBe('https://env.neutron.example.com');
    expect(resolved.auth_base_url).toBe('https://env-auth.example.com');
    expect(resolved.configured).toBe(true);
  });

  it('(b) `extra` beats the env var', () => {
    const resolved = resolveServerBases({
      persisted: null,
      extra: { gateway_base_url: 'https://extra.neutron.example.com' },
      env: { gateway_base_url: 'https://env.neutron.example.com' },
    });
    expect(resolved.gateway_base_url).toBe('https://extra.neutron.example.com');
    expect(resolved.configured).toBe(true);
  });

  it('(c) the persisted runtime value beats BOTH', () => {
    const resolved = resolveServerBases({
      persisted: {
        gateway_base_url: 'https://mine.neutron.example.com',
        auth_base_url: 'https://mine-auth.example.com',
      },
      extra: {
        gateway_base_url: 'https://extra.neutron.example.com',
        auth_base_url: 'https://extra-auth.example.com',
      },
      env: {
        gateway_base_url: 'https://env.neutron.example.com',
        auth_base_url: 'https://env-auth.example.com',
      },
    });
    expect(resolved.gateway_base_url).toBe('https://mine.neutron.example.com');
    expect(resolved.auth_base_url).toBe('https://mine-auth.example.com');
  });

  it('resolves each field independently (persisted gateway + build-time auth)', () => {
    const resolved = resolveServerBases({
      persisted: { gateway_base_url: 'https://mine.neutron.example.com', auth_base_url: null },
      extra: { auth_base_url: 'https://extra-auth.example.com' },
      env: {},
    });
    expect(resolved.gateway_base_url).toBe('https://mine.neutron.example.com');
    expect(resolved.auth_base_url).toBe('https://extra-auth.example.com');
  });

  it('(d) unconfigured → configured === false and NO loopback fabricated', () => {
    const resolved = resolveServerBases({ persisted: null, extra: {}, env: {} });
    expect(resolved.configured).toBe(false);
    expect(resolved.gateway_base_url).toBe('');
    expect(resolved.auth_base_url).toBe('');
    expect(JSON.stringify(resolved)).not.toContain('127.0.0.1');
  });

  it('treats blank / whitespace-only sources as absent', () => {
    const resolved = resolveServerBases({
      persisted: { gateway_base_url: '   ', auth_base_url: '' },
      extra: { gateway_base_url: '' },
      env: { gateway_base_url: undefined },
    });
    expect(resolved.configured).toBe(false);
    expect(resolved.gateway_base_url).toBe('');
  });

  it('treats a NON-BLANK but degenerate source as absent — never configured with an unusable base', () => {
    // Argus r1 MAJOR: `configured` used to be derived from the raw string,
    // so any of these produced `configured: true` with an empty/garbage
    // base — which mounts the app tree and reintroduces the schemeless
    // relative-URL failure #385 exists to kill.
    for (const bad of ['/', '///', '   /   ', 'https://', 'ftp://bad host', 'javascript:alert(1)']) {
      const resolved = resolveServerBases({
        persisted: null,
        extra: {},
        env: { gateway_base_url: bad },
      });
      expect(resolved.configured).toBe(false);
      expect(resolved.gateway_base_url).toBe('');
    }
  });

  it('a degenerate higher-precedence source falls through to a usable lower one', () => {
    const resolved = resolveServerBases({
      persisted: { gateway_base_url: 'https://', auth_base_url: null },
      extra: { gateway_base_url: 'neutron.example.com' },
      env: {},
    });
    expect(resolved.gateway_base_url).toBe('https://neutron.example.com');
    expect(resolved.configured).toBe(true);
  });

  it('normalises a build-time source (scheme added, case folded, slashes stripped)', () => {
    const resolved = resolveServerBases({
      persisted: null,
      extra: {},
      env: { gateway_base_url: '  Neutron.Example.COM:8443/  ', auth_base_url: 'auth.example.com/' },
    });
    expect(resolved.gateway_base_url).toBe('https://neutron.example.com:8443');
    expect(resolved.auth_base_url).toBe('https://auth.example.com');
  });

  it('ignores non-string `extra` values (Constants.extra is untyped JSON)', () => {
    const resolved = resolveServerBases({
      persisted: null,
      extra: { gateway_base_url: 8080 },
      env: { gateway_base_url: 'https://env.neutron.example.com' },
    });
    expect(resolved.gateway_base_url).toBe('https://env.neutron.example.com');
  });

  it('strips trailing slashes from whichever source wins', () => {
    const resolved = resolveServerBases({
      persisted: { gateway_base_url: 'https://mine.neutron.example.com///', auth_base_url: null },
      extra: {},
      env: {},
    });
    expect(resolved.gateway_base_url).toBe('https://mine.neutron.example.com');
  });

  it('the local-dev suggestion is a UI prefill only — never a resolver default', () => {
    // The PORT must match what a real install listens on, or the
    // mandatory gate fails on its own default (Argus r2 MAJOR).
    // 7800 = `gateway/boot-listener-registry.ts:30` DEFAULT_LISTEN_PORT,
    // `install.sh:82` CHAT_PORT, `bin/neutron:76`.
    expect(LOCAL_DEV_SUGGESTION).toBe('http://127.0.0.1:7800');
    const resolved = resolveServerBases({ persisted: null, extra: {}, env: {} });
    expect(resolved.gateway_base_url).not.toBe(LOCAL_DEV_SUGGESTION);
  });

  it('the suggested port matches the gateway default the harness actually binds', () => {
    // Cross-check against the SOURCE of the default rather than a second
    // hardcoded literal, so a future port change can't silently strand
    // the prefill again.
    const registry = readFileSync(
      join(__dirname, '..', '..', 'gateway', 'boot-listener-registry.ts'),
      'utf8',
    );
    const match = /export const DEFAULT_LISTEN_PORT = ([\d_]+)/.exec(registry);
    expect(match).not.toBeNull();
    const port = Number(match![1]!.replace(/_/g, ''));
    expect(LOCAL_DEV_SUGGESTION.endsWith(`:${port}`)).toBe(true);
  });
});

describe('describeInsecureOrigin — plaintext-to-public-host warning', () => {
  it('says nothing for https', () => {
    expect(describeInsecureOrigin('https://neutron.example.com')).toBeNull();
  });

  it('says nothing for loopback / RFC-1918 / link-local / .local / IPv6 ULA', () => {
    for (const origin of [
      'http://127.0.0.1:7800',
      'http://localhost:7800',
      'http://10.0.0.5:7800',
      'http://192.168.1.20:7800',
      'http://172.16.4.4:7800',
      'http://172.31.255.1',
      'http://169.254.10.10',
      'http://neutron.local:7800',
      'http://[::1]:7800',
      'http://[fd00::1]:7800',
    ]) {
      expect(describeInsecureOrigin(origin)).toBeNull();
    }
  });

  it('warns for plain http to a PUBLIC host (Android allows cleartext to any host)', () => {
    const warning = describeInsecureOrigin('http://neutron.example.com');
    expect(warning).not.toBeNull();
    expect(warning!).toContain('neutron.example.com');
    expect(warning!).toContain('unencrypted');
  });

  it('warns for a public IPv4 too, and is not fooled by 172.15/172.32 edges', () => {
    expect(describeInsecureOrigin('http://93.184.216.34:7800')).not.toBeNull();
    expect(describeInsecureOrigin('http://172.15.0.1')).not.toBeNull();
    expect(describeInsecureOrigin('http://172.32.0.1')).not.toBeNull();
  });
});

describe('normalizeServerUrl — (e) normalisation', () => {
  it('adds https:// when no scheme is given', () => {
    expect(normalizeServerUrl('neutron.example.com')).toBe('https://neutron.example.com');
  });

  it('keeps an explicit http:// scheme (local dev)', () => {
    expect(normalizeServerUrl('http://192.168.1.20:8080')).toBe('http://192.168.1.20:8080');
  });

  it('strips trailing slashes', () => {
    expect(normalizeServerUrl('https://neutron.example.com///')).toBe(
      'https://neutron.example.com',
    );
    expect(normalizeServerUrl('neutron.example.com/')).toBe('https://neutron.example.com');
  });

  it('preserves a reverse-proxy sub-path but strips its trailing slash', () => {
    expect(normalizeServerUrl('https://example.com/neutron/')).toBe(
      'https://example.com/neutron',
    );
  });

  it('trims whitespace and lower-cases scheme + authority', () => {
    expect(normalizeServerUrl('  HTTPS://Neutron.Example.COM:8443/  ')).toBe(
      'https://neutron.example.com:8443',
    );
  });

  it('drops query strings and fragments', () => {
    expect(normalizeServerUrl('https://neutron.example.com/?a=1#frag')).toBe(
      'https://neutron.example.com',
    );
  });

  it('rejects empty, whitespace-only and non-http(s) input', () => {
    expect(normalizeServerUrl('')).toBeNull();
    expect(normalizeServerUrl('   ')).toBeNull();
    expect(normalizeServerUrl('ftp://neutron.example.com')).toBeNull();
    expect(normalizeServerUrl('https://')).toBeNull();
    expect(normalizeServerUrl('not a host')).toBeNull();
  });

  it('rejects a scheme-like prefix with no `//` (would otherwise become a hostname)', () => {
    expect(normalizeServerUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeServerUrl('mailto:sam@example.com')).toBeNull();
    expect(normalizeServerUrl('https://host:notaport')).toBeNull();
  });

  it('accepts an IPv4 literal with a port and a bracketed IPv6 literal', () => {
    expect(normalizeServerUrl('http://10.0.0.5:8080')).toBe('http://10.0.0.5:8080');
    expect(normalizeServerUrl('http://[::1]:8080/')).toBe('http://[::1]:8080');
  });

  it('rejects an out-of-range port instead of failing later with an opaque transport error', () => {
    expect(normalizeServerUrl('https://neutron.example.com:99999')).toBeNull();
    expect(normalizeServerUrl('https://neutron.example.com:0')).toBeNull();
    expect(normalizeServerUrl('https://neutron.example.com:65535')).toBe(
      'https://neutron.example.com:65535',
    );
  });

  it('rejects malformed authorities (empty label, underscore) and accepts a trailing-dot FQDN', () => {
    expect(normalizeServerUrl('https://host..example.com')).toBeNull();
    expect(normalizeServerUrl('https://a_b.example.com')).toBeNull();
    expect(normalizeServerUrl('https://-nope.example.com')).toBeNull();
    expect(normalizeServerUrl('neutron.example.com.')).toBe('https://neutron.example.com.');
  });

  it('stripTrailingSlashes is a no-op on a clean origin', () => {
    expect(stripTrailingSlashes('https://neutron.example.com')).toBe(
      'https://neutron.example.com',
    );
  });
});

describe('checkServerUrl — (f) /healthz validation', () => {
  it('succeeds when /healthz answers 200 with the gateway health body', async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string) => {
      seen.push(url);
      return new Response(healthBody(), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const result = await checkServerUrl({ raw: 'neutron.example.com/', fetchFn });
    expect(result.ok).toBe(true);
    expect(result.ok && result.url).toBe('https://neutron.example.com');
    expect(seen).toEqual(['https://neutron.example.com/healthz']);
  });

  it('accepts a DEGRADED gateway (still 200, still your server)', async () => {
    const fetchFn = (async () =>
      new Response(healthBody('degraded'), { status: 200 })) as unknown as typeof globalThis.fetch;
    const result = await checkServerUrl({ raw: 'https://neutron.example.com', fetchFn });
    expect(result.ok).toBe(true);
  });

  it('rejects a 200 that is NOT a Neutron health body (captive portal / router page)', async () => {
    const fetchFn = (async () =>
      new Response('<html><title>Wi-Fi login</title></html>', {
        status: 200,
      })) as unknown as typeof globalThis.fetch;
    const result = await checkServerUrl({ raw: 'https://portal.example.com', fetchFn });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('not like a Neutron gateway');
  });

  it('rejects a 200 JSON body missing the health keys', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ hello: 'world' }), {
        status: 200,
      })) as unknown as typeof globalThis.fetch;
    const result = await checkServerUrl({ raw: 'https://neutron.example.com', fetchFn });
    expect(result.ok).toBe(false);
  });

  it('reports a TIMEOUT in plain language, not a raw AbortError', async () => {
    // A blackholed host / firewalled port: the fetch never settles until
    // the AbortController fires, then rejects with an AbortError whose
    // message ("signal is aborted without reason") is useless to the owner.
    const fetchFn = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('signal is aborted without reason')),
        );
      })) as unknown as typeof globalThis.fetch;

    const result = await checkServerUrl({
      raw: 'https://blackhole.example.com',
      fetchFn,
      timeout_ms: 20,
    });
    expect(result.ok).toBe(false);
    // Argus r2 NIT: a sub-second budget used to render as "within 0s".
    expect(!result.ok && result.message).toContain('did not answer /healthz within 20ms.');
    expect(!result.ok && result.message).not.toContain('within 0s');
    expect(!result.ok && result.message).not.toContain('aborted');
  });

  it('renders a whole-second budget in seconds', async () => {
    const fetchFn = (() => new Promise(() => undefined)) as unknown as typeof globalThis.fetch;
    const result = await checkServerUrl({
      raw: 'https://blackhole.example.com',
      fetchFn,
      timeout_ms: 2000,
    });
    expect(!result.ok && result.message).toContain('within 2s.');
  });

  it('TIMES OUT even when the fetch ignores the abort signal entirely', async () => {
    // Argus r2 NIT: the deadline used to be wired ONLY to an
    // AbortController, so a fetch that never settles (or a runtime with
    // no AbortController) left the form `busy` forever with no Cancel.
    // The timer is now raced, so `checkServerUrl` is total.
    const fetchFn = (() => new Promise(() => undefined)) as unknown as typeof globalThis.fetch;
    const result = await checkServerUrl({
      raw: 'https://hangs.example.com',
      fetchFn,
      timeout_ms: 15,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('did not answer /healthz within');
  });

  it('reports a TIMEOUT, not a bad-body error, when the abort lands mid body read', async () => {
    // Argus r2 NIT: `isNeutronHealthBody` swallows a throwing `res.text()`
    // and returns false, and that false used to be checked BEFORE the
    // timeout branch — so a lossy LAN link that dropped during the body
    // read was reported as "not like a Neutron gateway", pointing the
    // owner at the wrong problem.
    const fetchFn = (async (_url: string, init?: { signal?: AbortSignal }) => ({
      ok: true,
      status: 200,
      async text(): Promise<string> {
        await new Promise<void>((resolve) => {
          if (init?.signal?.aborted === true) resolve();
          else init?.signal?.addEventListener('abort', () => resolve());
        });
        throw new Error('The network connection was lost.');
      },
    })) as unknown as typeof globalThis.fetch;

    const result = await checkServerUrl({
      raw: 'https://lossy.example.com',
      fetchFn,
      timeout_ms: 15,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('did not answer /healthz within');
    expect(!result.ok && result.message).not.toContain('not like a Neutron gateway');
  });

  it('fails with the status when /healthz answers non-2xx', async () => {
    const fetchFn = (async () =>
      new Response('nope', { status: 502 })) as unknown as typeof globalThis.fetch;
    const result = await checkServerUrl({ raw: 'https://neutron.example.com', fetchFn });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('502');
  });

  it('fails with the transport error when the host is unreachable', async () => {
    const fetchFn = (async () => {
      throw new Error('Network request failed');
    }) as unknown as typeof globalThis.fetch;
    const result = await checkServerUrl({ raw: 'https://nope.example.com', fetchFn });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('Network request failed');
    expect(!result.ok && result.url).toBe('https://nope.example.com');
  });

  it('fails before any fetch when the URL cannot be normalised', async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response('ok');
    }) as unknown as typeof globalThis.fetch;
    const result = await checkServerUrl({ raw: 'ftp://x', fetchFn });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
    expect(!result.ok && result.url).toBeNull();
  });
});

describe('commitServerConfig — persist + session hygiene', () => {
  it('persists the normalised gateway URL under the server key', async () => {
    const backing = makeBacking();
    const store = new WebTokenStorage(backing);
    const result = await commitServerConfig({
      gateway_raw: 'neutron.example.com/',
      previous_gateway_base_url: '',
      store,
      fetchFn: okFetch(),
    });
    expect(result.ok).toBe(true);
    expect(backing.snapshot()[SERVER_GATEWAY_KEY]).toBe('https://neutron.example.com');
    expect(await store.getServerConfig()).toEqual({
      gateway_base_url: 'https://neutron.example.com',
      auth_base_url: null,
    });
  });

  it('persists an optional identity-service URL and removes it when blank', async () => {
    const backing = makeBacking();
    const store = new WebTokenStorage(backing);
    await commitServerConfig({
      gateway_raw: 'https://neutron.example.com',
      auth_raw: 'auth.example.com/',
      previous_gateway_base_url: '',
      store,
      fetchFn: okFetch(),
    });
    expect(backing.snapshot()[SERVER_AUTH_KEY]).toBe('https://auth.example.com');

    await commitServerConfig({
      gateway_raw: 'https://neutron.example.com',
      auth_raw: '',
      previous_gateway_base_url: 'https://neutron.example.com',
      store,
      fetchFn: okFetch(),
    });
    expect(backing.snapshot()[SERVER_AUTH_KEY]).toBeUndefined();
  });

  it('(g) clears the persisted session when the host CHANGES', async () => {
    const backing = makeBacking();
    const store = new WebTokenStorage(backing);
    await store.setToken(USER.token);
    await store.setUser(USER);

    const result = await commitServerConfig({
      gateway_raw: 'https://new.neutron.example.com',
      previous_gateway_base_url: 'https://old.neutron.example.com',
      store,
      fetchFn: okFetch(),
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.session_cleared).toBe(true);
    expect(backing.snapshot()[TOKEN_KEY]).toBeUndefined();
    expect(backing.snapshot()[USER_KEY]).toBeUndefined();
    // The server config survives the session wipe.
    expect(backing.snapshot()[SERVER_GATEWAY_KEY]).toBe('https://new.neutron.example.com');
  });

  it('(g) keeps the session when the host is unchanged (re-save / trailing slash)', async () => {
    const backing = makeBacking();
    const store = new WebTokenStorage(backing);
    await store.setToken(USER.token);
    await store.setUser(USER);

    const result = await commitServerConfig({
      gateway_raw: 'https://neutron.example.com/',
      previous_gateway_base_url: 'https://neutron.example.com',
      store,
      fetchFn: okFetch(),
    });

    expect(result.ok && result.session_cleared).toBe(false);
    expect(backing.snapshot()[TOKEN_KEY]).toBe(USER.token);
  });

  it('first-run with NOTHING stored does not report a session clear', async () => {
    const backing = makeBacking();
    const store = new WebTokenStorage(backing);
    const result = await commitServerConfig({
      gateway_raw: 'https://neutron.example.com',
      previous_gateway_base_url: '',
      store,
      fetchFn: okFetch(),
    });
    expect(result.ok && result.session_cleared).toBe(false);
  });

  it('(g) first-run gate WIPES a session inherited from another host (OTA upgrade)', async () => {
    // Argus r1 MAJOR: an install that signed in under the old loopback
    // default has no `neutron.server.*` key, so it lands on the first-run
    // gate with `previous_gateway_base_url === ''` — and its stale token
    // must NOT survive into the newly named host (signed-in UI where every
    // request 401s).
    const backing = makeBacking();
    const store = new WebTokenStorage(backing);
    await store.setToken(USER.token);
    await store.setUser(USER);

    const result = await commitServerConfig({
      gateway_raw: 'https://mine.neutron.example.com',
      previous_gateway_base_url: '',
      store,
      fetchFn: okFetch(),
    });

    expect(result.ok && result.session_cleared).toBe(true);
    expect(backing.snapshot()[TOKEN_KEY]).toBeUndefined();
    expect(backing.snapshot()[USER_KEY]).toBeUndefined();
    expect(backing.snapshot()[SERVER_GATEWAY_KEY]).toBe('https://mine.neutron.example.com');
  });

  it('persists the new server BEFORE wiping the session (a failed persist keeps both consistent)', async () => {
    // Argus r1 MINOR: clearing first meant a rejected `setServerConfig`
    // left the owner logged out AND still pointed at the old host.
    const order: string[] = [];
    const store = {
      async getServerConfig() {
        order.push('getServerConfig');
        return { gateway_base_url: 'https://old.neutron.example.com', auth_base_url: null };
      },
      async setServerConfig() {
        order.push('persist');
        throw new Error('QuotaExceededError');
      },
      async getToken() {
        order.push('getToken');
        return USER.token;
      },
      async clearAll() {
        order.push('clearAll');
      },
    };

    await expect(
      commitServerConfig({
        gateway_raw: 'https://new.neutron.example.com',
        previous_gateway_base_url: 'https://old.neutron.example.com',
        store,
        fetchFn: okFetch(),
      }),
    ).rejects.toThrow('QuotaExceededError');
    expect(order).toEqual(['getServerConfig', 'persist']);
  });

  it('ROLLS BACK the persisted server when the session wipe rejects', async () => {
    // Argus r2 MINOR: the persist landed first, so a rejecting
    // `getToken`/`clearAll` (partial AsyncStorage IO failure) used to
    // leave storage on the NEW host while the running process stayed on
    // the OLD one — and the next launch booted the new server holding
    // the old server's token.
    const backing = makeBacking();
    const real = new WebTokenStorage(backing);
    await real.setServerConfig({
      gateway_base_url: 'https://old.neutron.example.com',
      auth_base_url: 'https://auth.example.com',
    });
    const store = {
      getServerConfig: () => real.getServerConfig(),
      setServerConfig: (config: Parameters<typeof real.setServerConfig>[0]) =>
        real.setServerConfig(config),
      async getToken(): Promise<string | null> {
        throw new Error('AsyncStorage read failed');
      },
      clearAll: () => real.clearAll(),
    };

    const result = await commitServerConfig({
      gateway_raw: 'https://new.neutron.example.com',
      previous_gateway_base_url: 'https://old.neutron.example.com',
      store,
      fetchFn: okFetch(),
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('AsyncStorage read failed');
    // Storage is back exactly where it started — a clean retryable no-op.
    expect(backing.snapshot()[SERVER_GATEWAY_KEY]).toBe('https://old.neutron.example.com');
    expect(backing.snapshot()[SERVER_AUTH_KEY]).toBe('https://auth.example.com');
  });

  it('reports host_changed so the caller can bounce to /login even with no token to clear', async () => {
    // Argus r2 MAJOR: Settings keyed its `clear()` + `router.replace`
    // on `session_cleared`, which is false when there was no persisted
    // token — leaving an authenticated-looking screen on a NEW host.
    const backing = makeBacking();
    const store = new WebTokenStorage(backing);
    const changed = await commitServerConfig({
      gateway_raw: 'https://new.neutron.example.com',
      previous_gateway_base_url: 'https://old.neutron.example.com',
      store,
      fetchFn: okFetch(),
    });
    expect(changed.ok && changed.host_changed).toBe(true);
    expect(changed.ok && changed.session_cleared).toBe(false);

    const same = await commitServerConfig({
      gateway_raw: 'https://new.neutron.example.com/',
      previous_gateway_base_url: 'https://new.neutron.example.com',
      store,
      fetchFn: okFetch(),
    });
    expect(same.ok && same.host_changed).toBe(false);
  });

  it('persists NOTHING when /healthz validation fails', async () => {
    const backing = makeBacking();
    const store = new WebTokenStorage(backing);
    const fetchFn = (async () => {
      throw new Error('Network request failed');
    }) as unknown as typeof globalThis.fetch;

    const result = await commitServerConfig({
      gateway_raw: 'https://nope.example.com',
      previous_gateway_base_url: '',
      store,
      fetchFn,
    });
    expect(result.ok).toBe(false);
    expect(backing.snapshot()[SERVER_GATEWAY_KEY]).toBeUndefined();
  });

  it('rejects an unparseable identity-service URL before touching the network', async () => {
    const backing = makeBacking();
    const store = new WebTokenStorage(backing);
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response('ok');
    }) as unknown as typeof globalThis.fetch;

    const result = await commitServerConfig({
      gateway_raw: 'https://neutron.example.com',
      auth_raw: 'ftp://bad',
      previous_gateway_base_url: '',
      store,
      fetchFn,
    });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
    expect(backing.snapshot()[SERVER_GATEWAY_KEY]).toBeUndefined();
  });
});

/**
 * ISSUES #394 — the persisted origin must be the one the probe SETTLED on,
 * not the one that was typed.
 *
 * Entering `http://<host>` for a TLS-terminated install makes the proxy 301 to
 * https. The probe follows it and reports healthy, so the connect screen
 * accepted the typed `http://` origin — and every later authenticated request
 * then redirected too, with the platform STRIPPING `Authorization` across the
 * scheme change. The gateway answered `missing_bearer` and the Projects screen
 * looked broken while the token was perfectly valid.
 *
 * Observed live 2026-07-27 with ONE token against ONE host:
 *   https://<host>/api/app/projects       → 200
 *   http://<host>/api/app/projects  (301) → 401   ← header did not survive
 */
describe('checkServerUrl — persists the post-redirect origin (#394)', () => {
  const withFinalUrl = (finalUrl: string): typeof globalThis.fetch =>
    (async () => {
      const res = new Response(healthBody(), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      Object.defineProperty(res, 'url', { value: finalUrl, configurable: true });
      return res;
    }) as unknown as typeof globalThis.fetch;

  it('an http:// input that redirects to https:// is stored as https://', async () => {
    const res = await checkServerUrl({
      raw: 'http://neutron.example.com',
      fetchFn: withFinalUrl('https://neutron.example.com/healthz'),
    });
    expect(res.ok).toBe(true);
    expect(res.url).toBe('https://neutron.example.com');
  });

  it('keeps the typed origin when no redirect happened', async () => {
    const res = await checkServerUrl({
      raw: 'https://neutron.example.com',
      fetchFn: withFinalUrl('https://neutron.example.com/healthz'),
    });
    expect(res.ok).toBe(true);
    expect(res.url).toBe('https://neutron.example.com');
  });

  it('keeps plain http for a loopback dev server (no redirect)', async () => {
    const res = await checkServerUrl({
      raw: 'http://127.0.0.1:7800',
      fetchFn: withFinalUrl('http://127.0.0.1:7800/healthz'),
    });
    expect(res.ok).toBe(true);
    expect(res.url).toBe('http://127.0.0.1:7800');
  });

  it('falls back to the typed origin when the fetch reports no final url', async () => {
    const res = await checkServerUrl({
      raw: 'https://neutron.example.com',
      fetchFn: okFetch(),
    });
    expect(res.ok).toBe(true);
    expect(res.url).toBe('https://neutron.example.com');
  });
});
