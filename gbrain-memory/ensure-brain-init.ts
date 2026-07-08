/**
 * @neutronai/gbrain-memory — idempotent brain initialization guard.
 *
 * THE production memory bug (ND1, dogfood 2026-06-27 §2): the realmode composer
 * spawns `gbrain serve` against a brain that was **never `gbrain init`'d**, so
 * `serve` prints "No brain configured. Run: gbrain init" and exits → every MCP
 * op fails `MCP error -32000: Connection closed` → `gbrain_search`, the scribe
 * write fan-out, and the admin "Memory" tab all silently no-op. Recall only
 * *appeared* to work because the agent fell back to Claude Code file-memory.
 * The live install was affected too (`GBRAIN_HOME=… gbrain list` → "No brain
 * configured"). CI missed it because the test harness boots an in-process
 * PGLite engine that never exercises the real `init`→`serve` path.
 *
 * This module closes the gap: before the FIRST `gbrain serve` spawn, ensure the
 * brain at `GBRAIN_HOME` is initialized. It is **idempotent** — a no-op once a
 * brain exists (detected via `<GBRAIN_HOME>/.gbrain/config.json`). Keyword +
 * typed-edge graph search work with NO embedder; semantic embeddings turn on
 * only when an OpenAI key is present.
 *
 * **Embeddings-ready by construction (the key design decision).** We always
 * init the PGLite brain with the OpenAI embedding model + dims (3072) so the
 * `content_chunks` vector column is OpenAI-compatible *from creation* — EVEN
 * when no key is present. Verified end-to-end: with no key, `gbrain` computes no
 * embeddings and `gbrain serve` answers `put_page` + keyword `search` exactly as
 * the default keyword+graph mode requires. When the owner later adds an OpenAI
 * key (the onboarding optional-key offer → secrets store), embeddings flip on
 * with **NO schema rebuild** and a one-time `gbrain embed --stale` backfill of
 * any pages written before the key existed. A `--no-embedding` brain could NOT
 * upgrade in place: its default column is 1280-dim and OpenAI's
 * `text-embedding-3-large` rejects 1280-dim vectors (allowed: 256/512/768/1024/
 * 1536/3072). The init dims/model track an explicitly-configured embedder when
 * one is set via `NEUTRON_EMBEDDINGS` (e.g. ollama 768), so an operator who
 * opts into a different provider gets a matching column.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { EmbedderConfig } from './embedder-config.ts'
import { isGbrainBinaryMissingError } from './memory-store.ts'
import { type CommandRunner, bunCommandRunner } from './command-runner.ts'
import { resolveGbrainChildPath } from './resolve-gbrain-command.ts'

/** OpenAI default the latent column is sized for (upgrade-without-rebuild). */
const DEFAULT_EMBEDDING_MODEL = 'openai:text-embedding-3-large'
const DEFAULT_EMBEDDING_DIMENSIONS = 3072

/** Marker file (under the brain dir) recording a completed embeddings backfill. */
const BACKFILL_MARKER = '.neutron-embeddings-backfilled'

export interface EnsureBrainInitInput {
  /** The per-instance `GBRAIN_HOME` (the data boundary; `.gbrain/` lives under it). */
  gbrainHome: string
  /**
   * The resolved embedder (from `resolveEmbedderConfig`), or `null` when no
   * embedder is configured. `null` still inits an OpenAI-ready column so a
   * later key upgrades in place; a non-null embedder pins the column to that
   * provider's model + dims and (when its `childEnv` carries the provider key)
   * triggers a one-time backfill of pre-existing pages.
   */
  embedder: EmbedderConfig | null
  /** Binary to invoke. Default `gbrain` (resolved from PATH / global install). */
  command?: string
  /** Process env to inherit for the spawned `gbrain` child. */
  env?: NodeJS.ProcessEnv
  /** Command runner seam (injected in tests). Default `bunCommandRunner()`. */
  runner?: CommandRunner
  /** Structured log sink (injected in tests). Default `console`. */
  logger?: { warn: (msg: string) => void; info: (msg: string) => void }
}

export type EnsureBrainInitStatus =
  | 'already-initialized'
  | 'initialized'
  | 'embeddings-backfilled'
  | 'binary-missing'
  | 'init-failed'

export interface EnsureBrainInitResult {
  status: EnsureBrainInitStatus
  /** Human-readable detail for logs / the delivery transcript. */
  detail: string
}

/** `<GBRAIN_HOME>/.gbrain/config.json` — written by `gbrain init`, absent before. */
export function brainConfigPath(gbrainHome: string): string {
  return join(gbrainHome, '.gbrain', 'config.json')
}

/** True once `gbrain init` has run against this `GBRAIN_HOME`. */
export function isBrainInitialized(gbrainHome: string): boolean {
  return existsSync(brainConfigPath(gbrainHome))
}

/**
 * The (model, dimensions) the brain's vector column is sized for. Tracks an
 * explicitly-configured embedder; otherwise the OpenAI default so an
 * onboarding-captured key upgrades the brain in place.
 */
export function resolveInitEmbeddingTarget(embedder: EmbedderConfig | null): {
  model: string
  dimensions: number
} {
  if (embedder !== null) {
    return { model: embedder.model, dimensions: embedder.dimensions }
  }
  return { model: DEFAULT_EMBEDDING_MODEL, dimensions: DEFAULT_EMBEDDING_DIMENSIONS }
}

/**
 * Ensure the brain at `gbrainHome` is initialized and (when a provider key is
 * present) its embeddings are backfilled. Idempotent + fail-soft: a missing
 * `gbrain` binary or a failed `init` returns a status rather than throwing, so
 * the caller degrades to the same logged no-op the pre-existing lazy/fail-soft
 * contract already guaranteed — it never crashes a chat turn.
 */
export async function ensureBrainInitialized(
  input: EnsureBrainInitInput,
): Promise<EnsureBrainInitResult> {
  const command = input.command ?? 'gbrain'
  const runner = input.runner ?? bunCommandRunner()
  const logger = input.logger ?? {
    warn: (m: string) => console.warn(m),
    info: (m: string) => console.info(m),
  }
  const childEnv: Record<string, string> = { GBRAIN_HOME: input.gbrainHome }
  // Provider auth (e.g. OPENAI_API_KEY) the embed backfill needs lives in the
  // embedder's childEnv; merge it so `gbrain embed` can reach the provider.
  if (input.embedder !== null) Object.assign(childEnv, input.embedder.childEnv)
  // Carry a bun-resolvable PATH into the init child so `gbrain`'s
  // `#!/usr/bin/env bun` shebang re-resolves even under the service's narrow
  // PATH (the same reachability fix the serve spawn uses). Without this, the
  // absolute `command` execs but its shebang can't find `bun` and init fails →
  // brain never created → memory silently disabled.
  childEnv['PATH'] = resolveGbrainChildPath({
    command: command === 'gbrain' ? null : command,
    env: input.env ?? process.env,
  })

  const target = resolveInitEmbeddingTarget(input.embedder)

  if (!isBrainInitialized(input.gbrainHome)) {
    // `--skip-embed-check` keeps boot fast + non-blocking (no live test-embed
    // network call); `--non-interactive` forbids any TTY picker. The column is
    // created at `target.dimensions`; embeddings are only ever COMPUTED when a
    // key is present at serve/embed time.
    const initArgs = [
      'init',
      '--pglite',
      '--non-interactive',
      '--skip-embed-check',
      '--embedding-model',
      target.model,
      '--embedding-dimensions',
      String(target.dimensions),
    ]
    let res: { code: number; stdout: string; stderr: string }
    try {
      res = await runner.run(command, initArgs, { timeoutMs: 120_000, env: childEnv })
    } catch (err) {
      // `Bun.spawn` throws synchronously when the binary is absent
      // ("Executable not found in $PATH: gbrain" / spawn ENOENT). Degrade to
      // the existing fail-soft path — the stdio client latches the same
      // condition on connect and disables sync with ONE warning.
      const detail = err instanceof Error ? err.message : String(err)
      if (isGbrainBinaryMissingError(err)) {
        logger.warn(
          `[gbrain-memory] '${command}' could not be spawned for init — memory DISABLED ` +
            '(pages stay on disk; sync degrades to a logged no-op). ' +
            'Install: bun install -g github:garrytan/gbrain',
        )
        return { status: 'binary-missing', detail: detail.slice(0, 200) }
      }
      logger.warn(
        `[gbrain-memory] 'gbrain init' threw at GBRAIN_HOME=${input.gbrainHome} — ` +
          `memory will degrade to logged no-ops. err: ${detail.slice(0, 200)}`,
      )
      return { status: 'init-failed', detail: detail.slice(0, 200) }
    }
    if (res.code !== 0) {
      logger.warn(
        `[gbrain-memory] 'gbrain init' failed (code ${res.code}) at GBRAIN_HOME=${input.gbrainHome} — ` +
          `memory will degrade to logged no-ops. stderr: ${res.stderr.trim().slice(0, 200)}`,
      )
      return { status: 'init-failed', detail: res.stderr.trim().slice(0, 200) }
    }
    logger.info(
      `[gbrain-memory] initialized brain at GBRAIN_HOME=${input.gbrainHome} ` +
        `(keyword+graph; column ${target.model} ${target.dimensions}d, embeddings ` +
        `${input.embedder !== null ? 'ENABLED' : 'latent — add an OpenAI key to turn on'}).`,
    )
    // Fresh brain has no pre-key pages, so no backfill is needed even with a key.
    return { status: 'initialized', detail: `${target.model} ${target.dimensions}d` }
  }

  // Already initialized. The only remaining work is a one-time embeddings
  // backfill when a provider key is now present but pages predate it.
  const hasProviderKey =
    input.embedder !== null &&
    typeof input.embedder.childEnv['OPENAI_API_KEY'] === 'string' &&
    input.embedder.childEnv['OPENAI_API_KEY'].length > 0
  if (hasProviderKey && !existsSync(join(input.gbrainHome, '.gbrain', BACKFILL_MARKER))) {
    // `embed --stale` only embeds pages missing/with-outdated vectors, so this
    // is cheap when there is nothing to backfill (fresh-with-key) and bounded
    // otherwise. Best-effort: a failure must never block serving.
    const res = await runner.run(command, ['embed', '--stale'], { timeoutMs: 120_000, env: childEnv })
    if (res.code === 0) {
      // Drop the marker so subsequent boots skip the backfill scan. We can't
      // write files from the runner seam, so do it directly — best-effort.
      try {
        await Bun.write(join(input.gbrainHome, '.gbrain', BACKFILL_MARKER), new Date().toISOString())
      } catch {
        /* marker is an optimization; a missing marker only re-scans (idempotent). */
      }
      logger.info(
        `[gbrain-memory] embeddings backfill complete at GBRAIN_HOME=${input.gbrainHome} — ` +
          'semantic recall active.',
      )
      return { status: 'embeddings-backfilled', detail: 'embed --stale ok' }
    }
    logger.warn(
      `[gbrain-memory] 'gbrain embed --stale' failed (code ${res.code}) — keyword+graph recall ` +
        `still works; semantic embeddings will populate on next write. stderr: ${res.stderr.trim().slice(0, 160)}`,
    )
  }
  return { status: 'already-initialized', detail: brainConfigPath(input.gbrainHome) }
}
