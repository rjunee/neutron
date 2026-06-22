/**
 * embedder-config — conditional, opt-in embedding-store resolution.
 *
 * Two contracts under test:
 *   (a) embedder configured → a non-null config with the GBrain embedding env
 *       (`GBRAIN_EMBEDDING_MODEL` + `GBRAIN_EMBEDDING_DIMENSIONS` + provider auth).
 *   (b) NO embedder (the default) → `null`, so provisioning forwards nothing and
 *       memory runs on keyword + graph exactly as today.
 *
 * `resolveEmbedderConfig` is pure — every case passes an explicit `env`, so no
 * process.env leakage and no I/O.
 */

import { describe, test, expect, spyOn, afterEach } from 'bun:test'
import { resolveEmbedderConfig } from '../embedder-config.ts'

// Silence + capture the opt-in/misconfig warnings.
function muteWarn() {
  return spyOn(console, 'warn').mockImplementation(() => {})
}

afterEach(() => {
  // Restore any console spies between cases.
  ;(console.warn as unknown as { mockRestore?: () => void }).mockRestore?.()
})

describe('resolveEmbedderConfig — default (no embedder, keyword + graph only)', () => {
  test('unset NEUTRON_EMBEDDINGS → null', () => {
    expect(resolveEmbedderConfig({})).toBeNull()
  })

  test('a bare OPENAI_API_KEY (used by the LLM adapter) does NOT enable embeddings', () => {
    // The opt-in contract: an LLM key present must not silently bill embeddings.
    expect(resolveEmbedderConfig({ OPENAI_API_KEY: 'sk-llm-only' })).toBeNull()
  })

  test.each(['off', 'OFF', '0', 'false', 'none', ''])(
    'explicit off-ish value %p → null',
    (val) => {
      expect(resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: val, OPENAI_API_KEY: 'sk-x' })).toBeNull()
    },
  )

  test('an unrecognized value → null + a warning', () => {
    const warn = muteWarn()
    expect(resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: 'cohere' })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('resolveEmbedderConfig — openai (cloud text-embedding-3-large)', () => {
  test('NEUTRON_EMBEDDINGS=openai + OPENAI_API_KEY → cloud config', () => {
    const cfg = resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: 'openai', OPENAI_API_KEY: 'sk-real' })
    expect(cfg).not.toBeNull()
    expect(cfg!.provider).toBe('openai')
    expect(cfg!.model).toBe('text-embedding-3-large')
    expect(cfg!.dimensions).toBe(3072)
    expect(cfg!.childEnv).toEqual({
      GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
      GBRAIN_EMBEDDING_DIMENSIONS: '3072',
      OPENAI_API_KEY: 'sk-real',
    })
  })

  test('a dedicated NEUTRON_EMBEDDINGS_OPENAI_API_KEY wins over the shared key', () => {
    const cfg = resolveEmbedderConfig({
      NEUTRON_EMBEDDINGS: 'openai',
      NEUTRON_EMBEDDINGS_OPENAI_API_KEY: 'sk-embed',
      OPENAI_API_KEY: 'sk-llm',
    })
    expect(cfg!.childEnv['OPENAI_API_KEY']).toBe('sk-embed')
  })

  test('openai opted in but NO key → null + a warning (cannot embed without auth)', () => {
    const warn = muteWarn()
    expect(resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: 'openai' })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('resolveEmbedderConfig — ollama (local / free)', () => {
  test('NEUTRON_EMBEDDINGS=ollama → local config with the default base url, no key needed', () => {
    const cfg = resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: 'ollama' })
    expect(cfg).not.toBeNull()
    expect(cfg!.provider).toBe('ollama')
    expect(cfg!.model).toBe('nomic-embed-text')
    expect(cfg!.dimensions).toBe(768)
    expect(cfg!.childEnv).toEqual({
      GBRAIN_EMBEDDING_MODEL: 'ollama:nomic-embed-text',
      GBRAIN_EMBEDDING_DIMENSIONS: '768',
      OLLAMA_BASE_URL: 'http://localhost:11434/v1',
    })
  })

  test('honors a custom OLLAMA_BASE_URL', () => {
    const cfg = resolveEmbedderConfig({
      NEUTRON_EMBEDDINGS: 'ollama',
      OLLAMA_BASE_URL: 'http://gpu-box:11434/v1',
    })
    expect(cfg!.childEnv['OLLAMA_BASE_URL']).toBe('http://gpu-box:11434/v1')
  })
})

describe('resolveEmbedderConfig — auto (best available)', () => {
  test.each(['auto', 'on', '1', 'true'])('%p prefers OpenAI when a key is present', (val) => {
    const cfg = resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: val, OPENAI_API_KEY: 'sk-real' })
    expect(cfg!.provider).toBe('openai')
  })

  test('auto falls back to Ollama when only OLLAMA_BASE_URL is set', () => {
    const cfg = resolveEmbedderConfig({
      NEUTRON_EMBEDDINGS: 'auto',
      OLLAMA_BASE_URL: 'http://localhost:11434/v1',
    })
    expect(cfg!.provider).toBe('ollama')
  })

  test('auto with neither key nor ollama → null + a warning', () => {
    const warn = muteWarn()
    expect(resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: 'auto' })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('resolveEmbedderConfig — case + whitespace tolerance', () => {
  test('value is case-insensitive and trimmed', () => {
    const cfg = resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: '  OpenAI  ', OPENAI_API_KEY: 'sk-real' })
    expect(cfg!.provider).toBe('openai')
  })

  test('blank/whitespace key is treated as absent', () => {
    const warn = muteWarn()
    expect(resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: 'openai', OPENAI_API_KEY: '   ' })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
