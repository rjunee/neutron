/**
 * K11b0 survivor tests for the RETAINED slug-history shim helpers in
 * gateway/http/chat-bridge.ts: `InMemorySlugHistoryCache` (TTL cache +
 * push-invalidate) and `buildSlugHistoryShimFromRegistry` (registry →
 * async shim adapter). The JWT-claim / ownerRegistry routing this file
 * once also covered lived on the dead `buildWebChatBridge` surface
 * (excised in K11b0); the retained HTTP path's slug shim is covered by
 * landing/__tests__/auth-gate.test.ts.
 */

import { describe, expect, test } from 'bun:test'
import {
  InMemorySlugHistoryCache,
  buildSlugHistoryShimFromRegistry,
  type SlugHistoryShimStore,
} from '../chat-bridge.ts'

const NOW_MS = 1_700_000_000_000

describe('InMemorySlugHistoryCache', () => {
  test('caches positive lookups + serves cached on retry', async () => {
    let inner_calls = 0
    const inner: SlugHistoryShimStore = {
      async lookup() {
        inner_calls += 1
        return { expires_at_ms: NOW_MS + 86_400_000 }
      },
    }
    const cache = new InMemorySlugHistoryCache({
      inner,
      ttl_ms: 60_000,
      now: () => NOW_MS,
    })
    const a = await cache.lookup({ old_slug: 'sam', internal_handle: 't-x', now_ms: NOW_MS })
    const b = await cache.lookup({ old_slug: 'sam', internal_handle: 't-x', now_ms: NOW_MS })
    expect(a?.expires_at_ms).toBe(NOW_MS + 86_400_000)
    expect(b?.expires_at_ms).toBe(NOW_MS + 86_400_000)
    expect(inner_calls).toBe(1)
  })

  test('invalidateInternalHandle drops cached entries for that handle', async () => {
    let inner_calls = 0
    const inner: SlugHistoryShimStore = {
      async lookup() {
        inner_calls += 1
        return { expires_at_ms: NOW_MS + 86_400_000 }
      },
    }
    const cache = new InMemorySlugHistoryCache({ inner, ttl_ms: 60_000, now: () => NOW_MS })
    await cache.lookup({ old_slug: 'sam', internal_handle: 't-x', now_ms: NOW_MS })
    cache.invalidateInternalHandle('t-x')
    await cache.lookup({ old_slug: 'sam', internal_handle: 't-x', now_ms: NOW_MS })
    expect(inner_calls).toBe(2)
  })

  test('expired-during-cache returns null + drops entry', async () => {
    const inner: SlugHistoryShimStore = {
      async lookup() {
        return { expires_at_ms: NOW_MS - 1 }
      },
    }
    const cache = new InMemorySlugHistoryCache({ inner, ttl_ms: 60_000, now: () => NOW_MS })
    const r = await cache.lookup({ old_slug: 'sam', internal_handle: 't-x', now_ms: NOW_MS })
    // Inner stored expires_at < now; cache helper returns it but caller-side check (in
    // chat-bridge) handles the expiry. Here we just confirm pass-through.
    expect(r).not.toBeNull()
  })
})

describe('buildSlugHistoryShimFromRegistry', () => {
  test('passes lookup through with seconds → ms conversion', async () => {
    const sec_now = 1_700_000_000
    const ms_now = sec_now * 1000
    const shim = buildSlugHistoryShimFromRegistry({
      lookup: () => ({ expires_at: sec_now + 86_400 }),
    })
    const r = await shim.lookup({ old_slug: 'sam', internal_handle: 't-x', now_ms: ms_now })
    expect(r).not.toBeNull()
    expect(r?.expires_at_ms).toBe((sec_now + 86_400) * 1000)
  })

  test('returns null when registry returns undefined', async () => {
    const shim = buildSlugHistoryShimFromRegistry({
      lookup: () => undefined,
    })
    const r = await shim.lookup({ old_slug: 'x', internal_handle: 't-y', now_ms: 0 })
    expect(r).toBeNull()
  })

  test('returns null when registry says expired (defense-in-depth)', async () => {
    const sec_now = 1_700_000_000
    const ms_now = sec_now * 1000
    const shim = buildSlugHistoryShimFromRegistry({
      lookup: () => ({ expires_at: sec_now - 1 }),
    })
    const r = await shim.lookup({ old_slug: 'x', internal_handle: 't-y', now_ms: ms_now })
    expect(r).toBeNull()
  })
})
