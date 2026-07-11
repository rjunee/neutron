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
import {
  resolveEmbedderConfig,
  buildOpenAiEmbedderConfig,
  probeOllamaHealth,
  redactUrlUserinfo,
  isOpenAiEmbeddingWidthSupported,
} from '../embedder-config.ts'

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

describe('resolveEmbedderConfig — openai (explicit opt-in, shared 768-dim width)', () => {
  test('NEUTRON_EMBEDDINGS=openai + OPENAI_API_KEY → cloud config at the universal 768-dim width', () => {
    // RA3: the openai opt-in uses the SAME 768 width as every other fresh-brain
    // lineage, so an onboarding key or an `off`→key transition never diverges.
    const cfg = resolveEmbedderConfig({ NEUTRON_EMBEDDINGS: 'openai', OPENAI_API_KEY: 'sk-real' })
    expect(cfg).not.toBeNull()
    expect(cfg!.provider).toBe('openai')
    expect(cfg!.model).toBe('text-embedding-3-large')
    expect(cfg!.dimensions).toBe(768)
    expect(cfg!.childEnv).toEqual({
      GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
      GBRAIN_EMBEDDING_DIMENSIONS: '768',
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

  test('explicit dimensions override the shared default (used by reconciliation for a legacy column)', () => {
    const cfg = buildOpenAiEmbedderConfig('sk-explicit', 3072)
    expect(cfg.dimensions).toBe(3072)
    expect(cfg.childEnv['GBRAIN_EMBEDDING_DIMENSIONS']).toBe('3072')
  })
})

describe('probeOllamaHealth — best-effort reachability probe (fail-soft, no real network)', () => {
  test('probes the native /api/tags endpoint derived from the /v1 base url', async () => {
    let seenUrl: string | undefined
    let sawSignal = false
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url)
      sawSignal = init?.signal instanceof AbortSignal
      return new Response(JSON.stringify({ models: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await probeOllamaHealth('http://localhost:11434/v1', { fetchImpl })
    expect(seenUrl).toBe('http://localhost:11434/api/tags')
    // The production boundary MUST supply a timeout AbortSignal.
    expect(sawSignal).toBe(true)
  })

  test('reachable + model pulled → { reachable: true, modelPresent: true }', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }] }), {
        status: 200,
      })) as unknown as typeof fetch
    const health = await probeOllamaHealth('http://localhost:11434/v1', { fetchImpl })
    expect(health).toEqual({ reachable: true, modelPresent: true })
  })

  test('malformed successful JSON (not the promised shape) → modelPresent:false, never throws', async () => {
    const fetchImpl = (async () =>
      new Response('this is not json at all', { status: 200 })) as unknown as typeof fetch
    const health = await probeOllamaHealth('http://localhost:11434/v1', { fetchImpl })
    expect(health).toEqual({ reachable: false, modelPresent: false })
  })

  test('200 with no `models` array → reachable:true, modelPresent:false', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 })) as unknown as typeof fetch
    const health = await probeOllamaHealth('http://localhost:11434/v1', { fetchImpl })
    expect(health).toEqual({ reachable: true, modelPresent: false })
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

  test('a hung server → the timeout signal aborts the fetch → fail-soft, never throws', async () => {
    // The fake fetch never resolves on its own; it settles ONLY when the
    // timeout AbortSignal fires — so this genuinely exercises the production
    // timeout boundary (a probe that dropped the signal would hang forever
    // and this test would time out, not pass).
    const fetchImpl = ((_url: string | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (signal instanceof AbortSignal) {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          )
        }
      })) as unknown as typeof fetch
    const health = await probeOllamaHealth('http://localhost:11434/v1', { fetchImpl, timeoutMs: 20 })
    expect(health).toEqual({ reachable: false, modelPresent: false })
  })

  test('a base url without a /v1 suffix still targets /api/tags on the same host', async () => {
    let seenUrl: string | undefined
    const fetchImpl = (async (url: string | URL) => {
      seenUrl = String(url)
      return new Response(JSON.stringify({ models: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await probeOllamaHealth('http://gpu-box:11434', { fetchImpl })
    expect(seenUrl).toBe('http://gpu-box:11434/api/tags')
  })
})

describe('redactUrlUserinfo — never log OLLAMA_BASE_URL credentials', () => {
  test('strips user:pass@ userinfo from a credentialed URL', () => {
    expect(redactUrlUserinfo('http://alice:secret@ollama.internal:11434/v1')).not.toContain('secret')
    expect(redactUrlUserinfo('http://alice:secret@ollama.internal:11434/v1')).not.toContain('alice')
    expect(redactUrlUserinfo('http://alice:secret@ollama.internal:11434/v1')).toContain('***@')
    expect(redactUrlUserinfo('http://alice:secret@ollama.internal:11434/v1')).toContain('ollama.internal')
  })

  test('a URL without userinfo is returned unchanged', () => {
    expect(redactUrlUserinfo('http://localhost:11434/v1')).toBe('http://localhost:11434/v1')
  })

  test('a username-only URL is still redacted', () => {
    const out = redactUrlUserinfo('http://token@host:11434/v1')
    expect(out).not.toContain('token')
    expect(out).toContain('***@')
  })

  test('a non-URL string is passed through by the regex fallback without throwing', () => {
    expect(redactUrlUserinfo('not a url')).toBe('not a url')
  })
})

describe('isOpenAiEmbeddingWidthSupported — validate an untrusted persisted width', () => {
  test.each([1, 256, 512, 768, 1024, 1280, 1536, 3072])('in-range width %p → supported', (d) => {
    expect(isOpenAiEmbeddingWidthSupported(d)).toBe(true)
  })
  test.each([0, -1, 3073, 9999, 1.5, Number.NaN])('out-of-range/invalid width %p → NOT supported', (d) => {
    expect(isOpenAiEmbeddingWidthSupported(d)).toBe(false)
  })
})
