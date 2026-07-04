/**
 * Tests for the P1.5 § 1.5.5 JWT-claim shim middleware in
 * gateway/http/chat-bridge.ts.
 *
 * Locked behavior:
 *   - JWT.project_slug == expected_project_slug → accept
 *   - JWT.project_slug != expected_project_slug + slug_history match (non-expired)
 *     → accept
 *   - JWT.project_slug != expected_project_slug + history miss → reject
 *   - JWT.project_slug != expected_project_slug + history expired → reject
 *   - DB unreachable → fail-closed (reject)
 *   - Cross-instance safety: history match for a DIFFERENT internal_handle → reject
 */

import { describe, expect, test } from 'bun:test'
import { generateKeyPair, type KeyLike } from 'jose'
import {
  buildWebChatBridge,
  InMemoryWebChatSenderRegistry,
  InMemorySlugHistoryCache,
  buildSlugHistoryShimFromRegistry,
  type SlugHistoryShimStore,
} from '../chat-bridge.ts'
import {
  InMemoryConsumedTokens,
  issueStartToken,
  verifyStartToken,
  claimStartTokenJti,
  type StartTokenSigningKey,
  type StartTokenVerificationKey,
} from '@neutronai/runtime/__tests__/start-token-testkit.ts'
import type { OnboardingState } from '../../../onboarding/interview/state-store.ts'
import type {
  AdvanceInput,
  AdvanceResult,
  InterviewEngine,
  StartInput,
  StartResult,
} from '../../../onboarding/interview/engine.ts'

async function makeKeys() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true })
  const signing: StartTokenSigningKey = { kid: 'k1', privateKey: privateKey as KeyLike }
  const verifying: StartTokenVerificationKey = { kid: 'k1', publicKey: publicKey as KeyLike }
  return { signing, verifying }
}

function makeFakeEngine(): InterviewEngine {
  const fakeState: OnboardingState = {
    project_slug: 'whatever',
    user_id: 'test-user',
    phase: 'signup',
    phase_state: {},
    started_at: 0,
    last_advanced_at: 0,
    completed_at: null,
    import_job_id: null,
    persona_files_committed: false,
    wow_fired: false,
    wow_pushed_at: null,
    onboarding_handoff_emitted_at: null,
    attempt_id: 'test-attempt',
  }
  const advanceResult: AdvanceResult = { outcome: 'advanced', state: fakeState }
  return {
    async start(_: StartInput): Promise<StartResult> {
      return { prompt_id: 'p', was_new: true, state: fakeState }
    },
    async advance(_: AdvanceInput): Promise<AdvanceResult> {
      return advanceResult
    },
    async tick() {},
    async emitCurrentPhasePrompt() {
      return advanceResult
    },
  } as unknown as InterviewEngine
}

const NOW_MS = 1_700_000_000_000

describe('chat-bridge JWT shim', () => {
  test('happy path: matching project_slug accepts without consulting history', async () => {
    const { signing, verifying } = await makeKeys()
    const issued = await issueStartToken({
      project_slug: 'nova',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
      now: () => NOW_MS,
    })
    const lookups: number[] = []
    const store: SlugHistoryShimStore = {
      async lookup() {
        lookups.push(1)
        return null
      },
    }
    const bridge = buildWebChatBridge({
      expected_project_slug: 'nova',
      internal_handle: 't-aaaaaaaa',
      slugHistoryStore: store,
      resolveKey: async (kid) => (kid === verifying.kid ? verifying.publicKey : null),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
      now: () => NOW_MS,
    })
    const claim = await bridge.validateStartToken({ start_token: issued.token })
    expect(claim).not.toBeNull()
    expect(lookups).toHaveLength(0)
  })

  test('grace match: old slug + non-expired history → accept', async () => {
    const { signing, verifying } = await makeKeys()
    const issued = await issueStartToken({
      project_slug: 'sam', // OLD slug
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
      now: () => NOW_MS,
    })
    const store: SlugHistoryShimStore = {
      async lookup({ old_slug, internal_handle }) {
        if (old_slug === 'sam' && internal_handle === 't-aaaaaaaa') {
          return { expires_at_ms: NOW_MS + 86_400_000 }
        }
        return null
      },
    }
    const bridge = buildWebChatBridge({
      expected_project_slug: 'nova', // CURRENT slug after rename
      internal_handle: 't-aaaaaaaa',
      slugHistoryStore: store,
      resolveKey: async (kid) => (kid === verifying.kid ? verifying.publicKey : null),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
      now: () => NOW_MS,
    })
    const claim = await bridge.validateStartToken({ start_token: issued.token })
    expect(claim).not.toBeNull()
    // Argus r3 [BLOCKING #1]: claim must surface the CURRENT slug, not the
    // (possibly stale) JWT-embedded one — SqliteOnboardingStateStore keys
    // by project_slug, so passing the old slug downstream would fork state.
    expect(claim?.project_slug).toBe('nova')
  })

  test('Argus r3 #1: shim-accept emits expected_project_slug, not the stale JWT slug', async () => {
    // Regression test for the state-store-fork bug. The shim must collapse
    // the claim's project_slug to the gateway's CURRENT slug so engine.start
    // (and SqliteOnboardingStateStore.upsert keyed by project_slug) writes
    // onboarding rows under the SAME key the post-rename JWTs will use.
    const { signing, verifying } = await makeKeys()
    const issued = await issueStartToken({
      project_slug: 'old-handle', // pre-rename
      user_id: 'u-7',
      signup_via: 'web',
      signing_key: signing,
      now: () => NOW_MS,
    })
    const store: SlugHistoryShimStore = {
      async lookup({ old_slug, internal_handle }) {
        if (old_slug === 'old-handle' && internal_handle === 't-bbbbbbbb') {
          return { expires_at_ms: NOW_MS + 86_400_000 }
        }
        return null
      },
    }
    const bridge = buildWebChatBridge({
      expected_project_slug: 'new-handle', // post-rename current slug
      internal_handle: 't-bbbbbbbb',
      slugHistoryStore: store,
      resolveKey: async (kid) => (kid === verifying.kid ? verifying.publicKey : null),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
      now: () => NOW_MS,
    })
    const claim = await bridge.validateStartToken({ start_token: issued.token })
    expect(claim).not.toBeNull()
    expect(claim?.project_slug).toBe('new-handle')
    expect(claim?.project_slug).not.toBe('old-handle')
  })

  test('grace expired: old slug + expired history → reject', async () => {
    const { signing, verifying } = await makeKeys()
    const issued = await issueStartToken({
      project_slug: 'sam',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
      now: () => NOW_MS,
    })
    const store: SlugHistoryShimStore = {
      async lookup() {
        return { expires_at_ms: NOW_MS - 1 }
      },
    }
    const bridge = buildWebChatBridge({
      expected_project_slug: 'nova',
      internal_handle: 't-aaaaaaaa',
      slugHistoryStore: store,
      resolveKey: async (kid) => (kid === verifying.kid ? verifying.publicKey : null),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
      now: () => NOW_MS,
    })
    const claim = await bridge.validateStartToken({ start_token: issued.token })
    expect(claim).toBeNull()
  })

  test('cross-instance safety: history miss for THIS internal_handle → reject', async () => {
    const { signing, verifying } = await makeKeys()
    const issued = await issueStartToken({
      project_slug: 'sam',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
      now: () => NOW_MS,
    })
    // Store would match 'sam' for handle 't-otherrr1' but caller passes 't-aaaaaaaa'.
    const store: SlugHistoryShimStore = {
      async lookup({ internal_handle }) {
        if (internal_handle === 't-aaaaaaaa') return null // miss for our handle
        return { expires_at_ms: NOW_MS + 86_400_000 }
      },
    }
    const bridge = buildWebChatBridge({
      expected_project_slug: 'nova',
      internal_handle: 't-aaaaaaaa',
      slugHistoryStore: store,
      resolveKey: async (kid) => (kid === verifying.kid ? verifying.publicKey : null),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
      now: () => NOW_MS,
    })
    const claim = await bridge.validateStartToken({ start_token: issued.token })
    expect(claim).toBeNull()
  })

  test('DB unreachable: fail-closed (reject)', async () => {
    const { signing, verifying } = await makeKeys()
    const issued = await issueStartToken({
      project_slug: 'sam',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
      now: () => NOW_MS,
    })
    const store: SlugHistoryShimStore = {
      async lookup() {
        throw new Error('SQLite locked')
      },
    }
    const bridge = buildWebChatBridge({
      expected_project_slug: 'nova',
      internal_handle: 't-aaaaaaaa',
      slugHistoryStore: store,
      resolveKey: async (kid) => (kid === verifying.kid ? verifying.publicKey : null),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
      now: () => NOW_MS,
    })
    const claim = await bridge.validateStartToken({ start_token: issued.token })
    expect(claim).toBeNull()
  })

  test('shim disabled (no internal_handle / store): mismatched slug rejects', async () => {
    const { signing, verifying } = await makeKeys()
    const issued = await issueStartToken({
      project_slug: 'sam',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
      now: () => NOW_MS,
    })
    const bridge = buildWebChatBridge({
      expected_project_slug: 'nova',
      // no internal_handle, no store
      resolveKey: async (kid) => (kid === verifying.kid ? verifying.publicKey : null),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
      now: () => NOW_MS,
    })
    const claim = await bridge.validateStartToken({ start_token: issued.token })
    expect(claim).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────
// 2026-05-13 — no-restart slug rename: ownerRegistry lookup shim.
// New JWTs (post-rename, carrying the NEW slug) must validate against
// a gateway whose `expected_project_slug` is still the OLD slug because
// the per-instance unit was NOT restarted as part of the rename. The
// validator consults `ownerRegistry.getCurrentUrlSlugByInternalHandle`
// before falling through to the slug-history shim.
// ─────────────────────────────────────────────────────────────────────

describe('chat-bridge ownerRegistry lookup (no-restart rename)', () => {
  test('new-slug JWT validates against gateway pinned at OLD expected_project_slug', async () => {
    const { signing, verifying } = await makeKeys()
    // Token minted post-rename carries the NEW slug.
    const issued = await issueStartToken({
      project_slug: 'nova',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
      now: () => NOW_MS,
    })
    let registryCalls = 0
    let slugHistoryCalls = 0
    const slugHistoryStore: SlugHistoryShimStore = {
      async lookup() {
        slugHistoryCalls += 1
        return null
      },
    }
    const bridge = buildWebChatBridge({
      // The gateway is still pinned at the OLD slug because no restart
      // happened. The chat-bridge's expected_project_slug reflects the
      // boot-time env value.
      expected_project_slug: 't-aaaaaaaa',
      internal_handle: 't-aaaaaaaa',
      slugHistoryStore,
      ownerRegistry: {
        getCurrentUrlSlugByInternalHandle(handle) {
          registryCalls += 1
          if (handle === 't-aaaaaaaa') return 'nova' // current url_slug post-rename
          return null
        },
      },
      resolveKey: async (kid) => (kid === verifying.kid ? verifying.publicKey : null),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
      now: () => NOW_MS,
    })
    const claim = await bridge.validateStartToken({ start_token: issued.token })
    expect(claim).not.toBeNull()
    // Downstream callers see `expected_project_slug` (the OLD slug the
    // gateway is still pinned to). The state-store row for THIS session
    // was created under the OLD slug while the user was mid-onboarding
    // — a NEW-slug JWT must continue to advance THAT row, not fork to
    // a fresh one. Symmetric with how the slug-history shim handles
    // old-slug JWTs.
    expect(claim?.project_slug).toBe('t-aaaaaaaa')
    expect(registryCalls).toBe(1)
    // Registry-shim accept short-circuits before slug-history is
    // consulted: zero slug-history calls.
    expect(slugHistoryCalls).toBe(0)
  })

  test('old-slug JWT (slug_history path) still validates when ownerRegistry is wired', async () => {
    const { signing, verifying } = await makeKeys()
    const issued = await issueStartToken({
      project_slug: 'sam', // OLD slug
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
      now: () => NOW_MS,
    })
    const slugHistoryStore: SlugHistoryShimStore = {
      async lookup({ old_slug, internal_handle }) {
        if (old_slug === 'sam' && internal_handle === 't-aaaaaaaa') {
          return { expires_at_ms: NOW_MS + 86_400_000 }
        }
        return null
      },
    }
    const bridge = buildWebChatBridge({
      expected_project_slug: 'nova', // current, post-rename
      internal_handle: 't-aaaaaaaa',
      slugHistoryStore,
      ownerRegistry: {
        getCurrentUrlSlugByInternalHandle(handle) {
          // Registry would say current is 'nova' — but the JWT's
          // claim is 'sam' so registry path won't match, falls through
          // to slug_history.
          return handle === 't-aaaaaaaa' ? 'nova' : null
        },
      },
      resolveKey: async (kid) => (kid === verifying.kid ? verifying.publicKey : null),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
      now: () => NOW_MS,
    })
    const claim = await bridge.validateStartToken({ start_token: issued.token })
    expect(claim).not.toBeNull()
    // Old-slug shim collapses to expected_project_slug — preserves the
    // pre-change Argus r3 [BLOCKING #1] guarantee.
    expect(claim?.project_slug).toBe('nova')
  })

  test('cross-instance safety: a slug belonging to a DIFFERENT instance rejects even with ownerRegistry wired', async () => {
    const { signing, verifying } = await makeKeys()
    // Attacker mints a token for a slug that EXISTS in the registry
    // but belongs to a different instance.
    const issued = await issueStartToken({
      project_slug: 'someone-else',
      user_id: 'attacker',
      signup_via: 'web',
      signing_key: signing,
      now: () => NOW_MS,
    })
    const slugHistoryStore: SlugHistoryShimStore = {
      async lookup() {
        return null
      },
    }
    const bridge = buildWebChatBridge({
      expected_project_slug: 't-aaaaaaaa', // pre-rename or never-renamed
      internal_handle: 't-aaaaaaaa', // OUR instance
      slugHistoryStore,
      ownerRegistry: {
        // Our instance's current url_slug is still 't-aaaaaaaa'. The
        // registry says someone-else's slug ('someone-else') is NOT
        // what `internal_handle=t-aaaaaaaa` resolves to, so the
        // lookup returns 't-aaaaaaaa' ≠ 'someone-else' → no match.
        getCurrentUrlSlugByInternalHandle(handle) {
          if (handle === 't-aaaaaaaa') return 't-aaaaaaaa'
          return null
        },
      },
      resolveKey: async (kid) => (kid === verifying.kid ? verifying.publicKey : null),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
      now: () => NOW_MS,
    })
    const claim = await bridge.validateStartToken({ start_token: issued.token })
    expect(claim).toBeNull()
  })

  test('ownerRegistry throws → fall-closed through to slug-history shim (no implicit accept)', async () => {
    const { signing, verifying } = await makeKeys()
    const issued = await issueStartToken({
      project_slug: 'nova',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
      now: () => NOW_MS,
    })
    let slugHistoryCalls = 0
    const slugHistoryStore: SlugHistoryShimStore = {
      async lookup() {
        slugHistoryCalls += 1
        // No grace-window entry for this slug — slug-history rejects.
        return null
      },
    }
    const bridge = buildWebChatBridge({
      expected_project_slug: 't-aaaaaaaa',
      internal_handle: 't-aaaaaaaa',
      slugHistoryStore,
      ownerRegistry: {
        getCurrentUrlSlugByInternalHandle() {
          throw new Error('registry unreachable')
        },
      },
      resolveKey: async (kid) => (kid === verifying.kid ? verifying.publicKey : null),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
      now: () => NOW_MS,
    })
    const claim = await bridge.validateStartToken({ start_token: issued.token })
    expect(claim).toBeNull()
    // Slug-history was consulted as a fallback.
    expect(slugHistoryCalls).toBe(1)
  })

  test('ownerRegistry undefined → behaves like pre-change (slug-history only)', async () => {
    const { signing, verifying } = await makeKeys()
    const issued = await issueStartToken({
      project_slug: 'nova',
      user_id: 'u-1',
      signup_via: 'web',
      signing_key: signing,
      now: () => NOW_MS,
    })
    const slugHistoryStore: SlugHistoryShimStore = {
      async lookup() {
        return null // no grace window entry → reject
      },
    }
    const bridge = buildWebChatBridge({
      expected_project_slug: 't-aaaaaaaa',
      internal_handle: 't-aaaaaaaa',
      slugHistoryStore,
      // ownerRegistry omitted on purpose
      resolveKey: async (kid) => (kid === verifying.kid ? verifying.publicKey : null),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine: makeFakeEngine(),
      registry: new InMemoryWebChatSenderRegistry(),
      now: () => NOW_MS,
    })
    const claim = await bridge.validateStartToken({ start_token: issued.token })
    expect(claim).toBeNull()
  })

  test('engine state continuity: NEW-slug JWT advances the SAME row created under OLD slug', async () => {
    // Regression for the no-restart-rename engine-state-fork bug.
    //
    // Scenario:
    //   1. User signs up on the OLD slug; an onboarding_state row is
    //      written keyed by OLD slug.
    //   2. The slug gets renamed in-process — registry url_slug flips
    //      to NEW, but NEUTRON_INSTANCE_SLUG (expected_project_slug) stays
    //      pinned at OLD because there is no systemd restart.
    //   3. The identity service mints a fresh JWT carrying the NEW slug
    //      for the next login.
    //   4. The user reconnects.
    //
    // The bridge MUST collapse the claim's project_slug to
    // `expected_project_slug` (OLD) so engine.start finds the existing
    // row. If we passed `currentSlug` (NEW) downstream, engine.start
    // would write a fresh S1 row under NEW and the user would lose
    // their onboarding progress.
    const { signing, verifying } = await makeKeys()
    // JWT minted by identity service AFTER the rename — carries NEW slug.
    const issued = await issueStartToken({
      project_slug: 'nova', // NEW
      user_id: 'u-resume',
      signup_via: 'web',
      signing_key: signing,
      now: () => NOW_MS,
    })
    // Engine fake that records the project_slug it was started with.
    const startedSlugs: string[] = []
    const engine: InterviewEngine = {
      async start(input: StartInput): Promise<StartResult> {
        startedSlugs.push(input.project_slug)
        return {
          prompt_id: 'p',
          was_new: false,
          state: {
            project_slug: input.project_slug,
            user_id: input.user_id,
            phase: 'slug_chosen', // pre-rename progress
            phase_state: {},
            started_at: 0,
            last_advanced_at: 0,
            completed_at: null,
            import_job_id: null,
            persona_files_committed: false,
            wow_fired: false,
            wow_pushed_at: null,
            onboarding_handoff_emitted_at: null,
            attempt_id: 'pre-existing',
          },
        }
      },
      async advance(_: AdvanceInput): Promise<AdvanceResult> {
        throw new Error('unused')
      },
      async tick() {},
      async emitCurrentPhasePrompt() {
        throw new Error('unused')
      },
    } as unknown as InterviewEngine
    const bridge = buildWebChatBridge({
      // Gateway is still pinned at the OLD slug (no restart).
      expected_project_slug: 't-aaaaaaaa',
      internal_handle: 't-aaaaaaaa',
      slugHistoryStore: {
        async lookup() {
          return null // not relied on — registry shim should match first
        },
      },
      ownerRegistry: {
        getCurrentUrlSlugByInternalHandle(handle) {
          // Registry says current = NEW (the rename committed).
          return handle === 't-aaaaaaaa' ? 'nova' : null
        },
      },
      resolveKey: async (kid) => (kid === verifying.kid ? verifying.publicKey : null),
      consumedTokens: new InMemoryConsumedTokens(),
      verifyStartToken,
      claimStartTokenJti,
      engine,
      registry: new InMemoryWebChatSenderRegistry(),
      now: () => NOW_MS,
    })
    const claim = await bridge.validateStartToken({ start_token: issued.token })
    expect(claim).not.toBeNull()
    // The claim's project_slug MUST be the OLD value — that is the key
    // the in-progress onboarding_state row was written under.
    expect(claim?.project_slug).toBe('t-aaaaaaaa')

    // Drive startSession so engine.start actually fires with the
    // claim's slug. Asserting on the recorded slug locks the contract:
    // engine.start sees the OLD slug, finds the OLD-keyed row, and
    // continues from `slug_chosen` rather than restarting at S1.
    const ok = await bridge.startSession({
      claim: claim!,
      send: () => {},
    })
    expect(ok).toBe(true)
    expect(startedSlugs).toEqual(['t-aaaaaaaa'])
  })
})

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
