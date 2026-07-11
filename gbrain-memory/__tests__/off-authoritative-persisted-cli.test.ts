/**
 * RA3 — `NEUTRON_EMBEDDINGS=off` is AUTHORITATIVE from a PERSISTED-Ollama brain,
 * proven end-to-end through the REAL `gbrain` write op (put_page via `capture`),
 * CI-ENFORCED (un-skipped).
 *
 * WHY THIS EXISTS (Codex Blocker)
 * ------------------------------
 * RA3 makes Ollama the default, so essentially EVERY brain persists
 * `embedding_model: "ollama:nomic-embed-text"` in its `config.json` (written by
 * `gbrain init`). gbrain's `loadConfig` spreads config.json FIRST and only
 * overrides `embedding_model` when `GBRAIN_EMBEDDING_MODEL` is TRUTHY
 * (`gbrain/src/core/config.ts`). So an EMPTY serve env is NOT a kill switch —
 * gbrain falls back to the persisted Ollama (which needs no key) and keeps
 * embedding on write (or FAILS the write when Ollama is down), despite the
 * operator setting `off`.
 *
 * The serve seam therefore emits a TRUTHY keyless override for `off`
 * (`resolveServeEmbeddingEnv` → `keylessDisableEmbeddingEnv` in
 * `build-gbrain-memory.ts`): `GBRAIN_EMBEDDING_MODEL=openai:text-embedding-3-large`
 * + `OPENAI_API_KEY=''`. With no usable credential gbrain's
 * `noEmbed = !isAvailable('embedding')` is true → put_page stores the page
 * UNEMBEDDED and succeeds, making no provider call.
 *
 * This test starts from a REAL persisted-Ollama brain (the boundary the unit
 * tests can't reach) and drives the REAL `gbrain capture` (which runs the
 * embed-on-write `put_page` op):
 *   • POSITIVE: with the off-override env, capture succeeds and the chunk is
 *     stored WITHOUT an embedding — even with Ollama pinned to a closed port.
 *   • NEGATIVE (non-vacuous): with an EMPTY env, the persisted Ollama stays live,
 *     capture ATTEMPTS to embed and FAILS ("Failed after N attempts") — proving
 *     the override is doing real work.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// The AUTHORITATIVE disable env the serve seam emits for `off` (and any
// keyword+graph drop) — kept in lockstep with `resolveServeEmbeddingEnv` /
// `keylessDisableEmbeddingEnv` (gateway `build-gbrain-memory.ts`) and its unit
// test `DISABLED_EMBED_ENV`. A TRUTHY model override is what wins over the
// persisted `ollama:*` config; the empty key neutralizes any ambient BYO key.
const OFF_OVERRIDE_ENV: Record<string, string> = {
  GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
  OPENAI_API_KEY: '',
}

const GBRAIN_CLI = (() => {
  const enginePath = (Bun as unknown as { resolveSync(spec: string, dir: string): string }).resolveSync(
    'gbrain/pglite-engine',
    import.meta.dir,
  )
  return join(dirname(dirname(dirname(enginePath))), 'src', 'cli.ts')
})()

// Pin every embedder base URL to a guaranteed-CLOSED local port so an embed
// ATTEMPT fails fast (and can never silently reach a host Ollama) — the negative
// case must observably attempt+fail, the positive must never attempt at all.
const PINNED_CLOSED: Record<string, string> = {
  OLLAMA_BASE_URL: 'http://127.0.0.1:1',
  OPENAI_BASE_URL: 'http://127.0.0.1:1',
}

function runGbrain(
  args: string[],
  env: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
  const res = Bun.spawnSync([process.execPath, GBRAIN_CLI, ...args], {
    env: { ...process.env, ...PINNED_CLOSED, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() }
}

interface FileEngine {
  connect(config: { database_path: string }): Promise<void>
  disconnect(): Promise<void>
  getChunksWithEmbeddings(slug: string): Promise<Array<{ embedding: Float32Array | null }>>
}

async function openEngine(databasePath: string): Promise<FileEngine> {
  const mod = (await import('gbrain' + '/pglite-engine')) as { PGLiteEngine: new () => FileEngine }
  const eng = new mod.PGLiteEngine()
  await eng.connect({ database_path: databasePath })
  return eng
}

describe('RA3 — `off` override is authoritative on a PERSISTED-Ollama brain (CI-enforced)', () => {
  test('off-override → capture stores UNEMBEDDED (no embed attempt); empty env → persisted Ollama embeds + FAILS', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-off-persisted-'))
    const gbrainHome = join(home, 'gbrain')
    const base = { GBRAIN_HOME: gbrainHome }

    // 1) Init a REAL default-lineage brain: persists ollama:nomic-embed-text @768.
    const init = runGbrain(
      ['init', '--pglite', '--non-interactive', '--skip-embed-check', '--embedding-model', 'ollama:nomic-embed-text', '--embedding-dimensions', '768'],
      base,
    )
    expect(init.code).toBe(0)
    const databasePath = join(gbrainHome, '.gbrain', 'brain.pglite')

    // 2) POSITIVE — capture with the off-override env. The truthy openai-latent
    //    model beats the persisted ollama config; with no key gbrain skips embed.
    const off = runGbrain(
      ['capture', '--slug', 'off-note', '--type', 'note', 'the quick brown fox jumps'],
      { ...base, ...OFF_OVERRIDE_ENV },
    )
    expect(off.code).toBe(0) // write SUCCEEDS
    // No embed was attempted at all — no "Failed after N attempts" / embed error.
    expect(off.stderr).not.toContain('Failed after')
    expect(off.stderr).not.toContain('embed(')

    // The chunk is stored WITHOUT an embedding (NULL vector).
    {
      const eng = await openEngine(databasePath)
      try {
        const chunks = await eng.getChunksWithEmbeddings('off-note')
        expect(chunks.length).toBeGreaterThanOrEqual(1)
        expect(chunks.every((c) => c.embedding === null)).toBe(true)
      } finally {
        await eng.disconnect()
      }
    }

    // 3) NEGATIVE (non-vacuous) — an EMPTY serve env falls through to the
    //    PERSISTED Ollama, which needs no key → capture ATTEMPTS to embed and
    //    FAILS against the pinned-closed port. This is exactly the bug the
    //    off-override prevents.
    const noOverride = runGbrain(
      ['capture', '--slug', 'oll-note', '--type', 'note', 'the quick brown fox jumps'],
      { ...base },
    )
    expect(noOverride.code).not.toBe(0) // write FAILS (embed attempted)
    expect(noOverride.stderr).toContain('embed(ollama:nomic-embed-text)')
    expect(noOverride.stderr).toContain('Failed after')
  }, 120_000)
})
