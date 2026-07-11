/**
 * RA3 — the UPSTREAM contract that makes "run `gbrain embed --stale` on every
 * connect" safe across a provider switch, pinned against a REAL PGLite brain.
 *
 * `ensureBrainInitialized` (already-initialized branch) now runs `gbrain embed
 * --stale` unconditionally. Its correctness for a provider/model switch —
 * converging a mixed openai/ollama 768-dim column back to ONE vector space
 * instead of silently corrupting semantic ranking — does NOT live in our code:
 * it lives in gbrain's `embedAllStale`, which BEFORE scanning calls
 * `invalidateStaleSignatureEmbeddings({ signature })` to NULL every chunk whose
 * page `embedding_signature` differs from the now-current model, so the same
 * `embedding IS NULL` cursor re-embeds them (`gbrain/src/commands/embed.ts`).
 *
 * The unit tests around `ensureBrainInitialized` use a fake runner, so they only
 * prove `embed --stale` is INVOKED — they cannot prove that invocation actually
 * re-embeds signature-drifted vectors (Codex P1). This test closes that gap with
 * direct database-state assertions against the real engine primitives the
 * `--stale` path depends on: stamp a chunk's vectors under provider A, switch to
 * provider B, and assert the drift is detected + the vectors are invalidated
 * (NULLed) so they become stale and get re-embedded under B. If gbrain ever
 * dropped signature invalidation, our provider-switch convergence would silently
 * break — and THIS test would go red.
 *
 * Runs in CI on the same in-process PGLite harness as the other real-brain
 * suites (no network embedder needed — we stamp vectors directly).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'

import { bootPgliteBrain } from './boot-pglite-brain.ts'

/** The engine methods the `embed --stale` path drives (structurally typed). */
interface DrivableEngine {
  disconnect(): Promise<void>
  putPage(slug: string, page: Record<string, unknown>, opts?: { sourceId?: string }): Promise<unknown>
  upsertChunks(slug: string, chunks: Array<Record<string, unknown>>, opts?: { sourceId?: string }): Promise<void>
  getChunksWithEmbeddings(
    slug: string,
    opts?: { sourceId?: string },
  ): Promise<Array<{ chunk_index: number; embedding: Float32Array | null }>>
  countStaleChunks(opts?: { sourceId?: string; signature?: string }): Promise<number>
  setPageEmbeddingSignature(slug: string, opts: { sourceId?: string; signature: string }): Promise<void>
  invalidateStaleSignatureEmbeddings(opts: { signature: string; sourceId?: string }): Promise<number>
}

// Two DISTINCT provider signatures over the SAME column — the exact openai↔
// ollama shape RA3 allows (numerically compatible, semantically distinct). The
// signature string is opaque to invalidation (it keys on string inequality), so
// the width in the label is immaterial here.
const SIG_A = 'openai:text-embedding-3-large@768'
const SIG_B = 'ollama:nomic-embed-text@768'

// The width an UNCONFIGURED PGLite brain's `content_chunks.embedding` column
// ends up at: the base schema declares `vector(1536)` but the no-embedding
// migration resizes it to 1280 (pgvector's `CheckExpectedDim` enforces it at
// insert). The gateway isn't configured under `bun test`, so we size the stamped
// vector to the column directly rather than via `getEmbeddingDimensions()`
// (which requires a configured gateway). Only the width must match the column;
// the invalidation logic itself is width-agnostic (it keys on page signature).
const COLUMN_DIMS = 1280

describe('RA3 signature-drift invalidation — the embed --stale convergence contract', () => {
  let engine: DrivableEngine
  const dims = COLUMN_DIMS

  beforeAll(async () => {
    const { engine: eng } = await bootPgliteBrain()
    engine = eng as unknown as DrivableEngine
  }, 60_000)

  afterAll(async () => {
    if (engine !== undefined) await engine.disconnect()
  }, 30_000)

  test('provider switch: a chunk stamped under provider A is detected as drift, invalidated, and left stale for re-embed under B', async () => {
    const slug = 'ra3-sig-drift-fact'
    await engine.putPage(slug, {
      type: 'note',
      title: 'Launch',
      compiled_truth: 'The launch code is BLUEBIRD-42.',
    })

    // Embed the chunk (a non-null vector) and stamp the page as embedded under
    // provider A — the state after a healthy backfill.
    await engine.upsertChunks(slug, [
      {
        chunk_index: 0,
        chunk_text: 'The launch code is BLUEBIRD-42.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array(dims).fill(0.1),
        token_count: 8,
      },
    ])
    await engine.setPageEmbeddingSignature(slug, { signature: SIG_A })

    // Baseline: the chunk HAS a vector → not NULL-stale; and under its own
    // signature A it is not drift-stale either.
    expect(await engine.countStaleChunks()).toBe(0)
    expect(await engine.countStaleChunks({ signature: SIG_A })).toBe(0)
    const before = await engine.getChunksWithEmbeddings(slug)
    expect(before).toHaveLength(1)
    expect(before[0]!.embedding).not.toBeNull()

    // Switch to provider B: gbrain now sees the A-signed chunk as drift.
    expect(await engine.countStaleChunks({ signature: SIG_B })).toBe(1)

    // THE CONTRACT the unconditional `embed --stale` relies on: invalidation
    // NULLs the drifted vector (returns the count swept), so the plain
    // NULL-embedding cursor will re-embed it into provider B's space.
    const invalidated = await engine.invalidateStaleSignatureEmbeddings({ signature: SIG_B })
    expect(invalidated).toBe(1)

    // Post-invalidation: the vector is NULL (the A-space embedding is gone) and
    // the chunk is now plain NULL-stale → the `--stale` scan re-embeds it under B.
    const after = await engine.getChunksWithEmbeddings(slug)
    expect(after).toHaveLength(1)
    expect(after[0]!.embedding).toBeNull()
    expect(await engine.countStaleChunks()).toBe(1)
  }, 60_000)

  test('same signature → NO invalidation (idempotent: a matching provider never wipes vectors)', async () => {
    const slug = 'ra3-sig-stable-fact'
    await engine.putPage(slug, {
      type: 'note',
      title: 'Stable',
      compiled_truth: 'Nothing drifted here.',
    })
    await engine.upsertChunks(slug, [
      {
        chunk_index: 0,
        chunk_text: 'Nothing drifted here.',
        chunk_source: 'compiled_truth',
        embedding: new Float32Array(dims).fill(0.2),
        token_count: 4,
      },
    ])
    await engine.setPageEmbeddingSignature(slug, { signature: SIG_A })

    // Invalidating under the SAME signature A must sweep nothing (this is why a
    // steady-state reconnect's `--stale` is a cheap no-op, not a destructive
    // re-embed).
    const invalidated = await engine.invalidateStaleSignatureEmbeddings({ signature: SIG_A })
    expect(invalidated).toBe(0)
    const rows = await engine.getChunksWithEmbeddings(slug)
    expect(rows[0]!.embedding).not.toBeNull()
  }, 60_000)
})
