/**
 * RA3 — the CENTRAL fail-soft promise, proven end-to-end through the REAL
 * `gbrain search` CLI, CI-ENFORCED (un-skipped).
 *
 * WHY THIS EXISTS (Codex P1 #3)
 * ----------------------------
 * RA3 flips EVERY unset deployment from "no embedder" to "Ollama-by-default", so
 * the load-bearing promise becomes: when Ollama is UNREACHABLE, default semantic
 * search STILL returns useful lexical (keyword/BM25 + graph) results, NOT an
 * error and NOT an empty set. If the default hybrid search errored (or silently
 * returned nothing) whenever the local embedder was down, RA3 would have made the
 * out-of-the-box experience WORSE than the pre-RA3 lexical-only default.
 *
 * This test initializes a brain with the DEFAULT Ollama config, inserts
 * keyword-searchable content, then runs the REAL `gbrain search` with the
 * embedder pinned to a guaranteed-CLOSED local port (so the query-embedding leg
 * fails on any host) and asserts search exits 0 and returns the lexical hit.
 *
 * RESULT: fail-soft is a gbrain-layer property (its hybrid retrieval degrades the
 * vector leg to keyword when the embedder is unreachable) — this test locks it in
 * as a CI-enforced contract for the RA3 default lineage.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Resolve the pinned workspace `gbrain` CLI + PGLite engine (present via bun.lock).
const enginePath = (Bun as unknown as { resolveSync(spec: string, dir: string): string }).resolveSync(
  'gbrain/pglite-engine',
  import.meta.dir,
)
const GBRAIN_CLI = join(dirname(dirname(dirname(enginePath))), 'src', 'cli.ts')

// HERMETICITY: pin every embedder base URL to a guaranteed-closed local port so
// the query-embedding leg ALWAYS fails with ECONNREFUSED — the test must not
// depend on the host NOT running Ollama (a dogfood Mac / some CI hosts run it).
const HERMETIC_EMBED_ENV: Record<string, string> = {
  OLLAMA_BASE_URL: 'http://127.0.0.1:1',
  OPENAI_BASE_URL: 'http://127.0.0.1:1',
  OPENAI_API_KEY: '',
}

function runGbrain(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const res = Bun.spawnSync([process.execPath, GBRAIN_CLI, ...args], {
    env: { ...process.env, ...env, ...HERMETIC_EMBED_ENV },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() }
}

interface FileEngine {
  connect(config: { database_path: string }): Promise<void>
  disconnect(): Promise<void>
  putPage(slug: string, page: Record<string, unknown>): Promise<unknown>
  upsertChunks(slug: string, chunks: Array<Record<string, unknown>>): Promise<void>
}

describe('RA3 — default Ollama config with the embedder UNREACHABLE still returns lexical search hits (CI-enforced)', () => {
  test('`gbrain search` degrades to keyword+graph (exit 0, returns the hit) when the local embedder is down', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-failsoft-'))
    const gbrainHome = join(home, 'gbrain')
    const env = { GBRAIN_HOME: gbrainHome }

    // 1) Init the DEFAULT lineage: a local-Ollama brain at the shared 768 column.
    const init = runGbrain(
      ['init', '--pglite', '--non-interactive', '--skip-embed-check', '--embedding-model', 'ollama:nomic-embed-text', '--embedding-dimensions', '768'],
      env,
    )
    expect(init.code).toBe(0)

    // 2) Insert keyword-searchable content (no embeddings — the embedder is down,
    //    exactly the degraded state under test).
    const databasePath = join(gbrainHome, '.gbrain', 'brain.pglite')
    const mod = (await import(enginePath)) as { PGLiteEngine: new () => FileEngine }
    const eng = new mod.PGLiteEngine()
    await eng.connect({ database_path: databasePath })
    try {
      const text =
        'The unicorn revenue forecast for Q3 mentions widget pricing strategy and margin analysis.'
      await eng.putPage('failsoft-note', {
        type: 'note',
        title: 'Quarterly revenue planning',
        compiled_truth: text,
      })
      await eng.upsertChunks('failsoft-note', [
        { chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', token_count: 14 },
      ])
    } finally {
      await eng.disconnect()
    }

    // 3) Run the REAL `gbrain search` with the embedder pinned to a CLOSED port.
    //    The query-embedding (vector) leg fails with ECONNREFUSED; hybrid
    //    retrieval must degrade to keyword+graph rather than erroring or
    //    returning nothing.
    const search = runGbrain(['search', 'unicorn revenue forecast'], env)

    // Fail-soft contract: exit 0 (not an error) AND the lexical hit is returned.
    expect(search.code).toBe(0)
    expect(search.stdout).toContain('failsoft-note')
    expect(search.stdout).toContain('unicorn revenue forecast')
  }, 120_000)
})
