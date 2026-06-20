/**
 * @neutronai/app — PushTapDedupeStore unit tests
 * (Argus r1 I2 round 2 — 2026-05-22 follow-up).
 *
 * Exercises the persistent dedupe store directly with an in-memory
 * `KvBacking`. The Expo notifications wrapper at `app/lib/push.ts:
 * installPushTapHandler` is verified separately by a source-pin test
 * (matches the chat-deep-link-navigator + push-deep-link-routing
 * precedent for RN-coupled wrappers).
 */

import { describe, expect, it } from 'bun:test';

import {
  MemoryKvBacking,
  PUSH_TAP_DEDUPE_KEY,
  PUSH_TAP_DEDUPE_TTL_MS,
  PushTapDedupeStore,
  type KvBacking,
} from '../lib/push-tap-dedupe-store';

function fixedClock(initial: number): { now: () => number; set: (t: number) => void } {
  let t = initial;
  return {
    now: () => t,
    set: (next) => {
      t = next;
    },
  };
}

describe('PushTapDedupeStore', () => {
  it('returns false for has() before any mark', async () => {
    const store = new PushTapDedupeStore(new MemoryKvBacking());
    await store.hydrate();
    expect(store.has('abc')).toBe(false);
  });

  it('markSeen then has → true (in-memory)', async () => {
    const store = new PushTapDedupeStore(new MemoryKvBacking());
    await store.hydrate();
    await store.markSeen('abc');
    expect(store.has('abc')).toBe(true);
  });

  it('persists across a fresh store instance using the same backing', async () => {
    const backing = new MemoryKvBacking();
    const first = new PushTapDedupeStore(backing);
    await first.hydrate();
    await first.markSeen('cold-start-1');
    // Second instance simulates a force-quit + relaunch — same
    // device, same backing, fresh module state.
    const second = new PushTapDedupeStore(backing);
    await second.hydrate();
    expect(second.has('cold-start-1')).toBe(true);
  });

  it('drops entries older than the 7-day TTL on hydrate', async () => {
    const backing = new MemoryKvBacking();
    const clock = fixedClock(1_700_000_000_000);
    const first = new PushTapDedupeStore(backing, clock.now);
    await first.hydrate();
    await first.markSeen('old');
    // Advance the clock 8 days; the next hydrate must drop the entry.
    clock.set(1_700_000_000_000 + 8 * 24 * 60 * 60 * 1000);
    const second = new PushTapDedupeStore(backing, clock.now);
    await second.hydrate();
    expect(second.has('old')).toBe(false);
  });

  it('keeps entries inside the 7-day TTL on hydrate', async () => {
    const backing = new MemoryKvBacking();
    const clock = fixedClock(1_700_000_000_000);
    const first = new PushTapDedupeStore(backing, clock.now);
    await first.hydrate();
    await first.markSeen('recent');
    // Advance 6 days — still inside the window.
    clock.set(1_700_000_000_000 + 6 * 24 * 60 * 60 * 1000);
    const second = new PushTapDedupeStore(backing, clock.now);
    await second.hydrate();
    expect(second.has('recent')).toBe(true);
  });

  it('honours an explicit TTL override', async () => {
    const backing = new MemoryKvBacking();
    const clock = fixedClock(1_000_000);
    const first = new PushTapDedupeStore(backing, clock.now, 1000);
    await first.hydrate();
    await first.markSeen('id');
    clock.set(1_002_000);
    const second = new PushTapDedupeStore(backing, clock.now, 1000);
    await second.hydrate();
    expect(second.has('id')).toBe(false);
  });

  it('hydrate is idempotent — second call resolves the same promise', async () => {
    const store = new PushTapDedupeStore(new MemoryKvBacking());
    const p1 = store.hydrate();
    const p2 = store.hydrate();
    expect(p1).toBe(p2);
    await p1;
  });

  it('tolerates a corrupted persisted blob (drops it on hydrate, never throws)', async () => {
    const backing = new MemoryKvBacking();
    backing.setItem(PUSH_TAP_DEDUPE_KEY, '{not valid json');
    const store = new PushTapDedupeStore(backing);
    await store.hydrate();
    expect(store.has('anything')).toBe(false);
    // The wipe is best-effort but should leave the key gone so the
    // next hydrate is cheap.
    expect(backing.getItem(PUSH_TAP_DEDUPE_KEY)).toBeNull();
  });

  it('tolerates a non-object persisted payload', async () => {
    const backing = new MemoryKvBacking();
    backing.setItem(PUSH_TAP_DEDUPE_KEY, '[]');
    const store = new PushTapDedupeStore(backing);
    await store.hydrate();
    expect(store.has('anything')).toBe(false);
  });

  it('tolerates a payload with no entries field', async () => {
    const backing = new MemoryKvBacking();
    backing.setItem(PUSH_TAP_DEDUPE_KEY, JSON.stringify({ other: true }));
    const store = new PushTapDedupeStore(backing);
    await store.hydrate();
    expect(store.has('anything')).toBe(false);
  });

  it('drops malformed entries (non-number timestamp) on hydrate', async () => {
    const backing = new MemoryKvBacking();
    backing.setItem(
      PUSH_TAP_DEDUPE_KEY,
      JSON.stringify({ entries: { good: Date.now(), bad: 'not a number' } }),
    );
    const store = new PushTapDedupeStore(backing);
    await store.hydrate();
    expect(store.has('good')).toBe(true);
    expect(store.has('bad')).toBe(false);
  });

  it('markSeen with empty id is a no-op (defensive)', async () => {
    const store = new PushTapDedupeStore(new MemoryKvBacking());
    await store.hydrate();
    await store.markSeen('');
    expect(store.has('')).toBe(false);
  });

  it('reset clears in-memory + persisted state + allows re-hydration', async () => {
    const backing = new MemoryKvBacking();
    const store = new PushTapDedupeStore(backing);
    await store.hydrate();
    await store.markSeen('id');
    expect(store.has('id')).toBe(true);
    await store.reset();
    expect(store.has('id')).toBe(false);
    expect(backing.getItem(PUSH_TAP_DEDUPE_KEY)).toBeNull();
    // Re-hydrate works after reset.
    await store.hydrate();
    expect(store.has('id')).toBe(false);
  });

  it('tolerates a backing whose getItem throws', async () => {
    const throwingBacking: KvBacking = {
      getItem: () => {
        throw new Error('quota exceeded');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const store = new PushTapDedupeStore(throwingBacking);
    await store.hydrate();
    expect(store.has('id')).toBe(false);
  });

  it('tolerates a backing whose setItem throws (still updates in-memory)', async () => {
    const throwingBacking: KvBacking = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
      removeItem: () => undefined,
    };
    const store = new PushTapDedupeStore(throwingBacking);
    await store.hydrate();
    await store.markSeen('id');
    // In-memory set was updated even though persistence failed.
    expect(store.has('id')).toBe(true);
  });

  it('TTL constant is 7 days', () => {
    expect(PUSH_TAP_DEDUPE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
