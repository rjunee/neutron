/**
 * @neutronai/gateway/realmode-composer — per-instance GBrain memory wiring.
 *
 * Builds the three live GBrain seams the composer threads into the boot path,
 * so GBrain is the genuine production memory store (not a built-but-unwired
 * layer):
 *
 *   1. `client`      — `GBrainStdioMcpClient`, the stdio MCP transport that
 *      spawns `gbrain serve` scoped to THIS instance's brain.
 *   2. `memoryStore` — `GBrainMemoryStore` over that client. Threaded into the
 *      admin "Memory" tab (`app-admin-surface.ts`) so browse reads real pages.
 *   3. `syncHook`    — `GBrainSyncHook` over the store + client. Threaded into
 *      the entity-writer's `syncHook` seam (today via the history-import
 *      populator's `importGbrainSyncHook`) so entity writes fan out to the
 *      GBrain page store + typed-edge graph.
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
  type MemoryStore,
  type EmbedderConfig,
  resolveEmbedderConfig,
  buildOpenAiEmbedderConfig,
  ensureBrainInitialized,
  resolveGbrainCommand,
  resolveGbrainChildPath,
} from '../../gbrain-memory/index.ts'
import type { SyncHook } from '../../runtime/entity-writer.ts'

export interface GBrainMemoryWiring {
  /** The live stdio MCP transport (spawns `gbrain serve` lazily). */
  client: GBrainStdioMcpClient
  /** Admin "Memory" tab read/write surface. */
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
 * operator-provided `GBRAIN_BRAIN_ID` passthrough, and the **conditional**
 * embedding-store wiring.
 *
 * **Conditional embedding store (opt-in).** When — and only when — an embedder
 * is opted into via `NEUTRON_EMBEDDINGS` (see `resolveEmbedderConfig`), its
 * `GBRAIN_EMBEDDING_*` + provider-auth env is merged into the child so
 * `gbrain serve` initializes its embedding/vector store. With no embedder
 * configured (the default), the child env is byte-for-byte today's
 * keyword-+-graph wiring — provisioning and search are unaffected.
 */
/**
 * Resolve the effective embedder, preferring an OpenAI key the owner captured
 * through the onboarding optional-key offer ("paste a key to unlock cloud
 * embeddings"). That purpose-stated capture is the sanctioned embeddings
 * trigger — so a stored key alone flips on semantic memory, no
 * `NEUTRON_EMBEDDINGS` env required (ND1: "wire it so gbrain flips to
 * semantic-embeddings mode when present"). With no stored key we fall back to
 * the env `NEUTRON_EMBEDDINGS` opt-in path (`resolveEmbedderConfig`), which
 * stays byte-for-byte unchanged so a bare env `OPENAI_API_KEY` (the GPT BYO
 * adapter's key) never silently bills for embeddings.
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
  /** The owner's onboarding-captured OpenAI key (from the ApiKeyStore), if any. */
  openaiApiKey?: string | undefined
}): GBrainStdioMcpClientOptions {
  const env = input.env ?? process.env
  const gbrainHome = join(input.owner_home, 'gbrain')

  // GBRAIN_HOME is the per-instance data boundary. Forward an
  // operator/systemd-provided GBRAIN_SOURCE / GBRAIN_BRAIN_ID when present.
  const childEnv: Record<string, string> = { GBRAIN_HOME: gbrainHome }

  // Conditional embedding-store init: merge the embedder's child env ONLY when
  // an embedder is opted in (stored onboarding key, or the env opt-in). `null`
  // (the default) leaves childEnv untouched, so gbrain serve computes no
  // embeddings — keyword + graph exactly as the default requires.
  const embedder = resolveEffectiveEmbedder({ env, openaiApiKey: input.openaiApiKey })
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
  return opts
}

export function buildGBrainMemory(input: {
  owner_home: string
  project_slug: string
  env?: NodeJS.ProcessEnv
  /**
   * The owner's onboarding-captured OpenAI key (resolved from the ApiKeyStore
   * by the composer). Present → GBrain initializes + serves with semantic
   * embeddings; absent → keyword + graph default. Threading the key (not the
   * store) keeps this builder pure-ish + unit-testable.
   */
  openaiApiKey?: string | undefined
}): GBrainMemoryWiring {
  const env = input.env ?? process.env
  const opts = resolveGbrainClientOptions({
    owner_home: input.owner_home,
    env,
    ...(input.openaiApiKey !== undefined ? { openaiApiKey: input.openaiApiKey } : {}),
  })

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
  const gbrainHome = join(input.owner_home, 'gbrain')
  const embedder = resolveEffectiveEmbedder({ env, openaiApiKey: input.openaiApiKey })
  opts.ensureInitialized = async () => {
    await ensureBrainInitialized({
      gbrainHome,
      embedder,
      env,
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
  const syncHook = new GBrainSyncHook({ memoryStore, gbrainMcp: client })

  return {
    client,
    memoryStore,
    syncHook,
    close: () => client.close(),
  }
}
