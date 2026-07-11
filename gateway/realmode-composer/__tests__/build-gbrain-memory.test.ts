/**
 * build-gbrain-memory — per-instance GBrain memory wiring.
 *
 * Covers the scoping logic (`resolveGbrainClientOptions`) and that
 * `buildGBrainMemory` returns ONLY the typed seams (memoryStore + syncHook +
 * close) that the composer threads into the admin surface (browse) and the
 * landing stack (`importGbrainSyncHook`) — NOT the raw transport (RA5 / I2).
 */

import { describe, test, expect } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildGBrainMemory,
  resolveGbrainClientOptions,
  type GBrainMemoryWiring,
} from '../build-gbrain-memory.ts'

// COMPILE-TIME negative probe (RA5 / invariant I2). The composer wiring is the
// exempt-module bypass Codex flagged: if the raw transport were on this public
// shape, a product module could `buildGBrainMemory(...).client.call('put_page',
// …)` with no `gbrain-memory` import, so depcruise never fires. This assertion
// FAILS `tsc` if a `client` (or any GBrainStdioMcpClient) field is re-added —
// `keyof GBrainMemoryWiring` must not include `client`.
type _WiringExposesNoRawClient = 'client' extends keyof GBrainMemoryWiring
  ? { ERROR: 'GBrainMemoryWiring must not expose the raw transport (RA5 swap-seam bypass)' }
  : true
const _wiringExposesNoRawClient: _WiringExposesNoRawClient = true
void _wiringExposesNoRawClient

describe('resolveGbrainClientOptions', () => {
  test('GBRAIN_HOME is the per-project <owner_home>/gbrain boundary', () => {
    // Uses the explicit `off` opt-out so this test stays decoupled from the
    // RA3 default embedder choice — its whole point is the path boundary.
    const opts = resolveGbrainClientOptions({
      owner_home: '/srv/owners/acme',
      env: { NEUTRON_EMBEDDINGS: 'off' },
    })
    expect(opts.env).toEqual({ GBRAIN_HOME: '/srv/owners/acme/gbrain' })
  })

  test('source defaults to "default" and brainId is omitted when env is unset', () => {
    const opts = resolveGbrainClientOptions({ owner_home: '/t', env: {} })
    expect(opts.source).toBe('default')
    expect(opts.brainId).toBeUndefined()
  })

  test('honors operator-provided GBRAIN_SOURCE + GBRAIN_BRAIN_ID', () => {
    const opts = resolveGbrainClientOptions({
      owner_home: '/t',
      env: { GBRAIN_SOURCE: 'projects', GBRAIN_BRAIN_ID: 'acme-brain' },
    })
    expect(opts.source).toBe('projects')
    expect(opts.brainId).toBe('acme-brain')
  })

  test('blank GBRAIN_SOURCE falls back to "default"', () => {
    const opts = resolveGbrainClientOptions({ owner_home: '/t', env: { GBRAIN_SOURCE: '' } })
    expect(opts.source).toBe('default')
  })

  // --- Conditional embedding-store init (opt-in) ---------------------------
  describe('conditional embedding store', () => {
    test('DEFAULT (unset, no key) → child env carries the local Ollama fallback seam', () => {
      // RA3: the default is now the local Ollama fallback (hybrid recall out
      // of the box), not "no embedder at all".
      const opts = resolveGbrainClientOptions({
        owner_home: '/srv/owners/acme',
        env: {},
      })
      expect(opts.env).toEqual({
        GBRAIN_HOME: '/srv/owners/acme/gbrain',
        GBRAIN_EMBEDDING_MODEL: 'ollama:nomic-embed-text',
        GBRAIN_EMBEDDING_DIMENSIONS: '768',
        OLLAMA_BASE_URL: 'http://localhost:11434/v1',
      })
    })

    test('DEFAULT + a bare OPENAI_API_KEY (LLM adapter key) → still the local fallback, no cloud billing', () => {
      // The billing-safety invariant survives RA3: a bare OPENAI_API_KEY (the
      // LLM adapter's key) must NOT leak into the embedding seam or trigger
      // cloud embeddings — the default stays the FREE local Ollama fallback.
      const opts = resolveGbrainClientOptions({
        owner_home: '/srv/owners/acme',
        env: { OPENAI_API_KEY: 'sk-llm-only' },
      })
      expect(opts.env).toEqual({
        GBRAIN_HOME: '/srv/owners/acme/gbrain',
        GBRAIN_EMBEDDING_MODEL: 'ollama:nomic-embed-text',
        GBRAIN_EMBEDDING_DIMENSIONS: '768',
        OLLAMA_BASE_URL: 'http://localhost:11434/v1',
      })
      expect(opts.env?.['OPENAI_API_KEY']).toBeUndefined()
    })

    test('explicit opt-out (NEUTRON_EMBEDDINGS=off) → child env is exactly GBRAIN_HOME (keyword + graph)', () => {
      const opts = resolveGbrainClientOptions({
        owner_home: '/srv/owners/acme',
        env: { NEUTRON_EMBEDDINGS: 'off', OPENAI_API_KEY: 'sk-llm-only' },
      })
      expect(opts.env).toEqual({ GBRAIN_HOME: '/srv/owners/acme/gbrain' })
    })

    test('embedder configured (openai) → child env carries the GBrain embedding seam', () => {
      const opts = resolveGbrainClientOptions({
        owner_home: '/srv/owners/acme',
        env: { NEUTRON_EMBEDDINGS: 'openai', OPENAI_API_KEY: 'sk-real' },
      })
      expect(opts.env).toEqual({
        GBRAIN_HOME: '/srv/owners/acme/gbrain',
        GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
        GBRAIN_EMBEDDING_DIMENSIONS: '3072',
        OPENAI_API_KEY: 'sk-real',
      })
    })

    test('embedder configured (ollama) → local embedding seam, GBRAIN_HOME preserved', () => {
      const opts = resolveGbrainClientOptions({
        owner_home: '/t',
        env: { NEUTRON_EMBEDDINGS: 'ollama' },
      })
      expect(opts.env).toMatchObject({
        GBRAIN_HOME: '/t/gbrain',
        GBRAIN_EMBEDDING_MODEL: 'ollama:nomic-embed-text',
        GBRAIN_EMBEDDING_DIMENSIONS: '768',
        OLLAMA_BASE_URL: 'http://localhost:11434/v1',
      })
    })

    test('embedder + GBRAIN_SOURCE/BRAIN_ID coexist on the same child', () => {
      const opts = resolveGbrainClientOptions({
        owner_home: '/t',
        env: {
          NEUTRON_EMBEDDINGS: 'ollama',
          GBRAIN_SOURCE: 'projects',
          GBRAIN_BRAIN_ID: 'acme-brain',
        },
      })
      expect(opts.source).toBe('projects')
      expect(opts.brainId).toBe('acme-brain')
      expect(opts.env).toMatchObject({ GBRAIN_EMBEDDING_MODEL: 'ollama:nomic-embed-text' })
    })
  })

  // --- LAZY onboarding-key activation (key captured AFTER boot) -------------
  // The composer can't see the onboarding/admin OpenAI key at boot (it's
  // captured later, over the already-running server), so it threads a LAZY
  // resolver. RA3: the STATIC child env is now the local Ollama fallback (the
  // default, always-on baseline — no longer "keyword-only"); a
  // `resolveDynamicEnv` thunk OVERRIDES it with OpenAI, at the SAME shared
  // 768-dim width, once/if a key resolves — so a spawn before vs. after the
  // key lands never straddles two different column widths.
  describe('lazy onboarding-key resolver (resolveOpenAiKey)', () => {
    test('static child env is the local Ollama fallback; a resolveDynamicEnv thunk is attached', () => {
      const opts = resolveGbrainClientOptions({
        owner_home: '/srv/owners/acme',
        env: {},
        resolveOpenAiKey: async () => 'sk-captured-later',
      })
      // The key is NOT in the static env — it resolves at spawn, not compose.
      // But the RA3 default (local Ollama) IS already in the static env.
      expect(opts.env).toEqual({
        GBRAIN_HOME: '/srv/owners/acme/gbrain',
        GBRAIN_EMBEDDING_MODEL: 'ollama:nomic-embed-text',
        GBRAIN_EMBEDDING_DIMENSIONS: '768',
        OLLAMA_BASE_URL: 'http://localhost:11434/v1',
      })
      expect(typeof opts.resolveDynamicEnv).toBe('function')
    })

    test('resolveDynamicEnv() yields the OpenAI embedding seam, at the SHARED 768-dim width, when the key is present', async () => {
      const opts = resolveGbrainClientOptions({
        owner_home: '/t',
        env: {},
        resolveOpenAiKey: async () => 'sk-captured-later',
      })
      // 768, not 3072: matches the local-fallback column this brain's `gbrain
      // init` already sized (upgrade in place, no rebuild).
      await expect(opts.resolveDynamicEnv!()).resolves.toEqual({
        GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
        GBRAIN_EMBEDDING_DIMENSIONS: '768',
        OPENAI_API_KEY: 'sk-captured-later',
      })
    })

    test('resolveDynamicEnv() yields the local Ollama fallback (not empty) when the key is absent', async () => {
      const opts = resolveGbrainClientOptions({
        owner_home: '/t',
        env: {},
        resolveOpenAiKey: async () => undefined,
      })
      await expect(opts.resolveDynamicEnv!()).resolves.toEqual({
        GBRAIN_EMBEDDING_MODEL: 'ollama:nomic-embed-text',
        GBRAIN_EMBEDDING_DIMENSIONS: '768',
        OLLAMA_BASE_URL: 'http://localhost:11434/v1',
      })
    })

    test('a blank/whitespace key does NOT activate cloud billing (falls to the free local fallback)', async () => {
      const opts = resolveGbrainClientOptions({
        owner_home: '/t',
        env: {},
        resolveOpenAiKey: async () => '   ',
      })
      const env = await opts.resolveDynamicEnv!()
      expect(env['GBRAIN_EMBEDDING_MODEL']).toBe('ollama:nomic-embed-text')
      expect(env['OPENAI_API_KEY']).toBeUndefined()
    })

    test('resolveDynamicEnv re-resolves each spawn → a key stored AFTER an Ollama spawn upgrades in place', async () => {
      // The miss is never cached at this seam: if the first memory op spawned
      // on the local fallback (no key yet), a later reconnect must pick up a
      // key stored since.
      let stored: string | undefined
      const opts = resolveGbrainClientOptions({
        owner_home: '/t',
        env: {},
        resolveOpenAiKey: async () => stored,
      })
      // First spawn: no key → the local Ollama fallback.
      await expect(opts.resolveDynamicEnv!()).resolves.toEqual({
        GBRAIN_EMBEDDING_MODEL: 'ollama:nomic-embed-text',
        GBRAIN_EMBEDDING_DIMENSIONS: '768',
        OLLAMA_BASE_URL: 'http://localhost:11434/v1',
      })
      // Key pasted during onboarding/admin, THEN a reconnect spawns again.
      stored = 'sk-stored-later'
      await expect(opts.resolveDynamicEnv!()).resolves.toEqual({
        GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
        GBRAIN_EMBEDDING_DIMENSIONS: '768',
        OPENAI_API_KEY: 'sk-stored-later',
      })
    })
  })
})

describe('buildGBrainMemory', () => {
  test('returns ONLY the typed seams (no raw transport) + a close() that resolves', async () => {
    const wiring = buildGBrainMemory({
      owner_home: '/srv/owners/acme',
      project_slug: 'acme',
      env: {},
    })
    expect(typeof wiring.memoryStore.query).toBe('function')
    expect(typeof wiring.syncHook.onEntityWrite).toBe('function')
    // RA5 / invariant I2 — the raw `GBrainStdioMcpClient` transport must NOT be
    // reachable through the exempt composer wiring (that would let a product
    // module grab `.client` and call raw ops without a `gbrain-memory` import).
    // The public shape carries ONLY memoryStore/syncHook/close.
    expect('client' in wiring).toBe(false)
    expect((wiring as unknown as Record<string, unknown>)['client']).toBeUndefined()
    expect(Object.keys(wiring).sort()).toEqual(['close', 'memoryStore', 'syncHook'])
    // close() never spawned a child (lazy connect), so it resolves cleanly.
    await expect(wiring.close()).resolves.toBeUndefined()
  })

  // --- gbrain reachability (dogfood 2026-06-28) ------------------------------
  // The boot-time disabled-warning must reflect the SAME absolute-path resolver
  // the serve spawn uses — not a bare `Bun.which` against the (narrow) service
  // PATH — so a gbrain reachable only via $BUN_INSTALL/bin no longer trips the
  // "memory DISABLED" warning.
  describe('disabled-warning uses the absolute-path resolver', () => {
    function captureWarn(run: () => void): string[] {
      const warnings: string[] = []
      const orig = console.warn
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(' '))
      }
      try {
        run()
      } finally {
        console.warn = orig
      }
      return warnings
    }

    test('gbrain reachable ONLY via $BUN_INSTALL/bin (not PATH) → NO disabled warning', () => {
      const home = mkdtempSync(join(tmpdir(), 'bgm-home-'))
      try {
        const bunBin = join(home, '.bun', 'bin')
        mkdirSync(bunBin, { recursive: true })
        const g = join(bunBin, 'gbrain')
        writeFileSync(g, '#!/bin/sh\necho ok\n')
        chmodSync(g, 0o755)
        // PATH is EMPTY — gbrain is only findable via the probe list. The old
        // `Bun.which('gbrain')` check would have warned here.
        const warnings = captureWarn(() =>
          buildGBrainMemory({
            owner_home: join(home, 'data'),
            project_slug: 'acme',
            env: { PATH: '', HOME: home, BUN_INSTALL: join(home, '.bun') },
          }),
        )
        expect(warnings.some((w) => w.includes('DISABLED'))).toBe(false)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test('gbrain truly absent everywhere → emits the DISABLED warning (fail-soft)', () => {
      const home = mkdtempSync(join(tmpdir(), 'bgm-nohome-'))
      try {
        const warnings = captureWarn(() =>
          buildGBrainMemory({
            owner_home: join(home, 'data'),
            project_slug: 'acme',
            env: { PATH: join(home, 'empty'), HOME: join(home, 'noinstall') },
          }),
        )
        expect(warnings.some((w) => w.includes('DISABLED'))).toBe(true)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
  })
})
