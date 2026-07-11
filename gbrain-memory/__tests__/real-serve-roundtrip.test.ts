/**
 * ND1 — REAL `gbrain serve` write→read regression guard.
 *
 * THE bug this proves fixed (dogfood 2026-06-27 §2): production spawns the
 * external `gbrain serve` binary against a brain that was never `gbrain init`'d,
 * so serve prints "No brain configured" and exits → every MCP op fails
 * `MCP error -32000: Connection closed` → `memory_search`, scribe-write, and the
 * admin Memory tab silently no-op. CI's other "real GBrain" test boots an
 * IN-PROCESS PGLite engine, so it never exercised the `init`→`serve` seam where
 * the bug lived. This test closes that gap: it drives the EXACT production path
 * — `ensureBrainInitialized()` (the new init guard) → `GBrainStdioMcpClient`
 * (spawns the real `gbrain serve` child) → `put_page` → `search` — and asserts
 * the written fact is recalled from the real brain.
 *
 * Gated on the real `gbrain` binary being installed (it is not a workspace dep;
 * CI hosts without it skip with a clear reason rather than failing). Run locally
 * with `bun install -g github:garrytan/gbrain` on PATH to exercise it.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureBrainInitialized } from '../ensure-brain-init.ts'
import { GBrainStdioMcpClient } from '../gbrain-stdio-client.ts'

const HAS_GBRAIN = Bun.which('gbrain') !== null
const describeReal = HAS_GBRAIN ? describe : describe.skip

if (!HAS_GBRAIN) {
  // eslint-disable-next-line no-console
  console.warn(
    '[real-serve-roundtrip] SKIPPED — `gbrain` not on PATH. ' +
      'Install with `bun install -g github:garrytan/gbrain` to run the real-serve regression guard.',
  )
}

describeReal('ND1 — real gbrain serve write→read round-trip (keyword+graph default)', () => {
  test('init guard makes serve work; put_page → search recalls the fact', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-real-serve-'))
    const gbrainHome = join(home, 'gbrain')

    // 1. The init guard (the fix): keyword+graph default, NO embedder.
    const initRes = await ensureBrainInitialized({ gbrainHome, embedder: null })
    expect(initRes.status).toBe('initialized')

    // 2. The production transport: a real `gbrain serve` child over stdio MCP.
    const client = new GBrainStdioMcpClient({
      source: 'default',
      env: { GBRAIN_HOME: gbrainHome },
    })
    try {
      // 3. WRITE (what the scribe does every turn) — must NOT throw
      //    "Connection closed" (the symptom of the uninitialized-brain bug).
      await client.call('put_page', {
        slug: 'nd1-regression-fact',
        content: 'The launch code is BLUEBIRD-42 and the on-call engineer is Dana.',
      })

      // 4. READ (what `memory_search` does on recall) — keyword search over the
      //    real brain, no embedder required.
      const res = (await client.call('search', {
        query: 'launch code on-call engineer',
        limit: 5,
      })) as Array<{ slug?: string; chunk_text?: string }>

      expect(Array.isArray(res)).toBe(true)
      expect(res.length).toBeGreaterThan(0)
      const hit = res.find((r) => r.slug === 'nd1-regression-fact')
      expect(hit).toBeDefined()
      expect(hit?.chunk_text ?? '').toContain('BLUEBIRD-42')
    } finally {
      await client.close()
    }
  }, 60_000)

  // RA3 per-spawn cadence, against a REAL live `gbrain serve` child: the init
  // guard runs exactly once for the life of a connection (no mid-session
  // re-backfill), and a close()+reconnect re-runs it (the recovery boundary).
  test('LIVE gbrain serve: init guard runs once per connection, re-runs on reconnect', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-real-cadence-'))
    const gbrainHome = join(home, 'gbrain')
    await ensureBrainInitialized({ gbrainHome, embedder: null })

    let guardRuns = 0
    const client = new GBrainStdioMcpClient({
      source: 'default',
      env: { GBRAIN_HOME: gbrainHome },
      ensureInitialized: async () => {
        guardRuns += 1
      },
    })
    try {
      await client.call('search', { query: 'a', limit: 1 })
      expect(guardRuns).toBe(1)
      // More ops on the SAME live connection → guard stays latched.
      await client.call('search', { query: 'b', limit: 1 })
      expect(guardRuns).toBe(1)
      // Reconnect → guard re-runs (this is where an outage backfill would fire).
      await client.close()
      await client.call('search', { query: 'c', limit: 1 })
      expect(guardRuns).toBe(2)
    } finally {
      await client.close()
    }
  }, 60_000)
})
