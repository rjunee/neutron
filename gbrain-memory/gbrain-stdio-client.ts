/**
 * @neutronai/gbrain-memory — production GBrain MCP transport (stdio).
 *
 * Spawns `gbrain serve` as a child process and speaks MCP over stdio — the
 * shape the per-instance runtime wires (the GBrain CLI is installed globally via
 * `bun install -g github:garrytan/gbrain`, or vendored at instance-provision
 * time). This is the real MCP transport the prior in-tree memory adapter only
 * ever sketched as an interface ("the actual client lands in P1").
 *
 * The per-instance systemd unit sets `GBRAIN_BRAIN_ID` (which brain) + optionally
 * `GBRAIN_SOURCE` (project scope — MM ships single-source `default`; project
 * partitioning via GBrain `source` comes in M2.6) before launch; we forward
 * those through the child env.
 *
 * **Version-notice (notify mode).** GBrain emits `UPGRADE_AVAILABLE <cur>
 * <latest>` on the child's stderr on a minor/major upstream bump. We pipe
 * stderr into a `GBrainVersionNotice` so the owner's admin "Memory" tab can
 * surface a one-line nudge — never a silent auto-upgrade inside an instance
 * (see `version-notice.ts`).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  GBrainUnavailableError,
  isGbrainBinaryMissingError,
} from './memory-store.ts'
import type { McpClient } from './mcp-client.ts'
import {
  GBrainVersionNotice,
  type GBrainUpgradeMode,
  type GBrainUpgradeNotice,
} from './version-notice.ts'

export interface GBrainStdioMcpClientOptions {
  /** Binary to spawn. Default `gbrain` (resolved from PATH / global install). */
  command?: string
  /** Args. Default `['serve']` (stdio MCP). */
  args?: string[]
  /** `GBRAIN_BRAIN_ID` — which per-instance brain to open. */
  brainId?: string
  /** `GBRAIN_SOURCE` — project scope. MM ships `default` (single source). */
  source?: string
  /** Extra child env (merged over `getDefaultEnvironment()`). */
  env?: Record<string, string>
  /**
   * Extra child env resolved LAZILY, at each `gbrain serve` spawn (first memory
   * op), and merged OVER the static `env`. This is the seam that lets an
   * embedder opted in AFTER process boot still activate: the onboarding/admin
   * OpenAI key is captured over the already-running server (after the boot-time
   * composition), so the static `env` baked at boot can't see it. The composer
   * passes a resolver that reads the key from the `ApiKeyStore` at connect time,
   * so the first memory op AFTER the key lands spawns gbrain with the embedding
   * seam (`GBRAIN_EMBEDDING_*` + `OPENAI_API_KEY`) — exactly the "flips on your
   * next turn" the onboarding offer promises. Fail-soft: a throwing resolver is
   * logged and ignored (keyword + graph), never blocking the connect.
   */
  resolveDynamicEnv?: () => Promise<Record<string, string>>
  /** Working dir for the child. */
  cwd?: string
  /** Upgrade-notice mode. Default `notify` — Neutron never auto-upgrades. */
  upgradeMode?: GBrainUpgradeMode
  clientName?: string
  clientVersion?: string
  /**
   * Idempotent init guard, awaited ONCE before the first `gbrain serve` spawn
   * so serve never hits an uninitialized brain ("No brain configured. Run:
   * gbrain init" → exit → `MCP error -32000: Connection closed`). Provided by
   * `buildGBrainMemory`, which closes over the resolved `GBRAIN_HOME` +
   * embedder. Best-effort by contract: it must never throw (it returns/logs a
   * status), so a failed init degrades to the existing lazy/fail-soft path
   * rather than blocking the connect.
   */
  ensureInitialized?: () => Promise<void>
}

/**
 * The embedding-selector env keys that determine the `content_chunks` vector
 * column's model + width. These are OWNED by the resolved embedder seam
 * (`opts.env` static childEnv + `opts.resolveDynamicEnv()`): they must reach the
 * `gbrain serve` child ONLY when our reconciliation intends them. We strip any
 * value inherited from the ambient base env first, so the composer's fail-safe
 * (an embedder dropped to keyword+graph → NO embedding env) can't be silently
 * defeated by an ambient `GBRAIN_EMBEDDING_DIMENSIONS` that would mismatch an
 * existing brain's column (the whole point of `reconcileEmbedderToBrain`). The
 * MCP SDK's `getDefaultEnvironment()` already allowlists inherited vars (these
 * aren't on it), so this is defense-in-depth that makes the guarantee
 * self-contained rather than dependent on that allowlist.
 */
const EMBEDDER_OWNED_ENV_KEYS = ['GBRAIN_EMBEDDING_MODEL', 'GBRAIN_EMBEDDING_DIMENSIONS'] as const

/**
 * Build the `gbrain serve` child env, merging (in precedence order) the MCP SDK
 * defaults (with embedder-owned keys stripped — see `EMBEDDER_OWNED_ENV_KEYS`),
 * the static `opts.env` (baked at composition), the LAZILY-resolved
 * `opts.resolveDynamicEnv()` (the embedder seam for a key captured after boot),
 * then the explicit `GBRAIN_BRAIN_ID` / `GBRAIN_SOURCE` scoping. Extracted (and
 * exported) so the boot-time-vs-connect-time merge is unit-testable without a
 * live spawn. Fail-soft: a throwing dynamic resolver degrades to keyword+graph.
 */
export async function composeGbrainChildEnv(
  opts: Pick<GBrainStdioMcpClientOptions, 'env' | 'brainId' | 'source' | 'resolveDynamicEnv'>,
  base: Record<string, string>,
): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...base }
  // The embedder seam is the SOLE authority on the embedding column selectors;
  // never inherit them ambiently (would defeat a reconciled keyword+graph drop).
  for (const key of EMBEDDER_OWNED_ENV_KEYS) delete env[key]
  if (opts.env !== undefined) Object.assign(env, opts.env)
  if (opts.resolveDynamicEnv !== undefined) {
    try {
      Object.assign(env, await opts.resolveDynamicEnv())
    } catch (err) {
      console.warn(
        '[gbrain-stdio-client] dynamic env resolver threw (continuing keyword+graph): ' +
          (err instanceof Error ? err.message : String(err)),
      )
    }
  }
  if (opts.brainId !== undefined) env['GBRAIN_BRAIN_ID'] = opts.brainId
  if (opts.source !== undefined) env['GBRAIN_SOURCE'] = opts.source
  return env
}

export class GBrainStdioMcpClient implements McpClient {
  private readonly opts: GBrainStdioMcpClientOptions
  private client: Client | null = null
  private connecting: Promise<Client> | null = null
  /**
   * 2026-06-10 (wow-hang-resilience) — latched binary-missing detail.
   * Non-null once a connect attempt failed because the `gbrain` binary
   * is absent (Bun "Executable not found in $PATH" / spawn ENOENT).
   * Every subsequent `call(...)` throws `GBrainUnavailableError`
   * immediately — no re-spawn attempt, no per-op log storm. The
   * condition is permanent for the process lifetime (installing the
   * binary requires an instance restart anyway).
   */
  private unavailableDetail: string | null = null
  /**
   * Latched once the init guard (`opts.ensureInitialized`) has run for the
   * CURRENT connection, so the idempotent `gbrain init` is attempted at most
   * once per `gbrain serve` session. RE-ARMED on `close()` so a teardown +
   * reconnect runs the guard again — this is what lets an OpenAI key captured
   * AFTER the first connection trigger its one-time `gbrain embed --stale`
   * backfill of pre-key pages on the next spawn (the guard body is idempotent:
   * `init` is skipped when the brain exists and the backfill is marker-gated,
   * so re-running per session is cheap + safe).
   */
  private initGuardDone = false
  /** The latest GBrain upstream upgrade notice, fed from the child's stderr. */
  readonly versionNotice: GBrainVersionNotice

  constructor(opts: GBrainStdioMcpClientOptions = {}) {
    this.opts = opts
    this.versionNotice = new GBrainVersionNotice(opts.upgradeMode ?? 'notify')
  }

  private async ensureConnected(): Promise<Client> {
    if (this.unavailableDetail !== null) {
      throw new GBrainUnavailableError(this.unavailableDetail)
    }
    if (this.client !== null) return this.client
    if (this.connecting !== null) return this.connecting
    this.connecting = (async () => {
      // Init guard: ensure the brain exists BEFORE spawning `gbrain serve`.
      // Idempotent + best-effort (never throws), so a fresh brain is created
      // exactly once and a failed init degrades to the fail-soft path below
      // rather than blocking the connect. Runs at most once per client.
      if (this.opts.ensureInitialized !== undefined && !this.initGuardDone) {
        this.initGuardDone = true
        try {
          await this.opts.ensureInitialized()
        } catch (err) {
          console.warn(
            '[gbrain-stdio-client] init guard threw (continuing fail-soft): ' +
              (err instanceof Error ? err.message : String(err)),
          )
        }
      }
      const env = await composeGbrainChildEnv(this.opts, getDefaultEnvironment())
      const transport = new StdioClientTransport({
        command: this.opts.command ?? 'gbrain',
        args: this.opts.args ?? ['serve'],
        env,
        stderr: 'pipe',
        ...(this.opts.cwd !== undefined ? { cwd: this.opts.cwd } : {}),
      })
      const client = new Client(
        {
          name: this.opts.clientName ?? 'neutron-gbrain-memory',
          version: this.opts.clientVersion ?? '0.0.0',
        },
        { capabilities: {} },
      )
      try {
        await client.connect(transport)
      } catch (err) {
        // Binary-missing is permanent for this process — latch it and
        // log ONCE so downstream per-op failures degrade to a cheap
        // tagged throw instead of re-spawning + spamming per page/edge.
        if (isGbrainBinaryMissingError(err)) {
          const detail = err instanceof Error ? err.message : String(err)
          this.unavailableDetail = detail
          console.error(
            `[gbrain-stdio-client] '${this.opts.command ?? 'gbrain'}' could not be spawned (${detail}) — ` +
              'GBrain memory sync DISABLED for this process. Entity pages remain on disk; ' +
              'install gbrain (bun install -g github:garrytan/gbrain) and restart the owner to re-enable. ' +
              'Further calls fail fast without re-spawning.',
          )
          throw new GBrainUnavailableError(detail)
        }
        throw err
      }
      const errStream = transport.stderr as { on?: (e: string, cb: (chunk: unknown) => void) => void } | null
      if (errStream !== null && typeof errStream.on === 'function') {
        errStream.on('data', (chunk: unknown) => {
          this.versionNotice.ingestStderr(String(chunk))
        })
      }
      this.client = client
      return client
    })()
    try {
      return await this.connecting
    } finally {
      this.connecting = null
      // Re-arm the init guard if this attempt did NOT establish a live client
      // (a transient connect failure, a thrown compose, etc.). `initGuardDone`
      // is latched optimistically BEFORE the spawn, so without this a failed
      // first connect would leave it stuck `true` with no live child — the next
      // attempt would then skip the guard (and its per-connect key re-resolve),
      // so a key stored between a failed spawn and the retry would never
      // activate. On SUCCESS (`this.client` set) the guard stays latched, so a
      // live session never re-runs it. (Binary-missing latches
      // `unavailableDetail`, so future calls fast-fail regardless.)
      if (this.client === null) this.initGuardDone = false
    }
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.ensureConnected()
    const res = await client.callTool({ name, arguments: args })
    return parseToolResult(res)
  }

  /** The latest GBrain upgrade notice, or null if up to date / mode off. */
  upgrade(): GBrainUpgradeNotice | null {
    return this.versionNotice.current()
  }

  async close(): Promise<void> {
    if (this.client !== null) {
      await this.client.close()
      this.client = null
    }
    // Re-arm the init guard so the NEXT connect re-runs it. A key captured
    // after this session (onboarding/admin) then triggers its marker-gated
    // `gbrain embed --stale` backfill on the reconnect — without this, the
    // reconnect would activate the embedder env (via `resolveDynamicEnv`) but
    // never backfill the pages written before the key existed. Not gated on a
    // prior client: a connect that failed before completing (leaving the guard
    // latched but no live child) must also re-arm so the next attempt retries.
    this.initGuardDone = false
  }
}

/**
 * Normalise an MCP `CallToolResult` into the tool's payload. GBrain returns
 * `{ content: [{ type: 'text', text: <json> }], isError? }`; we JSON-parse the
 * text part (falling back to the raw string). An `isError` result throws so
 * the `GBrainSyncHook`'s best-effort try/catch + `logFailure` fire.
 */
function parseToolResult(res: unknown): unknown {
  const r = (res ?? {}) as Record<string, unknown>
  const content = r['content']
  let payload: unknown = res
  if (Array.isArray(content)) {
    const textPart = content.find(
      (c) =>
        c !== null &&
        typeof c === 'object' &&
        (c as Record<string, unknown>)['type'] === 'text' &&
        typeof (c as Record<string, unknown>)['text'] === 'string',
    ) as { text: string } | undefined
    if (textPart !== undefined) {
      try {
        payload = JSON.parse(textPart.text)
      } catch {
        payload = textPart.text
      }
    }
  } else if (r['structuredContent'] !== undefined) {
    payload = r['structuredContent']
  }
  if (r['isError'] === true) {
    const msg =
      typeof payload === 'string' ? payload : JSON.stringify(payload)
    throw new Error(`gbrain MCP tool error: ${msg}`)
  }
  return payload
}
