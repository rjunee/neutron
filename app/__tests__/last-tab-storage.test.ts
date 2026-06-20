/**
 * @neutronai/app — last-tab-storage unit tests (P5.2).
 *
 * Exercises the per-project last-tab persistence via the testable
 * `LastTabStore` class with an injected backing. The runtime
 * resolver `lastTabStorage()` is intentionally NOT covered here — it
 * just picks a backing based on Platform.OS, which is not loadable
 * under bun test.
 */

import { describe, expect, it } from 'bun:test';

import {
  LastTabStore,
  isLegalTab,
  sanitizeProjectId,
  type LastTabBacking,
} from '../lib/last-tab-storage';

function makeBacking(): LastTabBacking & { snapshot(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) ?? null) : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    snapshot: () => Object.fromEntries(map),
  };
}

describe('sanitizeProjectId', () => {
  it('accepts slug-shaped ids', () => {
    expect(sanitizeProjectId('neutron')).toBe('neutron');
    expect(sanitizeProjectId('p_2026_05-20')).toBe('p_2026_05-20');
    expect(sanitizeProjectId('123.456')).toBe('123.456');
  });

  it('rejects empty, oversized, and non-ASCII-safe ids', () => {
    expect(sanitizeProjectId('')).toBeNull();
    expect(sanitizeProjectId('a/b')).toBeNull();
    expect(sanitizeProjectId(' spaces ')).toBeNull();
    expect(sanitizeProjectId(123 as unknown as string)).toBeNull();
    expect(sanitizeProjectId('a'.repeat(200))).toBeNull();
  });
});

describe('isLegalTab', () => {
  it('returns true for the locked 5-tab set', () => {
    expect(isLegalTab('chat')).toBe(true);
    expect(isLegalTab('launcher')).toBe(true);
    expect(isLegalTab('tasks')).toBe(true);
    expect(isLegalTab('reminders')).toBe(true);
    expect(isLegalTab('docs')).toBe(true);
  });

  it('returns false for non-canonical values', () => {
    expect(isLegalTab('notes')).toBe(false);
    expect(isLegalTab('')).toBe(false);
    expect(isLegalTab(null)).toBe(false);
    expect(isLegalTab(undefined)).toBe(false);
    expect(isLegalTab('Chat')).toBe(false);
  });
});

describe('LastTabStore', () => {
  it('round-trips set → get for a valid project + tab', async () => {
    const backing = makeBacking();
    const store = new LastTabStore(backing);
    expect(await store.get('neutron')).toBeNull();
    await store.set('neutron', 'tasks');
    expect(await store.get('neutron')).toBe('tasks');
    expect(backing.snapshot()['neutron.project.neutron.lastTab']).toBe('tasks');
  });

  it('clear removes the persisted value', async () => {
    const backing = makeBacking();
    const store = new LastTabStore(backing);
    await store.set('neutron', 'docs');
    expect(await store.get('neutron')).toBe('docs');
    await store.clear('neutron');
    expect(await store.get('neutron')).toBeNull();
  });

  it('get returns null + self-heals when the stored value is no longer legal', async () => {
    const backing = makeBacking();
    backing.setItem('neutron.project.neutron.lastTab', 'notes');
    const store = new LastTabStore(backing);
    expect(await store.get('neutron')).toBeNull();
    expect(backing.snapshot()['neutron.project.neutron.lastTab']).toBeUndefined();
  });

  it('set is a no-op for invalid project ids', async () => {
    const backing = makeBacking();
    const store = new LastTabStore(backing);
    await store.set('', 'chat');
    await store.set('bad/id', 'chat');
    expect(backing.snapshot()).toEqual({});
  });

  it('set is a no-op for invalid tab values', async () => {
    const backing = makeBacking();
    const store = new LastTabStore(backing);
    await store.set('neutron', 'notes' as 'chat');
    expect(backing.snapshot()).toEqual({});
  });

  it('per-project isolation: writing one project does not affect another', async () => {
    const backing = makeBacking();
    const store = new LastTabStore(backing);
    await store.set('neutron', 'docs');
    await store.set('acme', 'reminders');
    expect(await store.get('neutron')).toBe('docs');
    expect(await store.get('acme')).toBe('reminders');
    expect(await store.get('northwind')).toBeNull();
  });

  it('storage exceptions in get fall through to null', async () => {
    const backing: LastTabBacking = {
      getItem: () => {
        throw new Error('quota');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const store = new LastTabStore(backing);
    expect(await store.get('neutron')).toBeNull();
  });
});
