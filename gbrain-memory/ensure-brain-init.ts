/**
 * @neutronai/gbrain-memory — idempotent brain initialization guard.
 *
 * THE production memory bug (ND1, dogfood 2026-06-27 §2): the realmode composer
 * spawns `gbrain serve` against a brain that was **never `gbrain init`'d**, so
 * `serve` prints "No brain configured. Run: gbrain init" and exits → every MCP
 * op fails `MCP error -32000: Connection closed` → `memory_search`, the scribe
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
 * **Embeddings-ready by construction (the key design decision).** We init the
 * PGLite brain against whatever embedder is effectively configured — by
 * DEFAULT (RA3, 2026-07) that is the local Ollama fallback (768 dims,
 * `resolveEmbedderConfig`'s unset case), so `content_chunks` is
 * semantic-ready *from creation* with no key and no operator config. EVERY
 * fresh-brain lineage — local fallback, onboarding key, explicit
 * `NEUTRON_EMBEDDINGS=openai`, AND the latent column of an `off` brain — uses
 * the SAME universal 768-dim width, so init-time and every serve-time width
 * are structurally identical and a key pasted later can never mismatch the
 * column. When the owner adds an OpenAI key (the onboarding optional-key
 * offer → secrets store), embeddings flip to cloud with **NO schema rebuild**:
 * OpenAI's `text-embedding-3-large` truncates to 768 via Matryoshka, so a
 * one-time `gbrain embed --stale` backfill writes into the SAME `vector(768)`
 * column. A `--no-embedding` brain could NOT upgrade in place (its default
 * column is 1280-dim). The init dims/model always track the EFFECTIVELY
 * -configured embedder (`resolveInitEmbeddingTarget`); the ONLY non-768
 * columns are LEGACY brains created under the pre-RA3 3072 default, reconciled
 * to their persisted width at boot (`build-gbrain-memory.ts`).
 *
 * **Fail-soft Ollama reachability (RA3).** Because the default now
 * optimistically configures the local Ollama fallback, `ensureBrainInitialized`
 * also probes it once at boot (`probeOllamaHealth`) and logs a clear
 * degradation warning when it's unreachable or `nomic-embed-text` isn't
 * pulled — advisory only, it never changes the embedder or column sizing.
 * GBrain's own `hybridSearch` already degrades a failed per-query embed to
 * keyword-only, so an absent Ollama never crashes recall; this probe just
 * makes the degraded state OBSERVABLE instead of a silent mystery.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { EmbedderConfig } from './embedder-config.ts'
import { probeOllamaHealth, redactUrlUserinfo } from './embedder-config.ts'
import { isGbrainBinaryMissingError } from './memory-store.ts'
import { type CommandRunner, bunCommandRunner } from './command-runner.ts'
import { resolveGbrainChildPath } from './resolve-gbrain-command.ts'

/**
 * The latent column an embedder-less (`off`) brain is pre-sized at so a later
 * key upgrades it in place WITHOUT a rebuild. RA3: this is the ONE universal
 * fresh-brain width (768) — identical to the local Ollama fallback and the
 * onboarding-key path — so an `off`→key transition can never mismatch the
 * column. OpenAI `text-embedding-3-large` truncates to 768 via Matryoshka, so
 * the model is still the OpenAI one (a `--no-embedding` 1280-dim brain could
 * not upgrade at all).
 */
const DEFAULT_EMBEDDING_MODEL = 'openai:text-embedding-3-large'
const DEFAULT_EMBEDDING_DIMENSIONS = 768

/**
 * Marker file (under the brain dir) recording the embedding MODEL the column was
 * last (re)embedded under, e.g. `openai:text-embedding-3-large`. RA3: the SAME
 * 768-dim column can be embedded by DIFFERENT providers (local Ollama
 * `nomic-embed-text` vs cloud OpenAI) — numerically compatible, but semantically
 * DISTINCT vector spaces.
 *
 * INFORMATIONAL ONLY (as of the outage-orphan fix): the marker enriches the
 * model-change log line and tracks the current provider; it NO LONGER gates the
 * backfill. `gbrain embed --stale` runs on EVERY connect (see the
 * already-initialized branch), so convergence to one vector space — and repair
 * of any NULL-embedding pages orphaned by a provider/Ollama outage — is driven
 * by gbrain's OWN per-page `embedding_signature` tracking + the unconditional
 * `--stale` cursor (`gbrain/src/commands/embed.ts:embedAllStale` →
 * `invalidateStaleSignatureEmbeddings`), NOT by this marker. Gating the backfill
 * on "marker == current model" was a bug: it wrongly implied "every page is
 * embedded" and permanently stranded pages written during an outage that
 * happened AFTER the marker was recorded.
 */
const BACKFILL_MARKER = '.neutron-embeddings-backfilled'

/** `<GBRAIN_HOME>/.gbrain/.neutron-embeddings-backfilled` */
function backfillMarkerPath(gbrainHome: string): string {
  return join(gbrainHome, '.gbrain', BACKFILL_MARKER)
}

/**
 * The embedding model recorded in the backfill marker, or `null` when absent /
 * unreadable / a LEGACY marker (pre-RA3 markers stored a bare ISO timestamp, no
 * model — treated as `null` so the first RA3 boot re-validates via one
 * `embed --stale`).
 */
function readBackfillMarkerModel(gbrainHome: string): string | null {
  try {
    const raw = readFileSync(backfillMarkerPath(gbrainHome), 'utf-8').trim()
    const parsed = JSON.parse(raw) as { model?: unknown }
    return typeof parsed.model === 'string' && parsed.model.length > 0 ? parsed.model : null
  } catch {
    return null
  }
}

/** The provider-qualified model id an embedder embeds under (`provider:model`). */
function embedderModelId(embedder: EmbedderConfig): string {
  return embedder.childEnv['GBRAIN_EMBEDDING_MODEL'] ?? `${embedder.provider}:${embedder.model}`
}

/** Record the model the column is now embedded under (best-effort). */
async function writeBackfillMarker(gbrainHome: string, model: string): Promise<void> {
  try {
    await Bun.write(backfillMarkerPath(gbrainHome), JSON.stringify({ model, at: new Date().toISOString() }))
  } catch {
    /* marker is an optimization; a missing marker only re-scans (idempotent). */
  }
}

/**
 * Count of chunks embedded this run, parsed from `gbrain embed --stale` stdout.
 * gbrain prints `Embedded N chunks across M pages` (or `Embedded 0 chunks (0
 * stale found)` on a clean brain) to stdout via `slog` → `console.log`. Returns
 * 0 when unparseable — a no-op scan, the steady-state case. Used only to label
 * the outcome (backfill happened vs cheap no-op); it never gates the embed.
 */
function parseEmbeddedCount(stdout: string): number {
  const m = stdout.match(/Embedded\s+(\d+)\s+chunk/i)
  const n = m?.[1] !== undefined ? parseInt(m[1], 10) : 0
  return Number.isFinite(n) ? n : 0
}

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
  /**
   * Ollama reachability probe seam (injected in tests). Default the real
   * `probeOllamaHealth` (does actual network I/O). Advisory-only — see
   * "Fail-soft Ollama reachability" above.
   */
  probeOllamaHealth?: typeof probeOllamaHealth
  /**
   * Skip the advisory Ollama reachability probe (+ its log). The init guard now
   * re-runs on every (re)connect, so the caller sets this after the FIRST run to
   * keep the probe a once-per-client boot signal — otherwise an unreachable
   * Ollama would add the probe's ~1.5s timeout to each reconnect. Init +
   * backfill (the correctness work) still run every time; only the advisory
   * probe is gated.
   */
  skipOllamaProbe?: boolean
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
 * The embedding dimensionality an EXISTING brain's `content_chunks` vector
 * column was created at, read from `<GBRAIN_HOME>/.gbrain/config.json`
 * (`embedding_dimensions`) — or `null` for a brain that isn't initialized, has
 * no persisted embedding config, or an unreadable/legacy config.
 *
 * This is the authoritative width for a brain that ALREADY exists: at gbrain
 * runtime the `GBRAIN_EMBEDDING_DIMENSIONS` env OVERRIDES config.json
 * (`gbrain/src/core/config.ts:loadConfig`), so sending a width that mismatches
 * the persisted `vector(N)` column makes `gbrain serve` embed writes fail with
 * a dimension mismatch. RA3 uses this to RECONCILE the effective embedder to a
 * pre-existing column (`build-gbrain-memory.ts:reconcileEmbedderToBrain`) —
 * e.g. a legacy 3072-dim brain created under the pre-RA3 default keeps its
 * width (an OpenAI key upgrades in place at 3072; the 768-dim local Ollama
 * fallback, which cannot match, is dropped to keyword+graph rather than
 * corrupting writes).
 */
export function readPersistedEmbeddingDims(gbrainHome: string): number | null {
  try {
    const raw = readFileSync(brainConfigPath(gbrainHome), 'utf-8')
    const parsed = JSON.parse(raw) as { embedding_dimensions?: unknown }
    const dims = parsed.embedding_dimensions
    return typeof dims === 'number' && Number.isInteger(dims) && dims > 0 ? dims : null
  } catch {
    return null
  }
}

/**
 * The column-width state a reconciler must key off — distinguishing a FRESH
 * brain (safe to init at the RA3 default width) from an already-initialized
 * one whose width we can't read (must NOT be treated as fresh):
 *
 *   - `null`      — NO brain yet (no `config.json`). Fresh: use the RA3 default.
 *   - `number`    — an existing brain with a KNOWN persisted column width.
 *   - `'unknown'` — an existing/initialized brain (`config.json` present) whose
 *                   width can't be determined (missing `embedding_dimensions`,
 *                   a malformed/unreadable config, or a `--no-embedding` brain).
 *                   FAIL SAFE: the reconciler injects NO embedding dimension so
 *                   `gbrain serve` honors the brain's OWN persisted config
 *                   rather than a guessed width that could mismatch the column.
 */
export type BrainEmbeddingWidth = number | 'unknown' | null

/**
 * Resolve the reconciliation width for the brain at `gbrainHome`. Combines the
 * initialized-ness check (`isBrainInitialized`) with the persisted-dims read so
 * an initialized-but-unreadable brain is `'unknown'` (fail safe), never `null`
 * (which would misclassify it as fresh and inject the RA3 default width).
 */
export function resolveExistingBrainWidth(gbrainHome: string): BrainEmbeddingWidth {
  if (!isBrainInitialized(gbrainHome)) return null
  return readPersistedEmbeddingDims(gbrainHome) ?? 'unknown'
}

/**
 * The (model, dimensions) the brain's vector column is sized for. Tracks an
 * explicitly-configured embedder; otherwise the OpenAI default so an
 * onboarding-captured key upgrades the brain in place.
 *
 * The `model` MUST be provider-qualified (`provider:model`, e.g.
 * `ollama:nomic-embed-text`) — `gbrain init` REFUSES a bare model id
 * ("missing a provider prefix"), so returning `embedder.model` (bare) would
 * abort init for EVERY keyless default (Ollama) and eager-key (OpenAI)
 * deployment. Use the same qualified id the runtime embed seam uses
 * (`embedderModelId`), keeping init and `gbrain serve` on one model lineage.
 * `DEFAULT_EMBEDDING_MODEL` is already qualified.
 */
export function resolveInitEmbeddingTarget(embedder: EmbedderConfig | null): {
  model: string
  dimensions: number
} {
  if (embedder !== null) {
    return { model: embedderModelId(embedder), dimensions: embedder.dimensions }
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
  const probeHealth = input.probeOllamaHealth ?? probeOllamaHealth

  // Whether the effective embedder is CONFIRMED able to embed right now. Used to
  // gate the fresh-init marker write: the marker must mean "the column is (and
  // will be, for the pages that exist) embedded under this model", NOT merely
  // "init ran". OpenAI (a key is present → embeds on write) needs no local probe
  // → treated as usable. A local Ollama embedder is usable ONLY when the probe
  // confirms reachable + model-pulled; if it's down/missing at init, we must NOT
  // write the marker, or pages written during the outage would be orphaned when
  // the later healthy reconnect sees a matching marker and skips `embed --stale`.
  let embedderConfirmedUsable = input.embedder !== null && input.embedder.provider !== 'ollama'

  // Advisory-only Ollama reachability probe (RA3). Never gates the embedder
  // or column sizing (already fixed by `resolveEmbedderConfig` at
  // composition time, before this function is ever called) — purely surfaces
  // a degraded state with an actionable log line, since GBrain's own
  // per-query embed-fail fallback to keyword-only is otherwise silent from
  // outside the gbrain process. `skipOllamaProbe` lets the caller run this at
  // most ONCE per client (the guard now re-runs on every reconnect), so an
  // unreachable Ollama doesn't add the probe's timeout to each retry.
  if (
    !input.skipOllamaProbe &&
    input.embedder !== null &&
    input.embedder.provider === 'ollama'
  ) {
    const baseUrl = input.embedder.childEnv['OLLAMA_BASE_URL'] ?? 'http://localhost:11434/v1'
    // Redact any `user:pass@` userinfo before logging — an operator can put
    // credentials in OLLAMA_BASE_URL and they must never reach a log line.
    const safeUrl = redactUrlUserinfo(baseUrl)
    const health = await probeHealth(baseUrl, { model: input.embedder.model })
    if (!health.reachable) {
      logger.warn(
        `[gbrain-memory] local Ollama embedder configured (${input.embedder.model} @ ${safeUrl}) ` +
          'but it is not reachable — semantic recall degrades to keyword+graph (lexical) while it ' +
          'is down. Once Ollama is available, NEW content embeds automatically; content written ' +
          'DURING the outage backfills on the next reconnect/restart of the GBrain connection ' +
          '(not mid-session — the running connection keeps its lexical fallback until it reconnects). ' +
          `Install: brew install ollama && ollama pull ${input.embedder.model} ` +
          '(or paste an OpenAI key in Settings to use cloud embeddings instead).',
      )
    } else if (!health.modelPresent) {
      logger.warn(
        `[gbrain-memory] Ollama is reachable at ${safeUrl} but '${input.embedder.model}' is not ` +
          'pulled — semantic recall degrades to keyword+graph (lexical) until it is. ' +
          `Install: ollama pull ${input.embedder.model}`,
      )
    } else {
      logger.info(
        `[gbrain-memory] local Ollama embedder healthy (${input.embedder.model} @ ${safeUrl}) — ` +
          'semantic recall active.',
      )
      embedderConfirmedUsable = true
    }
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
    // Fresh brain has no pages, so no backfill is needed — record the model the
    // column starts under so a later provider/model switch is detected. BUT only
    // when the embedder is CONFIRMED usable: if a local Ollama embedder is down /
    // model-missing at init, do NOT write the marker — leave it absent so the
    // next healthy reconnect runs `embed --stale` and backfills any pages written
    // while degraded (the marker means "backfill completed", not "init ran").
    if (input.embedder !== null && embedderConfirmedUsable) {
      await writeBackfillMarker(input.gbrainHome, embedderModelId(input.embedder))
    }
    return { status: 'initialized', detail: `${target.model} ${target.dimensions}d` }
  }

  // Already initialized. Run `gbrain embed --stale` on EVERY connect (whenever an
  // embedder is configured) — NOT gated on the marker. It is idempotent + cheap
  // and is the single operation that repairs BOTH orphan modes:
  //   • OUTAGE ORPHANS — any chunk whose embedding IS NULL (pages written while
  //     Ollama / the provider was unreachable, WHENEVER that outage happened,
  //     including AFTER a healthy init already wrote the marker) is (re)embedded.
  //     This is the crux of the fix: a marker matching the current model means
  //     "the last backfill ran under this model", NOT "every page is embedded" —
  //     the old `markerModel !== currentModel` gate skipped this backfill and
  //     stranded those pages permanently.
  //   • MODEL / PROVIDER SWITCH — gbrain first NULLs the prior-signature vectors
  //     (`invalidateStaleSignatureEmbeddings`, keyed on gbrain's OWN per-page
  //     signature — not this marker), then the same NULL-embedding cursor
  //     re-embeds them into the new space, converging a mixed column (openai↔
  //     ollama) back to one space.
  // Cheap on a clean brain: gbrain's stale fast-path exits after a single
  // `countStaleChunks` (~50 bytes wire) when nothing is NULL. Keyword+graph
  // brains (no embedder) never embed, so skip entirely. Best-effort throughout:
  // a failure (Ollama still down, a missing binary, a provider error) never
  // blocks serving — the pages stay NULL and the NEXT reconnect's unconditional
  // `--stale` backfills them (the per-spawn recovery cadence).
  if (input.embedder !== null) {
    const currentModel = embedderModelId(input.embedder)
    const markerModel = readBackfillMarkerModel(input.gbrainHome)
    let res: { code: number; stdout: string; stderr: string }
    try {
      res = await runner.run(command, ['embed', '--stale'], { timeoutMs: 120_000, env: childEnv })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      if (isGbrainBinaryMissingError(err)) {
        logger.warn(
          `[gbrain-memory] '${command}' could not be spawned for embed backfill — memory DISABLED ` +
            '(keyword+graph still works). Install: bun install -g github:garrytan/gbrain',
        )
        return { status: 'binary-missing', detail: detail.slice(0, 200) }
      }
      logger.warn(
        `[gbrain-memory] 'gbrain embed --stale' threw under ${currentModel} — keyword+graph ` +
          `recall still works; embeddings backfill on the next reconnect. err: ${detail.slice(0, 160)}`,
      )
      return { status: 'already-initialized', detail: brainConfigPath(input.gbrainHome) }
    }
    if (res.code === 0) {
      const embedded = parseEmbeddedCount(res.stdout)
      // Record the model the column is now embedded under (informational — see
      // the marker doc; it no longer gates anything).
      await writeBackfillMarker(input.gbrainHome, currentModel)
      if (embedded > 0) {
        logger.info(
          `[gbrain-memory] embeddings backfill embedded ${embedded} chunk(s) at ` +
            `GBRAIN_HOME=${input.gbrainHome} under ${currentModel}` +
            `${markerModel !== null && markerModel !== currentModel ? ` (was ${markerModel})` : ''} — semantic recall active.`,
        )
        return { status: 'embeddings-backfilled', detail: `embed --stale ok (${embedded} under ${currentModel})` }
      }
      // Clean idempotent no-op — nothing was stale. Steady state.
      return { status: 'already-initialized', detail: brainConfigPath(input.gbrainHome) }
    }
    logger.warn(
      `[gbrain-memory] 'gbrain embed --stale' failed (code ${res.code}) under ${currentModel} — ` +
        'keyword+graph recall still works; embeddings backfill on the next reconnect. ' +
        `stderr: ${res.stderr.trim().slice(0, 160)}`,
    )
  }
  return { status: 'already-initialized', detail: brainConfigPath(input.gbrainHome) }
}
