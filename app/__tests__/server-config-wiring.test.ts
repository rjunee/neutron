/**
 * @neutronai/app — `lib/config.ts` WIRING tests (ISSUES #385).
 *
 * `server-url.test.ts` covers the pure resolver. This file covers the part
 * that actually ships the fix and that a pure-helper test can never reach
 * (Argus r1 MAJOR — "assert the pure module, never the invocation" is a
 * banned pattern):
 *
 *   - `hydrateServerConfig()` reads the persisted config into the
 *     module-level cache (and never throws when storage fails),
 *   - `loadAppConfig()` — SYNCHRONOUS, ~20 call sites — sees that cache,
 *   - `setRuntimeServerConfig()` makes an in-app change visible
 *     immediately, without a re-hydrate,
 *   - the env tier is read as a LITERAL `process.env.EXPO_PUBLIC_*` member
 *     expression (the regression that made the whole build-time tier dead
 *     in every real Expo build),
 *   - an unconfigured install reports `configured: false` and fabricates
 *     NO URL — in particular no `127.0.0.1`.
 *
 * Convention (matching `diagnostics-pane-render.test.ts` /
 * `authed-attachment-file-open.test.tsx`): the app's bun:test runtime has
 * no Expo runtime, so `expo-constants` is virtualized via `mock.module`
 * and the REAL `lib/config.ts` is then imported with a top-level
 * `await import`. `mock.module` is process-global in bun — safe here
 * because this is the only app test that touches `expo-constants`
 * (`grep -rn "expo-constants" app/__tests__/`). `lib/token-storage.ts`
 * needs no mock: its `react-native` require is lazy, inside
 * `tokenStorage()`, and every test below injects its own storage.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PersistedServerConfig } from '../lib/token-storage';

// Mutable `extra`, read through a getter so a test can swap the build-time
// config between calls without re-registering the module mock.
const expoState: { extra: Record<string, unknown> } = { extra: {} };
mock.module('expo-constants', () => ({
  default: {
    get expoConfig() {
      return { extra: expoState.extra };
    },
  },
}));

const {
  __resetServerConfigForTests,
  getRuntimeServerConfig,
  getServerConfigEpoch,
  hydrateServerConfig,
  isServerConfigHydrated,
  loadAppConfig,
  setRuntimeServerConfig,
  subscribeServerConfig,
} = await import('../lib/config');

const GATEWAY_ENV = 'EXPO_PUBLIC_NEUTRON_BASE_URL';
const AUTH_ENV = 'EXPO_PUBLIC_NEUTRON_AUTH_BASE_URL';

/** A `getServerConfig`-only storage stub — the shape `hydrateServerConfig` needs. */
function stubStore(config: PersistedServerConfig | Error) {
  return {
    calls: 0,
    async getServerConfig(): Promise<PersistedServerConfig> {
      this.calls += 1;
      if (config instanceof Error) throw config;
      return config;
    },
  };
}

beforeEach(() => {
  __resetServerConfigForTests();
  expoState.extra = {};
  delete process.env[GATEWAY_ENV];
  delete process.env[AUTH_ENV];
});

afterEach(() => {
  __resetServerConfigForTests();
  delete process.env[GATEWAY_ENV];
  delete process.env[AUTH_ENV];
});

describe('loadAppConfig — unconfigured install', () => {
  it('(d) reports configured:false and fabricates NO url (no loopback anywhere)', async () => {
    await hydrateServerConfig(stubStore({ gateway_base_url: null, auth_base_url: null }));
    const config = loadAppConfig();
    expect(config.configured).toBe(false);
    expect(config.gateway_base_url).toBe('');
    expect(config.base_url).toBe('');
    expect(config.auth_base_url).toBe('');
    expect(config.ws_base_url).toBe('');
    expect(JSON.stringify(config)).not.toContain('127.0.0.1');
  });

  it('hydration marks itself complete even when storage throws (gate, not crash)', async () => {
    expect(isServerConfigHydrated()).toBe(false);
    await hydrateServerConfig(stubStore(new Error('AsyncStorage unavailable')));
    expect(isServerConfigHydrated()).toBe(true);
    expect(getRuntimeServerConfig()).toEqual({ gateway_base_url: null, auth_base_url: null });
    expect(loadAppConfig().configured).toBe(false);
  });
});

describe('loadAppConfig — precedence through the real module cache', () => {
  it('(a) honours EXPO_PUBLIC_NEUTRON_* when nothing is persisted', async () => {
    process.env[GATEWAY_ENV] = 'https://env.neutron.example.com';
    process.env[AUTH_ENV] = 'https://env-auth.example.com';
    await hydrateServerConfig(stubStore({ gateway_base_url: null, auth_base_url: null }));

    const config = loadAppConfig();
    expect(config.gateway_base_url).toBe('https://env.neutron.example.com');
    expect(config.auth_base_url).toBe('https://env-auth.example.com');
    expect(config.ws_base_url).toBe('wss://env.neutron.example.com');
    expect(config.configured).toBe(true);
  });

  it('(a) the env read is a LITERAL process.env member expression (source invariant)', () => {
    // REGRESSION GUARD for the Argus r1 BLOCKER, and the one property no
    // runtime assertion can cover: under bun the alias form behaves
    // identically, but `babel-preset-expo`'s inline-env-vars plugin only
    // rewrites `process.env.EXPO_PUBLIC_*` reads whose object is literally
    // `process.env` (`isProcessEnv`), so hoisting that object into a local
    // variable compiles fine, passes every resolver test, and is DEAD in
    // every real Expo build. Same structural-guard pattern as
    // `docs-hooks-invariants.test.ts`.
    const source = readFileSync(join(import.meta.dir, '..', 'lib', 'config.ts'), 'utf8');
    const reads = source.match(/process\.env\.EXPO_PUBLIC_NEUTRON_\w+/g) ?? [];
    expect(reads).toEqual([
      'process.env.EXPO_PUBLIC_NEUTRON_BASE_URL',
      'process.env.EXPO_PUBLIC_NEUTRON_AUTH_BASE_URL',
    ]);
    // No local rebinding of `process.env` (in code OR in a stale comment
    // that would mislead the next reader into re-introducing one).
    expect(source).not.toMatch(/(?:const|let|var)\s+\w+\s*=\s*process\.env\b/);
  });

  it('(b) `extra.neutron_*` beats the env var', async () => {
    process.env[GATEWAY_ENV] = 'https://env.neutron.example.com';
    expoState.extra = { neutron_base_url: 'https://extra.neutron.example.com' };
    await hydrateServerConfig(stubStore({ gateway_base_url: null, auth_base_url: null }));

    expect(loadAppConfig().gateway_base_url).toBe('https://extra.neutron.example.com');
  });

  it('(c) the persisted runtime value beats BOTH', async () => {
    process.env[GATEWAY_ENV] = 'https://env.neutron.example.com';
    expoState.extra = { neutron_base_url: 'https://extra.neutron.example.com' };
    await hydrateServerConfig(
      stubStore({ gateway_base_url: 'https://mine.neutron.example.com', auth_base_url: null }),
    );

    const config = loadAppConfig();
    expect(config.gateway_base_url).toBe('https://mine.neutron.example.com');
    expect(config.base_url).toBe('https://mine.neutron.example.com');
    expect(config.ws_base_url).toBe('wss://mine.neutron.example.com');
  });

  it('normalises a build-time value (the app never carries a raw typed string)', async () => {
    process.env[GATEWAY_ENV] = 'neutron.example.com/';
    await hydrateServerConfig(stubStore({ gateway_base_url: null, auth_base_url: null }));
    expect(loadAppConfig().gateway_base_url).toBe('https://neutron.example.com');
  });

  it('a degenerate build-time value leaves the install UNCONFIGURED (setup gate shows)', async () => {
    process.env[GATEWAY_ENV] = '/';
    await hydrateServerConfig(stubStore({ gateway_base_url: null, auth_base_url: null }));
    const config = loadAppConfig();
    expect(config.configured).toBe(false);
    expect(config.gateway_base_url).toBe('');
    expect(config.ws_base_url).toBe('');
  });

  it('reads `extra.hide_telegram_parity_hint` off the same Constants.extra', async () => {
    expoState.extra = { neutron_base_url: 'https://extra.neutron.example.com' };
    await hydrateServerConfig(stubStore({ gateway_base_url: null, auth_base_url: null }));
    expect(loadAppConfig().show_telegram_parity_hint).toBe(true);

    expoState.extra = {
      neutron_base_url: 'https://extra.neutron.example.com',
      hide_telegram_parity_hint: true,
    };
    expect(loadAppConfig().show_telegram_parity_hint).toBe(false);
  });
});

describe('boot-gate contract: hydrate once, then synchronous reads', () => {
  it('hydrates exactly once and every later loadAppConfig() is a cache read', async () => {
    const store = stubStore({
      gateway_base_url: 'https://mine.neutron.example.com',
      auth_base_url: null,
    });
    await hydrateServerConfig(store);
    loadAppConfig();
    loadAppConfig();
    expect(store.calls).toBe(1);
    expect(loadAppConfig().gateway_base_url).toBe('https://mine.neutron.example.com');
  });

  it('setRuntimeServerConfig makes an in-app change visible to the NEXT sync read', async () => {
    await hydrateServerConfig(stubStore({ gateway_base_url: null, auth_base_url: null }));
    expect(loadAppConfig().configured).toBe(false);

    // What `components/ServerConnectForm.tsx` does after a successful
    // commit — the setup gate then flips to 'ready' and the app tree reads
    // the new host synchronously, with no re-hydrate.
    setRuntimeServerConfig({
      gateway_base_url: 'http://192.168.1.20:7800',
      auth_base_url: null,
    });
    const config = loadAppConfig();
    expect(config.configured).toBe(true);
    expect(config.gateway_base_url).toBe('http://192.168.1.20:7800');
    expect(config.ws_base_url).toBe('ws://192.168.1.20:7800');
    expect(getRuntimeServerConfig().gateway_base_url).toBe('http://192.168.1.20:7800');
    expect(isServerConfigHydrated()).toBe(true);
  });
});

describe('server-config epoch — invalidation for already-mounted screens', () => {
  // Argus r2 MAJOR: `loadAppConfig()` is frozen for a component's lifetime
  // at ~10 `useMemo(() => loadAppConfig(), [])` call sites, so mutating the
  // cache alone left mounted screens issuing HTTP + WS at the OLD host.
  // `app/app/_layout.tsx` subscribes here and re-keys the whole app tree.

  it('starts at 0 and increments once per commit', async () => {
    await hydrateServerConfig(stubStore({ gateway_base_url: null, auth_base_url: null }));
    expect(getServerConfigEpoch()).toBe(0);
    setRuntimeServerConfig({ gateway_base_url: 'https://a.example.com', auth_base_url: null });
    expect(getServerConfigEpoch()).toBe(1);
    setRuntimeServerConfig({ gateway_base_url: 'https://b.example.com', auth_base_url: null });
    expect(getServerConfigEpoch()).toBe(2);
  });

  it('notifies subscribers, and the epoch is already current when they run', () => {
    const seen: Array<{ epoch: number; base: string }> = [];
    const unsubscribe = subscribeServerConfig(() => {
      seen.push({ epoch: getServerConfigEpoch(), base: loadAppConfig().gateway_base_url });
    });
    setRuntimeServerConfig({ gateway_base_url: 'https://new.example.com', auth_base_url: null });
    expect(seen).toEqual([{ epoch: 1, base: 'https://new.example.com' }]);

    unsubscribe();
    setRuntimeServerConfig({ gateway_base_url: 'https://other.example.com', auth_base_url: null });
    expect(seen).toHaveLength(1);
  });

  it('a throwing subscriber cannot block the others or the commit', () => {
    const calls: string[] = [];
    subscribeServerConfig(() => {
      calls.push('first');
      throw new Error('unmounted mid-notify');
    });
    subscribeServerConfig(() => {
      calls.push('second');
    });
    setRuntimeServerConfig({ gateway_base_url: 'https://x.example.com', auth_base_url: null });
    expect(calls).toEqual(['first', 'second']);
    expect(loadAppConfig().gateway_base_url).toBe('https://x.example.com');
  });

  it('a subscriber that unsubscribes DURING notification does not skip its siblings', () => {
    // React unmounts run as effect cleanups, so this really happens.
    const calls: string[] = [];
    const off = subscribeServerConfig(() => {
      calls.push('self-removing');
      off();
    });
    subscribeServerConfig(() => {
      calls.push('sibling');
    });
    setRuntimeServerConfig({ gateway_base_url: 'https://y.example.com', auth_base_url: null });
    expect(calls).toEqual(['self-removing', 'sibling']);
  });
});

/**
 * LOGIN-FIRST — the final hop of discovery (SPEC § Decisions Log 2026-07-25).
 *
 * `login-first-discovery.test.ts` owns the discovery flow, but it must not
 * mock `expo-constants` (that mock is process-global in bun, and this file is
 * the only app test allowed to register it — see the header). So the last
 * link in the chain is asserted HERE, where `lib/config.ts` is genuinely
 * loadable: a discovered `publicUrl`, once adopted, is what the synchronous
 * `loadAppConfig()` that ~20 call sites read actually returns.
 *
 * Without this, "discovery persists the right value" and "the app reads the
 * persisted value" would both be proven while the join between them was not.
 */
describe('login-first — an adopted publicUrl becomes what loadAppConfig() returns', () => {
  it('discover → adopt → hydrate → loadAppConfig, with no 127.0.0.1 anywhere', async () => {
    const { adoptDiscoveredInstance, discoverInstance } = await import('../lib/identity-client');
    const { SERVER_GATEWAY_KEY, WebTokenStorage } = await import('../lib/token-storage');

    const map = new Map<string, string>();
    const backing = {
      getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    };
    const store = new WebTokenStorage(backing);

    // `/v1/route` answers with BOTH urls, exactly as the real service does;
    // `/healthz` answers as a real gateway so the adopt step can validate.
    const fetchFn = (async (url: string) => {
      if (url.endsWith('/v1/route')) {
        return new Response(
          JSON.stringify({
            slug: 'acme',
            publicUrl: 'https://acme.example.com',
            upstreamUrl: 'http://127.0.0.1:7800',
            accessToken: 'instance-scoped-acme',
            claims: { sub: 'u-1', slug: 'acme' },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ status: 'ok', project_slug: 'general', uptime_ms: 1 }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const found = await discoverInstance({
      auth_base_url: 'https://auth.example.com',
      session_token: 'account-scoped-token',
      fetchFn,
    });
    expect(found.ok).toBe(true);
    if (!found.ok) return;

    const adopted = await adoptDiscoveredInstance({
      instance: found.value,
      auth_base_url: 'https://auth.example.com',
      previous_gateway_base_url: '',
      store,
      fetchFn,
    });
    expect(adopted.ok).toBe(true);
    expect(map.get(SERVER_GATEWAY_KEY)).toBe('https://acme.example.com');

    // The REAL boot path: hydrate the module cache from storage, then read it
    // the way every screen does.
    await hydrateServerConfig(store);
    const config = loadAppConfig();
    expect(config.configured).toBe(true);
    expect(config.gateway_base_url).toBe('https://acme.example.com');
    // The WS base is derived from the discovered host, not the loopback.
    expect(config.ws_base_url).toBe('wss://acme.example.com');
    expect(JSON.stringify(config)).not.toContain('127.0.0.1');
  });
});
