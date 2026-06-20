/**
 * Deterministic port-bind regression tests for #314.
 *
 * Bug: on restart, when the Open server's configured port (default 7800 via
 * NEUTRON_PORT) was transiently held by the dying old process, boot did NOT
 * ride out the brief overlap — it failed/raced, and the user's bookmarked
 * http://127.0.0.1:7800 broke. A configured port must be bound DETERMINISTICALLY:
 * retry through a bounded window (the old process releasing the socket), then
 * FAIL LOUD — never silently bind a different port. Only the genuine "pick
 * anything" case (port 0, dev/tests) auto-selects a free port.
 *
 * These are REAL tests: they stand up an actual Bun.serve squatter on a fixed
 * port and exercise `bindHttpListener` against it (no mock-only assertions).
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { bindHttpListener } from './boot-helpers.ts'

type Stoppable = { port?: number | undefined; stop: (force?: boolean) => void | Promise<void> }

const cleanup: Stoppable[] = []

afterEach(() => {
  while (cleanup.length > 0) {
    const s = cleanup.pop()
    try {
      void s?.stop(true)
    } catch {
      /* already gone */
    }
  }
})

function squat(): { server: Stoppable; port: number } {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('squatter'),
  }) as unknown as Stoppable
  cleanup.push(server)
  return { server, port: server.port! }
}

function serveOn(port: number): Stoppable {
  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    fetch: () => new Response('ok'),
  }) as unknown as Stoppable
}

describe('bindHttpListener — deterministic configured-port bind (#314)', () => {
  test('FAILS LOUD when a configured port stays occupied — never silently moves', async () => {
    const { port } = squat() // squatter holds `port` for the whole test
    let bound: Stoppable | undefined
    let threw: Error | undefined
    try {
      bound = await bindHttpListener({
        port,
        serve: () => serveOn(port),
        retryWindowMs: 400,
        retryIntervalMs: 50,
      })
      if (bound) cleanup.push(bound)
    } catch (err) {
      threw = err as Error
    }
    // It must NOT have bound a (different, random) port — it must fail loud.
    expect(bound).toBeUndefined()
    expect(threw).toBeDefined()
    expect(threw!.message).toContain(String(port))
    expect(threw!.message).toMatch(/in use/i)
    expect(threw!.message).toMatch(/NEUTRON_PORT/)
  })

  test('binds the configured port AFTER the old process releases it (bounded retry)', async () => {
    const { server: squatter, port } = squat()
    // The "dying old process" releases the socket shortly after boot starts.
    setTimeout(() => {
      void squatter.stop(true)
    }, 250)
    const bound = await bindHttpListener({
      port,
      serve: () => serveOn(port),
      retryWindowMs: 5_000,
      retryIntervalMs: 50,
    })
    cleanup.push(bound)
    expect(bound.port).toBe(port) // the SAME configured port, not a random one
  })

  test('control: port 0 auto-selects a free port (genuine pick-anything, no retry)', async () => {
    let attempts = 0
    const bound = await bindHttpListener({
      port: 0,
      serve: () => {
        attempts += 1
        return serveOn(0)
      },
    })
    cleanup.push(bound)
    expect(bound.port).toBeGreaterThan(0)
    expect(attempts).toBe(1) // single attempt — no deterministic retry loop
  })

  test('non-EADDRINUSE errors rethrow immediately (no retry masking real bugs)', async () => {
    let attempts = 0
    const boom = new Error('transport mismatch')
    await expect(
      bindHttpListener({
        port: 7_801,
        serve: () => {
          attempts += 1
          throw boom
        },
        retryWindowMs: 5_000,
        retryIntervalMs: 50,
      }),
    ).rejects.toThrow('transport mismatch')
    expect(attempts).toBe(1) // failed fast, did not enter the retry window
  })
})
