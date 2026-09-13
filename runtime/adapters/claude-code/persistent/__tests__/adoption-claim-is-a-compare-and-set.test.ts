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
  releaseAdoptionClaim,
  renewAdoptionClaim,
  reconcileOwnRepl,
  resetBootAdoptionForTests,
} from '../boot-adoption.ts'
import { childByKey, pool, sink, supervisedBySessionKey } from '../pool-state.ts'
import { shutdownAllPersistentRepls } from '../pool.ts'
import { ADOPTION_CLAIM_TAKEOVER_MS, DEFAULT_WATCHDOG_INTERVAL_MS } from '../signatures.ts'
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
    const b = await pass(f)

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
    const t0 = Date.parse('2026-09-13T12:00:00Z')
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    const ownersChild = f.host.attached[0]
    const ownersSession = await pool.get(KEY)
    expect(ownersSession).toBeDefined()

    // A LIVES, and its ticks say so. Six intervals takes us past the threshold measured
    // from the adoption — which is the whole point of the case.
    let t = t0
    for (let i = 0; i < 8; i += 1) {
      t += DEFAULT_WATCHDOG_INTERVAL_MS
      await tickAt(f, t)
    }
    expect(t - t0).toBeGreaterThan(ADOPTION_CLAIM_TAKEOVER_MS)
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
    expect(readRow(f.registryPath)?.adoption_claim_by).toBe(ownersSession?.adoptionClaimBy)
  })

  it('...and an ordinary first adoption claims, publishes AND renews', async () => {
    // THE POSITIVE CONTROL, with a second job. It proves the refusal above is not a gate
    // that refuses everyone — and it proves the renewal is WIRED, which is the half a
    // refusal test can never see: an unrenewed claim expires exactly as the TTL did, and
    // every case here would still pass.
    const f = fixture()
    supervise(f)
    const t0 = Date.parse('2026-09-13T12:00:00Z')
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
    const t0 = Date.parse('2026-09-13T12:00:00Z')
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
    const t0 = Date.parse('2026-09-13T12:00:00Z')
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
    const t0 = Date.parse('2026-09-13T12:00:00Z')
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    pool.clear()
    childByKey.clear()
    resetBootAdoptionForTests()

    const b = await pass(f, { now: () => t0 + 1_000, claimantLiveness: () => 'unknown' })
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
    const t0 = Date.parse('2026-09-13T12:00:00Z')
    expect((await pass(f, { now: () => t0 })).kind).toBe('adopted')
    const aSession = await pool.get(KEY)
    const aClaim = aSession?.adoptionClaimBy
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
