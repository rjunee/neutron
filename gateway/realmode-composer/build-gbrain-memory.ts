/**
 * @neutronai/gateway/realmode-composer — per-instance GBrain memory wiring.
 *
 * Builds the live GBrain seams the composer threads into the boot path, so
 * GBrain is the genuine production memory store (not a built-but-unwired layer).
 *
 * The raw stdio MCP transport (`GBrainStdioMcpClient`, which spawns `gbrain
 * serve` scoped to THIS instance's brain) is an INTERNAL local of this builder —
 * it is deliberately NOT on the returned `GBrainMemoryWiring` surface (RA5 /
 * invariant I2). Exposing it would let a product module reach a raw op-name
 * transport through the exempt composer (`buildGBrainMemory(...).client`),
 * defeating the swap-seam type+import boundary. The PUBLIC seams are only the
 * TYPED contract surfaces:
 *
 *   1. `memoryStore` — `GBrainMemoryStore` over the internal client. Threaded
 *      into the admin "Memory" tab (`app-admin-surface.ts`) so browse reads real
 *      pages, and into the `memory_search` agent tool.
 *   2. `syncHook`    — `GBrainSyncHook` over the store + client. Threaded into
 *      the entity-writer's `syncHook` seam (today via the history-import
 *      populator's `importGbrainSyncHook`) so entity writes fan out to the
 *      GBrain page store + typed-edge graph.
 *   3. `close`        — tears down the `gbrain serve` child on SIGTERM.
 *
 * **Per-instance isolation.** Each instance's brain lives at `<owner_home>/gbrain/`
 * (per `docs/architecture/memory-adapter-gbrain-2026-06-06.md`). We point
 * `gbrain serve` at it via `GBRAIN_HOME` — gbrain resolves its `.gbrain`
 * directory from that env (`gbrain/src/core/preferences.ts`,
 * `gbrain/src/core/config.ts`). The data boundary IS the per-instance home; an
 * operator/systemd-provided `GBRAIN_BRAIN_ID` is honored when present but is not
 * required for isolation. `GBRAIN_SOURCE` defaults to `default` (single source
 * at MM; project partitioning lands in M2.6).
 *
 * **Lazy + fail-soft.** `GBrainStdioMcpClient` connects lazily on first `call`,
 * so constructing this at boot spawns nothing. The first memory op spawns
 * `gbrain serve`; if the `gbrain` binary is absent, that op throws and the
 * callers (admin surface read path + entity-writer hook) already catch + log
 * rather than crash. So wiring this live is safe even on a host without gbrain
 * installed — it simply degrades to logged failures until the binary lands.
 */

import { join } from 'node:path'

import {
  GBrainStdioMcpClient,
  type GBrainStdioMcpClientOptions,
  GBrainMemoryStore,
  GBrainSyncHook,
  type GbrainSyncStateSink,
  type MemoryStore,
  type EmbedderConfig,
  type BrainEmbeddingWidth,
  resolveEmbedderConfig,
  buildOpenAiEmbedderConfig,
  ensureBrainInitialized,
  resolveExistingBrainWidth,
  isOpenAiEmbeddingWidthSupported,
  resolveGbrainCommand,
  resolveGbrainChildPath,
  probeOllamaHealth,
  type OllamaHealthCheck,
} from '@neutronai/gbrain-memory/index.ts'
import type { SyncHook } from '@neutronai/runtime/entity-writer.ts'

export interface GBrainMemoryWiring {
  // NB: the raw `GBrainStdioMcpClient` transport is intentionally NOT a field
  // here — it stays a local inside `buildGBrainMemory`. Product code must reach
  // memory only through the typed `MemoryStore` (RA5 / invariant I2). This is
  // layer (ii) of the acquisition boundary: the ENFORCED guarantee is that no
  // product-scope module can OBTAIN a raw transport via (i) importing the sealed
  // type [depcruise import-ban], (ii) this composer wiring [MemoryStore only —
  // guarded by the compile-time probe in build-gbrain-memory.test.ts], or (iii)
  // a connect provider surface [type-checker acquisition scan]. Exposing the
  // transport on this returned shape would break (ii). (Deliberate type-erasing
  // laundering inside the trusted connect/ boundary is a documented out-of-scope
  // residual — see memory-swap-seam.depcruise.test.ts.)
  /** Admin "Memory" tab read/write surface + `memory_search` backing store. */
  memoryStore: MemoryStore
  /** Entity-writer fan-out hook (page store + typed-edge graph). */
  syncHook: SyncHook
  /** Tear down the `gbrain serve` child on SIGTERM. */
  close: () => Promise<void>
}

/**
 * Resolve the per-instance `GBrainStdioMcpClient` options from the instance home +
 * env. Pure (no I/O, no spawn) so the scoping logic is unit-testable: the
 * `GBRAIN_HOME` data boundary, the `GBRAIN_SOURCE` default, the optional
 * operator-provided `GBRAIN_BRAIN_ID` passthrough, and the embedding-store
 * wiring.
 *
 * **Hybrid-by-default embedding store (RA3).** By DEFAULT an embedder IS
 * configured — the free local Ollama fallback (`resolveEmbedderConfig`'s
 * unset case) — so `gbrain serve` computes vectors and recall is hybrid out
 * of the box; its `GBRAIN_EMBEDDING_*` + provider/base-url env is merged into
 * the child. The pre-RA3 keyword-+-graph-only wiring is still reachable as the
 * explicit `NEUTRON_EMBEDDINGS=off` opt-out (embedder `null` → child env is
 * byte-for-byte GBRAIN_HOME only). An onboarding-captured OpenAI key (threaded
 * lazily) overrides the default with cloud embeddings at the shared column
 * width. When an EXISTING brain's persisted column width is known
 * (`existingBrainDims`), the embedder is RECONCILED to it
 * (`reconcileEmbedderToBrain`) so a cross-version upgrade never sends a
 * mismatched dimension to `gbrain serve`.
 */
/**
 * Reconcile an effective embedder against an EXISTING brain's persisted
 * `content_chunks` column width (`brainWidth`, from
 * `resolveExistingBrainWidth`). At gbrain runtime the
 * `GBRAIN_EMBEDDING_DIMENSIONS` env OVERRIDES config.json, so a width that
 * mismatches the persisted `vector(N)` column would make embed writes fail —
 * this is the guard that prevents that on a cross-version upgrade (e.g. a
 * legacy 3072-dim brain created under the pre-RA3 default meeting RA3's
 * 768-dim local fallback):
 *
 *   - `null` embedder (explicit `off`) → `null`.
 *   - `brainWidth` `null` (FRESH brain — no config yet) or a matching known
 *     width → embedder returned unchanged (fresh init at the RA3 default; or
 *     already aligned).
 *   - known-width mismatch + OpenAI embedder → rebuilt at the brain's width.
 *     OpenAI `text-embedding-3-large` truncates via Matryoshka to any width
 *     ≤ 3072, so a stored key upgrades the legacy column IN PLACE at its native
 *     fidelity (e.g. full 3072 for a legacy brain), no rebuild.
 *   - known-width mismatch + Ollama embedder → dropped to `null` (keyword
 *     +graph). `nomic-embed-text` is fixed at 768 dims and cannot match a wider
 *     legacy column; rather than corrupt writes we degrade to lexical recall
 *     (the caller logs this loudly). A later OpenAI key still upgrades in place.
 *   - `brainWidth` `'unknown'` (an INITIALIZED brain whose width we can't read
 *     — missing `embedding_dimensions`, malformed config, or `--no-embedding`)
 *     → dropped to `null`. FAIL SAFE: inject NO embedding dimension so
 *     `gbrain serve` honors the brain's OWN persisted config rather than a
 *     guessed width that could mismatch the column (the caller logs this).
 */
/**
 * Per-connect coherent resolver for the two inputs that select the effective
 * embedder — the onboarding OpenAI key AND the persisted brain column WIDTH.
 * Both are read by the init guard (`ensureInitialized`) and the serve childEnv
 * (`resolveDynamicEnv`) WITHIN one connect, and they MUST observe the SAME
 * values or the two split (init runs keyword/no-backfill while the same spawn
 * serves cloud embeddings; or init inits a fresh 768 column while serve targets
 * a legacy 3072 one). Both are freshly resolved — and memoized — per connect:
 *
 *   - `getKey` memoizes the resolved key (found OR miss, swallowing resolver
 *     errors → `undefined`) so a key landing between the two reads can't split
 *     them.
 *   - `getBrainWidth` memoizes a FRESH `resolveExistingBrainWidth` read (NOT a
 *     composition-time snapshot) — a legacy brain created/restored AFTER
 *     composition but BEFORE the first connect is seen on that connect, so
 *     reconciliation never sends a 768 dim to a pre-existing 3072 column.
 *
 * `resetForConnect` clears both so the NEXT connect re-resolves fresh
 * (preserving no-restart activation: a key/brain appearing later is picked up on
 * the next spawn). The client re-runs `ensureInitialized` — which calls
 * `resetForConnect` FIRST, then reads — at the start of every (re)connect, and
 * the serve `resolveDynamicEnv` runs after, reading the same memoized values.
 */
export function makePerConnectResolver(input: {
  resolveOpenAiKey?: () => Promise<string | undefined>
  resolveBrainWidth: () => BrainEmbeddingWidth
}): {
  getKey: () => Promise<string | undefined>
  getBrainWidth: () => BrainEmbeddingWidth
  resetForConnect: () => void
} {
  const resolveOpenAiKey = input.resolveOpenAiKey
  let cachedKey: string | undefined
  let keyValid = false
  let cachedWidth: BrainEmbeddingWidth = null
  let widthValid = false
  return {
    getKey: async () => {
      if (resolveOpenAiKey === undefined) return undefined
      if (keyValid) return cachedKey
      const key = await resolveOpenAiKey().catch(() => undefined)
      cachedKey = key !== undefined && key.trim().length > 0 ? key : undefined
      keyValid = true
      return cachedKey
    },
    getBrainWidth: () => {
      if (widthValid) return cachedWidth
      // Fail-safe: an unexpected throw → 'unknown' (inject no width) rather than
      // a guessed one. `resolveExistingBrainWidth` already handles its own I/O
      // errors, so this is defense-in-depth.
      try {
        cachedWidth = input.resolveBrainWidth()
      } catch {
        cachedWidth = 'unknown'
      }
      widthValid = true
      return cachedWidth
    },
    resetForConnect: () => {
      keyValid = false
      cachedKey = undefined
      widthValid = false
      cachedWidth = null
    },
  }
}

export function reconcileEmbedderToBrain(
  embedder: EmbedderConfig | null,
  brainWidth: BrainEmbeddingWidth,
): EmbedderConfig | null {
  if (embedder === null) return null
  // Initialized-but-unknown width → never guess; let gbrain's own config drive.
  if (brainWidth === 'unknown') return null
  if (brainWidth === null || brainWidth === embedder.dimensions) return embedder
  if (embedder.provider === 'openai') {
    // Validate the (untrusted) persisted width against what OpenAI can actually
    // serve BEFORE forwarding it — a corrupt/out-of-range width (e.g. 9999, or
    // <= 0) would make gbrain reject embed/backfill at runtime. Degrade to
    // keyword+graph (fail-safe) rather than configure a doomed width.
    if (!isOpenAiEmbeddingWidthSupported(brainWidth)) return null
    const apiKey = embedder.childEnv['OPENAI_API_KEY'] ?? ''
    return buildOpenAiEmbedderConfig(apiKey, brainWidth)
  }
  // Ollama (or any fixed-width local provider) cannot match a different
  // persisted column → degrade to keyword+graph rather than mis-dimension writes.
  return null
}

/**
 * Resolve the effective embedder. Precedence (an EXPLICIT operator choice wins
 * over any stored key; the stored key only decides the OTHERWISE-default path):
 *
 *   1. `NEUTRON_EMBEDDINGS=off` (/`0`/`false`/`none`) — AUTHORITATIVE kill
 *      switch → keyword+graph only. An onboarding-captured key must NOT silently
 *      re-enable cloud embeddings the operator explicitly turned off.
 *   2. `=ollama` / `=openai` — explicit provider pin, wins over the stored key
 *      (an operator who pinned ollama gets ollama even with a key on file;
 *      explicit openai prefers the stored onboarding key, else the env key).
 *   3. stored onboarding key (ND1 product path) — with `NEUTRON_EMBEDDINGS`
 *      unset (or `auto`/`on`), a key the owner captured through the onboarding
 *      optional-key offer ("paste a key to unlock cloud embeddings") flips on
 *      CLOUD semantic memory with no env required.
 *   4. env `resolveEmbedderConfig` — RA3 default: free local Ollama fallback
 *      (still hybrid recall, no billing). A bare env `OPENAI_API_KEY` (the GPT
 *      BYO adapter's key) never silently bills for CLOUD embeddings here.
 *
 * NOTE: returned dims are the provider default — the caller reconciles to an
 * existing brain's column via `reconcileEmbedderToBrain`.
 */
export function resolveEffectiveEmbedder(input: {
  env: NodeJS.ProcessEnv
  openaiApiKey?: string | undefined
}): EmbedderConfig | null {
  const normalized = readNeutronEmbeddingsMode(input.env)
  const stored = input.openaiApiKey?.trim()

  // 1. Kill switch is authoritative — off beats any stored key.
  if (normalized === 'off') return null

  // 2. Explicit provider pin beats the stored key.
  if (normalized === 'ollama') return resolveEmbedderConfig(input.env)
  if (normalized === 'openai') {
    if (stored !== undefined && stored.length > 0) return buildOpenAiEmbedderConfig(stored)
    return resolveEmbedderConfig(input.env)
  }

  // 3. Onboarding-captured key (unset / auto) → cloud embeddings, no env needed.
  if (stored !== undefined && stored.length > 0) return buildOpenAiEmbedderConfig(stored)

  // 4. Env default → free local Ollama fallback (or auto→env-key OpenAI).
  return resolveEmbedderConfig(input.env)
}

/**
 * Normalize `NEUTRON_EMBEDDINGS` to a coarse mode for the effective-embedder
 * precedence. Mirrors `resolveEmbedderConfig`'s own token handling: unset /
 * blank → `'default'` (NOT off — RA3 defaults to the local Ollama fallback);
 * the opt-out tokens collapse to `'off'`.
 */
function readNeutronEmbeddingsMode(
  env: NodeJS.ProcessEnv,
): 'off' | 'openai' | 'ollama' | 'default' {
  const raw = env.NEUTRON_EMBEDDINGS
  const t = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (t === '') return 'default'
  if (t === 'off' || t === '0' || t === 'false' || t === 'none') return 'off'
  if (t === 'ollama') return 'ollama'
  if (t === 'openai') return 'openai'
  return 'default' // auto / on / 1 / true / anything else → env resolver decides
}

/**
 * Reachability probe seam for the local Ollama embedder (injected in tests).
 * Signature-compatible with `probeOllamaHealth`.
 */
export type OllamaReachabilityProbe = (
  baseUrl: string,
  opts: { model: string },
) => Promise<OllamaHealthCheck>

/**
 * The embedding env to forward to the `gbrain serve` child for a resolved
 * embedder — with a WRITE-side fail-soft gate for the local Ollama fallback.
 *
 * gbrain's `put_page` embeds inline and FAILS HARD ("[embed(...)] Failed after
 * N attempts") when the configured provider is unreachable — it only skips
 * embedding when NO provider is configured (`operations.ts`:
 * `noEmbed = !isAvailable('embedding')`). So forwarding an unreachable Ollama
 * (the RA3 default on a host without Ollama installed) would make EVERY memory
 * write fail — "silently useless", the exact failure mode RA3 forbids.
 *
 * Fix: when the effective embedder is local Ollama and it is NOT reachable (or
 * the model isn't pulled) at connect, forward NO embedding env → gbrain writes
 * succeed as keyword+graph (chunks land NULL-stale). The column stays sized for
 * Ollama (init created it at 768), so the next reachable reconnect's
 * `embed --stale` backfills those chunks IN PLACE. This is the write-side mirror
 * of gbrain's read-side per-query search fallback (proven in
 * `gbrain-memory/__tests__/failsoft-search-cli.test.ts`). A CLOUD (OpenAI)
 * embedder is never probed — it is assumed reachable; a transient API blip is
 * gbrain's own retry concern, and a bad key is a config error to surface, not a
 * reason to silently drop embeddings.
 */
async function resolveServeEmbeddingEnv(
  embedder: EmbedderConfig | null,
  probe: OllamaReachabilityProbe,
): Promise<Record<string, string>> {
  if (embedder === null) return {}
  if (embedder.provider === 'ollama') {
    const baseUrl = embedder.childEnv['OLLAMA_BASE_URL'] ?? 'http://localhost:11434/v1'
    let health: OllamaHealthCheck
    try {
      health = await probe(baseUrl, { model: embedder.model })
    } catch {
      // A probe that itself errors is treated as unreachable (fail-soft).
      health = { reachable: false, modelPresent: false }
    }
    if (!health.reachable || !health.modelPresent) {
      // Ollama configured but DOWN. Simply omitting the embed env is NOT enough:
      // gbrain's `loadConfig` falls back to the PERSISTED `embedding_model`
      // (`ollama:nomic-embed-text`, written by init), and an Ollama provider
      // needs no key so `isAvailable('embedding')` stays true → put_page would
      // still try to embed and FAIL HARD. So we OVERRIDE the persisted provider
      // (env beats config in gbrain's loadConfig) with the KEYLESS OpenAI-latent
      // default at the SAME column width: with no key, `isAvailable('embedding')`
      // is false → gbrain stores the page UNEMBEDDED (NULL-stale) and succeeds.
      // We also NEUTRALIZE any ambient `OPENAI_API_KEY` (a BYO GPT chat key the
      // owner never opted into for cloud embeddings) so this degraded state can
      // never silently start cloud-billing. When Ollama comes back, the next
      // reconnect forwards the real `ollama:*` env → `embed --stale` backfills
      // the NULL-stale chunks IN PLACE at the shared 768 width.
      return {
        GBRAIN_EMBEDDING_MODEL: OLLAMA_DOWN_LATENT_MODEL,
        GBRAIN_EMBEDDING_DIMENSIONS: String(embedder.dimensions),
        OPENAI_API_KEY: '',
      }
    }
  }
  return embedder.childEnv
}

/**
 * The keyless latent model the WRITE gate parks an unreachable-Ollama brain on
 * (see `resolveServeEmbeddingEnv`). `text-embedding-3-large` is the shared-width
 * default and requires a key, so with the key neutralized gbrain treats
 * embedding as unavailable and stores pages unembedded rather than failing.
 */
const OLLAMA_DOWN_LATENT_MODEL = 'openai:text-embedding-3-large'

export function resolveGbrainClientOptions(input: {
  owner_home: string
  env?: NodeJS.ProcessEnv
  /**
   * The owner's onboarding-captured OpenAI key (from the ApiKeyStore), if any,
   * resolved EAGERLY at composition. Baked into the static child env. Prefer
   * `resolveOpenAiKey` (lazy) for the live boot path — a key captured during
   * onboarding/admin lands AFTER the boot-time composition, so an eager read
   * here would miss it. Retained for backward-compat + tests that pass a
   * known-at-build key.
   */
  openaiApiKey?: string | undefined
  /**
   * LAZY resolver for the onboarding-captured OpenAI key, read at each
   * `gbrain serve` spawn (first memory op) rather than at composition. This is
   * what makes a key pasted AFTER process boot actually activate embeddings:
   * the composer can't see the key at boot (it's captured later, over the
   * already-running server), so it threads this thunk and the FIRST memory op
   * after the key lands spawns gbrain with the embedding seam. Takes precedence
   * over `openaiApiKey` for the embedder seam.
   */
  resolveOpenAiKey?: () => Promise<string | undefined>
  /**
   * The persisted column-width state of the brain at this `GBRAIN_HOME` (from
   * `resolveExistingBrainWidth`): `null`/omitted = FRESH; a number = a known
   * legacy width; `'unknown'` = initialized-but-unreadable (fail safe). Used by
   * the EAGER (no-lazy-resolver) path only — baked into the static child env at
   * composition. The LIVE boot path passes `resolveBrainWidth` instead so the
   * width is read per connect, not snapshotted here.
   */
  existingBrainDims?: BrainEmbeddingWidth
  /**
   * PER-CONNECT brain-width reader (the live boot path). When present, the
   * embedder seam is resolved ENTIRELY in `resolveDynamicEnv` at each spawn —
   * key AND width read fresh — so a legacy brain created/restored AFTER
   * composition but BEFORE the first connect is reconciled correctly (no stale
   * composition-time snapshot; the TOCTOU that `existingBrainDims` alone had).
   * Threaded together with `resolveOpenAiKey`; both should be the memoized
   * per-connect readers (`makePerConnectResolver`) so init + serve agree.
   */
  resolveBrainWidth?: () => BrainEmbeddingWidth
  /**
   * Local-Ollama reachability probe (injected in tests). Default the real
   * `probeOllamaHealth`. Used by `resolveDynamicEnv` to gate the WRITE-side
   * embed env: an unreachable Ollama is dropped to keyword+graph so `gbrain
   * put_page` doesn't fail hard — see `resolveServeEmbeddingEnv`.
   */
  probeOllamaReachable?: OllamaReachabilityProbe
}): GBrainStdioMcpClientOptions {
  const env = input.env ?? process.env
  const gbrainHome = join(input.owner_home, 'gbrain')

  // GBRAIN_HOME is the per-instance data boundary. Forward an
  // operator/systemd-provided GBRAIN_SOURCE / GBRAIN_BRAIN_ID when present.
  const childEnv: Record<string, string> = { GBRAIN_HOME: gbrainHome }

  const source =
    typeof env['GBRAIN_SOURCE'] === 'string' && env['GBRAIN_SOURCE']!.length > 0
      ? env['GBRAIN_SOURCE']!
      : 'default'

  // The live boot path threads a PER-CONNECT resolver for the key AND/OR the
  // brain width. In that mode the embedder seam (GBRAIN_EMBEDDING_* + provider
  // auth) is resolved ENTIRELY per connect in `resolveDynamicEnv` — key AND
  // width read fresh at spawn — so the static child env carries NO embedding
  // keys (GBRAIN_HOME only). This is what makes per-connect resolution
  // authoritative: there is no composition-time embedder snapshot that a stale
  // width could bake in and that an empty dynamic result couldn't later clear.
  //
  // CRUCIALLY, the per-connect path is enabled by EITHER a lazy key resolver OR
  // a per-connect width reader — NOT the key alone. `buildGBrainMemory` ALWAYS
  // threads `resolveBrainWidth` but only CONDITIONALLY a key resolver, so the
  // common default (local Ollama, no OpenAI key) MUST still take this path: else
  // `resolveDynamicEnv` wouldn't attach, the static env would bake a stale
  // composition-time 768, and the init guard (which always reconciles against
  // the live width) would drop to keyword+graph — init and serve disagreeing on
  // the same spawn (the exact TOCTOU this fix prevents).
  const perConnect = input.resolveOpenAiKey !== undefined || input.resolveBrainWidth !== undefined

  // EAGER path only (tests / backward-compat, NEITHER a lazy key nor a
  // per-connect width reader): bake the reconciled embedder into the static
  // child env at composition, using the composition-time `existingBrainDims`.
  // RA3 default is the local Ollama fallback; `null` (off, or a width-mismatched
  // drop) → keyword + graph.
  if (!perConnect) {
    const embedder = reconcileEmbedderToBrain(
      resolveEffectiveEmbedder({ env, openaiApiKey: input.openaiApiKey }),
      input.existingBrainDims ?? null,
    )
    if (embedder !== null) Object.assign(childEnv, embedder.childEnv)
  }

  const opts: GBrainStdioMcpClientOptions = { source, env: childEnv }
  if (typeof env['GBRAIN_BRAIN_ID'] === 'string' && env['GBRAIN_BRAIN_ID']!.length > 0) {
    opts.brainId = env['GBRAIN_BRAIN_ID']
  }

  // Per-connect embedder seam: resolve the onboarding key (if any) AND the brain
  // width at each `gbrain serve` SPAWN and produce the reconciled embedding env.
  // Resolving here — not at composition — is what lets a key pasted (or a legacy
  // brain created) after boot take effect at the next SPAWN, and is what keeps
  // this in lockstep with the init guard's own per-connect reconciliation. NOTE:
  // the stdio client holds ONE persistent `gbrain serve` child for the process,
  // so this runs at connect, not per memory op — activation is a per-spawn
  // boundary (process restart, or a reconnect after `close()` re-arms the init
  // guard), NOT mid-session. Absent key → the RA3 default (local Ollama
  // fallback), reconciled to the freshly-read brain width.
  if (perConnect) {
    const resolveOpenAiKey = input.resolveOpenAiKey
    const resolveBrainWidth = input.resolveBrainWidth
    const probeOllama = input.probeOllamaReachable ?? probeOllamaHealth
    opts.resolveDynamicEnv = async () => {
      // No key resolver → fall back to the eager static key (usually undefined →
      // the RA3 default local Ollama embedder).
      const key = resolveOpenAiKey !== undefined ? await resolveOpenAiKey() : input.openaiApiKey
      const width: BrainEmbeddingWidth = resolveBrainWidth ? resolveBrainWidth() : (input.existingBrainDims ?? null)
      const lazyEmbedder = reconcileEmbedderToBrain(
        resolveEffectiveEmbedder({ env, openaiApiKey: key }),
        width,
      )
      // Fail-soft WRITE gate: an unreachable local Ollama is dropped to
      // keyword+graph so `gbrain put_page` succeeds (unembedded, backfilled
      // later) instead of failing hard on every write.
      return resolveServeEmbeddingEnv(lazyEmbedder, probeOllama)
    }
  }

  return opts
}

export function buildGBrainMemory(input: {
  owner_home: string
  project_slug: string
  env?: NodeJS.ProcessEnv
  /**
   * The owner's onboarding-captured OpenAI key (resolved from the ApiKeyStore
   * by the composer). Present → GBrain initializes + serves with CLOUD OpenAI
   * embeddings; absent → RA3's default, the free local Ollama fallback (still
   * hybrid recall). Threading the key (not the
   * store) keeps this builder pure-ish + unit-testable.
   */
  openaiApiKey?: string | undefined
  /**
   * LAZY resolver for the onboarding-captured OpenAI key, read at each
   * `gbrain serve` SPAWN rather than at composition. The live boot path threads
   * this so a key captured during onboarding/admin — always AFTER the boot-time
   * composition — flips on cloud embeddings at the next SPAWN.
   *
   * ACTIVATION CADENCE (accurate as-built): the stdio client holds ONE
   * persistent `gbrain serve` child for the process, so this resolver runs at
   * connect time, NOT per memory op. A key stored BEFORE the child first
   * connects (the common onboarding case — the memory connection is lazy and
   * usually opens after the key is captured) activates on that first spawn. A
   * key stored AFTER the child is already connected activates on the next spawn
   * — a process restart, or a reconnect after `close()` (which re-arms the init
   * guard, so the one-time `gbrain embed --stale` backfill of pre-key pages runs
   * then). It does NOT hot-swap the live connection mid-session. Memoized below
   * so the init guard and the serve childEnv share ONE store read and agree on
   * the embedder selected at each spawn. Takes precedence over `openaiApiKey`.
   */
  resolveOpenAiKey?: () => Promise<string | undefined>
  /**
   * P9 — OPTIONAL sync-health observability sink. When present, the
   * `GBrainSyncHook` publishes a `gbrain_sync_state` snapshot at each latch /
   * success / defer point (built from `db` by the live wiring). Absent (the
   * default, and every test/legacy caller) → byte-for-byte today's behavior:
   * the hook simply skips the publish. Fail-soft is unaffected either way — the
   * publish is a wrapped, swallow-all side-observation.
   */
  syncStateSink?: GbrainSyncStateSink
}): GBrainMemoryWiring {
  const env = input.env ?? process.env

  const gbrainHome = join(input.owner_home, 'gbrain')

  // PER-CONNECT resolution. The init guard (`ensureInitialized`, below) and the
  // serve childEnv (`resolveDynamicEnv`) each read the onboarding key AND the
  // brain WIDTH, and the client runs the guard THEN composes the env within one
  // connect. They MUST observe the SAME key + width so (a) a `gbrain embed
  // --stale` backfill never disagrees with the serve embedder, and (b) a legacy
  // brain appearing AFTER composition is seen on the connect (not snapshotted at
  // boot). `resolveExistingBrainWidth` is read FRESH each connect through this
  // resolver, never captured once.
  const conn = makePerConnectResolver({
    ...(input.resolveOpenAiKey !== undefined ? { resolveOpenAiKey: input.resolveOpenAiKey } : {}),
    resolveBrainWidth: () => resolveExistingBrainWidth(gbrainHome),
  })
  const getKey = input.resolveOpenAiKey !== undefined ? conn.getKey : undefined

  // The advisory Ollama reachability probe is a once-per-client boot signal;
  // the init guard re-runs each (re)connect, so this latches after the first
  // run to keep an unreachable Ollama from adding its timeout to every retry.
  let ollamaProbed = false

  const opts = resolveGbrainClientOptions({
    owner_home: input.owner_home,
    env,
    resolveBrainWidth: conn.getBrainWidth,
    ...(input.openaiApiKey !== undefined ? { openaiApiKey: input.openaiApiKey } : {}),
    ...(getKey !== undefined ? { resolveOpenAiKey: getKey } : {}),
  })

  // Loud-not-silent: when an existing brain's width forces the free local
  // Ollama fallback OFF (a wider known legacy column, or an unreadable width),
  // semantic recall stays lexical for THIS brain until a key upgrades it in
  // place — surface that, don't let it be a silent no-op (RA3 / "dead in prod"
  // lesson). Only warn when the default WOULD otherwise configure the local
  // embedder (i.e. not for the explicit `off` opt-out). Advisory boot-time
  // read: a brain absent here (fresh install) simply doesn't warn; the
  // CORRECTNESS path is the per-connect reconciliation above.
  const bootBrainDims = resolveExistingBrainWidth(gbrainHome)
  // Use the EFFECTIVE EAGER embedder — factoring in a build-time `openaiApiKey`
  // exactly as the selection does at `ensureInitialized` (:507, `getKey() ??
  // input.openaiApiKey`). Reading `resolveEmbedderConfig(env)` alone ignored the
  // eager key, so a real key + a wide legacy brain (e.g. 3072) falsely warned
  // "recall stays keyword+graph, paste a key" even though OpenAI@<width> IS
  // selected and recall is NOT degraded. (A LAZY onboarding key isn't
  // sync-resolvable at this boot-time advisory read; the per-connect
  // reconciliation above is the correctness path.)
  const bootEmbedder = resolveEffectiveEmbedder({ env, openaiApiKey: input.openaiApiKey })
  if (
    bootBrainDims !== null &&
    bootEmbedder?.provider === 'ollama' &&
    reconcileEmbedderToBrain(bootEmbedder, bootBrainDims) === null
  ) {
    // A key upgrades in place ONLY if the persisted width is one OpenAI can
    // serve (1..3072 Matryoshka); a corrupt/out-of-range width can't be served
    // by either provider, so re-init is the only path.
    const keyCanUpgrade =
      typeof bootBrainDims === 'number' && isOpenAiEmbeddingWidthSupported(bootBrainDims)
    const detail =
      bootBrainDims === 'unknown'
        ? 'an unreadable column width (its config predates or omits ' +
          'embedding_dimensions); the local Ollama fallback (768-dim ' +
          'nomic-embed-text) is not injected, so gbrain honors the brain’s own ' +
          'persisted config and semantic recall stays keyword+graph. Re-init the ' +
          'brain to adopt the local fallback.'
        : `a ${bootBrainDims}-dim column (created under an earlier default); the ` +
          'local Ollama fallback (768-dim nomic-embed-text) cannot match it, so semantic ' +
          'recall stays keyword+graph for this brain. ' +
          (keyCanUpgrade
            ? 'Paste an OpenAI key in Settings to upgrade it in place at its existing width ' +
              '(no rebuild), or re-init the brain to use the local fallback.'
            : 'That width is outside the supported range, so re-init the brain to adopt the ' +
              'local fallback (or a supported width).')
    console.warn(`[gbrain-memory] project=${input.project_slug}: existing brain has ${detail}`)
  }

  // Reachability fix (dogfood 2026-06-28): the launchd/systemd SERVICE runs with
  // a narrow curated PATH that omits the bun global-bin dir where `gbrain` lives,
  // so a bare `gbrain` spawn fails → memory silently DISABLED. Resolve gbrain to
  // an ABSOLUTE path here (PATH-first, then probe `$BUN_INSTALL/bin` etc.) and
  // hand the stdio client that absolute command + a child PATH that carries the
  // gbrain dir AND a bun dir so the binary's `#!/usr/bin/env bun` shebang
  // re-resolves. This repairs ALREADY-INSTALLED services on a code-update +
  // restart with NO plist regeneration. `null` (gbrain genuinely absent) leaves
  // the bare-`gbrain` default in place so the existing fail-soft disabled path
  // (one-time warning + logged no-op) is preserved unchanged.
  const command = resolveGbrainCommand(env)
  if (command !== null) {
    opts.command = command
    opts.env = { ...(opts.env ?? {}), PATH: resolveGbrainChildPath({ command, env }) }
  }

  // Init guard: ensure the brain at GBRAIN_HOME is `gbrain init`'d BEFORE the
  // first `gbrain serve` spawn (ND1 root cause: serve hit an uninitialized
  // brain → "No brain configured" → Connection closed → every memory op
  // silently no-op'd). Idempotent + best-effort; runs once, lazily, at the
  // client's first connect. The embedder it inits against is the SAME effective
  // embedder the serve child uses, so the vector column matches the runtime.
  opts.ensureInitialized = async () => {
    // Start of a (re)connect: drop any key/width cached on a PRIOR connect so
    // this connect re-resolves BOTH fresh (picks up a key stored — or a legacy
    // brain created — since) — then every read WITHIN this connect (here + the
    // serve `resolveDynamicEnv`) shares that one resolution, so the backfill's
    // key+width and the serve embedder can't disagree.
    conn.resetForConnect()
    // Resolve the embedder at INIT time, not composition time: read the key +
    // brain width NOW (memoized — the same values the serve childEnv sees) so
    // the brain is init'd + `embed --stale`-backfilled against the key present
    // and reconciled to the width present at THIS spawn. Absent a lazy key
    // resolver, fall back to the eager static key / env opt-in.
    const key = getKey !== undefined ? await getKey() : input.openaiApiKey
    const embedder = reconcileEmbedderToBrain(
      resolveEffectiveEmbedder({ env, openaiApiKey: key }),
      conn.getBrainWidth(),
    )
    // The guard re-runs on every (re)connect, but the advisory Ollama probe is
    // a once-per-client boot signal — skip it after the first run so an
    // unreachable Ollama doesn't add its timeout to each reconnect. (Init +
    // backfill still run every time.)
    const skipOllamaProbe = ollamaProbed
    ollamaProbed = true
    await ensureBrainInitialized({
      gbrainHome,
      embedder,
      env,
      skipOllamaProbe,
      // Pass the resolved ABSOLUTE command so init spawns the same binary the
      // serve path does (init also carries the bun-resolvable child PATH).
      ...(command !== null ? { command } : {}),
    })
  }

  // 2026-06-10 (wow-hang-resilience) — loud startup probe. The client
  // connects lazily, so without this the first signal that gbrain is
  // missing arrives mid-onboarding as a sync failure (prod incident
  // t-33333333: every entity-page seed logged "Executable not found in
  // $PATH: gbrain"). One clear boot-time warning beats N runtime ones;
  // the lazy/fail-soft behaviour below is unchanged (now with a
  // latched one-time runtime failure instead of a per-op storm).
  if (command === null) {
    console.warn(
      `[gbrain-memory] project=${input.project_slug} WARNING: 'gbrain' executable not found ` +
        'on PATH or in any known install dir ($BUN_INSTALL/bin, ~/.bun/bin, /usr/local/bin, ' +
        '/opt/homebrew/bin, ~/.local/bin) — entity-page memory sync will be DISABLED (pages remain ' +
        'on disk; sync degrades to a one-time logged failure on first use). Install with: ' +
        'bun install -g github:garrytan/gbrain',
    )
  }

  const client = new GBrainStdioMcpClient(opts)
  const memoryStore = new GBrainMemoryStore(client)
  const syncHook = new GBrainSyncHook({
    memoryStore,
    gbrainMcp: client,
    ...(input.syncStateSink !== undefined ? { syncStateSink: input.syncStateSink } : {}),
  })

  // `client` stays a LOCAL — used to construct memoryStore + syncHook and for
  // the close closure, but never surfaced (see GBrainMemoryWiring).
  return {
    memoryStore,
    syncHook,
    close: () => client.close(),
  }
}
