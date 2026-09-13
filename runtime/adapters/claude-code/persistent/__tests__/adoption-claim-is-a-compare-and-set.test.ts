/**
 * adoption-claim-is-a-compare-and-set.test.ts — #539, Argus r37.
 *
 * THE DEFECT: `claimRowOrUnwind` VERIFIED, and a verification is not a claim. Everything
 * inside its locked section only READ the row — handle, generation, pid — and the lock was
 * released the moment the callback returned, with `publish()` still to come. So two
 * incarnations could each take the lock in turn, each find the row exactly as it expected
 * BECAUSE the other had only looked at it, and each publish an attached wrapper onto the
 * same pane. Two owners of one live transcript: the single invariant this whole item
 * exists to hold, defeated by a check that wrote nothing.
 *
 * Nothing already in the row could tell them apart. `child_generation` is RESTORED from
 * the row on adoption rather than minted (that is what makes the reply credential resolve
 * across a restart, #537), so both claimants carry the same one; the pid is the same pane's
 * process. Only a WRITE distinguishes them, so the claim became a compare-and-set:
 * `adoption_claim_by` + `adoption_claim_at` — the same shape as `supervision.ts`'s
 * `respawn_in_flight_at`.
 *
 * AND THEN A SECOND DEFECT INSIDE THE FIRST REMEDY (r38). The marker was bounded by a bare
 * time-since-adoption, which answers "how long ago did somebody claim this" while the
 * question being asked is "is that somebody still alive". A healthy owner's claim therefore
 * aged out underneath it and the next gateway to boot was entitled to attach a second
 * wrapper: the same two-owner outcome, defeated by the clock instead of by a race. So the
 * owner RENEWS on its supervision tick, `ADOPTION_CLAIM_TAKEOVER_MS` is a multiple of that
 * tick's interval, and what expires is a claim nobody is refreshing.
 *
 * WHAT BOUNDS THE CRASH, which is the harder half. A claimant that dies between marking and
 * publishing leaves a marker nobody will ever clear, and a permanent one would wedge the row
 * so that NOTHING could adopt that pane again — a REPL preserved across the restart and then
 * unreachable forever, which is worse than the defect being fixed. Three things bound it:
 * every path that stops owning a session gives its own claim back (CAS'd, so it can only
 * ever release its own); a claim whose gateway PROCESS is provably gone is taken over at
 * once; and past the threshold an unrefreshed claim is ignored whatever the pid says.
 *
 * WHY A SEAM. In-process the CAS and the publish run in one synchronous stretch, so no
 * second pass can be scheduled between them and the race cannot be built at all. The
 * cheaper fixture — hand-write a rival's marker into the row and watch the pass refuse —
 * tests the refusal while leaving the marker WRITE unexercised: delete the write and that
 * case stays green. `deps.afterRowClaim` opens the real window instead, so the marker this
 * suite refuses against is one the code under test actually wrote.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  armSelfFence,
  fencedReasonFor,
  setFenceTimerFactoryForTests,
  releaseAdoptionClaim,
  renewAdoptionClaim,
  renewClaimForSession,
  reconcileOwnRepl,
  resetBootAdoptionForTests,
} from '../boot-adoption.ts'
import { getOrSpawnSession } from '../spawn.ts'
import type { ReplSession } from '../repl-session.ts'
import type { AgentSpec } from '../../../../substrate.ts'
import { childByKey, pool, sink, supervisedBySessionKey } from '../pool-state.ts'
import { shutdownAllPersistentRepls } from '../pool.ts'
import {
  ADOPTION_CLAIM_TAKEOVER_MS,
  DEFAULT_WATCHDOG_INTERVAL_MS,
  SELF_FENCE_AFTER_MS,
} from '../signatures.ts'
import { runReplWatchdogTick } from '../supervision.ts'
import type { ReplRegistry, ReplRegistryRecord } from '../repl-registry.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'
import { FakeAdoptableHost } from './boot-adoption-host.ts'
import { setFlockImplForTests } from '../registry-lock.ts'

const KEY = 'inst user proj cred'
const SESSION_ID = 'bbbbbbbb-5555-6666-7777-888888888888'
const CHANNEL = 'neutron-abcdef0123456789abcdef0123456789'
const GENERATION = 'gen-cas-3333'
const HANDLE = 'w9:p37'

const dirs: string[] = []
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'neutron-539-cas-'))
  dirs.push(d)
  return d
}

const oursArgv = (): string[] => [
  'claude',
  '--resume',
  SESSION_ID,
  '--dangerously-load-development-channels',
  `server:${CHANNEL}`,
]

type RowOverride = { [K in keyof ReplRegistryRecord]?: ReplRegistryRecord[K] | undefined }

function writeRegistry(path: string, over: RowOverride = {}): void {
  const row = {
    sessionKey: KEY,
    sessionId: SESSION_ID,
    cwd: '/tmp',
    channelName: CHANNEL,
    has_session: true,
    pid: 4242,
    devchannel_port: 45999,
    child_generation: GENERATION,
    pane_handle: HANDLE,
    reuse: { tool_surface: 'Read', tool_bridge: false, auth_fingerprint: 'fp-cas' },
    ...over,
  }
  const registry: ReplRegistry = { [KEY]: row as ReplRegistryRecord }
  writeFileSync(path, JSON.stringify(registry, null, 2))
}

function readRow(path: string): ReplRegistryRecord | undefined {
  return (JSON.parse(readFileSync(path, 'utf8')) as ReplRegistry)[KEY]
}

interface Fixture {
  options: PersistentReplSubstrateOptions
  host: FakeAdoptableHost
  registryPath: string
}

function fixture(over: RowOverride = {}): Fixture {
  const registryPath = join(scratch(), 'repl-registry.json')
  writeRegistry(registryPath, over)
  const host = new FakeAdoptableHost()
  host.addPane(HANDLE, { argv: oursArgv(), screens: ['idle screen'], pid: 4242 })
  const options = {
    substrate_instance_id: 'inst',
    model_preference: ['claude-opus-5'],
    replRegistryPath: registryPath,
    project_id: 'proj',
    cwd: '/tmp',
    ptyHost: host,
  } as unknown as PersistentReplSubstrateOptions
  return { options, host, registryPath }
}

/** What a pass may be told about the world: where the seam is, what time it is, and
 *  whether the process holding any existing claim is still there. */
interface PassOpts {
  afterRowClaim?: () => Promise<void> | void
  /** Capture this pass's diagnostics, so a case can assert what the pass DID and did not do
   *  — the priming line is the observable for "a screen was delivered to this wrapper". */
  log?: (msg: string) => void
  /** WHICH GATEWAY this pass is, as its claim records it. Two incarnations in one test
   *  process share `process.pid`, and the claim predicate deliberately does not let a
   *  gateway be blocked by its OWN process's earlier claim (a respawn must not refuse
   *  itself) — so a case that models two gateways gives them two pids. */
  claimantPid?: number
  /** The clock the claim reads — so a case can cross the takeover threshold without
   *  sleeping through ninety seconds. */
  now?: () => number
  /** Two incarnations in one test process share a pid, so the REAL probe can only ever
   *  answer `alive` and the takeover-on-death path would be unreachable without this. */
  claimantLiveness?: (pid: number) => 'alive' | 'gone' | 'unknown'
}

/** One incarnation's pass. Every dep here is one the rest of the suite injects too. */
function pass(
  f: Fixture,
  opts: PassOpts = {},
): Promise<Awaited<ReturnType<typeof reconcileOwnRepl>>> {
  return reconcileOwnRepl(f.options, KEY, {
    host: f.host,
    health: async () => true,
    log: () => {},
    ...opts,
  })
}

/**
 * ONE SUPERVISION TICK, at the time the case says it is — the renewal's real carrier.
 *
 * Driven through `runReplWatchdogTick` rather than by calling the renewal directly,
 * because what these cases have to establish is that the renewal is WIRED: a refresh
 * function nothing invokes leaves the claim expiring exactly as it did before. The probes
 * are pinned healthy so the tick takes no other action.
 */
async function tickAt(f: Fixture, nowMs: number): Promise<void> {
  await runReplWatchdogTick(f.options, {
    now: () => nowMs,
    healthProbe: async () => true,
    isPidAlive: () => true,
  })
}

/**
 * A tick whose probe says the REPL is DEAD, with every actuation it might take captured.
 *
 * THE PROBE'S VERDICT IS WHAT TURNS A FENCED TICK FROM INERT INTO DESTRUCTIVE, and every
 * existing fencing case pinned the probe healthy — so the whole class was invisible: a tick
 * that has just concluded it does not own the pane would otherwise emit a crash notice, patch
 * the winner's row and respawn over it.
 */
async function unhealthyTickAt(
  f: Fixture,
  nowMs: number,
): Promise<{ crashes: string[]; alerts: string[]; results: Array<{ action: string; respawned: boolean }> }> {
  const crashes: string[] = []
  const alerts: string[] = []
  const options = {
    ...f.options,
    onChildCrash: async (n: { sessionKey: string }) => {
      crashes.push(n.sessionKey)
    },
  } as unknown as PersistentReplSubstrateOptions
  const results = await runReplWatchdogTick(options, {
    now: () => nowMs,
    // DEAD in both of the ways the probe can say so, because `detectReplWedged` needs the
    // combination to reach a wedge verdict rather than an inconclusive one.
    healthProbe: async () => false,
    isPidAlive: () => false,
    postAlert: (text: string) => {
      alerts.push(text)
    },
  })
  return { crashes, alerts, results: results.map((r) => ({ action: r.action, respawned: r.respawned })) }
}

/** The gateway owns this key, which is what makes the tick visit it. */
function supervise(f: Fixture): void {
  supervisedBySessionKey.set(KEY, {
    replRegistryPath: f.registryPath,
  } as unknown as PersistentReplSubstrateOptions)
}

beforeAll(async () => {
  await sink.ensureStarted({ tokenPath: join(scratch(), 'sink-token') })
})

beforeEach(() => resetBootAdoptionForTests())

afterEach(() => {
  setFenceTimerFactoryForTests(undefined)
  setFlockImplForTests(undefined)
  resetBootAdoptionForTests()
  supervisedBySessionKey.clear()
  pool.clear()
  childByKey.clear()
  sink.unregister(SESSION_ID)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('two incarnations racing for one row', () => {
  it('the one that did not claim it refuses, and only one wrapper is left on the pane', async () => {
    const f = fixture()

    // A RUNS TO ITS CLAIM AND STOPS THERE — after the compare-and-set, before the
    // publish. The window a verification left open.
    let enteredGap!: () => void
    const inGap = new Promise<void>((res) => {
      enteredGap = res
    })
    let releaseGap!: () => void
    const gap = new Promise<void>((res) => {
      releaseGap = res
    })
    const a = pass(f, {
      afterRowClaim: async () => {
      // RESOLVED INSIDE THE HOOK, not at construction time. `entered` resolving early is
      // a sleep by another name, and this branch has already paid for that once.
        enteredGap()
        await gap
      },
    })

    // AWAITED, NOT SLEPT: B must run while A is genuinely between its claim and its
    // publish. A sleep that lost the race would run B before A had claimed anything, and
    // the case would assert the refusal against the row-moved path instead — green, and
    // about nothing.
    await inGap

    // B RUNS TO COMPLETION IN THAT WINDOW.
    // A DIFFERENT GATEWAY, so a different pid: the predicate does not let a gateway be
    // blocked by its own process's earlier claim.
    const b = await pass(f, { claimantPid: process.pid + 1 })

    releaseGap()
    const aOutcome = await a

    // EXACTLY ONE PUBLISHES.
    expect(aOutcome.kind).toBe('adopted')
    expect(b.kind).toBe('undecided')
    // And the refusal NAMES the claim — distinct from `row-moved` ("the row now describes
    // a different child") and from `lock-unacquired` ("I could not find out"). Three
    // different facts; identical text would mean no case could tell which fired.
    expect(b.kind === 'undecided' && b.reason).toMatch(/holds the adoption claim/i)

    // ONE WRAPPER ON THE PANE. Both passes attached — the claim is the last act before
    // publishing, so B had a child in hand — and the loser gave its child back through the
    // non-destructive hand-over rather than becoming a second owner.
    expect(f.host.attached).toHaveLength(2)
    const detached = f.host.attached.filter((c) => c.detached)
    expect(detached).toHaveLength(1)
    // NOT CLOSED: B's refusal must leave the pane running — it is A's now, and A is
    // serving it.
    expect(f.host.closed).toEqual([])

    // The pool holds the winner, and the row still carries the WINNER's marker: B's
    // release is CAS'd on its own identity, so a refusal cannot strip the claim of the
    // incarnation that beat it.
    expect(await pool.get(KEY)).toBeDefined()
    const row = readRow(f.registryPath)
    expect(typeof row?.adoption_claim_by).toBe('string')
    expect(row?.pane_handle).toBe(HANDLE)
  })

  it('...and a single incarnation with no competitor claims and publishes normally', async () => {
    // THE POSITIVE CONTROL. A claim that refused everything would pass the case above and
    // stop every REPL coming back across a restart — which is the feature.
    const f = fixture()
    const outcome = await pass(f)
    expect(outcome.kind).toBe('adopted')
    expect(await pool.get(KEY)).toBeDefined()
    expect(f.host.attached).toHaveLength(1)
    expect(f.host.attached[0]?.detached).toBe(false)
    // The marker is on the row, with a timestamp: a claim that published without writing
    // one leaves the next racer nothing to lose against.
    const row = readRow(f.registryPath)
    expect(typeof row?.adoption_claim_by).toBe('string')
    expect(typeof row?.adoption_claim_at).toBe('number')
  })
})

describe('a claim expires when it stops being RENEWED, not when it gets old', () => {
  /**
   * ROUND THIRTY-EIGHT, and the defect was in the remedy the round before. A bare
   * time-since-adoption TTL answers "how long ago did somebody claim this row"; the
   * question it was being asked is "is that somebody still alive". Those come apart the
   * moment an owner survives the window: a healthy gateway that had been serving a pane
   * for ninety-one seconds held a claim the next gateway to boot was entitled to
   * overwrite, and it would attach a second wrapper. The invariant, defeated by the clock
   * rather than by a race — the same two-owner outcome through a slower door.
   */
  const MINUTE = 60_000

  it('a LIVE owner that has renewed keeps the pane, long past the old expiry', async () => {
    // THE CASE THE TTL COULD NOT PASS. A publishes at T0 and goes on living; its
    // supervision tick refreshes the claim every interval. B arrives well past the
    // takeover threshold measured from the ADOPTION, and must still be refused, because
    // what the threshold measures now is the time since the last RENEWAL.
    const f = fixture()
    supervise(f)
    // BASED ON THE REAL CLOCK, not a fixed date. These cases inject `now` into the claim
    // path while `getOrSpawnSession` reads the real clock, and a fixed 2026 timestamp puts
    // the two an arbitrary distance apart — which made the r44 self-fencing deadline fire
    // spuriously on a session that had just confirmed. An injected clock has to be
    // COMMENSURABLE with the real one wherever both are consulted in one case.
    const t0 = Date.now()
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    const ownersChild = f.host.attached[0]
    const ownersSession = await pool.get(KEY)
    expect(ownersSession).toBeDefined()

    // A LIVES, and its ticks say so. Six intervals takes us past the threshold measured
    // from the adoption — which is the whole point of the case.
    // THE SPAN IS ARITHMETIC ON CONSTANTS, and asserted as such rather than as a delta of
    // two clock-derived values: the origin is seeded from the real clock (it has to be —
    // `getOrSpawnSession` reads the real one), so `t - t0` would be a wall-clock comparison
    // in form even though every increment here is logical. The product says what is meant
    // and cannot red under load.
    const renewedSpan = 8 * DEFAULT_WATCHDOG_INTERVAL_MS
    expect(renewedSpan).toBeGreaterThan(ADOPTION_CLAIM_TAKEOVER_MS)
    let t = t0
    for (let i = 0; i < 8; i += 1) {
      t += DEFAULT_WATCHDOG_INTERVAL_MS
      await tickAt(f, t)
    }
    expect(t).toBe(t0 + renewedSpan)
    expect(readRow(f.registryPath)?.adoption_claim_at).toBe(t)

    // B BOOTS IN THE GAP BETWEEN TWO RENEWALS — and not a millisecond after the last one,
    // which is what makes this a test of the two numbers rather than of one. A takeover
    // threshold shorter than the renewal interval would expire every claim before its owner
    // could refresh it; the interval this case waits (TWO, so a single skipped tick is
    // included — the supervision tick's in-flight gate DROPS a tick whose predecessor is
    // still running) is inside the documented slack and must not be enough to lose the pane.
    const sinceLastRenewal = 2 * DEFAULT_WATCHDOG_INTERVAL_MS
    expect(sinceLastRenewal).toBeLessThan(ADOPTION_CLAIM_TAKEOVER_MS)
    const b = await pass(f, {
      now: () => t + sinceLastRenewal,
      claimantLiveness: () => 'alive',
      claimantPid: process.pid + 1,
    })
    expect(b.kind).toBe('undecided')
    expect(b.kind === 'undecided' && b.reason).toMatch(/holds the adoption claim/i)

    // EXACTLY ONE WRAPPER, and it is A's. B attached before the claim (the claim is the
    // last act) and handed its child back non-destructively.
    expect(f.host.attached).toHaveLength(2)
    expect(ownersChild?.detached).toBe(false)
    expect(f.host.attached[1]?.detached).toBe(true)
    expect(f.host.closed).toEqual([])
    // A'S SESSION IS UNTOUCHED — the pool still resolves to the session A published, not
    // to a replacement, and the row still carries A's marker.
    expect(await pool.get(KEY)).toBe(ownersSession)
    expect(readRow(f.registryPath)?.adoption_claim_by).toBe(ownersSession?.paneClaimBy)
  })

  it('...and an ordinary first adoption claims, publishes AND renews', async () => {
    // THE POSITIVE CONTROL, with a second job. It proves the refusal above is not a gate
    // that refuses everyone — and it proves the renewal is WIRED, which is the half a
    // refusal test can never see: an unrenewed claim expires exactly as the TTL did, and
    // every case here would still pass.
    const f = fixture()
    supervise(f)
    const t0 = Date.now()
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    expect(readRow(f.registryPath)?.adoption_claim_at).toBe(t0)

    await tickAt(f, t0 + DEFAULT_WATCHDOG_INTERVAL_MS)
    expect(readRow(f.registryPath)?.adoption_claim_at).toBe(t0 + DEFAULT_WATCHDOG_INTERVAL_MS)
    // And the pane is still served by the one wrapper that was there before the tick.
    expect(f.host.attached).toHaveLength(1)
    expect(f.host.attached[0]?.detached).toBe(false)
  })

  it('an owner that STOPPED renewing loses the pane once the threshold passes', async () => {
    // The other side of the same rule, and a REAL absence of renewal rather than a
    // hand-written old timestamp: A adopts and publishes, its ticks stop (the gateway is
    // gone), and nothing refreshes the marker. The liveness probe cannot settle it —
    // `unknown` is what a pid we may not signal answers — so this is the threshold doing
    // the work alone.
    const f = fixture()
    supervise(f)
    const t0 = Date.now()
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    const stale = readRow(f.registryPath)?.adoption_claim_by
    pool.clear()
    childByKey.clear()
    resetBootAdoptionForTests()

    const b = await pass(f, {
      now: () => t0 + ADOPTION_CLAIM_TAKEOVER_MS + 1,
      claimantLiveness: () => 'unknown',
    })
    expect(b.kind).toBe('adopted')
    // REPLACED, not merely ignored: the next racer must lose against this incarnation
    // rather than against a ghost.
    const after = readRow(f.registryPath)?.adoption_claim_by
    expect(typeof after).toBe('string')
    expect(after).not.toBe(stale)
  })

  it('a claimant whose PROCESS IS GONE loses the pane immediately, not after the threshold', () => {
    // WHY THE PID IS IN THE ROW. Renewal alone would make a CRASHED gateway's panes
    // unadoptable for a full threshold — and a crash is a restart, which is the behaviour
    // this whole item exists to deliver. A process that is provably gone is a positive
    // finding, so the claim dies with it and the very next boot adopts.
    //
    // Synchronous on purpose: this is the claim rule, not a pass.
    const f = fixture()
    const t0 = Date.now()
    return pass(f, { now: () => t0 })
      .then(async (first) => {
        expect(first.kind).toBe('adopted')
        pool.clear()
        childByKey.clear()
        resetBootAdoptionForTests()
        // ONE SECOND later — nowhere near the threshold.
        const b = await pass(f, { now: () => t0 + 1_000, claimantLiveness: () => 'gone' })
        expect(b.kind).toBe('adopted')
      })
  })

  it('but a claimant we could not ASK about is not treated as gone', async () => {
    // `gone` and "I could not find out" are different facts, and `defaultIsPidAlive`
    // answers `false` for both — which is why this rule uses its own three-valued probe.
    // An EPERM or an unreadable answer must leave the claim standing until the threshold,
    // because the alternative is taking a pane away from an owner that is serving it.
    const f = fixture()
    const t0 = Date.now()
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    pool.clear()
    childByKey.clear()
    resetBootAdoptionForTests()

    const b = await pass(f, {
      now: () => t0 + 1_000,
      claimantLiveness: () => 'unknown',
      claimantPid: process.pid + 1,
    })
    expect(b.kind).toBe('undecided')
    expect(b.kind === 'undecided' && b.reason).toMatch(/holds the adoption claim/i)
    expect(f.host.closed).toEqual([])
  })

  it('a renewal is a compare-and-set: a superseded owner cannot take its claim back', async () => {
    // THE BACK DOOR. A refresh that wrote blindly would let a gateway that had already
    // been legitimately taken over re-assert ownership on its next tick — the original
    // two-owner defect, arriving through the tidy-up, and worse than the original because
    // the row would then name a gateway nobody is talking to.
    const f = fixture()
    supervise(f)
    const t0 = Date.now()
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    const aSession = await pool.get(KEY)
    const aClaim = aSession?.paneClaimBy
    expect(typeof aClaim).toBe('string')

    // B takes the row over, legitimately: A stopped renewing and the threshold passed.
    pool.clear()
    childByKey.clear()
    resetBootAdoptionForTests()
    const t1 = t0 + ADOPTION_CLAIM_TAKEOVER_MS + 1
    expect((await pass(f, { now: () => t1, claimantLiveness: () => 'unknown' })).kind).toBe('adopted')
    const bClaim = readRow(f.registryPath)?.adoption_claim_by
    expect(bClaim).not.toBe(aClaim)

    // A'S NEXT TICK FIRES ANYWAY — it does not know it was replaced. Driven with A's own
    // claim identity rather than through the pool-reading wrapper, because the pool now
    // holds B's session: asking the wrapper would renew B's claim and prove nothing.
    expect(renewAdoptionClaim(f.registryPath, KEY, aClaim as string, t1 + MINUTE)).toBe('not-ours')
    expect(readRow(f.registryPath)?.adoption_claim_by).toBe(bClaim)
    // And B's own renewal still works, so the CAS is not simply refusing everything.
    expect(renewAdoptionClaim(f.registryPath, KEY, bClaim as string, t1 + MINUTE)).toBe('renewed')
    expect(readRow(f.registryPath)?.adoption_claim_at).toBe(t1 + MINUTE)
  })
})

describe('the hand-over gives the claim back', () => {
  it('a surviving shutdown clears the marker, so the next boot is not refused', async () => {
    // THE WEDGE THIS BRANCH NEARLY SHIPPED. The survival branch keeps the pane alive
    // precisely so the NEXT construction can adopt it — and a claim left behind would
    // refuse that next construction for the whole TTL, disabling the feature for ninety
    // seconds after every restart while looking correct in every other test.
    const f = fixture()
    supervisedBySessionKey.set(KEY, {
      replRegistryPath: f.registryPath,
    } as unknown as PersistentReplSubstrateOptions)

    expect((await pass(f)).kind).toBe('adopted')
    expect(typeof readRow(f.registryPath)?.adoption_claim_by).toBe('string')

    await shutdownAllPersistentRepls()
    // Given back on the way out — while the pane is still running and the row still names
    // it, which is what makes the next line possible.
    expect(readRow(f.registryPath)?.adoption_claim_by).toBeUndefined()
    expect(f.host.closed).toEqual([])

    resetBootAdoptionForTests()
    const second = await pass(f)
    expect(second.kind).toBe('adopted')
    expect(f.host.attached).toHaveLength(2)
  })
})

describe('the give-back is still a write, and a write needs the lock', () => {
  /**
   * TESTED AT THE FUNCTION, and the reason is a finding in itself. The obvious route —
   * adopt, break the lock, shut down — does not reach the release at all: with no lock the
   * SURVIVAL decision fails closed, so that shutdown takes the kill branch and records
   * `killed_by_gateway_shutdown` instead. Correct behaviour (round fourteen), and a
   * different branch from the one under test. A case written that way would have passed or
   * failed for reasons unconnected to the guard it names.
   */
  const MARKER = 'the-incarnation-under-test'

  it('writes NOTHING when the lock was not held, and lets the TTL do it instead', () => {
    // THE LOST-UPDATE SHAPE, in the tidy-up rather than in the decision. `withRegistry` is a
    // whole-registry read-modify-write: save a snapshot taken without the lock and any row a
    // concurrent incarnation wrote in between is GONE — rows for keys this pass has nothing
    // to do with. The claim path argues this for itself and refuses; the release must make
    // the same argument, because skipping costs one bounded refusal on one key while
    // clobbering costs somebody else a REPL nothing can find.
    const f = fixture({ adoption_claim_by: MARKER, adoption_claim_at: Date.now() })
    const before = readFileSync(f.registryPath, 'utf8')
    setFlockImplForTests(() => 1)
    releaseAdoptionClaim(f.registryPath, KEY, MARKER)
    // THE WHOLE FILE, not just this row — what the guard protects is every OTHER key in it.
    expect(readFileSync(f.registryPath, 'utf8')).toBe(before)
  })

  it('...and clears the marker when it DID hold the lock', () => {
    // The positive control. A release that never wrote would pass the case above and wedge
    // every hand-over for a TTL, which is the defect this give-back exists to prevent.
    const f = fixture({ adoption_claim_by: MARKER, adoption_claim_at: Date.now() })
    releaseAdoptionClaim(f.registryPath, KEY, MARKER)
    expect(readRow(f.registryPath)?.adoption_claim_by).toBeUndefined()
    expect(readRow(f.registryPath)?.adoption_claim_at).toBeUndefined()
    // And the rest of the row is untouched — a give-back is not a reset.
    expect(readRow(f.registryPath)?.pane_handle).toBe(HANDLE)
    expect(readRow(f.registryPath)?.child_generation).toBe(GENERATION)
  })
})

describe('the gateway that LOST the claim stops serving the pane', () => {
  /**
   * ARGUS r39, and the last question in the chain: verify, then claim, then keep the claim
   * meaningful, then ACT when you lose it.
   *
   * The renewal detected `not-ours` and only logged. The session stayed attached, stayed in
   * `pool`, stayed registered at the sink and went on answering turns — the two-owner state
   * this item exists to prevent, reached by the LOSING party rather than the winning one,
   * and reached through this branch's most repeated shape: a verdict computed correctly and
   * dropped by its caller.
   *
   * FENCING IS NOT CLOSING. The winner's REPL is live and serving; a loser that closed on
   * its way out would destroy the conversation the takeover just preserved. That is the
   * distinction `detach` exists for, and the assertion below that `host.closed` stays empty
   * is the one that would catch its loss.
   */
  const spec: AgentSpec = { prompt: 'hi', tools: [], model_preference: ['claude-opus-5'] }

  it('detaches, evicts ITS OWN entry, and refuses turns — while the winner keeps serving', async () => {
    const f = fixture()
    supervise(f)
    const t0 = Date.now()

    // A ADOPTS AND PUBLISHES.
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    const aSession = await pool.get(KEY)
    const aChild = f.host.attached[0]
    expect(aSession).toBeDefined()
    expect(aChild?.detached).toBe(false)

    // A'S RENEWAL STOPS for longer than the takeover window — its ticks are gone, its
    // request path is not. Nothing else about A changes.
    const t1 = t0 + ADOPTION_CLAIM_TAKEOVER_MS + 1

    // B TAKES THE CLAIM AND PUBLISHES, into the same process and the same pool.
    resetBootAdoptionForTests()
    expect(
      (await pass(f, { now: () => t1, claimantLiveness: () => 'unknown' })).kind,
    ).toBe('adopted')
    const bSession = await pool.get(KEY)
    const bChild = f.host.attached[1]
    expect(bSession).not.toBe(aSession)
    expect(bChild).toBeDefined()

    // A'S RENEWAL RESUMES and meets the row B now owns. Driven from A's own session
    // because the pool is B's now — which is precisely the state that makes this the
    // loser's problem to solve.
    renewClaimForSession(f.registryPath, KEY, aSession as ReplSession, t1 + 1_000, () => {})

    // ── A, FENCED ────────────────────────────────────────────────────────────────
    // Detached: no poll, nothing delivered, and nothing it could answer with.
    expect(aChild?.detached).toBe(true)
    aChild?.push('❯ 1. Yes, proceed')
    expect(aChild?.screensDelivered).toEqual([])
    expect(aChild?.keysSent).toEqual([])
    // Its pool entry is gone — and what remains under the key is B's, not nothing.
    expect(await pool.get(KEY)).toBe(bSession)
    // And a turn on this key is REFUSED, through the spawn gate's existing vocabulary
    // rather than a second one invented for this.
    let threw = ''
    try {
      await getOrSpawnSession(KEY, f.options, spec)
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
    expect(threw).toMatch(/refusing to resume/i)
    expect(threw).toMatch(/NO LONGER OURS/i)

    // ── B, UNTOUCHED ─────────────────────────────────────────────────────────────
    // THE PANE IS ALIVE. A fence that closed would destroy the REPL the takeover just
    // preserved, and this is the assertion that catches it.
    expect(f.host.closed).toEqual([])
    // AND NOTHING ENDED THE PANE'S PROCESS EITHER — the distinction a fixture with
    // independent wrappers could not see. `paneGone` is set on every wrapper of a handle
    // whose child was killed, so a fence that destroyed instead of letting go reds here
    // even though it never called `closeHandle`.
    expect(bChild?.paneGone).toBe(false)
    expect(f.host.panes.has(HANDLE)).toBe(true)
    expect(bChild?.detached).toBe(false)
    bChild?.push('a screen for the new owner')
    expect(bChild?.screensDelivered).toEqual(['a screen for the new owner'])
    // Its row still names it: the loser's tidy-up is CAS'd and took nothing back.
    expect(readRow(f.registryPath)?.adoption_claim_by).toBe(bSession?.paneClaimBy)
  })

  it('...and a renewal that SUCCEEDS leaves the owner serving normally', async () => {
    // THE POSITIVE CONTROL. Fencing that fired on every renewal would pass the case above
    // and stop every adopted REPL at the first supervision tick — the feature, switched
    // off by its own safety mechanism.
    const f = fixture()
    supervise(f)
    const t0 = Date.now()
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    const session = await pool.get(KEY)
    const child = f.host.attached[0]

    await tickAt(f, t0 + DEFAULT_WATCHDOG_INTERVAL_MS)

    expect(child?.detached).toBe(false)
    expect(await pool.get(KEY)).toBe(session)
    child?.push('an ordinary screen')
    expect(child?.screensDelivered).toEqual(['an ordinary screen'])
    // And the turn path is open.
    expect(f.host.closed).toEqual([])
  })
})

describe('a lease holder stops on its OWN evidence, without observing the winner', () => {
  /**
   * ARGUS r44, and it is the finding that makes the lease correct rather than careful.
   *
   * Round thirty-nine fenced when the renewal came back `not-ours` — when this gateway SAW
   * the takeover. **It cannot rely on seeing it.** The same failure that costs a gateway its
   * lease — an unacquired lock, an unwritable registry, a vanished row, a throw — is the
   * failure that stops it learning anything about who took over. A renewal stuck on
   * `unwritable` never becomes `not-ours`, so the old holder served forever and the new one
   * served too: the two-owner state, produced by making A's safety depend on reading B's
   * marker.
   *
   * So the deadline is measured from A's last CONFIRMED renewal, and nothing else. The cases
   * below are written so the FIRST one has no B in it at all — if A's safety needed B to
   * exist, that case could not be written.
   */
  const spec: AgentSpec = { prompt: 'hi', tools: [], model_preference: ['claude-opus-5'] }

  it('fences itself when it cannot CONFIRM ownership, with no second gateway in existence', async () => {
    const f = fixture()
    supervise(f)
    const t0 = Date.now()
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    const session = await pool.get(KEY)
    const child = f.host.attached[0]
    expect(session?.paneClaimConfirmedAt).toBe(t0)

    // RENEWALS BEGIN FAILING FOR REAL — the flock stops working, so every renewal answers
    // `unwritable`. Not a stubbed return: the point is that the failure is the same one that
    // would hide a takeover, and it is forced at the lock rather than at the function.
    setFlockImplForTests(() => 1)
    // Ticks keep firing and keep failing, right up to the deadline.
    await tickAt(f, t0 + DEFAULT_WATCHDOG_INTERVAL_MS)
    await tickAt(f, t0 + SELF_FENCE_AFTER_MS - 1)
    // STILL SERVING: the deadline has not passed, and a gateway that fenced early would
    // abandon a pane it still provably owned.
    expect(child?.detached).toBe(false)
    expect(await pool.get(KEY)).toBe(session)

    // AND NOW IT PASSES.
    await tickAt(f, t0 + SELF_FENCE_AFTER_MS)

    // A HAS STOPPED, on its own account. No B exists — nothing has taken the row, and the
    // registry still says the claim is A's; A simply cannot prove it any more.
    expect(child?.detached).toBe(true)
    child?.push('❯ 1. Yes, proceed')
    expect(child?.screensDelivered).toEqual([])
    expect(child?.keysSent).toEqual([])
    expect(await pool.get(KEY)).toBeUndefined()
    // AND THE PANE IS LEFT ALIVE — whoever takes the row next inherits a live REPL.
    expect(f.host.closed).toEqual([])
    expect(f.host.panes.has(HANDLE)).toBe(true)

    // A turn is refused, through the same gate every other unestablished owner uses.
    setFlockImplForTests(undefined)
    let threw = ''
    try {
      await getOrSpawnSession(KEY, f.options, spec)
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
    expect(threw).toMatch(/refusing to resume/i)
    expect(threw).toMatch(/NOT CONFIRMED ownership/i)
  })

  it('...and the deadline is strictly SHORTER than the window another gateway may take over in', async () => {
    // THE RELATIONSHIP, pinned behaviourally rather than as an assertion about two numbers.
    // A stops at the deadline; B is entitled to the row only after the takeover window. If
    // those were reordered there would be an interval in which A still serves and B already
    // owns — so the case drives BOTH and asserts the handover is clean.
    expect(SELF_FENCE_AFTER_MS).toBeLessThan(ADOPTION_CLAIM_TAKEOVER_MS)
    const f = fixture()
    supervise(f)
    const t0 = Date.now()
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    const aSession = await pool.get(KEY)
    const aChild = f.host.attached[0]

    // A's renewals fail; A fences itself at its deadline.
    setFlockImplForTests(() => 1)
    await tickAt(f, t0 + SELF_FENCE_AFTER_MS)
    expect(aChild?.detached).toBe(true)

    // ONLY LATER may B take the row — and by then A has already stopped.
    setFlockImplForTests(undefined)
    resetBootAdoptionForTests()
    const b = await pass(f, {
      now: () => t0 + ADOPTION_CLAIM_TAKEOVER_MS + 1,
      claimantLiveness: () => 'unknown',
    })
    expect(b.kind).toBe('adopted')
    const bSession = await pool.get(KEY)
    expect(bSession).toBeDefined()
    expect(bSession).not.toBe(aSession)
    // B SERVES, A DOES NOT.
    const bChild = f.host.attached[1]
    expect(bChild?.detached).toBe(false)
    bChild?.push('a screen for the new owner')
    expect(bChild?.screensDelivered).toEqual(['a screen for the new owner'])
    aChild?.push('a screen for the old one')
    expect(aChild?.screensDelivered).toEqual([])
    // The pane was never closed on the way through.
    expect(f.host.closed).toEqual([])
  })

  it('...and renewals that keep SUCCEEDING leave it serving indefinitely', async () => {
    // THE POSITIVE CONTROL. A deadline that fired regardless would pass both cases above and
    // stop every adopted REPL a minute after it was adopted — the feature, switched off by
    // its own safety mechanism.
    const f = fixture()
    supervise(f)
    const t0 = Date.now()
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    const session = await pool.get(KEY)
    const child = f.host.attached[0]

    // Well past the deadline in elapsed time, but every tick confirms.
    // Arithmetic on constants, for the reason given in the live-owner case above.
    const confirmedSpan = 12 * DEFAULT_WATCHDOG_INTERVAL_MS
    expect(confirmedSpan).toBeGreaterThan(SELF_FENCE_AFTER_MS)
    let t = t0
    for (let i = 0; i < 12; i += 1) {
      t += DEFAULT_WATCHDOG_INTERVAL_MS
      await tickAt(f, t)
    }
    expect(t).toBe(t0 + confirmedSpan)
    expect(session?.paneClaimConfirmedAt).toBe(t)
    expect(child?.detached).toBe(false)
    expect(await pool.get(KEY)).toBe(session)
    child?.push('an ordinary screen')
    expect(child?.screensDelivered).toEqual(['an ordinary screen'])
  })
})


describe('a FENCED key is no longer this gateway\'s to supervise', () => {
  /**
   * ARGUS r46, and the second instance of "the caller ignored it" at the same two lines.
   *
   * The renewal fenced correctly and returned `void`; the tick carried on with the snapshot
   * it had loaded BEFORE the fencing. If the probe then reported the pane unhealthy, the
   * losing tick emitted a crash notice, patched the winner's row and attempted a respawn —
   * **a gateway that had just concluded it does not own the pane declaring the rightful owner
   * crashed and respawning over it.** Round thirty-nine asked for that to be impossible; what
   * landed was fencing that worked and a value that was still droppable.
   *
   * Every existing fencing case pinned the probe HEALTHY, which is exactly why this was
   * invisible: the probe's verdict is what turns a fenced tick from inert into destructive.
   */
  it('a fenced key with an UNHEALTHY probe raises nothing, patches nothing and respawns nothing', async () => {
    // `first_ready_at` WELL IN THE PAST, because without it `decideWedgeAction` answers
    // `ignore: never-ready` and the tick does nothing for reasons that have nothing to do with
    // fencing — a control that cannot act proves nothing about a guard that stops it acting.
    const f = fixture({ first_ready_at: Date.now() - 600_000 })
    supervise(f)
    const t0 = Date.now()
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    const aSession = await pool.get(KEY)
    expect(aSession).toBeDefined()

    // B takes the row over legitimately; A's next renewal observes it and fences.
    resetBootAdoptionForTests()
    const t1 = t0 + ADOPTION_CLAIM_TAKEOVER_MS + 1
    expect(
      (await pass(f, { now: () => t1, claimantLiveness: () => 'unknown', claimantPid: process.pid + 1 }))
        .kind,
    ).toBe('adopted')
    renewClaimForSession(f.registryPath, KEY, aSession as ReplSession, t1 + 1_000, () => {})
    const winnersRow = readFileSync(f.registryPath, 'utf8')

    // THE TICK RUNS WITH A DEAD-LOOKING PANE. Before r46 this is where the losing gateway
    // declared the winner crashed.
    const { crashes, alerts, results } = await unhealthyTickAt(f, t1 + 2_000)

    // NOTHING WAS RAISED and nothing was actuated for this key.
    expect(crashes).toEqual([])
    expect(alerts).toEqual([])
    expect(results.filter((r) => r.respawned)).toEqual([])
    // AND THE WINNER'S ROW IS BYTE-IDENTICAL — no patch, no respawn stamp, nothing.
    expect(readFileSync(f.registryPath, 'utf8')).toBe(winnersRow)
  })

  it('...and an UNFENCED key with the same unhealthy probe still acts', async () => {
    // THE POSITIVE CONTROL, and its second job is the one that matters: a guard that fired on
    // every tick would pass the case above and disable the watchdog for every healthy
    // gateway — turning a two-owner fix into a no-supervision bug.
    const f = fixture({ first_ready_at: Date.now() - 600_000 })
    supervise(f)
    const t0 = Date.now()
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')

    const { crashes, results } = await unhealthyTickAt(f, t0 + 1_000)

    // The watchdog still sees a dead REPL and still acts on it.
    expect(crashes).toEqual([KEY])
    expect(results.some((r) => r.action !== 'ignore')).toBe(true)
  })
})


describe('a claimant is blind and mute until it holds the claim', () => {
  /**
   * ARGUS r47 — THE ORDERING INVARIANT (stated in full at the top of `boot-adoption.ts`).
   *
   * Adoption used to enable output delivery and the detector set BEFORE the durable claim,
   * and publish afterwards. So both gateways attached, and the eventual loser could SEE the
   * pane and TYPE into it before it learned somebody else owned it — `1`+Enter into the
   * winner's live session, which is this issue's one destructive failure mode.
   *
   * Priming does not save it: priming latches the signatures present on the FIRST screen,
   * and the hazard is a FRESH rising edge arriving during the race. So this case delivers a
   * fresh actionable prompt at attach time, which is when a live pane really does render.
   */
  const ACTIONABLE = '❯ 1. Yes, proceed\n  2. No'

  it('the loser delivers no screen and sends no key, even with a fresh prompt on the pane', async () => {
    const f = fixture()
    f.host.deliverOnAttach = ACTIONABLE

    let enteredGap!: () => void
    const inGap = new Promise<void>((res) => {
      enteredGap = res
    })
    let releaseGap!: () => void
    const gap = new Promise<void>((res) => {
      releaseGap = res
    })
    const winnerLog: string[] = []
    const a = pass(f, {
      log: (m) => winnerLog.push(m),
      afterRowClaim: async () => {
        enteredGap()
        await gap
      },
    })
    await inGap

    // THE LOSER RUNS while the winner holds the claim. Its attach hands it the actionable
    // prompt immediately — before it can possibly know it lost.
    const loserLog: string[] = []
    const b = await pass(f, { claimantPid: process.pid + 1, log: (m) => loserLog.push(m) })
    expect(b.kind).toBe('undecided')

    const loserChild = f.host.attached[1]
    expect(loserChild).toBeDefined()
    // NO KEY. The destructive half: a detector answering that prompt would type into a
    // session another gateway owns.
    expect(loserChild?.keysSent).toEqual([])
    // AND NO SCREEN WAS EVER TAKEN IN. The priming line is emitted by the handler on the
    // first screen it accepts, so its absence is the observable for "this wrapper never
    // looked at the pane".
    expect(loserLog.filter((m) => m.includes('baseline screen'))).toEqual([])

    releaseGap()
    expect((await a).kind).toBe('adopted')
    // AND THE WINNER DOES SEE IT — the same screen, the same pane, the other side of the
    // claim. Without this the case would pass if nothing ever delivered anything.
    expect(winnerLog.filter((m) => m.includes('baseline screen')).length).toBeGreaterThan(0)
  })

  it('...and an uncontended adoption still enables output and serves', async () => {
    // THE POSITIVE CONTROL for the reordering itself: moving delivery behind the claim must
    // not leave it switched off. A session that never accepts a screen is a REPL that cannot
    // answer a turn, which is the feature.
    const f = fixture()
    f.host.deliverOnAttach = ACTIONABLE
    const logs: string[] = []
    const outcome = await pass(f, { log: (m) => logs.push(m) })
    expect(outcome.kind).toBe('adopted')
    expect(logs.filter((m) => m.includes('baseline screen')).length).toBeGreaterThan(0)
    // And it goes on accepting screens after the claim.
    const child = f.host.attached[0]
    child?.push('a later screen')
    expect(child?.screensDelivered).toEqual(['a later screen'])
  })
})

describe('the self-fence fires on its own, with nothing else running', () => {
  /**
   * ARGUS r49, and it is the hole in round forty-four's ruling rather than in its code.
   *
   * Round forty-four specified the CONDITION — fence when the last confirmed renewal is older
   * than the takeover window — and not what EVALUATES it. The deadline was checked in exactly
   * two places: when a new turn enters `beginBootAdoption`, and when a watchdog renewal runs.
   * **Both are things the losing gateway has stopped doing**, which is the one circumstance
   * the deadline exists for. A gateway mid-turn whose tick loop had stalled, with no next turn
   * arriving, was never fenced at all — it stayed attached and sink-registered while another
   * gateway took the pane, and could still complete its turn with a reply produced on it.
   *
   * **A predicate is not a mechanism.** So the fence is a timer, and this case runs with no
   * tick, no new turn and no probe — the crutch every earlier fencing case leaned on.
   */
  /** A fence timer the case fires by hand, because a suite cannot wait out the real deadline
   *  and shortening the constant would pin a different relationship than production runs. */
  function manualFenceTimer(): {
    fire: (which?: number) => void
    armed: () => number
    cancelled: (which?: number) => boolean
    cancels: () => number
  } {
    /**
     * CANCELLED CALLBACKS ARE RETAINED, which the first version of this fake did not do — and
     * that made the control for the very defect round fifty found VACUOUS: `cancel` deleted
     * the stored callback, so forcing a "stale firing" retrieved `undefined` and invoked
     * nothing. The case passed because nothing happened. **A fake that cannot produce the
     * event under test is not a control**, and this is the seventh fixture vacuity on this
     * branch.
     *
     * Real timers behave this way too: `clearTimeout` on a callback already dispatched does
     * not un-dispatch it, which is exactly the race being modelled.
     */
    const armedCbs: Array<() => void> = []
    const cancelledAt = new Set<number>()
    setFenceTimerFactoryForTests((cb) => {
      const i = armedCbs.push(cb) - 1
      return {
        cancel: () => {
          cancelledAt.add(i)
        },
      }
    })
    return {
      // Fires the LATEST armed timer by default, or a specific one by index — INCLUDING one
      // that has been cancelled, which is the stale-firing case.
      fire: (which) => {
        const i = which ?? armedCbs.length - 1
        armedCbs[i]?.()
      },
      armed: () => armedCbs.length,
      cancelled: (which) => cancelledAt.has(which ?? armedCbs.length - 1),
      cancels: () => cancelledAt.size,
    }
  }

  it('fences mid-turn with no tick, no new turn and no probe', async () => {
    const timer = manualFenceTimer()
    const f = fixture()
    supervise(f)
    const t0 = Date.now()
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    const session = await pool.get(KEY)
    const child = f.host.attached[0]
    expect(session).toBeDefined()
    // ARMED AT THE CLAIM, not at the first tick — which a stalled gateway never reaches.
    expect(timer.armed()).toBe(1)

    // A TURN IS IN FLIGHT. Nothing else runs: no `tickAt`, no second pass, no probe.
    const turnId = 'incarnation:1'
    ;(session as ReplSession).activeTurn = {
      turnId,
      settled: false,
      settle: () => {},
      sessionId: SESSION_ID,
      substrateInstanceId: 'inst',
      channel: { push: () => {}, close: () => {}, closed: false } as never,
    } as never

    // The deadline arrives. In production this is `setTimeout` firing; here the case fires it,
    // which is the same call with a clock it can control.
    timer.fire()

    // FENCED, ON ITS OWN. Detached, out of the pool, and blind and mute from here.
    expect(child?.detached).toBe(true)
    child?.push('❯ 1. Yes, proceed')
    expect(child?.screensDelivered).toEqual([])
    expect(child?.keysSent).toEqual([])
    expect(await pool.get(KEY)).toBeUndefined()
    // AND THE PANE IS LEFT ALIVE for whoever owns it next.
    expect(f.host.closed).toEqual([])

    // AND THE OUTSTANDING REPLY IS REFUSED. It arrives over the sink, not over the pane, so
    // detaching alone would not have stopped it — this is "claim before you are capable"
    // applied to the inbound direction.
    const turn = (session as ReplSession).activeTurn
    ;(session as ReplSession).onReply('the answer B produced', turnId)
    expect(turn?.settled).toBe(false)
  })

  it('a STALE firing does not orphan its replacement, so a released session stays released', async () => {
    // ARGUS r50. The timer callback used to clear `session.selfFenceTimer` unconditionally, so
    // a late firing of a SUPERSEDED timer erased its REPLACEMENT's cancellation handle. A
    // later release could then no longer cancel that replacement, and the orphan fired and
    // fenced a key the gateway had legitimately let go — refusing turns for a session nothing
    // was wrong with.
    //
    // It is the IDENTITY GUARD from rounds thirty and thirty-one, in a resource we had not
    // applied it to: `childByKey.get(key) === child` and `deleteOwnPoolEntry`'s peek exist
    // because a handle can be replaced between capturing it and acting on it, and a callback
    // is the purest form of "later".
    const timer = manualFenceTimer()
    const f = fixture()
    supervise(f)
    const t0 = Date.now()
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    const session = (await pool.get(KEY)) as ReplSession

    // A renewal replaces timer A with timer B.
    await tickAt(f, t0 + DEFAULT_WATCHDOG_INTERVAL_MS)
    expect(timer.armed()).toBe(2)
    const replacement = session.selfFenceTimer
    expect(replacement).toBeDefined()

    // TIMER A FIRES LATE. Before the guard this erased B's handle.
    timer.fire(0)
    expect(session.selfFenceTimer).toBe(replacement)

    // OWNERSHIP IS RELEASED THROUGH THE REAL PATH — a surviving shutdown, the ordinary
    // hand-over — which cancels B and gives the claim back. Driven through the production
    // teardown rather than by calling the pieces, because what is being tested is that the
    // teardown leaves nothing armed.
    await shutdownAllPersistentRepls()
    expect(timer.cancelled(1)).toBe(true)
    expect(session.paneClaimBy).toBeUndefined()

    // AND B, FIRING ANYWAY, FENCES NOTHING: the key stays usable.
    timer.fire(1)
    expect(session.fenced).toBe(false)
    resetBootAdoptionForTests()
    pool.clear()
    childByKey.clear()
    const again = await pass(f, { now: () => t0 + DEFAULT_WATCHDOG_INTERVAL_MS + 1_000 })
    expect(again.kind).toBe('adopted')
  })

  it('a child that EXITS while a deadline callback is dispatched is respawned, not fenced', async () => {
    // ARGUS r51, and it is round forty-one's lesson arriving for round fifty's guard: **a new
    // guard inherits every existing path's obligations.** Round fifty made the fence read
    // `paneClaimBy` — "a session with no claim has nothing to fence" — which is true only if
    // EVERY give-back path clears it. Child exit predates that premise and was never told: it
    // cancelled the timer and disowned the durable row and left the in-memory claim set.
    //
    // So a deadline callback already DISPATCHED when the child exited arrived after the
    // cancel, saw a stale claim, and installed a KEY-LEVEL fence — turning a crashed REPL into
    // a permanently refused key instead of one that respawns. The worst kind of bug this
    // branch produces: a safety mechanism denying service for the thing it was protecting.
    const timer = manualFenceTimer()
    const f = fixture()
    supervise(f)
    const t0 = Date.now()
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    const session = (await pool.get(KEY)) as ReplSession
    const child = f.host.attached[0]
    expect(session.paneClaimBy).toBeDefined()

    // THE CHILD DIES. Its teardown runs — including the cancel that cannot un-dispatch a
    // callback already runnable.
    child?.kill()
    await Promise.resolve()
    await Promise.resolve()
    // The exit teardown invalidated the in-memory claim, which is what the dispatched callback
    // will observe.
    expect(session.paneClaimBy).toBeUndefined()

    // THE DISPATCHED CALLBACK ARRIVES ANYWAY.
    timer.fire(0)

    // NO KEY-LEVEL FENCE. This is the assertion that carries it: a fence here would refuse
    // every later turn for this key rather than letting the next one respawn.
    expect(fencedReasonFor(KEY)).toBeUndefined()
    expect(session.fenced).toBe(false)

    // AND THE NEXT TURN REACHES THE SPAWN PATH rather than a refusal — the fake host throws
    // from `spawn`, which is how this suite shows "it got that far".
    resetBootAdoptionForTests()
    pool.clear()
    childByKey.clear()
    let threw = ''
    try {
      await getOrSpawnSession(KEY, f.options, { prompt: 'hi', tools: [], model_preference: ['claude-opus-5'] })
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
    expect(threw).not.toMatch(/refusing to resume/i)
    expect(threw).toMatch(/spawn is not part of these cases/i)
  })

  it('...and a healthy gateway whose renewals succeed never fences mid-turn', async () => {
    // THE POSITIVE CONTROL. A timer that fired regardless would pass the case above and stop
    // every REPL a deadline after it was adopted — the feature, switched off by its own guard.
    const timer = manualFenceTimer()
    const f = fixture()
    supervise(f)
    const t0 = Date.now()
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    const session = await pool.get(KEY)
    const child = f.host.attached[0]

    // A renewal confirms, which CANCELS the armed timer and re-arms from the new confirmation.
    await tickAt(f, t0 + DEFAULT_WATCHDOG_INTERVAL_MS)
    expect(session?.paneClaimConfirmedAt).toBe(t0 + DEFAULT_WATCHDOG_INTERVAL_MS)
    expect(timer.armed()).toBe(2)
    expect(timer.cancelled(0)).toBe(true)

    // THE SUPERSEDED TIMER FIRES ANYWAY — a dispatched callback that `clearTimeout` cannot
    // un-dispatch, a process resumed from suspend. It really is invoked now (the fake retains
    // cancelled callbacks); nothing happens because the deadline is re-checked against the
    // CURRENT confirmation, which the renewal moved forward.
    timer.fire(0)

    expect(child?.detached).toBe(false)
    expect(await pool.get(KEY)).toBe(session)
    child?.push('an ordinary screen')
    expect(child?.screensDelivered).toEqual(['an ordinary screen'])
    expect((session as ReplSession).fenced).toBe(false)
  })
})
