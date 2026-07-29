/**
 * RA3 — the DEFAULT (no-key) init lineage registers an Ollama@768 column through
 * the REAL `gbrain` CLI, CI-ENFORCED (un-skipped).
 *
 * WHY THIS EXISTS (Codex P1 #1)
 * ----------------------------
 * RA3 flips the keyless default from "no embedder" to the local Ollama fallback,
 * so EVERY keyless deployment now runs `ensureBrainInitialized` with the Ollama
 * embedder and `gbrain init --embedding-model <target.model>`. The target model
 * MUST be provider-qualified: `gbrain init` REFUSES a bare model id ("missing a
 * provider prefix"), so if `resolveInitEmbeddingTarget` returned the bare
 * `embedder.model` (`nomic-embed-text`) instead of the qualified
 * `ollama:nomic-embed-text`, init would abort and memory would be silently
 * disabled for the entire default fleet.
 *
 * The existing unit tests use a FAKE runner and only assert the init args
 * CONTAIN the substring `nomic-embed-text` — which a bare id also satisfies, so
 * they can't catch this. This test drives the REAL pinned workspace `gbrain` and
 * asserts the PERSISTED column config records the qualified Ollama model at 768,
 * i.e. init actually succeeded and registered the right provider.
 *
 * HERMETIC: init only SIZES the column (`--skip-embed-check`, no live embed), so
 * no provider need be reachable; we still pin every embedder base URL to a closed
 * port so a host Ollama can never influence the outcome.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ensureBrainInitialized,
  brainConfigPath,
  readPersistedEmbeddingDims,
} from '../ensure-brain-init.ts'
import { resolveEmbedderConfig } from '../embedder-config.ts'
import type { CommandRunner } from '../command-runner.ts'

// Resolve the pinned workspace `gbrain` CLI (`<pkg>/src/cli.ts`) from an exported
// subpath — always present via bun.lock, so this runs in CI (no PATH dependency).
const GBRAIN_CLI = (() => {
  const enginePath = (Bun as unknown as { resolveSync(spec: string, dir: string): string }).resolveSync(
    'gbrain/pglite-engine',
    import.meta.dir,
  )
  return join(dirname(dirname(dirname(enginePath))), 'src', 'cli.ts')
})()

// Pin every embedder base URL to a guaranteed-closed local port so no host
// provider can influence init (init never embeds here, but belt-and-suspenders).
const HERMETIC_EMBED_ENV: Record<string, string> = {
  OLLAMA_BASE_URL: 'http://127.0.0.1:1',
  OPENAI_BASE_URL: 'http://127.0.0.1:1',
  OPENAI_API_KEY: '',
}

// A real runner over the pinned workspace CLI via bun (ignores the injected
// `command`; always execs `src/cli.ts` so no global `gbrain` install is needed).
const realGbrainRunner: CommandRunner = {
  async run(_cmd, args, opts) {
    const res = Bun.spawnSync([process.execPath, GBRAIN_CLI, ...args], {
      env: { ...process.env, ...(opts?.env ?? {}), ...HERMETIC_EMBED_ENV },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() }
  },
}

describe('RA3 — default (no-key) init registers an Ollama@768 column via the real CLI (CI-enforced)', () => {
  test('fresh brain, DEFAULT embedder → gbrain init accepts the provider-qualified model and persists ollama:nomic-embed-text @ 768', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-default-lineage-'))
    const gbrainHome = join(home, 'gbrain')

    // The DEFAULT deployment: NEUTRON_EMBEDDINGS unset → local Ollama fallback.
    const embedder = resolveEmbedderConfig({})
    expect(embedder?.provider).toBe('ollama')

    const result = await ensureBrainInitialized({
      gbrainHome,
      embedder,
      runner: realGbrainRunner,
      logger: { warn: () => {}, info: () => {} },
      // Advisory network probe off — this is a hermetic init-only check.
      skipOllamaProbe: true,
    })

    // Init SUCCEEDED — the bare-model refusal ("missing a provider prefix") would
    // surface here as 'init-failed'. The detail carries the qualified id.
    expect(result.status).toBe('initialized')
    expect(result.detail).toBe('ollama:nomic-embed-text 768d')

    // The REAL persisted column config (not a fake-runner arg) records the
    // qualified Ollama model at the shared 768 width.
    const config = JSON.parse(readFileSync(brainConfigPath(gbrainHome), 'utf-8')) as {
      embedding_model?: string
      embedding_dimensions?: number
    }
    expect(config.embedding_model).toBe('ollama:nomic-embed-text')
    expect(config.embedding_dimensions).toBe(768)
    expect(readPersistedEmbeddingDims(gbrainHome)).toBe(768)
  }, 120_000)
})
