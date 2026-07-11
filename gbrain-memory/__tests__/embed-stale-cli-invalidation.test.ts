/**
 * RA3 — the REAL `gbrain embed --stale` provider-switch invalidation contract,
 * end-to-end through the ACTUAL pinned CLI (not the engine primitive).
 *
 * WHY THIS EXISTS (Codex P1)
 * --------------------------
 * Production relies ENTIRELY on `ensureBrainInitialized()` invoking ONE thing on
 * an already-initialized brain: the `gbrain embed --stale` CLI
 * (`ensure-brain-init.ts`, unconditional on every connect). Its safety across an
 * OpenAI↔Ollama switch — NULLing the prior-provider vectors so two incompatible
 * vector spaces never coexist in one 768-dim column and silently corrupt
 * ranking — lives in gbrain's `embedAllStale`, which calls
 * `invalidateStaleSignatureEmbeddings` BEFORE the embed loop.
 *
 * The unit tests use a fake runner (they only prove `--stale` is INVOKED), and
 * `signature-drift-invalidation.test.ts` calls the engine primitive DIRECTLY —
 * so if upstream `embedAllStale` (the CLI) stopped calling invalidation, ALL of
 * those would stay green while production silently mixed vector spaces. This
 * test closes that gap: it drives the REAL CLI and asserts it invalidated the
 * drifted vector, so an upstream gbrain regression fails HERE.
 *
 * OFFLINE-VERIFIABLE
 * ------------------
 * Invalidation runs BEFORE the embed loop, so it happens even without a live
 * embedding provider: we configure the brain for OpenAI, hand `embed --stale` a
 * dummy `OPENAI_API_KEY` (passes the credential preflight → reaches
 * invalidation), and the subsequent embed HTTP call fails harmlessly (exit 0).
 * We assert the drifted (prior-provider) chunk was NULLed and a same-provider
 * chunk was PRESERVED. Actually re-embedding the NULLed chunk needs a live
 * provider (covered by the `--stale` unit tests + the honest-degradation path);
 * the load-bearing safety property this pins is the CLI-level invalidation.
 *
 * Gated on the real `gbrain` binary (same skip-on-CI-without-binary pattern as
 * `real-serve-roundtrip.test.ts`). Run locally with
 * `bun install -g github:garrytan/gbrain` on PATH.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GBRAIN = Bun.which('gbrain')
const describeCli = GBRAIN !== null ? describe : describe.skip

if (GBRAIN === null) {
  // eslint-disable-next-line no-console
  console.warn(
    '[embed-stale-cli-invalidation] SKIPPED — `gbrain` not on PATH. ' +
      'Install with `bun install -g github:garrytan/gbrain` to run the real-CLI invalidation contract.',
  )
}

// The shared 768-dim column RA3 targets. OpenAI (Matryoshka) can be pinned to it;
// nomic-embed-text is natively 768. Column width must match the stamped vectors.
const DIMS = 768
// The brain is CONFIGURED for OpenAI, so gbrain's "current" signature is
// `${model}:${dims}` (`gbrain/src/core/embedding.ts:currentEmbeddingSignature`).
const CURRENT_SIG = `openai:text-embedding-3-large:${DIMS}`
// A chunk left behind by a PRIOR provider (the Ollama→OpenAI switch RA3 allows).
const DRIFT_SIG = `ollama:nomic-embed-text:${DIMS}`

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

/** Run the real `gbrain` CLI; returns exit code + captured stdout/stderr. */
function runGbrain(
  args: string[],
  env: Record<string, string | undefined>,
): { code: number; stdout: string; stderr: string } {
  const res = Bun.spawnSync([GBRAIN as string, ...args], {
    // Carry PATH so gbrain's `#!/usr/bin/env bun` shebang re-resolves.
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: res.exitCode,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  }
}

describeCli('RA3 — real `gbrain embed --stale` invalidates prior-provider vectors on a switch', () => {
  test('a drifted chunk is NULLed by the CLI; a same-provider chunk is preserved', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-cli-invalidate-'))
    const gbrainHome = join(home, 'gbrain')
    const env = { GBRAIN_HOME: gbrainHome }

    // 1) Init a real PGLite brain CONFIGURED for OpenAI at the 768-dim column.
    const init = runGbrain(
      [
        'init',
        '--pglite',
        '--non-interactive',
        '--skip-embed-check',
        '--embedding-model',
        'openai:text-embedding-3-large',
        '--embedding-dimensions',
        String(DIMS),
      ],
      env,
    )
    expect(init.code).toBe(0)

    const databasePath = join(gbrainHome, '.gbrain', 'brain.pglite')

    // 2) Seed the drifted state directly in the DB: a chunk embedded under a PRIOR
    //    provider (Ollama) plus a chunk already under the CURRENT provider
    //    (OpenAI) — both with real 768-vectors.
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

    // 3) Run the REAL `gbrain embed --stale`. A dummy key passes the credential
    //    preflight so the CLI reaches invalidation; the follow-on embed HTTP call
    //    fails harmlessly (exit 0). This is the EXACT command
    //    `ensureBrainInitialized` runs on every reconnect.
    const embed = runGbrain(['embed', '--stale'], { ...env, OPENAI_API_KEY: 'sk-dummy-not-a-real-key' })
    expect(embed.code).toBe(0)
    // The CLI reports it swept exactly the ONE drifted chunk (not the current one).
    // If upstream gbrain stopped calling invalidateStaleSignatureEmbeddings, this
    // line disappears and the NULL assertion below flips — the regression fails here.
    expect(embed.stdout).toContain('invalidated 1 chunk')

    // 4) Verify the DB state the CLI produced: the prior-provider vector is NULL
    //    (invalidated → now plain NULL-stale, ready to re-embed under OpenAI), and
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
        // Exactly the drifted chunk is now stale (re-embeds under OpenAI on the
        // next run with a live key); the current chunk is not.
        expect(await eng.countStaleChunks()).toBe(1)
      } finally {
        await eng.disconnect()
      }
    }
  }, 120_000)
})
