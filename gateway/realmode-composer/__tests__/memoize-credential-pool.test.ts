/**
 * Codex r1 P1 (2026-05-31) regression suite — credential-pool memoizer.
 *
 * Pre-fix, `resolveLlmCredentials` was called on every substrate dispatch
 * and `newCredentialPool(...)` built a fresh pool each call. The substrate's
 * `reportFailure(pool, cred.id, 429|402|401)` mutated the throwaway pool;
 * the next dispatch built another fresh pool with no memory of the prior
 * failure and re-served the wedged credential. Cooldown reporting was
 * functionally inert.
 *
 * This test pins the fix shape: the memoizer wraps the per-call resolver
 * and returns the SAME pool object across dispatches so `reportFailure`
 * mutations survive AND `selectCredential` is honoured on the next call.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { memoizeCredentialPoolByEnvMtime } from '../memoize-credential-pool.ts'
import {
  registerSystemEventSink,
  type SystemEventInput,
  type SystemEventSink,
} from '@neutronai/persistence/index.ts'
import {
  newCredentialPool,
  reportFailure,
  selectCredential,
  type CredentialKind,
  type CredentialPool,
} from '@neutronai/runtime/credential-pool.ts'

let owner_home: string

beforeEach(() => {
  owner_home = mkdtempSync(join(tmpdir(), 'neutron-memo-pool-'))
})

afterEach(() => {
  rmSync(owner_home, { recursive: true, force: true })
})

test('memoizer returns the SAME pool object across calls so reportFailure mutations persist', async () => {
  writeFileSync(join(owner_home, '.env'), 'ANTHROPIC_API_KEY=sk-test\n')
  let resolveCount = 0
  // Each underlying resolve returns a FRESH pool (mirrors
  // `resolveLlmCredentials` → `newCredentialPool` semantics) so the test
  // proves the memoizer pins the identity, not the underlying resolver.
  const resolver = memoizeCredentialPoolByEnvMtime({
    owner_home,
    resolve: async () => {
      resolveCount += 1
      return newCredentialPool({
        strategy: 'fill_first',
        credentials: [
          { id: 'k1', kind: 'api_key', secret: 'sk-1' },
          { id: 'k2', kind: 'api_key', secret: 'sk-2' },
        ],
      })
    },
  })

  const p1 = await resolver()
  const p2 = await resolver()
  const p3 = await resolver()
  expect(p1).not.toBeNull()
  // Same identity across calls (pinned by memoizer)
  expect(p2).toBe(p1)
  expect(p3).toBe(p1)
  // Underlying resolver invoked exactly once
  expect(resolveCount).toBe(1)
})

test('3 dispatches: second 429s, third selects a different credential (cooldown actually applied)', async () => {
  writeFileSync(join(owner_home, '.env'), 'ANTHROPIC_API_KEY=sk-test\n')
  const resolver = memoizeCredentialPoolByEnvMtime({
    owner_home,
    resolve: async () =>
      newCredentialPool({
        strategy: 'fill_first',
        credentials: [
          { id: 'k1', kind: 'api_key', secret: 'sk-1' },
          { id: 'k2', kind: 'api_key', secret: 'sk-2' },
        ],
      }),
  })

  // Dispatch 1 — select k1 (fill_first), success.
  const pool1 = await resolver()
  const c1 = selectCredential(pool1!)
  expect(c1!.id).toBe('k1')

  // Dispatch 2 — select k1 again (still healthy), then upstream returns
  // 429 → reportFailure stamps cooldown_until on k1 in the SHARED pool.
  const pool2 = await resolver()
  expect(pool2).toBe(pool1) // identity preserved
  const c2 = selectCredential(pool2!)
  expect(c2!.id).toBe('k1')
  reportFailure(pool2!, c2!.id, 429)
  expect(pool2!.credentials[0]!.cooldown_until).toBeDefined()
  expect(pool2!.credentials[0]!.cooldown_reason).toBe('rate_limit_429')

  // Dispatch 3 — the cooldown on k1 must now skip it and select k2.
  // This is the Codex P1 invariant: pre-fix, the dispatch-3 pool was a
  // FRESH instance with no cooldown_until on k1, and `selectCredential`
  // re-served k1.
  const pool3 = await resolver()
  expect(pool3).toBe(pool1) // still same identity
  const c3 = selectCredential(pool3!)
  expect(c3).not.toBeNull()
  expect(c3!.id).toBe('k2')
})

test('mtime bump on .env re-resolves (synthetic-auth wrote a new credential)', async () => {
  const envPath = join(owner_home, '.env')
  writeFileSync(envPath, 'ANTHROPIC_API_KEY=sk-first\n')
  let resolveCount = 0
  const pools: CredentialPool[] = []
  const resolver = memoizeCredentialPoolByEnvMtime({
    owner_home,
    resolve: async () => {
      resolveCount += 1
      const p = newCredentialPool({
        strategy: 'fill_first',
        credentials: [{ id: `k${resolveCount}`, kind: 'api_key', secret: `sk-${resolveCount}` }],
      })
      pools.push(p)
      return p
    },
  })

  const p1 = await resolver()
  const p1Again = await resolver()
  expect(p1Again).toBe(p1)
  expect(resolveCount).toBe(1)

  // Bump mtime explicitly (writeFileSync of the same content on some
  // filesystems doesn't bump mtime when atomic-writes are short-circuited;
  // utimesSync guarantees a strictly-greater mtimeMs).
  const future = new Date(Date.now() + 5000)
  utimesSync(envPath, future, future)

  const p2 = await resolver()
  expect(resolveCount).toBe(2)
  expect(p2).not.toBe(p1)
  expect(p2!.credentials[0]!.id).toBe('k2')

  // Subsequent calls without further mtime change reuse p2.
  const p2Again = await resolver()
  expect(p2Again).toBe(p2)
  expect(resolveCount).toBe(2)
})

test('null result is NOT cached — next call re-runs the resolver (DB-side attach without .env mutation)', async () => {
  // Instance boots with no `.env` and no credentials → resolver returns null.
  // A subsequent Max OAuth attach lands in the DB without bumping .env
  // mtime; the next call must re-resolve so the new credential is
  // observed without a gateway restart.
  let resolveCount = 0
  let returnPool = false
  const resolver = memoizeCredentialPoolByEnvMtime({
    owner_home,
    resolve: async () => {
      resolveCount += 1
      if (!returnPool) return null
      return newCredentialPool({
        strategy: 'fill_first',
        credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-1' }],
      })
    },
  })

  const r1 = await resolver()
  expect(r1).toBeNull()
  expect(resolveCount).toBe(1)

  const r2 = await resolver()
  expect(r2).toBeNull()
  // Null was NOT cached → resolver re-ran.
  expect(resolveCount).toBe(2)

  // Now flip — credential becomes available via DB attach (no .env mutation).
  returnPool = true
  const r3 = await resolver()
  expect(r3).not.toBeNull()
  expect(resolveCount).toBe(3)

  // Once non-null, cache kicks in.
  const r4 = await resolver()
  expect(r4).toBe(r3)
  expect(resolveCount).toBe(3)
})

test('concurrent calls coalesce into a single resolve', async () => {
  writeFileSync(join(owner_home, '.env'), 'ANTHROPIC_API_KEY=sk-test\n')
  let resolveCount = 0
  // Slow resolver so we can fan out before it resolves.
  const resolver = memoizeCredentialPoolByEnvMtime({
    owner_home,
    resolve: async () => {
      resolveCount += 1
      await new Promise<void>((r) => setTimeout(r, 10))
      return newCredentialPool({
        strategy: 'fill_first',
        credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-1' }],
      })
    },
  })

  const [a, b, c] = await Promise.all([resolver(), resolver(), resolver()])
  expect(a).not.toBeNull()
  expect(b).toBe(a)
  expect(c).toBe(a)
  // Only ONE underlying resolve fired across the three concurrent callers.
  expect(resolveCount).toBe(1)
})

test('missing .env file does not throw — mtime-sentinel keeps the cache stable', async () => {
  // No .env file written; statSync throws; helper falls through to mtime
  // sentinel 0 and resolves once. Subsequent calls reuse the cached pool
  // until .env appears.
  let resolveCount = 0
  const resolver = memoizeCredentialPoolByEnvMtime({
    owner_home,
    resolve: async () => {
      resolveCount += 1
      return newCredentialPool({
        strategy: 'fill_first',
        credentials: [{ id: 'k1', kind: 'api_key', secret: 'sk-1' }],
      })
    },
  })

  const p1 = await resolver()
  const p2 = await resolver()
  expect(p2).toBe(p1)
  expect(resolveCount).toBe(1)
})

// ---------------------------------------------------------------------------
// ISSUES #75 — all-cooldown invalidation (Codex r2 follow-up on PR #345).
//
// PR #345 keyed cache invalidation on `.env` mtime ONLY. If an instance booted
// with a stale BYO credential and ALL credentials in the cached pool wedged
// (401 / 402 / consecutive-failure cooldowns), a DB-side recovery — operator
// adds a fresh key via `ApiKeyStore`, which does NOT touch `.env` — was not
// observed until the mtime bumped or the gateway restarted. The fix treats an
// all-cooldown cached pool like a null result: the next dispatch re-resolves.
// ---------------------------------------------------------------------------

/** Mutable in-test stand-in for `ApiKeyStore` rows feeding the resolver. */
type StoreKey = { id: string; kind: CredentialKind; secret: string }

test('all-cooldown invalidation: a DB-added credential is picked up WITHOUT an .env mtime bump (ISSUES #75)', async () => {
  const envPath = join(owner_home, '.env')
  writeFileSync(envPath, 'ANTHROPIC_API_KEY=sk-test\n')
  // Pin the .env mtime to the past so the ONLY invalidation signal under
  // test is the all-cooldown path — never an mtime change.
  const pinned = new Date(Date.now() - 60_000)
  utimesSync(envPath, pinned, pinned)

  // Stand-in for the instance's ApiKeyStore rows. Starts with one BYO key;
  // the operator adds a second mid-session (no `.env` write).
  let storeKeys: StoreKey[] = [{ id: 'anthropic:k1', kind: 'api_key', secret: 'sk-1' }]
  let resolveCount = 0
  const resolver = memoizeCredentialPoolByEnvMtime({
    owner_home,
    resolve: async () => {
      resolveCount += 1
      return newCredentialPool({ strategy: 'fill_first', credentials: storeKeys })
    },
  })

  // Dispatch 1 — resolve, select k1, then k1 wedges on a 402 (billing →
  // 30-min cooldown). The single credential is now all-cooldown.
  const pool1 = await resolver()
  const c1 = selectCredential(pool1!)
  expect(c1!.id).toBe('anthropic:k1')
  reportFailure(pool1!, c1!.id, 402)
  expect(selectCredential(pool1!)).toBeNull()
  expect(resolveCount).toBe(1)

  // Operator adds a new key to the store — NO `.env` mutation, so mtime is
  // unchanged (still `pinned`).
  storeKeys = [
    { id: 'anthropic:k1', kind: 'api_key', secret: 'sk-1' },
    { id: 'anthropic:k2', kind: 'api_key', secret: 'sk-2' },
  ]

  // Dispatch 2 — the memoizer must observe the wedged cache, re-resolve,
  // and surface a pool where the new credential is selectable.
  const pool2 = await resolver()
  expect(resolveCount).toBe(2) // cache was invalidated → resolver re-ran
  expect(pool2).not.toBe(pool1) // adopted the fresh pool
  const c2 = selectCredential(pool2!)
  expect(c2).not.toBeNull()
  // k1's 402 cooldown is carried forward onto the fresh pool, so fill_first
  // skips the still-wedged k1 and selects the newly-added k2 — NOT k1 with a
  // reset cooldown (which would reintroduce the Codex r1 P1 inert-cooldown bug).
  expect(c2!.id).toBe('anthropic:k2')
  expect(pool2!.credentials.find((c) => c.id === 'anthropic:k1')!.cooldown_until).toBeDefined()
})

test('all-cooldown WITHOUT a credential-set change: cooldown is preserved, wedged credential is NOT re-served (ISSUES #75 regression guard)', async () => {
  const envPath = join(owner_home, '.env')
  writeFileSync(envPath, 'ANTHROPIC_API_KEY=sk-test\n')
  const pinned = new Date(Date.now() - 60_000)
  utimesSync(envPath, pinned, pinned)

  // The store never changes — one key, no DB recovery. Re-resolving on
  // all-cooldown must NOT reset the wedged key's cooldown and re-serve it.
  let resolveCount = 0
  const resolver = memoizeCredentialPoolByEnvMtime({
    owner_home,
    resolve: async () => {
      resolveCount += 1
      return newCredentialPool({
        strategy: 'fill_first',
        credentials: [{ id: 'anthropic:k1', kind: 'api_key', secret: 'sk-1' }],
      })
    },
  })

  const pool1 = await resolver()
  const c1 = selectCredential(pool1!)
  reportFailure(pool1!, c1!.id, 402)
  expect(selectCredential(pool1!)).toBeNull()
  expect(resolveCount).toBe(1)

  // Dispatch 2 — all-cooldown triggers a re-resolve, but the set is
  // unchanged: carry-forward keeps k1 wedged, so the re-resolved pool has no
  // usable credential. The memoizer keeps the wedged cache (no churn) and
  // selectCredential still returns null — the cooldown is honoured, not reset.
  const pool2 = await resolver()
  expect(resolveCount).toBe(2) // re-resolve fired (probing for a DB add)
  expect(pool2).toBe(pool1) // kept the wedged cache — cooldown clocks intact
  expect(selectCredential(pool2!)).toBeNull() // k1 still cooling — NOT re-served
})

test('same-label key rotation: cooldown does NOT carry onto a fresh secret under the same id (Argus r1 BLOCKING)', async () => {
  // BYO credential ids are `${provider}:${label}` — secret-independent. The
  // operator's most common recovery gesture is swapping a billing-dead key
  // for a fresh secret UNDER THE SAME LABEL. That yields the same id with new
  // secret material. The carry-forward must compare the secret (not just the
  // id) and treat the rotated secret as a fresh, immediately-selectable
  // credential — NOT stamp the stale 402 cooldown onto the working key.
  const envPath = join(owner_home, '.env')
  writeFileSync(envPath, 'ANTHROPIC_API_KEY=sk-test\n')
  const pinned = new Date(Date.now() - 60_000)
  utimesSync(envPath, pinned, pinned)

  // One BYO key under label `k1`. Operator later swaps its SECRET (same id).
  let storeKeys: StoreKey[] = [{ id: 'anthropic:k1', kind: 'api_key', secret: 'sk-dead' }]
  let resolveCount = 0
  const resolver = memoizeCredentialPoolByEnvMtime({
    owner_home,
    resolve: async () => {
      resolveCount += 1
      return newCredentialPool({ strategy: 'fill_first', credentials: storeKeys })
    },
  })

  // Dispatch 1 — select k1, then it wedges on a 402 (30-min billing cooldown).
  const pool1 = await resolver()
  const c1 = selectCredential(pool1!)
  expect(c1!.id).toBe('anthropic:k1')
  reportFailure(pool1!, c1!.id, 402)
  expect(selectCredential(pool1!)).toBeNull() // all-cooldown
  expect(resolveCount).toBe(1)

  // Operator rotates the secret under the SAME label — no `.env` mutation,
  // so mtime is unchanged (still `pinned`). Same id, brand-new secret.
  storeKeys = [{ id: 'anthropic:k1', kind: 'api_key', secret: 'sk-fresh' }]

  // Dispatch 2 — all-cooldown triggers a re-resolve. Because the secret
  // changed, the stale 402 cooldown must NOT carry forward; the fresh secret
  // is immediately selectable.
  const pool2 = await resolver()
  expect(resolveCount).toBe(2) // cache invalidated → resolver re-ran
  expect(pool2).not.toBe(pool1) // adopted the fresh pool (recovered)
  const rotated = pool2!.credentials.find((c) => c.id === 'anthropic:k1')!
  expect(rotated.secret).toBe('sk-fresh')
  expect(rotated.cooldown_until).toBeUndefined() // stale cooldown NOT carried
  const c2 = selectCredential(pool2!)
  expect(c2).not.toBeNull()
  expect(c2!.id).toBe('anthropic:k1') // fresh secret is selectable
  expect(c2!.secret).toBe('sk-fresh')
})

test('all-cooldown probe does NOT mutate use_count on the steady-state hot path (ISSUES #75)', async () => {
  // The hot-path probe must use the pure `hasUsableCredential` predicate, not
  // `selectCredential` — otherwise every dispatch would inflate `use_count`
  // and advance the round-robin cursor even when nothing was actually
  // dispatched. Confirm a healthy pool's bookkeeping is untouched by repeated
  // resolver calls that don't themselves select.
  writeFileSync(join(owner_home, '.env'), 'ANTHROPIC_API_KEY=sk-test\n')
  const resolver = memoizeCredentialPoolByEnvMtime({
    owner_home,
    resolve: async () =>
      newCredentialPool({
        strategy: 'least_used',
        credentials: [
          { id: 'k1', kind: 'api_key', secret: 'sk-1' },
          { id: 'k2', kind: 'api_key', secret: 'sk-2' },
        ],
      }),
  })

  const p1 = await resolver()
  await resolver()
  await resolver()
  const p4 = await resolver()
  expect(p4).toBe(p1)
  // No selection happened via the resolver itself — use_count stays 0 on both.
  expect(p4!.credentials[0]!.use_count).toBe(0)
  expect(p4!.credentials[1]!.use_count).toBe(0)
})

// ── O4: credential_all_cooldown degrade journal (rising edge) ───────────────

function fakeSink(): { rows: SystemEventInput[]; sink: SystemEventSink } {
  const rows: SystemEventInput[] = []
  return {
    rows,
    sink: {
      record(input: SystemEventInput) {
        rows.push(input)
        return { id: String(rows.length) }
      },
    },
  }
}

test('O4 — emits ONE credential_all_cooldown row per cooldown episode, not per wedged re-resolve', async () => {
  const { rows, sink } = fakeSink()
  registerSystemEventSink(sink)
  try {
    const envPath = join(owner_home, '.env')
    writeFileSync(envPath, 'ANTHROPIC_API_KEY=sk-test\n')
    const pinned = new Date(Date.now() - 60_000)
    utimesSync(envPath, pinned, pinned)

    let storeKeys: StoreKey[] = [{ id: 'anthropic:k1', kind: 'api_key', secret: 'sk-1' }]
    const resolver = memoizeCredentialPoolByEnvMtime({
      owner_home,
      resolve: async () => newCredentialPool({ strategy: 'fill_first', credentials: storeKeys }),
    })

    // Dispatch 1 — healthy resolve + select, then wedge k1 on a 402. No emit yet
    // (the wedge lands on the live pool; the memoizer hasn't returned wedged).
    const pool1 = await resolver()
    const c1 = selectCredential(pool1!)
    reportFailure(pool1!, c1!.id, 402)
    expect(rows).toHaveLength(0)

    // Dispatch 2 — all-cooldown re-resolve returns the wedged pool → RISING EDGE emit #1.
    await resolver()
    // Dispatch 3 — still wedged → latched, NO second emit.
    await resolver()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ event: 'credential_all_cooldown', module: 'credentials' })
    expect(rows[0]?.payload).toMatchObject({ credential_count: 1 })

    // Recovery — operator adds a usable key; next resolve is healthy → latch resets.
    storeKeys = [
      { id: 'anthropic:k1', kind: 'api_key', secret: 'sk-1' },
      { id: 'anthropic:k2', kind: 'api_key', secret: 'sk-2' },
    ]
    const recovered = await resolver()
    expect(selectCredential(recovered!)).not.toBeNull()
    expect(rows).toHaveLength(1) // healthy path emits nothing

    // Wedge the whole set again → fresh rising edge → emit #2.
    const c2 = selectCredential(recovered!)
    reportFailure(recovered!, c2!.id, 402)
    // k1 was carried forward already cooling; ensure both are wedged.
    for (const cr of recovered!.credentials) reportFailure(recovered!, cr.id, 402)
    expect(selectCredential(recovered!)).toBeNull()
    await resolver()
    expect(rows).toHaveLength(2)
  } finally {
    registerSystemEventSink(null)
  }
})

test('O4 — a throwing journal sink does NOT break the wedged-cache degrade decision', async () => {
  registerSystemEventSink({
    record() {
      throw new Error('journal write failed')
    },
  })
  try {
    const envPath = join(owner_home, '.env')
    writeFileSync(envPath, 'ANTHROPIC_API_KEY=sk-test\n')
    const pinned = new Date(Date.now() - 60_000)
    utimesSync(envPath, pinned, pinned)
    const resolver = memoizeCredentialPoolByEnvMtime({
      owner_home,
      resolve: async () =>
        newCredentialPool({
          strategy: 'fill_first',
          credentials: [{ id: 'anthropic:k1', kind: 'api_key', secret: 'sk-1' }],
        }),
    })
    const pool1 = await resolver()
    const c1 = selectCredential(pool1!)
    reportFailure(pool1!, c1!.id, 402)
    // Wedged re-resolve with a throwing sink: the degrade decision is unchanged —
    // the SAME wedged pool is returned and selectCredential still yields null.
    const pool2 = await resolver()
    expect(pool2).toBe(pool1)
    expect(selectCredential(pool2!)).toBeNull()
  } finally {
    registerSystemEventSink(null)
  }
})
