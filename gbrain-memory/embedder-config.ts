/**
 * @neutronai/gbrain-memory — conditional embedding-store configuration.
 *
 * RA3 (2026-07): recall is HYBRID (vector + keyword + graph) BY DEFAULT. A
 * fresh install with no OpenAI key still gets semantic recall via a LOCAL,
 * free embedder — Ollama `nomic-embed-text` — auto-configured with zero env
 * required. `NEUTRON_EMBEDDINGS` lets an operator override the provider or
 * opt all the way out:
 *
 *   - unset (DEFAULT)                     → local Ollama fallback
 *     (`nomic-embed-text`, 768 dims) over `OLLAMA_BASE_URL` (default
 *     `http://localhost:11434/v1`). No key, no env, no I/O in THIS resolver
 *     (it stays pure/sync) — GBrain's own `hybridSearch` already degrades a
 *     failed per-query embed to keyword-only (`gbrain/src/core/search/
 *     hybrid.ts`), so an unreachable/not-yet-pulled Ollama fails soft to
 *     lexical recall with no crash. `ensure-brain-init.ts` additionally
 *     probes Ollama once at boot (`probeOllamaHealth`, below) and logs a
 *     clear degradation warning — or a healthy confirmation — so this is
 *     never a silent mystery. Deliberately does NOT consult any OpenAI key
 *     (bare or dedicated) — see "Why the default never bills" below.
 *   - `off` / `0` / `false` / `none` / `` → `null` (no store, keyword + graph
 *     only — the pre-RA3 default, still available as an explicit opt-out).
 *   - `openai`                            → cloud `text-embedding-3-large`
 *     at the shared 768-dim width (see below). Requires an OpenAI key
 *     (`NEUTRON_EMBEDDINGS_OPENAI_API_KEY`, falling back to
 *     `OPENAI_API_KEY`). Missing key → `null` + a one-line warn.
 *   - `ollama`                            → local/free `nomic-embed-text`
 *     (768 dims) — the same provider as the default, but as an explicit,
 *     discoverable choice (e.g. a custom `OLLAMA_BASE_URL`).
 *   - `auto` / `on` / `1` / `true`        → EXPLICIT opt-in escape hatch:
 *     prefer OpenAI when a key is present (bare or dedicated), else the
 *     local Ollama fallback. This is the ONLY path where a bare
 *     `OPENAI_API_KEY` can activate cloud embeddings — an operator must
 *     deliberately type `NEUTRON_EMBEDDINGS=auto` (or `openai`) for that;
 *     the passive default never does.
 *
 * **Why the default never bills.** A plain `OPENAI_API_KEY` is already
 * consumed by the GPT BYO LLM adapter (`runtime/adapters/gpt-5-5-api/
 * auth.ts`). Defaulting to cloud embeddings off its mere presence would
 * silently bill every GPT-BYO user for embeddings — so the DEFAULT never
 * looks at any OpenAI key at all; it only ever activates the free local
 * Ollama fallback. Reaching cloud embeddings still requires the deliberate
 * `NEUTRON_EMBEDDINGS=openai|auto` opt-in (unchanged), or the SEPARATE,
 * consensual onboarding-key capture the composer wires ahead of this
 * resolver (`buildOpenAiEmbedderConfig`, called directly with a stored key —
 * see `gateway/realmode-composer/build-gbrain-memory.ts:resolveEffectiveEmbedder`).
 *
 * **One universal 768-dim column width (no-rebuild upgrade, no divergence).**
 * EVERY fresh-brain lineage — the local Ollama fallback (native 768), the
 * onboarding-captured OpenAI key (`buildOpenAiEmbedderConfig` default 768),
 * the explicit `NEUTRON_EMBEDDINGS=openai` opt-in (below), AND the latent
 * column a `off` brain is pre-sized at (`ensure-brain-init.ts:
 * resolveInitEmbeddingTarget`) — resolves to the SAME 768 dims. This is
 * deliberate: it makes the init-time width and every serve-time width
 * STRUCTURALLY identical, so a key pasted after boot (or after an `off`
 * install) can NEVER produce a `GBRAIN_EMBEDDING_DIMENSIONS` that mismatches
 * the persisted column. 768 is the one width the free local embedder can
 * emit; OpenAI's `text-embedding-3-large` supports Matryoshka truncation to
 * any width ≤ 3072 (verified against `gbrain/src/core/ai/dims.ts:
 * dimsProviderOptions`), so it slots into the same `vector(768)` column with
 * no ALTER and no `gbrain embed --stale` dimension-mismatch. The ONLY non-768
 * columns are LEGACY brains created under the pre-RA3 3072 default; those
 * already exist on disk and are reconciled to their persisted width at boot
 * (`build-gbrain-memory.ts:reconcileEmbedderToBrain`).
 *
 * **The GBrain seam.** GBrain reads its embedding model from
 * `GBRAIN_EMBEDDING_MODEL` (format `provider:model`, e.g.
 * `openai:text-embedding-3-large`) + `GBRAIN_EMBEDDING_DIMENSIONS`, falling
 * back to these env vars when no `~/.gbrain/config.json` is present
 * (`gbrain/src/cli.ts`, `gbrain/src/core/ai/model-resolver.ts#parseModelId`).
 *
 * This module is **pure** (no I/O, no spawn): given an env, `resolveEmbedder
 * Config` returns the child env GBrain needs, or `null`. The provisioning
 * seam (`resolveGbrainClientOptions`) merges a non-null result into the
 * `gbrain serve` child env; a `null` result leaves the child env untouched.
 * The one exception is `probeOllamaHealth` — a SEPARATE, explicitly-async,
 * explicitly-named export that does real network I/O; it is advisory-only
 * (never changes which embedder gets configured) and is called from
 * `ensure-brain-init.ts`, not from `resolveEmbedderConfig`.
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

/** Cloud: OpenAI `text-embedding-3-large`. Max native width 3072 dims. */
const OPENAI_EMBED_MODEL = 'text-embedding-3-large'
/**
 * `text-embedding-3-large` supports Matryoshka truncation to ANY integer width
 * in `1..3072` (mirrors gbrain's `isValidOpenAITextEmbedding3Dim`,
 * `gbrain/src/core/ai/dims.ts`). Used to VALIDATE an untrusted persisted column
 * width before configuring OpenAI against it — a corrupt/out-of-range width
 * (e.g. `9999`, or `<= 0`) must NOT be forwarded (gbrain would reject it at
 * embed time); the reconciler degrades to keyword+graph instead.
 */
const OPENAI_TE3_LARGE_MAX_DIMS = 3072

/** True when OpenAI `text-embedding-3-large` can serve embeddings at `dims`. */
export function isOpenAiEmbeddingWidthSupported(dims: number): boolean {
  return Number.isInteger(dims) && dims >= 1 && dims <= OPENAI_TE3_LARGE_MAX_DIMS
}

/** Local/free default: Ollama `nomic-embed-text` at its native 768 dims. */
const OLLAMA_EMBED_MODEL = 'nomic-embed-text'
const OLLAMA_EMBED_DIMENSIONS = 768
const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1'

/**
 * Shared width for the default/auto/onboarding-key lineage (see file doc,
 * "Shared 768-dim column width"). Matches Ollama's native output so an
 * onboarding-captured OpenAI key upgrades an existing local-fallback column
 * IN PLACE, no rebuild.
 */
const SHARED_DEFAULT_DIMENSIONS = OLLAMA_EMBED_DIMENSIONS

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
 *
 * `dimensions` defaults to `SHARED_DEFAULT_DIMENSIONS` (768) — the one
 * universal fresh-brain width (see "One universal 768-dim column width"). Pass
 * `dimensions` explicitly ONLY to target a pre-existing LEGACY column of a
 * different width (`reconcileEmbedderToBrain` does this for a 3072 brain), so
 * the key upgrades that column in place at its native width.
 */
export function buildOpenAiEmbedderConfig(
  apiKey: string,
  dimensions: number = SHARED_DEFAULT_DIMENSIONS,
): EmbedderConfig {
  return {
    provider: 'openai',
    model: OPENAI_EMBED_MODEL,
    dimensions,
    childEnv: {
      GBRAIN_EMBEDDING_MODEL: `openai:${OPENAI_EMBED_MODEL}`,
      GBRAIN_EMBEDDING_DIMENSIONS: String(dimensions),
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
 * Resolve the conditional embedder config from env. The DEFAULT (unset
 * `NEUTRON_EMBEDDINGS`) is the local Ollama fallback (hybrid recall out of
 * the box, no key, no billing risk) — `null` (no embedder at all) is now an
 * explicit opt-out (`off`/`0`/`false`/`none`), not the default.
 */
export function resolveEmbedderConfig(env: NodeJS.ProcessEnv = process.env): EmbedderConfig | null {
  const raw = readNonEmpty(env, 'NEUTRON_EMBEDDINGS')?.toLowerCase()

  // DEFAULT: unset (or blank/whitespace, which `readNonEmpty` also treats as
  // "not configured"). Local Ollama fallback, unconditionally — this branch
  // deliberately never calls `resolveOpenAiKey`; see "Why the default never
  // bills" above.
  if (raw === undefined) {
    return buildOllamaConfig(env)
  }

  // Explicit off: no embedder. The pre-RA3 default, still available as an
  // opt-out for operators who want keyword + graph only.
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'none') {
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
    // Shared universal width (768) — same as every other fresh-brain lineage,
    // so a later onboarding key or an `off`→key transition never diverges.
    return buildOpenAiEmbedderConfig(apiKey)
  }

  if (raw === 'ollama') {
    return buildOllamaConfig(env)
  }

  // auto / on / 1 / true → EXPLICIT opt-in: prefer OpenAI when a key is
  // present (bare or dedicated — deliberate, the operator typed this),
  // else the local Ollama fallback (always available; never null).
  if (raw === 'auto' || raw === 'on' || raw === '1' || raw === 'true') {
    const apiKey = resolveOpenAiKey(env)
    if (apiKey !== undefined) return buildOpenAiEmbedderConfig(apiKey)
    return buildOllamaConfig(env)
  }

  console.warn(
    `[gbrain-memory] NEUTRON_EMBEDDINGS="${raw}" is not recognized ` +
      '(expected: openai | ollama | auto | off). ' +
      'Embedding store DISABLED; memory runs on keyword + graph.',
  )
  return null
}

/** Result of a local-Ollama reachability probe. See `probeOllamaHealth`. */
export interface OllamaHealthCheck {
  /** The base URL answered at all (server up, port open). */
  reachable: boolean
  /** The configured embedding model is present in Ollama's local model list. */
  modelPresent: boolean
}

/**
 * Redact `user:pass@` userinfo from a URL for SAFE logging. An operator can put
 * credentials in `OLLAMA_BASE_URL` (`http://user:secret@host/v1`); those must
 * never reach a log line. Returns the URL with userinfo replaced by `***@`, or
 * the input unchanged when it has no userinfo / isn't a parseable URL.
 */
export function redactUrlUserinfo(url: string): string {
  try {
    const u = new URL(url)
    if (u.username === '' && u.password === '') return url
    u.username = ''
    u.password = ''
    return u.toString().replace('://', '://***@')
  } catch {
    // Not a parseable URL — fall back to a regex strip of `scheme://user:pass@`.
    return url.replace(/(^[a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1***@')
  }
}

/**
 * Derive Ollama's native `/api/tags` health/model-list endpoint from the base
 * URL — PRESERVING any base path so a reverse-proxied deployment probes the
 * right place. Strip a trailing `/v1` (the OpenAI-compat suffix) and any
 * trailing slash, then append `/api/tags`:
 *   - `http://localhost:11434/v1`        → `http://localhost:11434/api/tags`
 *   - `http://localhost:11434`           → `http://localhost:11434/api/tags`
 *   - `https://proxy.example/ollama/v1`  → `https://proxy.example/ollama/api/tags`
 *   - `https://proxy.example/ollama`     → `https://proxy.example/ollama/api/tags`
 * (Dropping the base path would probe `https://proxy.example/api/tags` and
 * yield a FALSE "not reachable" — which now also wrongly suppresses the
 * fresh-init backfill marker.)
 */
function ollamaTagsUrl(baseUrl: string): string {
  // Strip trailing slashes then a terminal `/v1` segment. Uses linear string ops
  // (NOT a `\/+$` regex, which is polynomial-ReDoS on `//////…x` inputs and runs
  // on the operator-supplied OLLAMA_BASE_URL — CodeQL js/polynomial-redos).
  const stripToBase = (path: string): string => {
    let p = path
    while (p.endsWith('/')) p = p.slice(0, -1)
    if (p.endsWith('/v1')) p = p.slice(0, -'/v1'.length)
    return p
  }
  try {
    const u = new URL(baseUrl)
    u.pathname = `${stripToBase(u.pathname)}/api/tags`
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return `${stripToBase(baseUrl)}/api/tags`
  }
}

/**
 * Best-effort reachability probe for the local Ollama embedder fallback.
 *
 * NOT used to gate which embedder gets configured — `resolveEmbedderConfig`
 * stays pure/sync, and GBrain's own `hybridSearch` already degrades a failed
 * per-query embed to keyword-only (`gbrain/src/core/search/hybrid.ts`:
 * "Embedding failure is non-fatal, fall back to keyword-only"), so recall
 * never crashes when Ollama is absent. This probe exists purely so that
 * degraded state is OBSERVABLE: `ensure-brain-init.ts` calls it once at boot
 * and logs a clear, actionable warning (or a healthy confirmation) instead of
 * leaving "why does recall feel lexical-only" a silent mystery.
 *
 * Fails soft in every direction: a network error, timeout, or malformed
 * response all resolve to `{ reachable: false, modelPresent: false }` rather
 * than throwing.
 */
export async function probeOllamaHealth(
  baseUrl: string,
  opts: { model?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<OllamaHealthCheck> {
  const model = opts.model ?? OLLAMA_EMBED_MODEL
  const timeoutMs = opts.timeoutMs ?? 1500
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const res = await doFetch(ollamaTagsUrl(baseUrl), { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { reachable: false, modelPresent: false }
    const body = (await res.json()) as { models?: Array<{ name?: string }> }
    const names = Array.isArray(body.models) ? body.models.map((m) => m?.name ?? '') : []
    const modelPresent = names.some((n) => n === model || n.startsWith(`${model}:`))
    return { reachable: true, modelPresent }
  } catch {
    return { reachable: false, modelPresent: false }
  }
}
