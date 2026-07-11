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
import { GBrainStdioMcpClient, composeGbrainChildEnv } from '../gbrain-stdio-client.ts'
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

// RA3 — the init guard is re-armed whenever a connect attempt does NOT yield a
// live client (a transient connect failure, or an explicit close()), so the
// NEXT attempt re-runs it. This is what lets a key captured AFTER a failed (or
// closed) connection trigger its per-connect key re-resolve + the marker-gated,
// idempotent `embed --stale` backfill on the next spawn. `initGuardDone` is
// latched optimistically BEFORE the spawn, so without the re-arm a failed first
// connect would leave it stuck `true` and every retry would skip the guard
// (Codex blocker). NB: on a SUCCESSFUL connect the guard stays latched, so a
// live persistent session never re-runs it — activation is a per-spawn boundary,
// not a mid-session hot-swap (cadence in build-gbrain-memory.ts:resolveOpenAiKey).
describe('GBrainStdioMcpClient — init guard re-arms when no live client (transient-failure key pickup)', () => {
  test('a failed connect re-arms the guard so the next attempt re-runs it AND observes a key stored since', async () => {
    // `/usr/bin/true` exists (so this is NOT the binary-missing latch) but exits
    // immediately, so `client.connect` fails fast with a transport-closed error
    // AFTER the init guard has run — letting us observe the guard, and the key it
    // would see, WITHOUT a live MCP server.
    const seen: Array<string | undefined> = []
    let stored: string | undefined
    const client = new GBrainStdioMcpClient({
      command: '/usr/bin/true',
      ensureInitialized: async () => {
        seen.push(stored)
      },
    })

    // Attempt 1: no key yet. Connect fails → the finally re-arms the guard.
    await client.call('get_links', { slug: 'x' }).catch(() => {})
    expect(seen).toEqual([undefined])

    // Key stored BETWEEN attempts, with NO explicit close(). The next memory op
    // must re-run the guard and observe the newly-stored key (pre-fix: the guard
    // stayed latched after the failed connect → this second read never happened →
    // the brain would stay on Ollama despite the key).
    stored = 'sk-late'
    await client.call('get_links', { slug: 'x' }).catch(() => {})
    expect(seen).toEqual([undefined, 'sk-late'])
  })

  test('close() also re-arms the guard (explicit-teardown reconnect boundary)', async () => {
    let runs = 0
    const client = new GBrainStdioMcpClient({
      command: '/usr/bin/true',
      ensureInitialized: async () => {
        runs += 1
      },
    })
    await client.call('get_links', { slug: 'x' }).catch(() => {})
    expect(runs).toBe(1)
    await client.close()
    await client.call('get_links', { slug: 'x' }).catch(() => {})
    expect(runs).toBe(2)
  })
})

// composeGbrainChildEnv — the boot-time-vs-spawn-time env merge that lets an
// embedder opted in AFTER process boot still activate (the onboarding/admin
// OpenAI key is captured over the already-running server). The lazy
// `resolveDynamicEnv` is merged OVER the static `env` at each spawn.
describe('composeGbrainChildEnv', () => {
  test('static env only → passed through over the base (keyword + graph)', async () => {
    const env = await composeGbrainChildEnv(
      { env: { GBRAIN_HOME: '/h/gbrain' }, source: 'default' },
      { PATH: '/usr/bin' },
    )
    expect(env).toMatchObject({ PATH: '/usr/bin', GBRAIN_HOME: '/h/gbrain', GBRAIN_SOURCE: 'default' })
    expect(env['GBRAIN_EMBEDDING_MODEL']).toBeUndefined()
  })

  test('resolveDynamicEnv merges the embedding seam OVER the static env at spawn', async () => {
    const env = await composeGbrainChildEnv(
      {
        env: { GBRAIN_HOME: '/h/gbrain' },
        source: 'default',
        brainId: 'acme-brain',
        resolveDynamicEnv: async () => ({
          GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
          GBRAIN_EMBEDDING_DIMENSIONS: '3072',
          OPENAI_API_KEY: 'sk-late',
        }),
      },
      {},
    )
    expect(env).toEqual({
      GBRAIN_HOME: '/h/gbrain',
      GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
      GBRAIN_EMBEDDING_DIMENSIONS: '3072',
      OPENAI_API_KEY: 'sk-late',
      GBRAIN_BRAIN_ID: 'acme-brain',
      GBRAIN_SOURCE: 'default',
    })
  })

  test('a throwing resolveDynamicEnv is fail-soft → keyword + graph, never blocks the spawn', async () => {
    const env = await composeGbrainChildEnv(
      {
        env: { GBRAIN_HOME: '/h/gbrain' },
        resolveDynamicEnv: async () => {
          throw new Error('store unreachable')
        },
      },
      {},
    )
    expect(env).toEqual({ GBRAIN_HOME: '/h/gbrain' })
  })

  test('an empty dynamic env (key absent) leaves the static keyword env intact', async () => {
    const env = await composeGbrainChildEnv(
      { env: { GBRAIN_HOME: '/h/gbrain' }, resolveDynamicEnv: async () => ({}) },
      {},
    )
    expect(env).toEqual({ GBRAIN_HOME: '/h/gbrain' })
  })
})
