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
import { getOrSpawnSession, quarantinedChildCount, sweepQuarantinedChildren } from '../spawn.ts'
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
function warmSession(
  opts: {
    poisoned?: boolean
    exited?: boolean
    key?: string
    generation?: string
    sessionId?: string
    onKill?: () => void
  } = {},
): ReplSession {
  const s = new ReplSession(
    opts.key ?? KEY,
    opts.generation ?? 'gen-r56',
    opts.sessionId ?? SESSION_ID,
    CHANNEL,
    '/tmp',
  )
  let exited = opts.exited ?? false
  // A LIVE CHILD'S `exited` IS PENDING. It was `Promise.resolve(null)` — an already-dead
  // child — and that quietly un-quarantined every quarantined child on the next microtask,
  // because the reaper hook fires on that promise and drops the entry. A fixture that says
  // "alive" in one field and "dead" in another can only test one of them.
  let markExited: () => void = () => {}
  const exitedPromise = new Promise<null>((res) => {
    markExited = () => res(null)
  })
  if (exited) markExited()
  s.attachChild({
    pid: 4242,
    write: () => {},
    kill: () => {
      exited = true
      markExited()
      opts.onKill?.()
    },
    exited: exitedPromise,
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
 * WHAT IS OBSERVED — and round fifty-seven changed the answer, because the first version
 * **asserted the mechanism and dismissed the harm.**
 *
 * It recorded deletes and explicitly ignored the final map state, on the reasoning that a turn
 * which refuses a warm session legitimately publishes its own entry afterwards. But the harm is
 * *"B is no longer the pool entry"*, and by-delete versus by-overwrite is a detail of HOW — so a
 * case that watched only deletes passed while the unconditional publish orphaned B anyway. The
 * ninth fixture vacuity on this branch and the sharpest of the family.
 *
 * So both are asserted now: no delete was issued while the replacement was registered, **and the
 * replacement is still the entry when the stale turn finishes.** The second is what turned the
 * unconditional publish into a finding.
 */
async function evictWithReplacementMidAwait(
  options: PersistentReplSubstrateOptions,
  sessionOpts: { poisoned?: boolean; exited?: boolean } = {},
): Promise<{
  deletedWhileRegistered: unknown[]
  pooledAfter: unknown
  replacement: Promise<ReplSession>
}> {
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
    // IT RESOLVES, and late (Argus r57). Under the fix a stale turn SERVES the entry it found
    // rather than publishing over it, so the turn's own promise now adopts the replacement — a
    // replacement that never settled would hang the case rather than fail it, which is exactly
    // the kind of "green because nothing finished" the fixture audits are about.
    let resolveReplacement: (s: ReplSession) => void = () => {}
    const replacement = new Promise<ReplSession>((res) => {
      resolveReplacement = res
    })
    pool.set(KEY, replacement)

    // Only now does our awaited promise resolve — with a session the reuse guards will refuse.
    resolveWarm(warmSession(sessionOpts))
    await settle()
    resolveReplacement(warmSession())
    await turn

    return {
      deletedWhileRegistered: deleted.filter((v) => v === replacement),
      pooledAfter: pool.get(KEY),
      replacement,
    }
  } finally {
    ;(pool as unknown as { delete: (k: string) => boolean }).delete = realDelete
  }
}

describe('an eviction deletes only the entry it resolved through', () => {
  it('the warm-reuse eviction leaves a replacement published mid-await alone', async () => {
    const { deletedWhileRegistered, pooledAfter, replacement } =
      await evictWithReplacementMidAwait(optionsFor())
    expect(deletedWhileRegistered).toEqual([])
    // THE OUTCOME, not just the mechanism: B is still the entry this key resolves through.
    expect(pooledAfter).toBe(replacement)
  })

  it('...and so does the quarantine path, which could not name its own entry at all', async () => {
    // `hostsLiveWork` routes the eviction through `quarantineChild`, which took no reference to
    // the entry it was removing — the enumeration counts "cannot name what it owns" as the
    // finding rather than as a site to leave alone, so it is passed one now.
    let asked = 0
    const { deletedWhileRegistered, pooledAfter, replacement } = await evictWithReplacementMidAwait(
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
    expect(pooledAfter).toBe(replacement)
  })

  it('the EXITED-child branch leaves a replacement published mid-await alone too', async () => {
    // The third eviction site: when the warm child has already exited, a different line does
    // the delete. Same suspension point, same rule, and no case reached it until now.
    const { deletedWhileRegistered, pooledAfter, replacement } =
      await evictWithReplacementMidAwait(optionsFor(), { exited: true })
    expect(deletedWhileRegistered).toEqual([])
    expect(pooledAfter).toBe(replacement)
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

/**
 * THE OTHER DIRECTION OF THE SAME MISTAKE (#539, Argus r57).
 *
 * Rounds fifty-three through fifty-six put identity guards on the pool deletes. Round
 * fifty-seven found one of them written as an early `return` at the top of `quarantineChild`,
 * so "this pool entry is not ours" silenced three obligations that were never about the pool:
 * the child stayed in `childByKey` (routable), it was never registered with the quarantine
 * reaper (unreapable), and it got no exit notification — while the caller recorded the
 * quarantine as done and therefore did NOT terminate it either. A live child, leaked.
 *
 * A missing guard drops a map entry; a guard scoped too widely leaks a process.
 */
describe('a pool-scoped guard does not drop the obligations that are not about the pool', () => {
  it('quarantines the poisoned child even when the pool entry belongs to somebody else', async () => {
    const LEAK_KEY = `${KEY} leak`
    const GENERATION = 'gen-r57-leak'
    let hosted = 1
    let killed = false

    let resolveWarm: (s: ReplSession) => void = () => {}
    const warm = new Promise<ReplSession>((res) => {
      resolveWarm = res
    })
    pool.set(LEAK_KEY, warm)

    const session = warmSession({
      poisoned: true,
      key: LEAK_KEY,
      generation: GENERATION,
      sessionId: 'r57r57r5-1111-2222-3333-444444444444',
      onKill: () => {
        killed = true
      },
    })
    // The child is routable before the turn runs, which is what makes the `childByKey`
    // obligation observable at all — without this the delete is a no-op and the assertion
    // about it says nothing.
    childByKey.set(LEAK_KEY, session.child)

    const quarantinedBefore = quarantinedChildCount()
    const turn = getOrSpawnSession(
      LEAK_KEY,
      optionsFor({ hostsLiveWork: () => hosted }),
      spec,
    ).catch(() => undefined)
    await settle()

    // A concurrent turn republishes under this key while we are suspended, so the pool entry
    // this turn resolved through is no longer the registered one.
    let resolveReplacement: (s: ReplSession) => void = () => {}
    const replacement = new Promise<ReplSession>((res) => {
      resolveReplacement = res
    })
    pool.set(LEAK_KEY, replacement)
    resolveWarm(session)
    await settle()
    resolveReplacement(warmSession({ key: LEAK_KEY }))
    await turn

    // The guard still does its job: B is untouched.
    expect(pool.get(LEAK_KEY)).toBe(replacement)
    // And the three obligations that are not about the pool happened anyway.
    expect(quarantinedChildCount()).toBe(quarantinedBefore + 1)
    expect(childByKey.get(LEAK_KEY)).toBeUndefined()
    expect(killed).toBe(false) // left RUNNING: it hosts live work

    // REGISTERED MEANS REACHABLE. The count is the mechanism; being reaped once the hosted
    // work drains is the outcome, and it is the outcome that says the child is not leaked.
    hosted = 0
    expect(await sweepQuarantinedChildren()).toBeGreaterThanOrEqual(1)
    expect(killed).toBe(true)
    expect(quarantinedChildCount()).toBe(quarantinedBefore)
  })
})
