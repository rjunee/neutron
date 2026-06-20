import { describe, expect, test } from 'bun:test'

import { makeMaxOAuthSubscriptionLoader } from './api-key-helper.ts'

describe('makeMaxOAuthSubscriptionLoader (P2 S1)', () => {
  test('returns the cached access_token when fresh enough', async () => {
    const now = 1_000_000
    let refreshed = 0
    const loader = makeMaxOAuthSubscriptionLoader({
      instance_slug: 't1',
      loadCached: async () => ({ access_token: 'cached', expires_at: now + 60_000 }),
      refresh: async () => {
        refreshed++
        return { access_token: 'refreshed', expires_at: now + 3_600_000 }
      },
      now: () => now,
    })
    const out = await loader()
    expect(out?.access_token).toBe('cached')
    expect(refreshed).toBe(0)
  })

  test('refreshes when the cached token is within the slack window', async () => {
    const now = 1_000_000
    const loader = makeMaxOAuthSubscriptionLoader({
      instance_slug: 't1',
      // Token expires 5 s out — within the 30 s slack window → refresh.
      loadCached: async () => ({ access_token: 'cached', expires_at: now + 5_000 }),
      refresh: async () => ({ access_token: 'refreshed', expires_at: now + 3_600_000 }),
      now: () => now,
    })
    const out = await loader()
    expect(out?.access_token).toBe('refreshed')
  })

  test('refreshes when no cache exists', async () => {
    const now = 1_000_000
    const loader = makeMaxOAuthSubscriptionLoader({
      instance_slug: 't1',
      loadCached: async () => null,
      refresh: async () => ({ access_token: 'refreshed', expires_at: now + 3_600_000 }),
      now: () => now,
    })
    const out = await loader()
    expect(out?.access_token).toBe('refreshed')
  })

  test('refreshes when cached access_token is empty (Codex r6 P2)', async () => {
    const now = 1_000_000
    let refreshed = 0
    const loader = makeMaxOAuthSubscriptionLoader({
      instance_slug: 't1',
      // Cached entry with an empty access_token — corrupted secrets row.
      // expires_at is far in the future, so the slack window would
      // otherwise short-circuit on the cached value.
      loadCached: async () => ({ access_token: '', expires_at: now + 3_600_000 }),
      refresh: async () => {
        refreshed++
        return { access_token: 'real-token', expires_at: now + 3_600_000 }
      },
      now: () => now,
    })
    const out = await loader()
    expect(out?.access_token).toBe('real-token')
    expect(refreshed).toBe(1)
  })

  test('returns null when refresh produces an empty access_token', async () => {
    const now = 1_000_000
    const loader = makeMaxOAuthSubscriptionLoader({
      instance_slug: 't1',
      loadCached: async () => null,
      refresh: async () => ({ access_token: '', expires_at: now + 3_600_000 }),
      now: () => now,
    })
    const out = await loader()
    expect(out).toBeNull()
  })
})
