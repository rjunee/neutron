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
 * Per-connect coherent OpenAI-key resolver. Wraps the lazy onboarding-key
 * thunk so the init guard and the serve childEnv, which each read the key
 * within one connect, observe the SAME value — a key landing between the two
 * reads can otherwise split them (init runs keyword/no-backfill while the same
 * spawn serves cloud embeddings). `getKey` memoizes the resolved key (found OR
 * miss, and swallows resolver errors → `undefined`) for the current connect;
 * `resetForConnect` clears it so the NEXT connect re-resolves fresh (preserving
 * no-restart activation: a key stored later is picked up on the next spawn). The
 * client re-runs `ensureInitialized` — which calls `resetForConnect` first — at
 * the start of every (re)connect.
 */
export function makePerConnectKeyResolver(resolveOpenAiKey: () => Promise<string | undefined>): {
  getKey: () => Promise<string | undefined>
  resetForConnect: () => void
} {
  let cachedKey: string | undefined
  let cacheValid = false
  return {
    getKey: async () => {
      if (cacheValid) return cachedKey
      const key = await resolveOpenAiKey().catch(() => undefined)
      cachedKey = key !== undefined && key.trim().length > 0 ? key : undefined
      cacheValid = true
      return cachedKey
    },
    resetForConnect: () => {
      cacheValid = false
      cachedKey = undefined
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
 * Resolve the effective embedder, preferring an OpenAI key the owner captured
 * through the onboarding optional-key offer ("paste a key to unlock cloud
 * embeddings"). That purpose-stated capture is the sanctioned embeddings
 * trigger — so a stored key alone flips on CLOUD semantic memory, no
 * `NEUTRON_EMBEDDINGS` env required (ND1: "wire it so gbrain flips to
 * semantic-embeddings mode when present"). With no stored key we fall back to
 * the env `resolveEmbedderConfig` path — RA3: that DEFAULTS to the free local
 * Ollama fallback (still hybrid recall, no billing), so a bare env
 * `OPENAI_API_KEY` (the GPT BYO adapter's key) still never silently bills for
 * CLOUD embeddings (that requires the explicit `NEUTRON_EMBEDDINGS=openai|auto`
 * opt-in). NOTE: the returned dims are the provider default — the caller
 * reconciles to an existing brain's column via `reconcileEmbedderToBrain`.
 */
export function resolveEffectiveEmbedder(input: {
  env: NodeJS.ProcessEnv
  openaiApiKey?: string | undefined
}): EmbedderConfig | null {
  const stored = input.openaiApiKey?.trim()
  if (stored !== undefined && stored.length > 0) {
    return buildOpenAiEmbedderConfig(stored)
  }
  return resolveEmbedderConfig(input.env)
}

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
   * legacy width; `'unknown'` = initialized-but-unreadable (fail safe). The
   * effective embedder is RECONCILED to it (`reconcileEmbedderToBrain`) — BOTH
   * the static child env and the lazy `resolveDynamicEnv` seam use the same
   * width, so a cross-version upgrade never sends `gbrain serve` a dimension
   * that mismatches the persisted column. Stays a plain param (no I/O here) to
   * keep this function pure; the read happens in `buildGBrainMemory`.
   */
  existingBrainDims?: BrainEmbeddingWidth
}): GBrainStdioMcpClientOptions {
  const env = input.env ?? process.env
  const gbrainHome = join(input.owner_home, 'gbrain')
  const existingBrainDims: BrainEmbeddingWidth = input.existingBrainDims ?? null

  // GBRAIN_HOME is the per-instance data boundary. Forward an
  // operator/systemd-provided GBRAIN_SOURCE / GBRAIN_BRAIN_ID when present.
  const childEnv: Record<string, string> = { GBRAIN_HOME: gbrainHome }

  // Embedding-store wiring (RA3: hybrid by default). Merge the embedder's child
  // env when an embedder is effective — by default the free local Ollama
  // fallback, or cloud OpenAI from an eager onboarding key / the env opt-in.
  // `null` (the explicit `NEUTRON_EMBEDDINGS=off` opt-out, OR a width-mismatched
  // local fallback dropped by `reconcileEmbedderToBrain`) leaves childEnv as
  // GBRAIN_HOME only → keyword + graph. The LAZY onboarding key
  // (`resolveOpenAiKey`) is merged later via `resolveDynamicEnv` at spawn time,
  // so it is intentionally NOT read here.
  const embedder = reconcileEmbedderToBrain(
    resolveEffectiveEmbedder({ env, openaiApiKey: input.openaiApiKey }),
    existingBrainDims,
  )
  if (embedder !== null) {
    Object.assign(childEnv, embedder.childEnv)
  }

  const source =
    typeof env['GBRAIN_SOURCE'] === 'string' && env['GBRAIN_SOURCE']!.length > 0
      ? env['GBRAIN_SOURCE']!
      : 'default'

  const opts: GBrainStdioMcpClientOptions = { source, env: childEnv }
  if (typeof env['GBRAIN_BRAIN_ID'] === 'string' && env['GBRAIN_BRAIN_ID']!.length > 0) {
    opts.brainId = env['GBRAIN_BRAIN_ID']
  }

  // Lazy embedder seam: resolve the onboarding key at each `gbrain serve` SPAWN
  // and merge the reconciled embedding env (GBRAIN_EMBEDDING_* + provider auth)
  // over the static child env. Resolving here — not at composition — is what
  // lets a key pasted after boot flip on cloud embeddings at the next SPAWN.
  // NOTE: the stdio client holds ONE persistent `gbrain serve` child for the
  // process, so `resolveDynamicEnv` runs at connect, not per memory op — a key
  // captured after that child is already connected activates on the next spawn
  // (process restart, or a reconnect after `close()` re-arms the init guard),
  // NOT mid-session over the live connection. Absent key → the RA3 default
  // (local Ollama fallback), reconciled to the brain width.
  if (input.resolveOpenAiKey !== undefined) {
    const resolveOpenAiKey = input.resolveOpenAiKey
    opts.resolveDynamicEnv = async () => {
      const key = await resolveOpenAiKey()
      const lazyEmbedder = reconcileEmbedderToBrain(
        resolveEffectiveEmbedder({ env, openaiApiKey: key }),
        existingBrainDims,
      )
      return lazyEmbedder?.childEnv ?? {}
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

  // PER-CONNECT key coherence. The init guard (`ensureInitialized`, below) and
  // the serve childEnv (`resolveDynamicEnv`) each read the key, and the client
  // runs the guard THEN composes the env within one connect. They MUST observe
  // the SAME key so a `gbrain embed --stale` backfill (gated on the key at init)
  // never disagrees with the embedder the serve child actually uses.
  const keyResolver =
    input.resolveOpenAiKey === undefined
      ? undefined
      : makePerConnectKeyResolver(input.resolveOpenAiKey)
  const getKey = keyResolver?.getKey

  // The advisory Ollama reachability probe is a once-per-client boot signal;
  // the init guard re-runs each (re)connect, so this latches after the first
  // run to keep an unreachable Ollama from adding its timeout to every retry.
  let ollamaProbed = false

  // Read the EXISTING brain's column-width state ONCE at boot (a fresh install
  // has no brain yet → null → no reconciliation, it will be init'd at the RA3
  // default width). This is the cross-version guard: a legacy brain created
  // under the pre-RA3 default (openai:3072), OR one whose width we can't read
  // ('unknown'), must not receive the new 768-dim local-fallback env, which
  // would mismatch its persisted `vector(N)` column.
  const gbrainHome = join(input.owner_home, 'gbrain')
  const existingBrainDims = resolveExistingBrainWidth(gbrainHome)

  const opts = resolveGbrainClientOptions({
    owner_home: input.owner_home,
    env,
    existingBrainDims,
    ...(input.openaiApiKey !== undefined ? { openaiApiKey: input.openaiApiKey } : {}),
    ...(getKey !== undefined ? { resolveOpenAiKey: getKey } : {}),
  })

  // Loud-not-silent: when an existing brain's width forces the free local
  // Ollama fallback OFF (a wider known legacy column, or an unreadable width),
  // semantic recall stays lexical for THIS brain until a key upgrades it in
  // place — surface that, don't let it be a silent no-op (RA3 / "dead in prod"
  // lesson). Only warn when the default WOULD otherwise configure the local
  // embedder (i.e. not for the explicit `off` opt-out).
  const defaultEnvEmbedder = resolveEmbedderConfig(env)
  if (
    existingBrainDims !== null &&
    defaultEnvEmbedder?.provider === 'ollama' &&
    reconcileEmbedderToBrain(defaultEnvEmbedder, existingBrainDims) === null
  ) {
    // A key upgrades in place ONLY if the persisted width is one OpenAI can
    // serve (1..3072 Matryoshka); a corrupt/out-of-range width can't be served
    // by either provider, so re-init is the only path.
    const keyCanUpgrade =
      typeof existingBrainDims === 'number' && isOpenAiEmbeddingWidthSupported(existingBrainDims)
    const detail =
      existingBrainDims === 'unknown'
        ? 'an unreadable column width (its config predates or omits ' +
          'embedding_dimensions); the local Ollama fallback (768-dim ' +
          'nomic-embed-text) is not injected, so gbrain honors the brain’s own ' +
          'persisted config and semantic recall stays keyword+graph. Re-init the ' +
          'brain to adopt the local fallback.'
        : `a ${existingBrainDims}-dim column (created under an earlier default); the ` +
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
    // Start of a (re)connect: drop any key cached on a PRIOR connect so this
    // connect re-resolves fresh (picks up a key stored since) — then every read
    // WITHIN this connect (here + the serve `resolveDynamicEnv`) shares that one
    // resolution, so the backfill's key and the serve embedder can't disagree.
    keyResolver?.resetForConnect()
    // Resolve the embedder at INIT time, not composition time: when a lazy key
    // resolver is threaded, read the key now (memoized — same value the serve
    // childEnv sees) so the brain is init'd + `embed --stale`-backfilled against
    // the key present at first spawn. Absent a lazy resolver, fall back to the
    // eager static key / env opt-in (unchanged behavior). Reconcile to the
    // existing brain width so a legacy column drives the backfill embedder
    // (and a fresh brain — dims null — inits at the RA3 default width).
    const key = getKey !== undefined ? await getKey() : input.openaiApiKey
    const embedder = reconcileEmbedderToBrain(
      resolveEffectiveEmbedder({ env, openaiApiKey: key }),
      existingBrainDims,
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
