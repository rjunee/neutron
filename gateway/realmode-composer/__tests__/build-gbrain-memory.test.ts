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
  resolveEffectiveEmbedder,
  reconcileEmbedderToBrain,
  makePerConnectKeyResolver,
  type GBrainMemoryWiring,
} from '../build-gbrain-memory.ts'
import { composeGbrainChildEnv } from '@neutronai/gbrain-memory/index.ts'
import {
  buildOpenAiEmbedderConfig,
  resolveInitEmbeddingTarget,
} from '@neutronai/gbrain-memory/index.ts'

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

    test('embedder configured (openai) → child env carries the GBrain embedding seam (universal 768 width)', () => {
      const opts = resolveGbrainClientOptions({
        owner_home: '/srv/owners/acme',
        env: { NEUTRON_EMBEDDINGS: 'openai', OPENAI_API_KEY: 'sk-real' },
      })
      expect(opts.env).toEqual({
        GBRAIN_HOME: '/srv/owners/acme/gbrain',
        GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
        GBRAIN_EMBEDDING_DIMENSIONS: '768',
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

  // --- Existing-brain width reconciliation (cross-version upgrade safety) ---
  // At gbrain runtime the GBRAIN_EMBEDDING_DIMENSIONS env OVERRIDES config.json,
  // so a fresh RA3 default (768) sent to a legacy 3072-dim brain's column would
  // mismatch → embed writes fail. `existingBrainDims` reconciles the effective
  // embedder to the persisted column so that never happens.
  describe('existing-brain dimension reconciliation', () => {
    test('legacy 3072 brain, default (no key) → local Ollama fallback DROPPED (keyword+graph)', () => {
      // Ollama nomic-embed-text is fixed at 768 and cannot match a 3072 column.
      const opts = resolveGbrainClientOptions({
        owner_home: '/t',
        env: {},
        existingBrainDims: 3072,
      })
      expect(opts.env).toEqual({ GBRAIN_HOME: '/t/gbrain' })
    })

    test('legacy 3072 brain + eager OpenAI key → cloud embedder at the brain width (in-place upgrade)', () => {
      const opts = resolveGbrainClientOptions({
        owner_home: '/t',
        env: {},
        openaiApiKey: 'sk-real',
        existingBrainDims: 3072,
      })
      expect(opts.env).toEqual({
        GBRAIN_HOME: '/t/gbrain',
        GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
        GBRAIN_EMBEDDING_DIMENSIONS: '3072',
        OPENAI_API_KEY: 'sk-real',
      })
    })

    test('existing 768 brain, default → local fallback matches, unchanged', () => {
      const opts = resolveGbrainClientOptions({
        owner_home: '/t',
        env: {},
        existingBrainDims: 768,
      })
      expect(opts.env).toMatchObject({
        GBRAIN_EMBEDDING_MODEL: 'ollama:nomic-embed-text',
        GBRAIN_EMBEDDING_DIMENSIONS: '768',
      })
    })

    test('legacy 3072 brain + LAZY key → resolveDynamicEnv upgrades in place at 3072, drops to keyword+graph without a key', async () => {
      let stored: string | undefined
      const opts = resolveGbrainClientOptions({
        owner_home: '/t',
        env: {},
        resolveOpenAiKey: async () => stored,
        existingBrainDims: 3072,
      })
      // No key yet: the 768 local fallback can't match → keyword+graph (no
      // embedding env leaks). Static env is GBRAIN_HOME only, so the empty
      // dynamic merge leaves no stale 768 keys behind.
      expect(opts.env).toEqual({ GBRAIN_HOME: '/t/gbrain' })
      await expect(opts.resolveDynamicEnv!()).resolves.toEqual({})
      // Key pasted → cloud embedder AT THE BRAIN WIDTH (3072), upgrade in place.
      stored = 'sk-late'
      await expect(opts.resolveDynamicEnv!()).resolves.toEqual({
        GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
        GBRAIN_EMBEDDING_DIMENSIONS: '3072',
        OPENAI_API_KEY: 'sk-late',
      })
    })
  })

  // --- reconcileEmbedderToBrain (pure unit) ---------------------------------
  describe('reconcileEmbedderToBrain', () => {
    test('null embedder (explicit off) → null regardless of brain width', () => {
      expect(reconcileEmbedderToBrain(null, 3072)).toBeNull()
      expect(reconcileEmbedderToBrain(null, null)).toBeNull()
    })

    test('fresh brain (dims null) → embedder returned unchanged', () => {
      const e = resolveEffectiveEmbedder({ env: {} }) // default: ollama 768
      expect(reconcileEmbedderToBrain(e, null)).toBe(e)
    })

    test('matching width → embedder returned unchanged', () => {
      const e = resolveEffectiveEmbedder({ env: {} })
      expect(reconcileEmbedderToBrain(e, 768)).toBe(e)
    })

    test('mismatch + openai → rebuilt at the brain width (Matryoshka truncation)', () => {
      const e = buildOpenAiEmbedderConfig('sk-x') // defaults to 768
      const r = reconcileEmbedderToBrain(e, 3072)!
      expect(r.provider).toBe('openai')
      expect(r.dimensions).toBe(3072)
      expect(r.childEnv['GBRAIN_EMBEDDING_DIMENSIONS']).toBe('3072')
      expect(r.childEnv['OPENAI_API_KEY']).toBe('sk-x')
    })

    test('mismatch + ollama (fixed width) → dropped to null (keyword+graph)', () => {
      const e = resolveEffectiveEmbedder({ env: {} }) // ollama 768
      expect(reconcileEmbedderToBrain(e, 3072)).toBeNull()
    })

    test('initialized-but-unknown width → dropped to null even for OpenAI (fail safe, no guessed dims)', () => {
      // We must NOT inject a guessed 768 against a possibly-1536/3072 column;
      // gbrain honors its own persisted config when we inject nothing.
      expect(reconcileEmbedderToBrain(buildOpenAiEmbedderConfig('sk-x'), 'unknown')).toBeNull()
      expect(reconcileEmbedderToBrain(resolveEffectiveEmbedder({ env: {} }), 'unknown')).toBeNull()
    })
  })

  // --- Fresh-brain width consistency (Codex blocker: init width MUST equal
  // every later serve width so a key stored AFTER init never mismatches the
  // column). For a FRESH brain existingBrainDims is null, so this pins that the
  // universal 768 width holds across the divergence-prone lineages. ------------
  describe('fresh-brain init width == later serve width (no divergence)', () => {
    // Mirror how buildGBrainMemory picks the INIT embedder: reconcile the
    // effective embedder (at init-time key state) against the brain width (null
    // for fresh), then ask what column width `gbrain init` would create.
    function initWidth(env: NodeJS.ProcessEnv, keyAtInit: string | undefined): number {
      const embedder = reconcileEmbedderToBrain(
        resolveEffectiveEmbedder({ env, openaiApiKey: keyAtInit }),
        null,
      )
      return resolveInitEmbeddingTarget(embedder).dimensions
    }

    test('fresh `off` brain (init with no key) → later key spawns at the SAME width', async () => {
      // Init: off + no key → embedder null → latent column width.
      const w = initWidth({ NEUTRON_EMBEDDINGS: 'off' }, undefined)
      expect(w).toBe(768)
      // Serve, after a key is stored: dynamic env must target the same width.
      let stored: string | undefined
      const opts = resolveGbrainClientOptions({
        owner_home: '/t',
        env: { NEUTRON_EMBEDDINGS: 'off' },
        resolveOpenAiKey: async () => stored,
        existingBrainDims: null, // fresh
      })
      stored = 'sk-late'
      const dyn = await opts.resolveDynamicEnv!()
      expect(dyn['GBRAIN_EMBEDDING_DIMENSIONS']).toBe(String(w))
      expect(dyn['GBRAIN_EMBEDDING_DIMENSIONS']).toBe('768')
    })

    test('fresh explicit `openai` brain (init with no key) → later onboarding key spawns at the SAME width', async () => {
      const w = initWidth({ NEUTRON_EMBEDDINGS: 'openai', OPENAI_API_KEY: 'sk-env' }, undefined)
      expect(w).toBe(768)
      let stored: string | undefined
      const opts = resolveGbrainClientOptions({
        owner_home: '/t',
        env: { NEUTRON_EMBEDDINGS: 'openai', OPENAI_API_KEY: 'sk-env' },
        resolveOpenAiKey: async () => stored,
        existingBrainDims: null, // fresh
      })
      stored = 'sk-onboarding'
      const dyn = await opts.resolveDynamicEnv!()
      expect(dyn['GBRAIN_EMBEDDING_DIMENSIONS']).toBe(String(w))
      expect(dyn['OPENAI_API_KEY']).toBe('sk-onboarding')
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

  test('legacy 3072-dim brain on disk + default → emits a LOUD keyword+graph-degradation warning', () => {
    const home = mkdtempSync(join(tmpdir(), 'bgm-legacy-'))
    try {
      // Simulate a brain created under the pre-RA3 default (openai:3072).
      const gbrainHome = join(home, 'data', 'gbrain')
      mkdirSync(join(gbrainHome, '.gbrain'), { recursive: true })
      writeFileSync(
        join(gbrainHome, '.gbrain', 'config.json'),
        JSON.stringify({ engine: 'pglite', embedding_dimensions: 3072 }),
      )
      const warnings: string[] = []
      const orig = console.warn
      console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
      try {
        buildGBrainMemory({ owner_home: join(home, 'data'), project_slug: 'acme', env: {} })
      } finally {
        console.warn = orig
      }
      // The degraded state is surfaced, not a silent no-op.
      expect(
        warnings.some(
          (w) => w.includes('3072-dim') && w.includes('keyword+graph') && w.includes('OpenAI key'),
        ),
      ).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('initialized brain with UNKNOWN width (config lacks embedding_dimensions) → no 768 injected + a LOUD warning', () => {
    const home = mkdtempSync(join(tmpdir(), 'bgm-unknown-'))
    try {
      const gbrainHome = join(home, 'data', 'gbrain')
      mkdirSync(join(gbrainHome, '.gbrain'), { recursive: true })
      // Initialized (config.json present) but width unreadable.
      writeFileSync(join(gbrainHome, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }))
      const warnings: string[] = []
      const orig = console.warn
      console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
      try {
        buildGBrainMemory({ owner_home: join(home, 'data'), project_slug: 'acme', env: {} })
      } finally {
        console.warn = orig
      }
      expect(
        warnings.some((w) => w.includes('unreadable') && w.includes('keyword+graph')),
      ).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('per-connect key coherence: init guard + serve env share ONE key read within a spawn', async () => {
    // Codex boundary: a resolver that changes value between the two reads within
    // one connect must NOT be observed differently by the init guard (which gates
    // the `embed --stale` backfill) and the serve `resolveDynamicEnv`. gbrain is
    // absent in the test env, so a memory op drives a real connect: the client
    // runs `ensureInitialized` (getKey read #1) then `resolveDynamicEnv` (getKey
    // read #2) before the spawn fails ENOENT. With the per-connect cache the
    // underlying resolver is called EXACTLY ONCE, so both reads agree; the pre-fix
    // code (cache found-only, no reset) called it twice and could disagree.
    const home = mkdtempSync(join(tmpdir(), 'bgm-coherence-'))
    try {
      let calls = 0
      const wiring = buildGBrainMemory({
        owner_home: join(home, 'data'),
        project_slug: 'acme',
        env: {},
        // Flips absent → present between successive calls; the shared read must
        // pin ONE value for the whole connect.
        resolveOpenAiKey: async () => {
          calls += 1
          return calls === 1 ? undefined : 'sk-late'
        },
      })
      // Drive one connect (gbrain absent → the op throws, swallowed).
      await wiring.memoryStore.query({ query: 'x', limit: 1 }).catch(() => undefined)
      await wiring.close()
      // Exactly one underlying resolution for the connect → init + serve agreed.
      expect(calls).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
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

// The observable core of the per-connect coherence contract (Codex boundary):
// both consumers read the SAME key within a connect, and a key stored BETWEEN
// connects is picked up on the next connect.
describe('makePerConnectKeyResolver', () => {
  test('within ONE connect, both reads see the SAME value even if the source flips between them', async () => {
    let calls = 0
    // Absent on the first read, present on the second — the classic race.
    const r = makePerConnectKeyResolver(async () => {
      calls += 1
      return calls === 1 ? undefined : 'sk-late'
    })
    // Read #1 = the init guard; read #2 = the serve childEnv, same connect.
    const initKey = await r.getKey()
    const serveKey = await r.getKey()
    expect(initKey).toBe(serveKey) // AGREE — no init-Ollama/serve-OpenAI split
    expect(initKey).toBeUndefined() // both pinned to the first resolution
    expect(calls).toBe(1) // one underlying store read shared by both consumers
  })

  test('a found key is shared within a connect (both reads = the key, one store read)', async () => {
    let calls = 0
    const r = makePerConnectKeyResolver(async () => {
      calls += 1
      return 'sk-A'
    })
    expect(await r.getKey()).toBe('sk-A')
    expect(await r.getKey()).toBe('sk-A')
    expect(calls).toBe(1)
  })

  test('resetForConnect re-resolves → a key stored BETWEEN connects is picked up on the next connect', async () => {
    let stored: string | undefined
    let calls = 0
    const r = makePerConnectKeyResolver(async () => {
      calls += 1
      return stored
    })
    // Connect 1: no key yet → both reads absent, one store read.
    expect(await r.getKey()).toBeUndefined()
    expect(await r.getKey()).toBeUndefined()
    expect(calls).toBe(1)
    // Key stored during onboarding/admin, THEN the next connect begins.
    stored = 'sk-late'
    r.resetForConnect()
    expect(await r.getKey()).toBe('sk-late') // fresh resolve picks it up
    expect(await r.getKey()).toBe('sk-late') // and is shared within this connect
    expect(calls).toBe(2) // exactly one more store read for the second connect
  })

  test('a whitespace/blank key normalizes to undefined (no accidental activation)', async () => {
    const r = makePerConnectKeyResolver(async () => '   ')
    expect(await r.getKey()).toBeUndefined()
  })

  test('a throwing resolver is swallowed → undefined (fail-soft), and still cached for the connect', async () => {
    let calls = 0
    const r = makePerConnectKeyResolver(async () => {
      calls += 1
      throw new Error('store unreachable')
    })
    expect(await r.getKey()).toBeUndefined()
    expect(await r.getKey()).toBeUndefined()
    expect(calls).toBe(1)
  })
})

// Blocker (Codex): the reconciled fail-safe (no embedder → empty dynamic env)
// must actually prevent an embedding dimension from reaching the serve child —
// even if one is inherited ambiently. `composeGbrainChildEnv` strips the
// embedder-owned selectors from the base so only our resolved seam sets them.
describe('composeGbrainChildEnv — embedder-owned keys are never inherited ambiently', () => {
  test('an ambient GBRAIN_EMBEDDING_DIMENSIONS in the base is stripped when the embedder is dropped', async () => {
    const env = await composeGbrainChildEnv(
      { env: { GBRAIN_HOME: '/x/gbrain' }, source: 'default', resolveDynamicEnv: async () => ({}) },
      // Base (would-be inherited) carries a stale/incompatible width + model.
      { PATH: '/usr/bin', GBRAIN_EMBEDDING_DIMENSIONS: '768', GBRAIN_EMBEDDING_MODEL: 'ollama:nomic-embed-text' },
    )
    // Fail-safe reconciliation → NO embedding selectors reach the child, so
    // gbrain honors its own persisted config (no dimension mismatch).
    expect(env['GBRAIN_EMBEDDING_DIMENSIONS']).toBeUndefined()
    expect(env['GBRAIN_EMBEDDING_MODEL']).toBeUndefined()
    expect(env).toMatchObject({ GBRAIN_HOME: '/x/gbrain', PATH: '/usr/bin', GBRAIN_SOURCE: 'default' })
  })

  test('the resolved embedder seam STILL sets the selectors (strip only removes ambient inheritance)', async () => {
    const env = await composeGbrainChildEnv(
      {
        env: { GBRAIN_HOME: '/x/gbrain' },
        source: 'default',
        resolveDynamicEnv: async () => ({
          GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
          GBRAIN_EMBEDDING_DIMENSIONS: '3072',
          OPENAI_API_KEY: 'sk-real',
        }),
      },
      { GBRAIN_EMBEDDING_DIMENSIONS: '768' }, // ambient stale value must lose
    )
    expect(env['GBRAIN_EMBEDDING_MODEL']).toBe('openai:text-embedding-3-large')
    expect(env['GBRAIN_EMBEDDING_DIMENSIONS']).toBe('3072') // reconciled value wins, not the ambient 768
    expect(env['OPENAI_API_KEY']).toBe('sk-real')
  })

  test('a static child env (opts.env) selector also overrides an ambient one', async () => {
    const env = await composeGbrainChildEnv(
      {
        env: {
          GBRAIN_HOME: '/x/gbrain',
          GBRAIN_EMBEDDING_MODEL: 'ollama:nomic-embed-text',
          GBRAIN_EMBEDDING_DIMENSIONS: '768',
        },
        source: 'default',
      },
      { GBRAIN_EMBEDDING_DIMENSIONS: '1536' }, // ambient must not survive
    )
    expect(env['GBRAIN_EMBEDDING_DIMENSIONS']).toBe('768')
    expect(env['GBRAIN_EMBEDDING_MODEL']).toBe('ollama:nomic-embed-text')
  })
})
