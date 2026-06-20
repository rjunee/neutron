/**
 * GBrainStdioMcpClient — binary-missing latch (2026-06-10
 * wow-hang-resilience; prod incident t-33333333).
 *
 * When the `gbrain` binary is absent, the client must:
 *   1. surface the failure as `GBrainUnavailableError`, and
 *   2. LATCH — subsequent calls fail fast WITHOUT re-attempting the
 *      spawn (pre-fix, every entity-page sync re-spawned + re-failed,
 *      producing a per-page/per-edge log storm).
 */

import { describe, expect, test } from 'bun:test'
import { GBrainStdioMcpClient } from '../gbrain-stdio-client.ts'
import { GBrainUnavailableError } from '../memory-store.ts'

describe('GBrainStdioMcpClient — binary-missing latch', () => {
  test('missing binary → GBrainUnavailableError on first call, fast latched failure on the second', async () => {
    const client = new GBrainStdioMcpClient({
      command: 'neutron-test-definitely-not-a-real-binary-xyz',
    })
    // First call attempts the spawn and fails.
    let first: unknown = null
    try {
      await client.call('get_links', { slug: 'x' })
    } catch (err) {
      first = err
    }
    expect(first).toBeInstanceOf(GBrainUnavailableError)

    // Second call must fail fast from the latch (no re-spawn). A spawn
    // attempt costs >1ms; the latch path is a synchronous throw inside
    // the promise — bound it generously at 50ms to keep CI happy while
    // still proving no transport work happened.
    const t0 = performance.now()
    let second: unknown = null
    try {
      await client.call('get_links', { slug: 'x' })
    } catch (err) {
      second = err
    }
    const elapsed = performance.now() - t0
    expect(second).toBeInstanceOf(GBrainUnavailableError)
    expect(elapsed).toBeLessThan(50)
  })
})
