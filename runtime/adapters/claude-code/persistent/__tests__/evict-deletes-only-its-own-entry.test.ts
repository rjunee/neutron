/**
 * evict-deletes-only-its-own-entry.test.ts — #539, Argus r56.
 *
 * `getOrSpawnSession` resolves a warm session by AWAITING the pooled promise, and then, if the
 * reuse guards refuse it, evicts. The await is a suspension point: a concurrent turn can evict
 * and republish under the same key while we wait, and the eviction that follows used to delete
 * whatever was registered — **taking a live REPL out of the map every turn resolves through.**
 *
 * These are the two sites the round-fifty-six enumeration turned up that no case reached. Both
 * are driven the same way: a pooled promise the case controls, a replacement installed while it
 * is pending, and a warm session that fails its reuse guard so the eviction path runs.
 *
 * WHY A DELIBERATELY MISMATCHED TOOL SURFACE: it is the guard that is cheapest to fail on
 * purpose, and failing it is what routes the turn into the eviction branch at all. The case is
 * about what the eviction DELETES, not about which guard refused.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import type { AgentSpec } from '../../../../substrate.ts'
import { getOrSpawnSession } from '../spawn.ts'
import { childByKey, pool, sink } from '../pool-state.ts'
import { ReplSession } from '../repl-session.ts'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'

const KEY = 'inst r56 evict identity'
const SESSION_ID = 'r56r56r5-1111-2222-3333-444444444444'
const CHANNEL = 'neutron-56565656565656565656565656565656'

afterEach(() => {
  pool.clear()
  childByKey.clear()
  sink.unregister(SESSION_ID)
})

/** A host that refuses to spawn: every case here ends at the eviction, and a spawn attempt
 *  afterwards is how the turn terminates without building a whole fake `claude`. */
const refusingHost: PtyHost = {
  async spawn(): Promise<PtyChild> {
    throw new Error('r56-host: spawn is not part of these cases')
  },
}

function optionsFor(extra: Partial<PersistentReplSubstrateOptions> = {}): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'r56',
    cwd: '/tmp',
    ptyHost: refusingHost,
    skipTrustSeed: true,
    idleQuietMs: 0,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    ...extra,
  } as unknown as PersistentReplSubstrateOptions
}

/** A warm session whose child is alive and whose tool surface will NOT match the turn's. */
function warmSession(opts: { poisoned?: boolean; exited?: boolean } = {}): ReplSession {
  const s = new ReplSession(KEY, 'gen-r56', SESSION_ID, CHANNEL, '/tmp')
  let exited = opts.exited ?? false
  s.attachChild({
    pid: 4242,
    write: () => {},
    kill: () => {
      exited = true
    },
    exited: Promise.resolve(null),
    hasExited: () => exited,
    wasKilledByUs: () => true,
  } as PtyChild)
  // POISONED routes the eviction through the quarantine branch, which is the only way to
  // reach `quarantineChild` — asserted by the premise check in that case rather than assumed.
  if (opts.poisoned === true) s.poisoned = true
  s.toolSurface = 'Read,Bash'
  s.authFingerprint = 'fp'
  s.toolBridgeActive = false
  return s
}

const spec: AgentSpec = {
  // A DIFFERENT surface from the warm session's, which is what makes the reuse guard refuse.
  prompt: 'hi',
  tools: [{ name: 'Write' } as never],
  model_preference: ['claude-opus-5'],
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

/**
 * Drive one eviction with a replacement published during the await, and report what the pool
 * holds afterwards.
 */
/**
 * WHAT IS OBSERVED, and why it is the deletions rather than the final map state. A turn that
 * refuses a warm session goes on to SPAWN, and publishing its own entry over whatever is
 * registered is legitimate — "don't delete somebody else's" is the rule, not "never replace".
 * So the map's contents at the end say nothing about the eviction; what says it is whether a
 * DELETE was ever issued while the replacement was the registered entry.
 */
async function evictWithReplacementMidAwait(
  options: PersistentReplSubstrateOptions,
  sessionOpts: { poisoned?: boolean; exited?: boolean } = {},
): Promise<{ deletedWhileRegistered: unknown[]; replacement: Promise<ReplSession> }> {
  let resolveWarm: (s: ReplSession) => void = () => {}
  const warm = new Promise<ReplSession>((res) => {
    resolveWarm = res
  })
  pool.set(KEY, warm)

  // Every delete, with what was registered at the moment it was issued.
  const deleted: unknown[] = []
  const realDelete = pool.delete.bind(pool)
  ;(pool as unknown as { delete: (k: string) => boolean }).delete = (k: string) => {
    if (k === KEY) deleted.push(pool.get(KEY))
    return realDelete(k)
  }

  try {
    // The turn starts and suspends on the pooled promise.
    const turn = getOrSpawnSession(KEY, options, spec).catch(() => undefined)
    await settle()

    // A concurrent turn evicts and republishes under the same key.
    const replacement = new Promise<ReplSession>(() => {})
    pool.set(KEY, replacement)

    // Only now does our awaited promise resolve — with a session the reuse guards will refuse.
    resolveWarm(warmSession(sessionOpts))
    await turn

    return { deletedWhileRegistered: deleted.filter((v) => v === replacement), replacement }
  } finally {
    ;(pool as unknown as { delete: (k: string) => boolean }).delete = realDelete
  }
}

describe('an eviction deletes only the entry it resolved through', () => {
  it('the warm-reuse eviction leaves a replacement published mid-await alone', async () => {
    const { deletedWhileRegistered } = await evictWithReplacementMidAwait(optionsFor())
    expect(deletedWhileRegistered).toEqual([])
  })

  it('...and so does the quarantine path, which could not name its own entry at all', async () => {
    // `hostsLiveWork` routes the eviction through `quarantineChild`, which took no reference to
    // the entry it was removing — the enumeration counts "cannot name what it owns" as the
    // finding rather than as a site to leave alone, so it is passed one now.
    let asked = 0
    const { deletedWhileRegistered } = await evictWithReplacementMidAwait(
      optionsFor({
        hostsLiveWork: () => {
          asked += 1
          return 1
        },
      }),
      { poisoned: true },
    )
    // THE PREMISE, ASSERTED: without this the case could pass while never entering the
    // quarantine branch at all — which is how a mutation on that branch fails to red and the
    // row looks like evidence it is not.
    expect(asked).toBeGreaterThan(0)
    expect(deletedWhileRegistered).toEqual([])
  })

  it('the EXITED-child branch leaves a replacement published mid-await alone too', async () => {
    // The third eviction site: when the warm child has already exited, a different line does
    // the delete. Same suspension point, same rule, and no case reached it until now.
    const { deletedWhileRegistered } = await evictWithReplacementMidAwait(optionsFor(), {
      exited: true,
    })
    expect(deletedWhileRegistered).toEqual([])
  })

  it('...and with NO replacement the eviction still removes its own entry', async () => {
    // The positive control for both: guarding must not become "never evict", or a refused warm
    // session stays in the pool and every later turn resolves through it.
    let resolveWarm: (s: ReplSession) => void = () => {}
    const warm = new Promise<ReplSession>((res) => {
      resolveWarm = res
    })
    pool.set(KEY, warm)
    const turn = getOrSpawnSession(KEY, optionsFor(), spec).catch(() => undefined)
    await settle()
    resolveWarm(warmSession())
    await turn
    expect(pool.get(KEY)).toBeUndefined()
  })
})
