/**
 * embedder-config — conditional embedding-store resolution.
 *
 * RA3 (2026-07): the DEFAULT (unset `NEUTRON_EMBEDDINGS`) is now the local
 * Ollama fallback — hybrid recall (vector + keyword + graph) out of the box,
 * no key required. `null` (keyword + graph only) is now an explicit opt-out
 * (`off`/`0`/`false`/`none`), not the default. Three contracts under test:
 *
 *   (a) DEFAULT (unset) → the local Ollama fallback, unconditionally, and
 *       WITHOUT ever consulting an OpenAI key (billing-safety: a bare
 *       `OPENAI_API_KEY` — the GPT BYO adapter's key — must never silently
 *       activate cloud embeddings).
 *   (b) explicit `off`-ish → `null`, so provisioning forwards nothing and
 *       memory runs on keyword + graph only.
 *   (c) explicit provider / `auto` opt-in → a non-null config with the
 *       GBrain embedding env (`GBRAIN_EMBEDDING_MODEL` +
 *       `GBRAIN_EMBEDDING_DIMENSIONS` + provider auth).
 *
 * `resolveEmbedderConfig` is pure — every case passes an explicit `env`, so no
 * process.env leakage and no I/O. `probeOllamaHealth` (a separate, explicitly
 * async export) is covered at the bottom with an injected fetch — no real
 * network calls.
 */

import { describe, test, expect, spyOn, afterEach } from 'bun:test'
import { resolveEmbedderConfig, buildOpenAiEmbedderConfig, probeOllamaHealth } from '../embedder-config.ts'

// Silence + capture the opt-in/misconfig warnings.
function muteWarn() {
  return spyOn(console, 'warn').mockImplementation(() => {})
}

afterEach(() => {
  // Restore any console spies between cases.
  ;(console.warn as unknown as { mockRestore?: () => void }).mockRestore?.()
})

describe('resolveEmbedderConfig — DEFAULT (unset → local Ollama fallback)', () => {
  test('unset NEUTRON_EMBEDDINGS → the local Ollama fallback (hybrid recall, no key)', () => {
    const cfg = resolveEmbedderConfig({})
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

  test('a bare OPENAI_API_KEY (used by the LLM adapter) does NOT activate cloud embeddings', () => {
    // The billing-safety contract: an LLM key present with no explicit
    // NEUTRON_EMBEDDINGS opt-in must still resolve to the FREE local
    // fallback, never silently bill cloud embeddings off the LLM key.
    const cfg = resolveEmbedderConfig({ OPENAI_API_KEY: 'sk-llm-only' })
    expect(cfg!.provider).toBe('ollama')
    expect(cfg!.childEnv['OPENAI_API_KEY']).toBeUndefined()
  })

  test('blank/whitespace NEUTRON_EMBEDDINGS is treated as unset → local fallback', () => {
    const cfg = resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: '   ' })
    expect(cfg!.provider).toBe('ollama')
  })

  test('honors a custom OLLAMA_BASE_URL even on the default (unset) path', () => {
    const cfg = resolveEmbedderConfig({ OLLAMA_BASE_URL: 'http://gpu-box:11434/v1' })
    expect(cfg!.childEnv['OLLAMA_BASE_URL']).toBe('http://gpu-box:11434/v1')
  })
})

describe('resolveEmbedderConfig — explicit off (opt-out, keyword + graph only)', () => {
  test.each(['off', 'OFF', '0', 'false', 'none'])('explicit off-ish value %p → null', (val) => {
    expect(resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: val, OPENAI_API_KEY: 'sk-x' })).toBeNull()
  })

  test('an unrecognized value → null + a warning', () => {
    const warn = muteWarn()
    expect(resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: 'cohere' })).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('resolveEmbedderConfig — openai (explicit opt-in, full 3072-dim fidelity)', () => {
  test('NEUTRON_EMBEDDINGS=openai + OPENAI_API_KEY → cloud config at full 3072 dims', () => {
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

describe('resolveEmbedderConfig — ollama (explicit, local / free)', () => {
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

describe('resolveEmbedderConfig — auto (explicit opt-in escape hatch)', () => {
  test.each(['auto', 'on', '1', 'true'])('%p prefers OpenAI when a key is present', (val) => {
    const cfg = resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: val, OPENAI_API_KEY: 'sk-real' })
    expect(cfg!.provider).toBe('openai')
  })

  test('auto is the ONE path where a bare OPENAI_API_KEY activates cloud embeddings', () => {
    // Unlike the passive default, `auto` is a DELIBERATE operator opt-in — so
    // it is allowed to prefer a bare LLM key for embeddings too.
    const cfg = resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: 'auto', OPENAI_API_KEY: 'sk-llm-only' })
    expect(cfg!.provider).toBe('openai')
    expect(cfg!.childEnv['OPENAI_API_KEY']).toBe('sk-llm-only')
  })

  test('auto falls back to the local Ollama fallback when no key is present (never null)', () => {
    const cfg = resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: 'auto' })
    expect(cfg!.provider).toBe('ollama')
  })

  test('auto honors a custom OLLAMA_BASE_URL when falling back', () => {
    const cfg = resolveEmbedderConfig({
      NEUTRON_EMBEDDINGS: 'auto',
      OLLAMA_BASE_URL: 'http://gpu-box:11434/v1',
    })
    expect(cfg!.provider).toBe('ollama')
    expect(cfg!.childEnv['OLLAMA_BASE_URL']).toBe('http://gpu-box:11434/v1')
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

describe('buildOpenAiEmbedderConfig — shared 768-dim default (no-rebuild upgrade)', () => {
  test('bare call (onboarding-key upgrade path) defaults to 768 dims — matches the local-fallback column', () => {
    const cfg = buildOpenAiEmbedderConfig('sk-onboarding')
    expect(cfg.provider).toBe('openai')
    expect(cfg.model).toBe('text-embedding-3-large')
    expect(cfg.dimensions).toBe(768)
    expect(cfg.childEnv).toEqual({
      GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
      GBRAIN_EMBEDDING_DIMENSIONS: '768',
      OPENAI_API_KEY: 'sk-onboarding',
    })
  })

  test('explicit dimensions override the shared default (used by the `openai` opt-in at 3072)', () => {
    const cfg = buildOpenAiEmbedderConfig('sk-explicit', 3072)
    expect(cfg.dimensions).toBe(3072)
    expect(cfg.childEnv['GBRAIN_EMBEDDING_DIMENSIONS']).toBe('3072')
  })
})

describe('probeOllamaHealth — best-effort reachability probe (fail-soft, no real network)', () => {
  test('reachable + model pulled → { reachable: true, modelPresent: true }', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }] }), {
        status: 200,
      })) as unknown as typeof fetch
    const health = await probeOllamaHealth('http://localhost:11434/v1', { fetchImpl })
    expect(health).toEqual({ reachable: true, modelPresent: true })
  })

  test('reachable but model NOT pulled → { reachable: true, modelPresent: false }', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ models: [{ name: 'llama3:latest' }] }), {
        status: 200,
      })) as unknown as typeof fetch
    const health = await probeOllamaHealth('http://localhost:11434/v1', { fetchImpl })
    expect(health).toEqual({ reachable: true, modelPresent: false })
  })

  test('connection refused (Ollama not running) → { reachable: false, modelPresent: false }, never throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
    }) as unknown as typeof fetch
    const health = await probeOllamaHealth('http://localhost:11434/v1', { fetchImpl })
    expect(health).toEqual({ reachable: false, modelPresent: false })
  })

  test('non-2xx response → { reachable: false, modelPresent: false }', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const health = await probeOllamaHealth('http://localhost:11434/v1', { fetchImpl })
    expect(health).toEqual({ reachable: false, modelPresent: false })
  })

  test('a timeout / abort never throws out of the probe', async () => {
    const fetchImpl = (async () => {
      const err = new Error('The operation was aborted')
      err.name = 'TimeoutError'
      throw err
    }) as unknown as typeof fetch
    const health = await probeOllamaHealth('http://localhost:11434/v1', { fetchImpl, timeoutMs: 10 })
    expect(health).toEqual({ reachable: false, modelPresent: false })
  })
})
