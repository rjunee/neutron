/**
 * @neutronai/gbrain-memory — conditional embedding-store configuration.
 *
 * Embeddings are **OPT-IN**. The default Neutron instance runs its memory on
 * GBrain's keyword (BM25) + typed-edge graph stores and initializes **no**
 * embedding/vector store — that path is unchanged and must stay untouched.
 *
 * An embedding store initializes ONLY when an embedder is explicitly opted into
 * via `NEUTRON_EMBEDDINGS`:
 *
 *   - unset / `off` / `0` / `false` / ``  → `null` (DEFAULT: no store,
 *     keyword + graph only — byte-for-byte today's behavior).
 *   - `openai`                            → cloud `text-embedding-3-large`
 *     (3072 dims). Requires an OpenAI key (`NEUTRON_EMBEDDINGS_OPENAI_API_KEY`,
 *     falling back to `OPENAI_API_KEY`). Missing key → `null` + a one-line warn.
 *   - `ollama`                            → local/free `nomic-embed-text`
 *     (768 dims) over `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`).
 *     No key required — runs unauthenticated on the local host.
 *   - `auto` / `on` / `1` / `true`        → prefer OpenAI when a key is present,
 *     else Ollama when `OLLAMA_BASE_URL` is set, else `null`.
 *
 * **Why an explicit switch and not "OpenAI key present → embed".** A plain
 * `OPENAI_API_KEY` is already consumed by the GPT BYO LLM adapter
 * (`runtime/adapters/gpt-5-5-api/auth.ts`). Triggering cloud embeddings off its
 * mere presence would silently bill every GPT-BYO user for embeddings and
 * change the default — violating the opt-in contract. The operator opts in once
 * via `NEUTRON_EMBEDDINGS`; provider auth is then resolved from the usual keys.
 *
 * **The GBrain seam.** GBrain reads its embedding model from
 * `GBRAIN_EMBEDDING_MODEL` (format `provider:model`, e.g.
 * `openai:text-embedding-3-large`) + `GBRAIN_EMBEDDING_DIMENSIONS`, falling back
 * to these env vars when no `~/.gbrain/config.json` is present
 * (`gbrain/src/cli.ts`, `gbrain/src/core/ai/model-resolver.ts#parseModelId`).
 * When neither is set, `gbrain serve` initializes no embedding store and
 * hybridSearch degrades to lexical — exactly the path Neutron ships today.
 *
 * This module is **pure** (no I/O, no spawn): given an env, it returns the child
 * env GBrain needs, or `null`. The provisioning seam
 * (`resolveGbrainClientOptions`) merges a non-null result into the `gbrain serve`
 * child env; a `null` result leaves the child env untouched.
 */

/** A configured embedder. `childEnv` is merged into the `gbrain serve` child. */
export interface EmbedderConfig {
  /** Which provider the embedder routes to. */
  provider: 'openai' | 'ollama'
  /** GBrain model id (`provider:model`), e.g. `openai:text-embedding-3-large`. */
  model: string
  /** Embedding dimensionality forwarded as `GBRAIN_EMBEDDING_DIMENSIONS`. */
  dimensions: number
  /**
   * Extra env the `gbrain serve` child needs to embed: the
   * `GBRAIN_EMBEDDING_*` selectors plus the provider's auth / base-url.
   */
  childEnv: Record<string, string>
}

/** Cloud default: OpenAI `text-embedding-3-large` at its max 3072 dims. */
const OPENAI_EMBED_MODEL = 'text-embedding-3-large'
const OPENAI_EMBED_DIMENSIONS = 3072

/** Local/free default: Ollama `nomic-embed-text` at its native 768 dims. */
const OLLAMA_EMBED_MODEL = 'nomic-embed-text'
const OLLAMA_EMBED_DIMENSIONS = 768
const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1'

function readNonEmpty(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key]
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
}

/** The OpenAI key for embeddings: a dedicated override, else the shared key. */
function resolveOpenAiKey(env: NodeJS.ProcessEnv): string | undefined {
  return (
    readNonEmpty(env, 'NEUTRON_EMBEDDINGS_OPENAI_API_KEY') ??
    readNonEmpty(env, 'OPENAI_API_KEY')
  )
}

/**
 * Build the OpenAI embedder config for a resolved key. Exported so the GBrain
 * provisioning seam can opt into embeddings from a key the OWNER captured
 * consensually through the onboarding optional-key offer ("paste an OpenAI key
 * to unlock cloud embeddings") — that explicit, purpose-stated capture is the
 * sanctioned trigger, distinct from a bare env `OPENAI_API_KEY` (which the GPT
 * BYO adapter consumes and which must NOT silently switch on cloud embeddings;
 * see `resolveEmbedderConfig`'s `NEUTRON_EMBEDDINGS` gate).
 */
export function buildOpenAiEmbedderConfig(apiKey: string): EmbedderConfig {
  return {
    provider: 'openai',
    model: OPENAI_EMBED_MODEL,
    dimensions: OPENAI_EMBED_DIMENSIONS,
    childEnv: {
      GBRAIN_EMBEDDING_MODEL: `openai:${OPENAI_EMBED_MODEL}`,
      GBRAIN_EMBEDDING_DIMENSIONS: String(OPENAI_EMBED_DIMENSIONS),
      OPENAI_API_KEY: apiKey,
    },
  }
}

function buildOllamaConfig(env: NodeJS.ProcessEnv): EmbedderConfig {
  const baseUrl = readNonEmpty(env, 'OLLAMA_BASE_URL') ?? OLLAMA_DEFAULT_BASE_URL
  return {
    provider: 'ollama',
    model: OLLAMA_EMBED_MODEL,
    dimensions: OLLAMA_EMBED_DIMENSIONS,
    childEnv: {
      GBRAIN_EMBEDDING_MODEL: `ollama:${OLLAMA_EMBED_MODEL}`,
      GBRAIN_EMBEDDING_DIMENSIONS: String(OLLAMA_EMBED_DIMENSIONS),
      OLLAMA_BASE_URL: baseUrl,
    },
  }
}

/**
 * Resolve the conditional embedder config from env. Returns `null` (the
 * default) when embeddings are not opted in or cannot be satisfied — in which
 * case provisioning forwards nothing and GBrain runs keyword + graph only.
 */
export function resolveEmbedderConfig(env: NodeJS.ProcessEnv = process.env): EmbedderConfig | null {
  const raw = readNonEmpty(env, 'NEUTRON_EMBEDDINGS')?.toLowerCase()

  // Default + explicit-off: no embedder. Today's behavior, untouched.
  if (raw === undefined || raw === 'off' || raw === '0' || raw === 'false' || raw === 'none') {
    return null
  }

  if (raw === 'openai') {
    const apiKey = resolveOpenAiKey(env)
    if (apiKey === undefined) {
      console.warn(
        "[gbrain-memory] NEUTRON_EMBEDDINGS=openai but no OpenAI key found " +
          '(set NEUTRON_EMBEDDINGS_OPENAI_API_KEY or OPENAI_API_KEY). ' +
          'Embedding store DISABLED; memory runs on keyword + graph.',
      )
      return null
    }
    return buildOpenAiEmbedderConfig(apiKey)
  }

  if (raw === 'ollama') {
    return buildOllamaConfig(env)
  }

  // auto / on / 1 / true → pick the best available provider.
  if (raw === 'auto' || raw === 'on' || raw === '1' || raw === 'true') {
    const apiKey = resolveOpenAiKey(env)
    if (apiKey !== undefined) return buildOpenAiEmbedderConfig(apiKey)
    if (readNonEmpty(env, 'OLLAMA_BASE_URL') !== undefined) return buildOllamaConfig(env)
    console.warn(
      `[gbrain-memory] NEUTRON_EMBEDDINGS=${raw} but no embedder is available ` +
        '(no OpenAI key, no OLLAMA_BASE_URL). ' +
        'Embedding store DISABLED; memory runs on keyword + graph.',
    )
    return null
  }

  console.warn(
    `[gbrain-memory] NEUTRON_EMBEDDINGS="${raw}" is not recognized ` +
      '(expected: openai | ollama | auto | off). ' +
      'Embedding store DISABLED; memory runs on keyword + graph.',
  )
  return null
}
