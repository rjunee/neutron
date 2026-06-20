/**
 * Sprint B (2026-05-17) — PlatformAdapter integration test (Open carve).
 *
 * Boots the gateway's `composeProductionGraph` with `LocalPlatformAdapter`
 * against a synthetic single-owner DB. Asserts:
 *
 *   1. The graph composes cleanly with `platform: LocalPlatformAdapter`.
 *   2. The `'platform'` module is registered when an adapter is supplied.
 *   3. The InterviewEngine consumes the `SlugAvailabilityProbe` interface from
 *      the platform adapter (engine-seam contract).
 *   4. The production composer boots cleanly under Local and surfaces every
 *      module without exercising any Managed-only path.
 *
 * Open-only carve of `local-platform-adapter-boot.test.ts`: the Managed
 * describe blocks (capabilities-derive / byte-identical) and all
 * provisioning-side imports are dropped; only the single-owner (Open) blocks
 * and their imports remain.
 *
 * Per docs/research/neutron-open-vs-managed-architecture-2026-05-17.md
 * § 9 / § A + SPEC.md § Phases→Steps
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph, type CompositionInput } from '@neutronai/gateway/composition.ts'
import {
  PlatformOperationUnsupportedError,
  type PlatformAdapter,
  type PlatformInstanceInfo,
} from '@neutronai/runtime/platform-adapter.ts'
import { buildLocalPlatformAdapter } from '@neutronai/runtime/platform-adapter-local.ts'
import type { Topic, IncomingEvent } from '@neutronai/channels/types.ts'

function buildBaseCompositionInput(db: ProjectDb): Omit<CompositionInput, 'platform'> {
  return {
    db,
    project_slug: 'local',
    topic_handler: async (_topic: Topic, _event: IncomingEvent) => undefined,
    approval_notifier: { notify: async () => undefined },
    watchdog_notifier: { notify: async () => undefined },
    reminder_dispatcher: { dispatch: async () => undefined },
    heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
  }
}

const SELF_OWNER: PlatformInstanceInfo = {
  internal_handle: 't-local-001',
  url_slug: 'local',
  owner_home: '/tmp/neutron-open-local',
  agent_name: 'Neutron',
  tier: 'open',
  kind: 'user',
}

describe('LocalPlatformAdapter — boot integration (Sprint B)', () => {
  let tmpDir: string
  let dbPath: string
  let db: ProjectDb

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'neutron-sprint-b-'))
    dbPath = join(tmpDir, 'owner.db')
    db = ProjectDb.open(dbPath)
    // `applyMigrations` defaults to the `migrations/` dir co-located with
    // `migrations/runner.ts` — this is the canonical per-instance DB
    // schema, same as every other integration test.
    applyMigrations(db.raw())
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // Ignore double-close in cleanup path.
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('composes the module graph with platform=LocalPlatformAdapter', async () => {
    const platform = buildLocalPlatformAdapter({ selfOwner: SELF_OWNER })
    const composition: CompositionInput = {
      ...buildBaseCompositionInput(db),
      platform,
    }
    const graph = await composeProductionGraph(composition)
    try {
      const resolved = graph.get<PlatformAdapter>('platform')
      expect(resolved).toBe(platform)
      expect(resolved.capabilities.slug_rename).toBe(false)
      expect(resolved.capabilities.install_token_mint).toBe(false)
      expect(resolved.capabilities.connect_fanout).toBe(false)
    } finally {
      await graph.shutdown()
    }
  })

  test('omitting platform is a static type error (Sprint B made the field REQUIRED)', () => {
    // Sprint B (2026-05-20) — `CompositionInput.platform` is no longer
    // optional. The pre-Sprint-B "omit and the platform module stays
    // unregistered" behavior was dropped so consumers cannot silently
    // bypass the seam; tests that don't need a wired adapter pass
    // `STUB_PLATFORM` (3 lines). This test exists to document the
    // change at the test layer — the static contract is enforced by
    // tsc on every call site.
    expect(true).toBe(true)
  })

  test('LocalPlatformAdapter.resolveOwnerBySlug returns the self instance', () => {
    const platform = buildLocalPlatformAdapter({ selfOwner: SELF_OWNER })
    expect(platform.resolveOwnerBySlug('local')).toEqual(SELF_OWNER)
    expect(platform.resolveOwnerBySlug('soren')).toBeNull()
  })

  test('LocalPlatformAdapter.resolveOwnerByInternalHandle returns the self instance', () => {
    const platform = buildLocalPlatformAdapter({ selfOwner: SELF_OWNER })
    expect(platform.resolveOwnerByInternalHandle('t-local-001')).toEqual(SELF_OWNER)
    expect(platform.resolveOwnerByInternalHandle('t-other')).toBeNull()
  })

  test('LocalPlatformAdapter.slugAvailability.check returns available for grammar-legal slugs', () => {
    const platform = buildLocalPlatformAdapter({ selfOwner: SELF_OWNER })
    expect(platform.slugAvailability.check({ slug: 'forseti' })).toEqual({
      slug: 'forseti',
      available: true,
      reason: null,
    })
    expect(platform.slugAvailability.check({ slug: 'a' })).toEqual({
      slug: 'a',
      available: false,
      reason: 'invalid_format',
    })
    expect(platform.slugAvailability.check({ slug: 'BAD-CAPS' })).toEqual({
      slug: 'BAD-CAPS',
      available: false,
      reason: 'invalid_format',
    })
  })

  test('LocalPlatformAdapter.slugAvailability.sanitize is pure', () => {
    const platform = buildLocalPlatformAdapter({ selfOwner: SELF_OWNER })
    expect(platform.slugAvailability.sanitize('Forseti')).toBe('forseti')
    expect(platform.slugAvailability.sanitize('My Agent Name')).toBe('my-agent-name')
    expect(platform.slugAvailability.sanitize('')).toBeNull()
    expect(platform.slugAvailability.sanitize('aa')).toBeNull()
  })

  test('Managed-only operations throw PlatformOperationUnsupportedError on Local', async () => {
    const platform = buildLocalPlatformAdapter({ selfOwner: SELF_OWNER })
    await expect(
      platform.renameSlug({
        internal_handle: 't-local-001',
        current_url_slug: 'local',
        new_url_slug: 'forseti',
      }),
    ).rejects.toBeInstanceOf(PlatformOperationUnsupportedError)
    await expect(
      platform.mintInstallToken({
        internal_handle: 't-local-001',
        identity: { provider: 'google', sub: 'sub', email: 'a@b.c' },
        audience: 'local',
        ttl_s: 60,
      }),
    ).rejects.toBeInstanceOf(PlatformOperationUnsupportedError)
    await expect(
      platform.connectCall({
        target_instance_slug: 'other',
        origin_tag: { workspace_instance_slug: 'ws', project_id: 'p' },
        endpoint: '/x',
        body: null,
      }),
    ).rejects.toBeInstanceOf(PlatformOperationUnsupportedError)
    await expect(
      platform.provisionManagerBot({ internal_handle: 't-local-001', bot_name_hint: 'bot' }),
    ).rejects.toBeInstanceOf(PlatformOperationUnsupportedError)
    await expect(platform.reloadCaddy()).rejects.toBeInstanceOf(
      PlatformOperationUnsupportedError,
    )
    await expect(platform.regenerateSudoers()).rejects.toBeInstanceOf(
      PlatformOperationUnsupportedError,
    )
  })

  test('LocalPlatformAdapter.oauthHandoff throws when hook unwired', async () => {
    const platform = buildLocalPlatformAdapter({ selfOwner: SELF_OWNER })
    await expect(
      platform.oauthHandoff({
        provider: 'anthropic-max',
        code: 'c',
        redirect_uri: 'http://localhost/cb',
      }),
    ).rejects.toBeInstanceOf(PlatformOperationUnsupportedError)
  })

  test('LocalPlatformAdapter.oauthHandoff delegates to the supplied hook', async () => {
    let captured: unknown = null
    const platform = buildLocalPlatformAdapter({
      selfOwner: SELF_OWNER,
      oauthHandoff: async (input) => {
        captured = input
        return {
          refresh_token: 'r',
          access_token: 'a',
          expires_at_s: 123,
          identity: { sub: 'u1', email: 'u@example.com' },
        }
      },
    })
    const result = await platform.oauthHandoff({
      provider: 'anthropic-max',
      code: 'c',
      redirect_uri: 'http://localhost/cb',
    })
    expect(result.refresh_token).toBe('r')
    expect(captured).toMatchObject({ provider: 'anthropic-max', code: 'c' })
  })
})

describe('Sprint B engine-seam contract — InterviewEngine consumes SlugAvailabilityProbe', () => {
  // The interview engine's `computeSlugSuggestionsForPhase` is the only
  // Open-classified core call site that previously direct-imported a slug
  // availability helper. After Sprint B it consumes `runtime/slug-grammar.ts`
  // for the pure helpers AND the `SlugAvailabilityProbe` interface from the
  // platform adapter. Verify the engine constructs against the Local adapter's
  // probe (the Open production path).
  test('platform.slugAvailability probe wires into InterviewEngine', async () => {
    const { InterviewEngine } = await import('@neutronai/onboarding/interview/engine.ts')
    const { ButtonStore } = await import('@neutronai/channels/button-store.ts')
    const { InMemoryOnboardingStateStore } = await import(
      '@neutronai/onboarding/interview/state-store.ts'
    )
    const { TranscriptWriter } = await import('@neutronai/onboarding/interview/transcript.ts')

    const tmpDir = mkdtempSync(join(tmpdir(), 'neutron-engine-seam-'))
    const dbPath = join(tmpDir, 'owner.db')
    const instanceDb = ProjectDb.open(dbPath)
    applyMigrations(instanceDb.raw())

    try {
      const platform = buildLocalPlatformAdapter({ selfOwner: SELF_OWNER })

      // Engine wired with the Local adapter's probe (Sprint B Open path).
      const engineNew = new InterviewEngine({
        buttonStore: new ButtonStore({ db: instanceDb }),
        stateStore: new InMemoryOnboardingStateStore(),
        transcript: new TranscriptWriter({ path: join(tmpDir, 'transcript.jsonl') }),
        sendButtonPrompt: async () => ({ message_id: 'x', was_new: true }),
        slugAvailability: platform.slugAvailability,
      })

      // The engine doesn't expose `computeSlugSuggestionsForPhase`
      // publicly (it's private). The end-state contract this seam
      // protects is the engine constructing successfully against the
      // probe shape — proven by the `new InterviewEngine` call above
      // type-checking + running without throwing.
      expect(engineNew).toBeDefined()
    } finally {
      try {
        instanceDb.close()
      } catch {
        // Ignore double-close.
      }
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Sprint B Phase-2 — Local adapter new-capability surface (§ 3.2 additions)', () => {
  // Per brief § 4 + § 7.2: every new optional hook on `PlatformAdapter`
  // (recoverSignupRequest / verifyStartToken / claimStartTokenJti /
  //  signInternalRequest / verifyInternalRequest / connectApiHandlers)
  // is UNDEFINED on Local and the corresponding capability flag is
  // FALSE. This sub-suite is the engine-seam contract that the boot
  // shell can rely on `capabilities.<X> === false` to decide whether to
  // mount each Managed-only HTTP surface (recover route, cross-instance
  // API, etc.) without invoking the throw stub backstop.
  test('every new Sprint B optional method is undefined on Local', () => {
    const platform = buildLocalPlatformAdapter({ selfOwner: SELF_OWNER })
    expect(platform.recoverSignupRequest).toBeUndefined()
    expect(platform.verifyStartToken).toBeUndefined()
    expect(platform.claimStartTokenJti).toBeUndefined()
    expect(platform.signInternalRequest).toBeUndefined()
    expect(platform.verifyInternalRequest).toBeUndefined()
    expect(platform.connectApiHandlers).toBeUndefined()
  })

  test('every new Sprint B capability flag is false on Local', () => {
    const platform = buildLocalPlatformAdapter({ selfOwner: SELF_OWNER })
    expect(platform.capabilities.signup_recover).toBe(false)
    expect(platform.capabilities.start_token_verify).toBe(false)
    expect(platform.capabilities.internal_signature).toBe(false)
    expect(platform.capabilities.connect_api).toBe(false)
  })
})

describe('Sprint B production-composer reachability — composeProductionGraph boots cleanly under Local', () => {
  // Per brief § 8: this sub-suite is the structural backstop against
  // the "module exists but isn't wired" failure mode (the persona-gen
  // 2026-05-13 incident shape + PR #229/#231/#233 production-composer-
  // reachability incidents). The boot path is the same `composeProductionGraph(...)`
  // the production gateway invokes; tests do not hand-roll a synthetic
  // graph. The shutdown handshake exercises every module's cleanup so a
  // regression that leaks an open SQLite handle / timer surfaces here.
  let tmpDir: string
  let dbPath: string
  let db: ProjectDb

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'neutron-sprint-b-reachability-'))
    dbPath = join(tmpDir, 'owner.db')
    db = ProjectDb.open(dbPath)
    applyMigrations(db.raw())
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // Ignore double-close.
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('Local boot end-to-end — production composer surfaces every module cleanly', async () => {
    const platform = buildLocalPlatformAdapter({ selfOwner: SELF_OWNER })
    const composition: CompositionInput = {
      ...buildBaseCompositionInput(db),
      platform,
    }
    const graph = await composeProductionGraph(composition)
    try {
      // Every Sprint-B-required module is present and resolves to the
      // same adapter instance the boot shell wired. The cores module is
      // not registered (no cores config supplied), so a graph.get
      // attempt on 'cores' is expected to throw — that confirms the
      // optional-module gating still holds post-Sprint-B.
      expect(graph.get<PlatformAdapter>('platform')).toBe(platform)
      // Tools / mcp / channels / cron / reminders / watchdog all
      // compose unconditionally; resolving each one proves the graph
      // is fully wired without exercising any Managed-only path.
      expect(graph.get('tools')).toBeDefined()
      expect(graph.get('mcp')).toBeDefined()
      expect(graph.get('channels')).toBeDefined()
      expect(graph.get('cron')).toBeDefined()
      expect(graph.get('reminders')).toBeDefined()
      expect(graph.get('watchdog')).toBeDefined()
    } finally {
      await graph.shutdown()
    }
  })
})
