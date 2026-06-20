/**
 * @neutronai/app — token storage unit tests (P5.0).
 *
 * Exercises both backings (sync + async) via the testable
 * `WebTokenStorage` / `NativeTokenStorage` classes — no Platform
 * detection, no React Native bridge. The runtime resolver
 * `tokenStorage()` is intentionally NOT covered here; it just picks
 * a class based on `Platform.OS`, which can't be loaded under
 * `bun test`.
 */

import { describe, expect, it } from 'bun:test';

import type { AuthUser } from '../lib/auth';
import {
  NativeTokenStorage,
  TOKEN_KEY,
  USER_KEY,
  WebTokenStorage,
  type SyncKeyValueStore,
} from '../lib/token-storage';

function makeSyncBacking(): SyncKeyValueStore & { snapshot(): Record<string, string> } {
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

interface AsyncBacking {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  snapshot(): Record<string, string>;
}

function makeAsyncBacking(): AsyncBacking {
  const map = new Map<string, string>();
  return {
    async getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    async setItem(key, value) {
      map.set(key, value);
    },
    async removeItem(key) {
      map.delete(key);
    },
    snapshot() {
      return Object.fromEntries(map);
    },
  };
}

const sampleUser: AuthUser = {
  id: 'sam',
  email: 'sam@dev.localhost',
  displayName: 'Sam Doe',
  provider: 'dev',
  token: 'dev:sam',
};

describe('WebTokenStorage', () => {
  it('setToken → getToken round-trips and clearToken removes it', async () => {
    const backing = makeSyncBacking();
    const ts = new WebTokenStorage(backing);
    expect(await ts.getToken()).toBeNull();
    await ts.setToken('dev:alpha');
    expect(await ts.getToken()).toBe('dev:alpha');
    expect(backing.snapshot()[TOKEN_KEY]).toBe('dev:alpha');
    await ts.clearToken();
    expect(await ts.getToken()).toBeNull();
    expect(backing.snapshot()[TOKEN_KEY]).toBeUndefined();
  });

  it('setUser persists JSON, getUser parses it back', async () => {
    const backing = makeSyncBacking();
    const ts = new WebTokenStorage(backing);
    expect(await ts.getUser()).toBeNull();
    await ts.setUser(sampleUser);
    const fromBacking = JSON.parse(backing.snapshot()[USER_KEY]!) as AuthUser;
    expect(fromBacking).toEqual(sampleUser);
    expect(await ts.getUser()).toEqual(sampleUser);
  });

  it('clearAll wipes both token + user keys', async () => {
    const backing = makeSyncBacking();
    const ts = new WebTokenStorage(backing);
    await ts.setToken('x');
    await ts.setUser(sampleUser);
    await ts.clearAll();
    expect(backing.snapshot()).toEqual({});
  });

  it('treats corrupt user JSON as logged-out and self-heals', async () => {
    const backing = makeSyncBacking();
    backing.setItem(USER_KEY, 'not json {{{');
    const ts = new WebTokenStorage(backing);
    expect(await ts.getUser()).toBeNull();
    expect(backing.snapshot()[USER_KEY]).toBeUndefined();
  });
});

describe('NativeTokenStorage', () => {
  it('setToken → getToken round-trips through the async backing', async () => {
    const backing = makeAsyncBacking();
    const ts = new NativeTokenStorage(backing);
    expect(await ts.getToken()).toBeNull();
    await ts.setToken('dev:beta');
    expect(await ts.getToken()).toBe('dev:beta');
    expect(backing.snapshot()[TOKEN_KEY]).toBe('dev:beta');
    await ts.clearToken();
    expect(await ts.getToken()).toBeNull();
  });

  it('persists + reads back AuthUser via JSON encoding', async () => {
    const backing = makeAsyncBacking();
    const ts = new NativeTokenStorage(backing);
    await ts.setUser(sampleUser);
    expect(await ts.getUser()).toEqual(sampleUser);
    await ts.clearUser();
    expect(await ts.getUser()).toBeNull();
  });

  it('clearAll wipes both async-stored keys', async () => {
    const backing = makeAsyncBacking();
    const ts = new NativeTokenStorage(backing);
    await ts.setToken('z');
    await ts.setUser(sampleUser);
    await ts.clearAll();
    expect(backing.snapshot()).toEqual({});
  });
});
