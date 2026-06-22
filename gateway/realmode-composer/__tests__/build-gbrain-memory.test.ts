/**
 * build-gbrain-memory — per-instance GBrain memory wiring.
 *
 * Covers the scoping logic (`resolveGbrainClientOptions`) and that
 * `buildGBrainMemory` returns the live trio (client + memoryStore + syncHook +
 * close) that the composer threads into the admin surface (browse) and the
 * landing stack (`importGbrainSyncHook`).
 */

import { describe, test, expect } from 'bun:test'
import {
  buildGBrainMemory,
  resolveGbrainClientOptions,
} from '../build-gbrain-memory.ts'

describe('resolveGbrainClientOptions', () => {
  test('GBRAIN_HOME is the per-project <owner_home>/gbrain boundary', () => {
    const opts = resolveGbrainClientOptions({ owner_home: '/srv/owners/acme', env: {} })
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
    test('NO embedder (default) → child env is exactly GBRAIN_HOME (keyword + graph)', () => {
      // The whole point of opt-in: a bare OPENAI_API_KEY (the LLM adapter key)
      // must NOT leak any GBRAIN_EMBEDDING_* env into the child.
      const opts = resolveGbrainClientOptions({
        owner_home: '/srv/owners/acme',
        env: { OPENAI_API_KEY: 'sk-llm-only' },
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
})

describe('buildGBrainMemory', () => {
  test('returns the live trio + a close() that resolves', async () => {
    const wiring = buildGBrainMemory({
      owner_home: '/srv/owners/acme',
      project_slug: 'acme',
      env: {},
    })
    expect(wiring.client).toBeDefined()
    expect(typeof wiring.memoryStore.query).toBe('function')
    expect(typeof wiring.syncHook.onEntityWrite).toBe('function')
    // close() never spawned a child (lazy connect), so it resolves cleanly.
    await expect(wiring.close()).resolves.toBeUndefined()
  })
})
