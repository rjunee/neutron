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
 * `adoption_claim_by` + `adoption_claim_at`, with `ADOPTION_CLAIM_TTL_MS` as the staleness
 * rule — the same shape as `supervision.ts`'s `respawn_in_flight_at`.
 *
 * WHAT THE TTL IS FOR, and it is the harder half. A claimant that dies between marking and
 * publishing leaves a marker nobody will ever clear, and a permanent marker would wedge the
 * row so that NOTHING could adopt that pane again — a REPL preserved across the restart and
 * then unreachable forever, which is worse than the defect being fixed. Two things bound
 * it: every path that stops owning a session gives its own claim back (CAS'd, so it can
 * only ever release its own), and a marker older than the TTL is ignored. The first keeps
 * the ordinary hand-over instant; the second is the backstop for the crash.
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
  reconcileOwnRepl,
  resetBootAdoptionForTests,
} from '../boot-adoption.ts'
import { childByKey, pool, sink, supervisedBySessionKey } from '../pool-state.ts'
import { shutdownAllPersistentRepls } from '../pool.ts'
import { ADOPTION_CLAIM_TTL_MS } from '../signatures.ts'
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

/** One incarnation's pass. `afterRowClaim` is the ordering seam; every other dep is the
 *  same one the rest of the suite injects. */
function pass(
  f: Fixture,
  afterRowClaim?: () => Promise<void> | void,
): Promise<Awaited<ReturnType<typeof reconcileOwnRepl>>> {
  return reconcileOwnRepl(f.options, KEY, {
    host: f.host,
    health: async () => true,
    log: () => {},
    ...(afterRowClaim === undefined ? {} : { afterRowClaim }),
  })
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
    const a = pass(f, async () => {
      // RESOLVED INSIDE THE HOOK, not at construction time. `entered` resolving early is
      // a sleep by another name, and this branch has already paid for that once.
      enteredGap()
      await gap
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

describe('a marker must not outlive the claimant that wrote it', () => {
  it('a claimant that died between marking and publishing does NOT wedge the row', async () => {
    // The failure mode the staleness rule exists for: a gateway killed in the microseconds
    // between its compare-and-set and its publish leaves a marker no release path will
    // ever clear. Without the TTL that pane is unadoptable forever — a REPL kept alive
    // across the restart and then unreachable, which is worse than two owners.
    const f = fixture({
      adoption_claim_by: 'an-incarnation-that-never-came-back',
      adoption_claim_at: Date.now() - ADOPTION_CLAIM_TTL_MS - 1_000,
    })
    const outcome = await pass(f)
    expect(outcome.kind).toBe('adopted')
    // And the dead claimant's marker is REPLACED, not merely ignored: the next racer must
    // lose against this incarnation, not against a ghost.
    const row = readRow(f.registryPath)
    expect(row?.adoption_claim_by).not.toBe('an-incarnation-that-never-came-back')
  })

  it('...but a marker still inside the window refuses, pane left running', async () => {
    // The other side of the same constant. Together these two pin `ADOPTION_CLAIM_TTL_MS`
    // as a real boundary rather than a value nothing reads.
    const f = fixture({
      adoption_claim_by: 'another-incarnation-mid-adoption',
      adoption_claim_at: Date.now() - 1_000,
    })
    const outcome = await pass(f)
    expect(outcome.kind).toBe('undecided')
    expect(outcome.kind === 'undecided' && outcome.reason).toMatch(/holds the adoption claim/i)
    expect(f.host.closed).toEqual([])
    expect(f.host.attached[0]?.detached).toBe(true)
    // UNTOUCHED. A refusal that overwrote the live claimant's marker would hand the row to
    // whoever asked third.
    expect(readRow(f.registryPath)?.adoption_claim_by).toBe('another-incarnation-mid-adoption')
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
