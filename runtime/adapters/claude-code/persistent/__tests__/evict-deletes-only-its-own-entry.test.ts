/**
 * evict-deletes-only-its-own-entry.test.ts — #539, Argus r56/r57/r58.
 *
 * `getOrSpawnSession` resolves a warm session by AWAITING the pooled promise, and then, if the
 * reuse guards refuse it, evicts. The await is a suspension point: a concurrent turn can evict
 * and republish under the same key while we wait, and the eviction that follows used to delete
 * whatever was registered — **taking a live REPL out of the map every turn resolves through.**
 *
 * WHAT EACH CASE OBSERVES, in three layers, because each layer was added when the one below it
 * turned out to be satisfiable by broken code:
 *
 *   1. **the mechanism** — no `pool.delete` was issued while the replacement was registered
 *      (r56, and on its own it is not enough);
 *   2. **the outcome** — the replacement is still the pool entry when the stale turn finishes
 *      (r57: the publish one line later was overwriting it, and layer 1 could not see that);
 *   3. **what comes back** — the value the turn RETURNS (r58: the loser was handed the winner's
 *      promise unvalidated, so a turn could receive a REPL with a tool surface it never asked
 *      for; layers 1 and 2 both passed while it did).
 *
 * WHY A DELIBERATELY MISMATCHED TOOL SURFACE ON THE WARM SESSION: it is the guard that is
 * cheapest to fail on purpose, and failing it is what routes the turn into the eviction branch
 * at all. The case is about what the eviction DELETES, not about which guard refused.
 *
 * WHY THE WINNER'S SURFACE MATCHES: after r58 the loser RE-ENTERS `getOrSpawnSession` rather
 * than returning the winner's promise, so the winner is validated like any pooled candidate. A
 * winner that matched nothing would be legitimately evicted, and then "the replacement is still
 * the entry" would be asserting the wrong thing. A matching winner is also the positive control
 * the ruling asks for: it is REUSED, not respawned.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { AgentSpec } from '../../../../substrate.ts'
import { getOrSpawnSession, quarantinedChildCount, sweepQuarantinedChildren } from '../spawn.ts'
import { classifyThrownSpawnError } from '../classify-spawn-error.ts'
import { childByKey, pool, sink } from '../pool-state.ts'
import { ReplSession } from '../repl-session.ts'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'

const KEY = 'inst r56 evict identity'
const SESSION_ID = 'r56r56r5-1111-2222-3333-444444444444'
const CHANNEL = 'neutron-56565656565656565656565656565656'

/** How much live work the quarantine guard is told the poisoned child hosts. MODULE-LEVEL so
 *  `afterEach` can drain it (r58): a quarantined child is only reaped once its hosted count
 *  reaches zero, and a case that leaves one behind contaminates the NEXT case's count. That is
 *  how the first version of the leaked-child case came to accept `>= 1` where an exact number
 *  belongs — an assertion shaped around a known-dirty fixture, which is worse than a wrong
 *  assertion because it looks deliberate. */
let hostedWork = 0
/** How many times the quarantine guard asked. A case asserts its own premise with it. */
let hostedAsks = 0

beforeEach(() => {
  hostedWork = 0
  hostedAsks = 0
  // A CLEAN BASELINE, ASSERTED. Every count below is exact, and an exact count is only
  // meaningful from zero.
  expect(quarantinedChildCount()).toBe(0)
})

afterEach(async () => {
  // Drain this case's quarantined children before the next one runs: zero the hosted work the
  // guard consults, then sweep, which is the production path for reaping them.
  hostedWork = 0
  await sweepQuarantinedChildren()
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

/** Options whose quarantine guard reports live work, counting the asks. */
function optionsWithLiveWork(): PersistentReplSubstrateOptions {
  return optionsFor({
    hostsLiveWork: () => {
      hostedAsks += 1
      return hostedWork
    },
  })
}

/** A session whose child is alive. By default its tool surface does NOT match the turn's, which
 *  is what routes the turn into the eviction branch. */
function warmSession(
  opts: {
    poisoned?: boolean
    exited?: boolean
    key?: string
    generation?: string
    sessionId?: string
    surface?: string
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
  s.toolSurface = opts.surface ?? 'Read,Bash'
  s.authFingerprint = 'fp'
  s.toolBridgeActive = false
  return s
}

/** The concurrent turn's session — SATISFIES this request: same tool surface, no bridge, and
 *  the empty credential fingerprint `authFingerprintFor(undefined)` returns for these options.
 *  A pooled session like this one is reusable, so the loser that re-enters must reuse it. */
function winnerSession(key: string = KEY): ReplSession {
  const s = warmSession({ key, surface: 'Write', generation: 'gen-r58-winner' })
  s.authFingerprint = ''
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

type Settled = { ok: true; value: ReplSession } | { ok: false; error: unknown }

/**
 * Drive one eviction with a replacement published during the await, and report what the pool
 * holds afterwards AND what the turn returned.
 */
async function evictWithReplacementMidAwait(
  options: PersistentReplSubstrateOptions,
  sessionOpts: { poisoned?: boolean; exited?: boolean } = {},
  /** The session the concurrent turn's entry resolves to. Defaults to one that satisfies this
   *  request, so the re-entering loser reuses it. */
  winner: ReplSession = winnerSession(),
): Promise<{
  deletedWhileRegistered: unknown[]
  pooledAfter: unknown
  replacement: Promise<ReplSession>
  returned: Settled
  winner: ReplSession
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
    const turn: Promise<Settled> = getOrSpawnSession(KEY, options, spec).then(
      (value) => ({ ok: true, value }) as Settled,
      (error) => ({ ok: false, error }) as Settled,
    )
    await settle()

    // A concurrent turn evicts and republishes under the same key.
    let resolveReplacement: (s: ReplSession) => void = () => {}
    const replacement = new Promise<ReplSession>((res) => {
      resolveReplacement = res
    })
    pool.set(KEY, replacement)

    // Only now does our awaited promise resolve — with a session the reuse guards will refuse.
    resolveWarm(warmSession(sessionOpts))
    await settle()
    resolveReplacement(winner)
    const returned = await turn

    return {
      deletedWhileRegistered: deleted.filter((v) => v === replacement),
      pooledAfter: pool.get(KEY),
      replacement,
      returned,
      winner,
    }
  } finally {
    ;(pool as unknown as { delete: (k: string) => boolean }).delete = realDelete
  }
}

describe('an eviction deletes only the entry it resolved through', () => {
  it('the warm-reuse eviction leaves a replacement published mid-await alone', async () => {
    const { deletedWhileRegistered, pooledAfter, replacement, returned, winner } =
      await evictWithReplacementMidAwait(optionsFor())
    expect(deletedWhileRegistered).toEqual([])
    // THE OUTCOME, not just the mechanism: B is still the entry this key resolves through.
    expect(pooledAfter).toBe(replacement)
    // AND WHAT CAME BACK (r58). The winner satisfies this request, so the loser re-entered,
    // validated it and REUSED it — which is also the control that the r58 fix cannot be
    // passing by never reusing anything.
    expect(returned).toEqual({ ok: true, value: winner })
  })

  it('...and so does the quarantine path, which could not name its own entry at all', async () => {
    // `hostsLiveWork` routes the eviction through `quarantineChild`, which took no reference to
    // the entry it was removing — the enumeration counts "cannot name what it owns" as the
    // finding rather than as a site to leave alone, so it is passed one now.
    hostedWork = 1
    const { deletedWhileRegistered, pooledAfter, replacement, returned, winner } =
      await evictWithReplacementMidAwait(optionsWithLiveWork(), { poisoned: true })
    // THE PREMISE, ASSERTED: without this the case could pass while never entering the
    // quarantine branch at all — which is how a mutation on that branch fails to red and the
    // row looks like evidence it is not.
    expect(hostedAsks).toBeGreaterThan(0)
    expect(deletedWhileRegistered).toEqual([])
    expect(pooledAfter).toBe(replacement)
    expect(returned).toEqual({ ok: true, value: winner })
  })

  it('the EXITED-child branch leaves a replacement published mid-await alone too', async () => {
    // The third eviction site: when the warm child has already exited, a different line does
    // the delete. Same suspension point, same rule, and no case reached it until now.
    const { deletedWhileRegistered, pooledAfter, replacement, returned, winner } =
      await evictWithReplacementMidAwait(optionsFor(), { exited: true })
    expect(deletedWhileRegistered).toEqual([])
    expect(pooledAfter).toBe(replacement)
    expect(returned).toEqual({ ok: true, value: winner })
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
 * THE PRIVILEGE BOUNDARY THE r57 FIX OPENED (#539, Argus r58).
 *
 * Round fifty-seven stopped the stale turn publishing over the winner, and returned the
 * winner's promise instead. But the winner was published for a DIFFERENT request, and the
 * reuse guards — tool surface, tool bridge, credential freshness, abandon-poison, child
 * liveness — are exactly what decides whether a pooled session may serve THIS one. Returning
 * the raw promise skipped all of them: a turn asking for one tool surface could be handed a
 * REPL spawned with another, which is the inheritance the surface guard exists to forbid.
 *
 * The fix is to RE-ENTER `getOrSpawnSession`, so the loser asks the same question of the winner
 * that any arriving turn asks of any pooled candidate.
 */
describe('a turn that loses the pool is still subject to the reuse guards', () => {
  it('is not handed a winner whose tool surface it never asked for', async () => {
    // The winner here is a `Read,Bash` session, and the request is for `Write`.
    const mismatched = warmSession({ surface: 'Read,Bash', generation: 'gen-r58-mismatch' })
    mismatched.authFingerprint = ''
    const { returned, winner } = await evictWithReplacementMidAwait(optionsFor(), {}, mismatched)

    // WHATEVER CAME BACK, IT IS NOT THAT SESSION. The turn re-entered, the surface guard
    // refused the winner exactly as it refuses any mismatched pooled session, and the turn went
    // on to spawn (which this host refuses, so the turn rejects — a rejection is a refusal to
    // serve, and serving a `Read,Bash` REPL to a `Write` request is what must not happen).
    if (returned.ok) expect(returned.value).not.toBe(winner)
    else expect(String(returned.error)).toContain('r56-host')
    // Stated positively so the case cannot pass by the turn hanging or returning undefined.
    expect(returned.ok).toBe(false)
  })

  it('...and IS handed one whose surface matches, rather than respawning over it', async () => {
    // The complement, and the control: "never reuse" would pass the case above and be wrong.
    const { returned, winner, pooledAfter, replacement } =
      await evictWithReplacementMidAwait(optionsFor())
    expect(returned).toEqual({ ok: true, value: winner })
    expect(pooledAfter).toBe(replacement)
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
    let killed = false
    hostedWork = 1

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

    const turn = getOrSpawnSession(LEAK_KEY, optionsWithLiveWork(), spec).catch(() => undefined)
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
    resolveReplacement(winnerSession(LEAK_KEY))
    await turn

    // The guard still does its job: B is untouched.
    expect(pool.get(LEAK_KEY)).toBe(replacement)
    // And the three obligations that are not about the pool happened anyway. EXACT counts,
    // from the zero baseline `beforeEach` asserts (r58).
    expect(quarantinedChildCount()).toBe(1)
    expect(childByKey.get(LEAK_KEY)).toBeUndefined()
    expect(killed).toBe(false) // left RUNNING: it hosts live work

    // REGISTERED MEANS REACHABLE. The count is the mechanism; being reaped once the hosted
    // work drains is the outcome, and it is the outcome that says the child is not leaked.
    hostedWork = 0
    expect(await sweepQuarantinedChildren()).toBe(1)
    expect(killed).toBe(true)
    expect(quarantinedChildCount()).toBe(0)

    pool.delete(LEAK_KEY)
  })
})

/**
 * THE TERMINATION BOUND (#539, Argus r59).
 *
 * The r58 fix re-enters `getOrSpawnSession` when the pool entry has been replaced, which raises
 * the question the fix itself has to answer: **what stops a turn that keeps losing?** Unbounded
 * re-entry is a livelock; spawning anyway is the two-owner outcome the whole change exists to
 * prevent; publishing anyway is the r57 defect. So the bound refuses, retryably and classified.
 *
 * The as-built claimed that guarantee and no case established it. These two do, in both
 * directions: contention JUST UNDER the bound still resolves normally, and contention past it
 * refuses — spawning nothing, publishing nothing, and carrying the class that keeps the refusal
 * off the credential cooldown.
 *
 * HOW SUCCESSIVE STALE DECISIONS ARE FORCED. Every earlier race fixture performs exactly one
 * replacement, which can only ever produce one re-entry. Here each pooled session replaces the
 * entry itself, from inside `hasChildExited()` — a synchronous call the turn makes after
 * awaiting the entry and before it reaches the publish point, so the interleaving is exact
 * rather than timing-dependent.
 */
const BOUND_KEY = `${KEY} bound`

/** Build a chain of pooled entries, each of which publishes the next one while the turn that
 *  resolved through it is still deciding. The last link publishes nothing, so the turn that
 *  reaches it decides normally.
 *
 *  Reports what it published and how many replacements it had left, so each case can assert its
 *  own premise — a chain that never fired would make both cases pass for the wrong reason, which
 *  is the vacuity this branch has now produced ten times. */
function publishContendingChain(
  replacements: number,
  finalSession: ReplSession,
): { remaining: () => number; lastPublished: () => Promise<ReplSession> } {
  let left = replacements
  let last: Promise<ReplSession>
  const link = (): Promise<ReplSession> => {
    const session = left > 0 ? warmSession({ key: BOUND_KEY }) : finalSession
    const asExited = session.hasChildExited.bind(session)
    session.hasChildExited = (): boolean => {
      if (left > 0) {
        left -= 1
        last = link()
        pool.set(BOUND_KEY, last)
      }
      return asExited()
    }
    return Promise.resolve(session)
  }
  last = link()
  pool.set(BOUND_KEY, last)
  return { remaining: () => left, lastPublished: () => last }
}

describe('the stale-turn re-entry terminates', () => {
  it('resolves normally when the contention stops just under the bound', async () => {
    let spawnAttempts = 0
    const winner = winnerSession(BOUND_KEY)
    // Three replacements: the turn re-enters at counters 0, 1 and 2 — the last re-entry the
    // bound permits — and the fourth pass finds a winner it may reuse.
    const chain = publishContendingChain(3, winner)
    const options = optionsFor({
      ptyHost: {
        async spawn(): Promise<PtyChild> {
          spawnAttempts += 1
          throw new Error('r59-host: a spawn here means the re-entry gave up too early')
        },
      },
    })
    const returned = await getOrSpawnSession(BOUND_KEY, options, spec)
    // THE PREMISE: all three replacements fired, so the turn really did re-enter three times.
    // Without this the case passes on a chain that never contended at all.
    expect(chain.remaining()).toBe(0)
    expect(returned).toBe(winner)
    expect(spawnAttempts).toBe(0)
    pool.delete(BOUND_KEY)
  })

  it('refuses — retryably and classified — when the contention outlasts the bound', async () => {
    let spawnAttempts = 0
    // One more replacement than the bound allows.
    const chain = publishContendingChain(4, winnerSession(BOUND_KEY))
    const options = optionsFor({
      ptyHost: {
        async spawn(): Promise<PtyChild> {
          spawnAttempts += 1
          throw new Error('r59-host: the refusal must not spawn')
        },
      },
    })
    const outcome = await getOrSpawnSession(BOUND_KEY, options, spec).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    // THE CLASS, THROUGH THE CLASSIFIER rather than by reading the field: the stamp is only
    // worth anything if it survives the taxonomy validation the consumer performs (r43).
    expect(classifyThrownSpawnError(outcome.error)).toBe('repl_unreconciled')
    expect(String(outcome.error)).toContain('replaced by a concurrent turn')
    // NOTHING SPAWNED, AND NOTHING PUBLISHED. The refusal's whole point is that it takes no
    // action on a key another turn is actively serving.
    expect(spawnAttempts).toBe(0)
    // THE PREMISE, and the "published nothing" assertion in one: the entry is exactly the last
    // one the CHAIN published, so the refusing turn neither spawned over it nor removed it —
    // and `remaining() === 0` says the contention really outlasted the bound.
    expect(chain.remaining()).toBe(0)
    expect(pool.get(BOUND_KEY)).toBe(chain.lastPublished())
    pool.delete(BOUND_KEY)
  })
})
