/**
 * RA3 — the REAL `gbrain embed --stale` provider-switch invalidation contract,
 * end-to-end through the ACTUAL CLI, CI-ENFORCED (un-skipped).
 *
 * WHY THIS EXISTS (Codex P1, round 16)
 * -----------------------------------
 * Production relies ENTIRELY on `ensureBrainInitialized()` invoking ONE thing on
 * an already-initialized brain: the `gbrain embed --stale` CLI
 * (`ensure-brain-init.ts`, unconditional on every connect). Its safety across an
 * OpenAI↔Ollama switch — NULLing the prior-provider vectors so two incompatible
 * vector spaces never coexist in one column and silently corrupt ranking — lives
 * in gbrain's `embedAllStale`, which calls `invalidateStaleSignatureEmbeddings`
 * BEFORE the embed loop. The unit tests use a fake runner (they only prove
 * `--stale` is INVOKED), and `signature-drift-invalidation.test.ts` calls the
 * engine primitive DIRECTLY — so if the CLI→primitive wiring regressed (the CLI
 * stopped invalidating), all of those would stay green while production silently
 * mixed vector spaces.
 *
 * This test closes that gap by driving the REAL CLI and asserting it invalidated
 * the drifted vector. Crucially it is NOT gated/skipped: it resolves the pinned
 * `gbrain` from the workspace (always installed via bun.lock — the SAME dep the
 * in-process PGLite suites already import) and runs it with `bun`, so it executes
 * in CI on every run. `embedAllStale`/`runEmbedCore` are not exported (the package
 * exports map blocks deep imports), so the CLI subprocess IS the pinned seam.
 *
 * OFFLINE
 * -------
 * Invalidation runs BEFORE the embed loop, so it happens with no reachable
 * embedding provider: we configure the brain for local Ollama, and in CI (no
 * Ollama) the follow-on embed call fails fast with a local ECONNREFUSED (no
 * external network), caught per-chunk, exit 0. We assert the drifted
 * (prior-provider) chunk was NULLed and the same-provider chunk was PRESERVED —
 * the load-bearing mix-prevention property. Re-embedding the NULLed chunk needs a
 * live provider (covered by the `--stale` unit tests + honest-degradation path).
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// The shared column RA3 targets. nomic-embed-text is natively 768, so an Ollama
// brain's column is 768; the stamped vectors must match it.
const DIMS = 768
// The brain is CONFIGURED for Ollama, so gbrain's "current" signature is
// `${model}:${dims}` (`gbrain/src/core/embedding.ts:currentEmbeddingSignature`).
const CURRENT_SIG = `ollama:nomic-embed-text:${DIMS}`
// A chunk left behind by a PRIOR provider (the OpenAI→Ollama switch RA3 allows).
const DRIFT_SIG = `openai:text-embedding-3-large:${DIMS}`

// Resolve the pinned workspace `gbrain` CLI (`<pkg>/src/cli.ts`) from an exported
// subpath — always present via bun.lock, so this runs in CI (no PATH dependency,
// no skip). The bin is the same `src/cli.ts` the global `gbrain` shims.
const GBRAIN_CLI = (() => {
  const enginePath = (Bun as unknown as { resolveSync(spec: string, dir: string): string }).resolveSync(
    'gbrain/pglite-engine',
    import.meta.dir,
  )
  // <pkg>/src/core/pglite-engine.ts → <pkg>
  const pkgRoot = dirname(dirname(dirname(enginePath)))
  return join(pkgRoot, 'src', 'cli.ts')
})()

interface FileEngine {
  connect(config: { database_path: string }): Promise<void>
  disconnect(): Promise<void>
  putPage(slug: string, page: Record<string, unknown>): Promise<unknown>
  upsertChunks(slug: string, chunks: Array<Record<string, unknown>>): Promise<void>
  getChunksWithEmbeddings(slug: string): Promise<Array<{ embedding: Float32Array | null }>>
  countStaleChunks(opts?: { signature?: string }): Promise<number>
  setPageEmbeddingSignature(slug: string, opts: { signature: string }): Promise<void>
}

async function openFileEngine(databasePath: string): Promise<FileEngine> {
  const mod = (await import('gbrain' + '/pglite-engine')) as { PGLiteEngine: new () => FileEngine }
  const eng = new mod.PGLiteEngine()
  await eng.connect({ database_path: databasePath })
  return eng
}

/** Run the pinned workspace `gbrain` CLI via bun; capture exit + stdout/stderr. */
function runGbrain(
  args: string[],
  env: Record<string, string | undefined>,
): { code: number; stdout: string; stderr: string } {
  const res = Bun.spawnSync([process.execPath, GBRAIN_CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() }
}

describe('RA3 — real `gbrain embed --stale` invalidates prior-provider vectors on a switch (CI-enforced)', () => {
  test('a drifted chunk is NULLed by the CLI; a same-provider chunk is preserved', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cli-invalidate-'))
    const gbrainHome = join(home, 'gbrain')
    const env = { GBRAIN_HOME: gbrainHome }

    // 1) Init a real PGLite brain CONFIGURED for local Ollama at the 768-dim column.
    const init = runGbrain(
      ['init', '--pglite', '--non-interactive', '--skip-embed-check', '--embedding-model', 'ollama:nomic-embed-text'],
      env,
    )
    expect(init.code).toBe(0)

    const databasePath = join(gbrainHome, '.gbrain', 'brain.pglite')

    // 2) Seed the drifted state directly in the DB: a chunk embedded under a PRIOR
    //    provider (OpenAI) plus a chunk already under the CURRENT provider
    //    (Ollama) — both with real 768-vectors.
    {
      const eng = await openFileEngine(databasePath)
      try {
        for (const [slug, sig] of [
          ['ra3-drift', DRIFT_SIG],
          ['ra3-current', CURRENT_SIG],
        ] as const) {
          await eng.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} content` })
          await eng.upsertChunks(slug, [
            {
              chunk_index: 0,
              chunk_text: `${slug} content`,
              chunk_source: 'compiled_truth',
              embedding: new Float32Array(DIMS).fill(0.1),
              token_count: 4,
            },
          ])
          await eng.setPageEmbeddingSignature(slug, { signature: sig })
        }
        // Both start with a vector; neither is NULL-stale yet.
        expect(await eng.countStaleChunks()).toBe(0)
      } finally {
        await eng.disconnect()
      }
    }

    // 3) Run the REAL `gbrain embed --stale` — the EXACT command
    //    `ensureBrainInitialized` runs on every reconnect. Ollama is unreachable
    //    (CI), so the embed step fails fast locally after invalidation (exit 0).
    const embed = runGbrain(['embed', '--stale'], env)
    expect(embed.code).toBe(0)
    // The CLI reports it swept exactly the ONE drifted chunk (not the current one).
    // If upstream gbrain stopped calling invalidateStaleSignatureEmbeddings, this
    // line disappears and the NULL assertion below flips — the regression fails here.
    expect(embed.stdout).toContain('invalidated 1 chunk')

    // 4) Verify the DB state the CLI produced: the prior-provider vector is NULL
    //    (invalidated → now plain NULL-stale, ready to re-embed under Ollama), and
    //    the same-provider vector is UNTOUCHED (a matching provider never wipes).
    {
      const eng = await openFileEngine(databasePath)
      try {
        const drift = await eng.getChunksWithEmbeddings('ra3-drift')
        const current = await eng.getChunksWithEmbeddings('ra3-current')
        expect(drift).toHaveLength(1)
        expect(drift[0]!.embedding).toBeNull() // invalidated by the real CLI
        expect(current).toHaveLength(1)
        expect(current[0]!.embedding).not.toBeNull() // same provider → preserved
        expect(await eng.countStaleChunks()).toBe(1) // exactly the drifted chunk is stale
      } finally {
        await eng.disconnect()
      }
    }
  }, 120_000)
})
