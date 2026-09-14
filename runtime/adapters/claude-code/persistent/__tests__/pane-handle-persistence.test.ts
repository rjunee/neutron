/**
 * pane-handle-persistence.test.ts — #539 seam 1: the row's pane handle describes the
 * CURRENT child, or it is absent.
 *
 * WHY THIS NEEDS ITS OWN CASE. The registry write merges the new record onto the prior
 * row, so every field that a spawn does not set survives from the incarnation before
 * it. That is right for `has_session` and wrong for a pane handle: a handle inherited
 * from a previous, herdr-hosted child would send the next boot's reconciliation to a
 * pane id that names nothing — or, after a herdr server restarted its pane numbering,
 * names SOMEBODY ELSE'S pane, which it would then inspect and could close.
 *
 * So the two directions are: a host that issues a handle writes it, and a host that
 * issues none leaves the row with none, even when the row had one a moment ago.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '../../../../substrate.ts'
import type { Event } from '../../../../events.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import {
  bakedChildSinkInfo,
  createPersistentReplSubstrate,
  poolKeyFor,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'
import type { ReplRegistry, ReplRegistryRecord } from '../repl-registry.ts'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import { paneClaimBlocksUs } from '../signatures.ts'
import type { ReplSession } from '../repl-session.ts'
import { fenceLostSession, reconcileOwnRepl, resetBootAdoptionForTests } from '../boot-adoption.ts'
import { registerSupervisedSubstrate, runReplWatchdogTick } from '../supervision.ts'
import { setFlockImplForTests } from '../registry-lock.ts'
import { childByKey, pool, sink } from '../pool-state.ts'
import { ProcessRegistry, pushAmbientProcessRegistry } from '@neutronai/tools/process-registry.ts'
import { FakeAdoptableHost } from './boot-adoption-host.ts'

const dirs: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'neutron-539-handle-'))
  dirs.push(d)
  return d
}

/** A fake `claude` + dev-channel that answers one turn. `paneHandle` is what this
 *  host claims about durability — present for a herdr-like host, absent for an
 *  in-process one. */
/** Kills observed on children this host handed out — the observable for "the spawn
 *  refused AND cleaned up after itself" rather than "the spawn refused". */
const killsByHandle: string[] = []
/** Every `PtyHost.spawn` this file's hosts were asked for. The r47 assertion surface: what
 *  matters is that the loser NEVER STARTED a process, not that one was tidied up after. */
const spawnCalls: string[] = []
/** The sink port + per-child credential baked into the last spawned child's config. */
let lastBakedSink: { port: number; token: string } | undefined

function echoHost(paneHandle?: string, onSpawn?: () => void): PtyHost {
  return {
    async spawn(argv: string[]): Promise<PtyChild> {
      spawnCalls.push(paneHandle ?? '(no handle)')
      // FIRES INSIDE THE SPAWN, which is the only point between the r47 reservation and the
      // ownership write that a case can reach — the seam for "the lock worked long enough to
      // reserve and then stopped".
      onSpawn?.()
      const i = argv.indexOf('--session-id')
      const r = argv.indexOf('--resume')
      const sid = (i >= 0 ? argv[i + 1] : r >= 0 ? argv[r + 1] : undefined) as string
      const { port: sinkPort, token } = bakedChildSinkInfo(argv)
      // CAPTURED FOR THE AUTHORIZATION CASES (r63): this is the coordinate pair the CHILD was
      // given, so a case can present exactly what the child presents.
      lastBakedSink = { port: sinkPort, token }
      let exited = false
      let exitResolve: (code: number | null) => void = () => {}
      const exitedPromise = new Promise<number | null>((res) => {
        exitResolve = res
      })
      const post = (path: string, body: unknown): Promise<unknown> =>
        fetch(`http://127.0.0.1:${sinkPort}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token },
          body: JSON.stringify(body),
        }).catch(() => undefined)
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/health') return Response.json({ ok: true, session_id: sid })
          if (req.method === 'POST' && url.pathname === '/message') {
            const body = (await req.json()) as { text: string; turn_id?: string }
            void post('/reply', { session_id: sid, text: `echo ${body.text}`, turn_id: body.turn_id })
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      servers.push(server)
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid: 4242 })
      void post('/channel-bound', { session_id: sid })
      return {
        pid: 4242,
        ...(paneHandle !== undefined ? { paneHandle } : {}),
        write() {},
        kill() {
          if (exited) return
          if (paneHandle !== undefined) killsByHandle.push(paneHandle)
          exited = true
          try {
            server.stop(true)
          } catch {
            /* ignore */
          }
          exitResolve(143)
        },
        exited: exitedPromise,
        hasExited: () => exited,
        wasKilledByUs: () => true,
      }
    },
  }
}

function optionsFor(host: PtyHost, registryPath: string): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-llm-handle',
    cwd: '/tmp/neutron-handle',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    replRegistryPath: registryPath,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
  } as unknown as PersistentReplSubstrateOptions
}

const spec = (prompt: string): AgentSpec => ({ prompt, tools: [], model_preference: ['claude-opus-5'] })

async function drain(handle: SessionHandle): Promise<string> {
  let text = ''
  for await (const ev of handle.events as AsyncIterable<Event>) {
    if (ev.kind === 'token') text += ev.text
    else if (ev.kind === 'completion') return text
    else if (ev.kind === 'error') throw new Error(`drain error: ${ev.message}`)
  }
  return text
}

function readRow(path: string, key: string): ReplRegistryRecord | undefined {
  return (JSON.parse(readFileSync(path, 'utf8')) as ReplRegistry)[key]
}

afterEach(async () => {
  setFlockImplForTests(undefined)
  killsByHandle.length = 0
  spawnCalls.length = 0
  await shutdownAllPersistentRepls()
  for (const s of servers.splice(0)) {
    try {
      s.stop(true)
    } catch {
      /* already stopped */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('the registry row records the current child terminal', () => {
  it('writes the handle a durable host issued', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost('w9:p77'), registryPath)
    await drain(createPersistentReplSubstrate(options).start(spec('hi')))
    const row = readRow(registryPath, poolKeyFor(options))
    expect(row?.pane_handle).toBe('w9:p77')
    // And the spawn-time reuse properties travel with it, or the next boot's
    // adoption has nothing to answer the warm-reuse guards with.
    expect(row?.reuse).toBeDefined()
    expect(typeof row?.reuse?.tool_surface).toBe('string')
    expect(row?.child_generation).toBeDefined()
  })

  it('CLEARS a stale handle when the new child has none', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost(), registryPath)
    const key = poolKeyFor(options)
    // A row left by a previous, herdr-hosted incarnation.
    const stale: ReplRegistry = {
      [key]: {
        sessionKey: key,
        sessionId: 'eeeeeeee-1111-2222-3333-444444444444',
        cwd: '/tmp/neutron-handle',
        channelName: 'neutron-904a860d597f559a30a30e0748dcec8e',
        has_session: false,
        pane_handle: 'w9:p-from-a-previous-life',
        // A pid the kernel will not know (above `pid_max`), so the boot pass can
        // establish POSITIVELY that the previous child is gone and let this spawn
        // proceed. Without it the pass would refuse — correctly — because a host that
        // cannot reach the pane and a row with no pid establish nothing between them.
        pid: 2_147_483_647,
      },
    }
    writeFileSync(registryPath, JSON.stringify(stale, null, 2))

    await drain(createPersistentReplSubstrate(options).start(spec('hi')))

    const row = readRow(registryPath, key)
    expect(row).toBeDefined()
    // The spawn happened, so the row describes the NEW child...
    expect(row?.child_generation).toBeDefined()
    // ...and carries no handle, because this child has none. A merged row would have
    // kept the old pane id and sent the next boot chasing it.
    expect(row?.pane_handle).toBeUndefined()
  })
})


describe('a pane is OWNED by whoever serves it, however that session came to exist', () => {
  /**
   * ARGUS r40. The claim was built into the ADOPTION path, and ownership is not a
   * property of how a session came to exist. A fresh spawn wrote a pane handle and NO
   * claim, so the row was owned and unclaimed — and an adopter starting while that
   * gateway was alive and serving read an unclaimed row, claimed it, attached and
   * published. Two live wrappers on one pane, with the spawner unable even to notice,
   * because renewal returns immediately for a session with no claim of its own.
   */
  it('an actively-served FRESH SPAWN blocks an overlapping adopter', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost('w9:p77'), registryPath)
    const key = poolKeyFor(options)
    // AS THE REAL SELECTOR DOES (`adapters/claude-code/index.ts`): the substrate registers
    // itself as the owner of its key before any tick runs. The tick actuates through that
    // registration, so a harness that skips it has no supervision at all — and the renewal
    // assertion below would pass vacuously in the one direction that matters.
    registerSupervisedSubstrate(options)
    await drain(createPersistentReplSubstrate(options).start(spec('hi')))

    // THE ROW IS OWNED AND CLAIMED, in one write. Field-for-field, because "adoption
    // succeeded" would pass with any of these missing.
    const row = readRow(registryPath, key)
    expect(row?.pane_handle).toBe('w9:p77')
    expect(typeof row?.adoption_claim_by).toBe('string')
    expect(typeof row?.adoption_claim_at).toBe('number')
    // The claiming gateway's OWN process — alive, because it is this one.
    expect(row?.adoption_claim_pid).toBe(process.pid)

    const served = await pool.get(key)
    expect(served).toBeDefined()

    // AND THE SPAWNED SESSION RENEWS, which is the half that keeps the claim meaningful
    // for longer than one takeover window. Without it a spawner's claim would simply
    // expire under it and the adopter below would win ninety seconds later — the same
    // defect, arriving slowly. Driven through the real supervision tick, because a
    // renewal nothing invokes is indistinguishable from no renewal at all.
    const claimedAt = readRow(registryPath, key)?.adoption_claim_at as number
    await runReplWatchdogTick(options, {
      now: () => claimedAt + 60_000,
      healthProbe: async () => true,
      isPidAlive: () => true,
    })
    expect(readRow(registryPath, key)?.adoption_claim_at).toBe(claimedAt + 60_000)
    // Still the same owner — a renewal is not a re-claim.
    expect(readRow(registryPath, key)?.adoption_claim_by).toBe(row?.adoption_claim_by)

    // A SECOND GATEWAY TRIES TO ADOPT THE PANE THIS ONE IS SERVING. Its host can see the
    // pane and the argv matches the row, so everything except the claim says "adopt me".
    const adopter = new FakeAdoptableHost()
    adopter.addPane('w9:p77', {
      argv: [
        'claude',
        '--resume',
        row?.sessionId as string,
        '--dangerously-load-development-channels',
        `server:${row?.channelName as string}`,
      ],
      screens: ['idle'],
      pid: 4242,
    })
    resetBootAdoptionForTests()
    const outcome = await reconcileOwnRepl(options, key, {
      host: adopter,
      health: async () => true,
      log: () => {},
      // A DIFFERENT GATEWAY, so a different pid. The claim predicate deliberately does not
      // let a gateway be blocked by its OWN process's earlier claim — a replacement spawn
      // must not refuse itself on the strength of a claim its dead child left — and two
      // gateways in one test process share `process.pid`, which would make this contest
      // vacuous. A case that models two gateways models two pids.
      claimantPid: process.pid + 1,
    })

    // REFUSED, naming the claim.
    expect(outcome.kind).toBe('undecided')
    expect(outcome.kind === 'undecided' && outcome.reason).toMatch(/holds the adoption claim/i)
    // ONE WRAPPER: the adopter attached before the claim (the claim is the last act) and
    // handed its child straight back, without closing the pane the spawner is serving.
    expect(adopter.attached).toHaveLength(1)
    expect(adopter.attached[0]?.detached).toBe(true)
    expect(adopter.closed).toEqual([])
    // AND THE SPAWNER IS STILL SERVING — the pool still resolves to its session, and the
    // row still carries its claim.
    expect(await pool.get(key)).toBe(served)
    expect(readRow(registryPath, key)?.adoption_claim_by).toBe(row?.adoption_claim_by)
  })

  it('...and blocks one IN THE SAME PROCESS, which is the supported case the pid shortcut broke', async () => {
    /**
     * THE CASE THE CASE ABOVE AVOIDS (#539, Argus r59 — found by a whole-branch review).
     *
     * The overlap case hands the adopter `claimantPid: process.pid + 1`, and says why: two
     * gateways in one test process share a pid, and the predicate treated ANY claim carrying
     * this process's pid as ours. But overlapping boots **in one process** are exactly what
     * this repo supports (`gateway/index.ts`, the overlapping-boot note), so substituting a
     * different pid did not make the fixture fair — **it substituted the defect away.** The
     * headline ownership case exercised the easy direction and left the supported one untested
     * for nineteen rounds.
     *
     * With the same pid, everything about the two gateways is identical except the one thing
     * that IS identity: the claimant id. The rule that makes this case pass is that a claim
     * whose id differs is not ours, whatever pid it carries — the pid is evidence about
     * liveness, and a process that still holds the id is the evidence that settles it.
     */
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost('w9:p77'), registryPath)
    const key = poolKeyFor(options)
    registerSupervisedSubstrate(options)
    await drain(createPersistentReplSubstrate(options).start(spec('hi')))

    const row = readRow(registryPath, key)
    expect(row?.pane_handle).toBe('w9:p77')
    const firstClaim = row?.adoption_claim_by
    expect(typeof firstClaim).toBe('string')
    // THE PREMISE: one process, one pid, on both sides of the contest below.
    expect(row?.adoption_claim_pid).toBe(process.pid)
    const served = await pool.get(key)
    expect(served).toBeDefined()

    const adopter = new FakeAdoptableHost()
    adopter.addPane('w9:p77', {
      argv: [
        'claude',
        '--resume',
        row?.sessionId as string,
        '--dangerously-load-development-channels',
        `server:${row?.channelName as string}`,
      ],
      screens: ['idle'],
      pid: 4242,
    })
    resetBootAdoptionForTests()
    // NO `claimantPid` OVERRIDE: this second logical gateway is in this process, as a second
    // boot of the same gateway binary is.
    const outcome = await reconcileOwnRepl(options, key, {
      host: adopter,
      health: async () => true,
      log: () => {},
    })

    // REFUSED, naming the claim — the first gateway is alive and serving.
    expect(outcome.kind).toBe('undecided')
    expect(outcome.kind === 'undecided' && outcome.reason).toMatch(/holds the adoption claim/i)
    // ONE WRAPPER: the adopter handed its child back rather than closing the pane.
    expect(adopter.attached).toHaveLength(1)
    expect(adopter.attached[0]?.detached).toBe(true)
    expect(adopter.closed).toEqual([])
    // AND THE FIRST GATEWAY IS STILL SERVING: its session is still the pool entry, its claim
    // is still the row's, and a turn dispatched now still reaches it.
    expect(await pool.get(key)).toBe(served)
    expect(readRow(registryPath, key)?.adoption_claim_by).toBe(firstClaim)
    // "STILL SERVING" IN THE CHECKABLE SENSE: it was not fenced, and it did not lose its
    // in-memory claim — the two states in which a session stops answering for its key. (A
    // second dispatch is not the instrument: this host's child exits with its turn, so a
    // failure there would say something about the fixture's echo child, not about ownership.)
    expect(served?.fenced).toBe(false)
    expect(served?.paneClaimBy).toBe(firstClaim)
  })

  it('A FRESH SPAWN LOSES THE CONTEST for a row another gateway owns, and ends its own child', async () => {
    // ARGUS r45, and it completes round forty's lesson. Round forty gave the fresh spawn a
    // claim; it did not give it a CONTEST. The ownership write replaced the row
    // unconditionally under the lock, so two gateways reconciling one resumable row both
    // spawned `--resume` panes and both published — A recorded claim A, B took the lock and
    // replaced it with claim B, and both served one transcript until some later renewal
    // happened to fence A. **Participating in the protocol means contending, not merely
    // writing.**
    //
    // ORDERING, because the loser has already spawned a process: the handle does not exist
    // until the spawn, so the sequence is spawn → contend → the loser KILLS ITS OWN CHILD and
    // refuses. Killing costs one respawn; leaving it alive costs a second owner.
    //
    // WHERE THE CONTEST IS REACHED, stated because the obvious fixture cannot reach it. Two
    // substrates started back to back do not race at the WRITE: the second one's boot
    // reconciliation runs first, cannot speak to the first one's pane (a different host
    // object), and clears the row — so by the time its spawn writes there is no claim left to
    // contend with, and the case would pass against the very code it exists to catch. So the
    // winner's claim is planted between a settled reconciliation and the spawn that follows
    // it, which is exactly the interleaving the defect lived in.
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = {
      ...optionsFor(echoHost('w9:p-loser'), registryPath),
      // TWO GATEWAYS, TWO PIDS: the predicate does not let a gateway be blocked by its own
      // process's earlier claim (a replacement spawn must not refuse itself), so a fixture
      // that models two gateways with one pid makes the contest vacuous.
      claimantPid: process.pid + 1,
      // It asks about the winner's pid and is told it is alive, which it is.
      claimantLiveness: () => 'alive' as const,
    } as PersistentReplSubstrateOptions
    const key = poolKeyFor(options)

    // A first turn settles this key's reconciliation verdict (the registry is empty, so it is
    // `no-handle`) and leaves a serving session behind.
    await drain(createPersistentReplSubstrate(options).start(spec('one')))
    expect(readRow(registryPath, key)?.pane_handle).toBe('w9:p-loser')

    // THE WINNER APPEARS: another gateway now owns this row, claim and all, and is alive.
    pool.delete(key)
    childByKey.delete(key)
    const winner = 'the-other-gateway'
    writeFileSync(
      registryPath,
      JSON.stringify(
        {
          [key]: {
            ...readRow(registryPath, key),
            pane_handle: 'w9:p-winner',
            adoption_claim_by: winner,
            adoption_claim_at: Date.now(),
            adoption_claim_pid: process.pid,
          },
        },
        null,
        2,
      ),
    )

    // THE LOSER SPAWNS ANYWAY — it cannot know until it has a handle to claim — and then
    // contends, and loses. The reconciliation verdict is cached from the first turn, so
    // nothing clears the winner's row on the way in.
    const events: Event[] = []
    let message = ''
    try {
      for await (const ev of createPersistentReplSubstrate(options).start(spec('two'))
        .events as AsyncIterable<Event>) {
        events.push(ev)
      }
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    const err = events.find((e) => e.kind === 'error')
    if (err?.kind === 'error') {
      message = err.message
      // THE REFUSAL CARRIES THE CODE, so an ownership conflict never cools a credential —
      // the same vocabulary as every other refusal this subsystem raises.
      expect(err.code).toBe('repl_unreconciled')
      expect(err.retryable).toBe(true)
    }

    expect(message).toMatch(/refusing to serve session/i)
    expect(message).toMatch(/already OWNS/i)
    // THE LOSER'S CHILD IS ENDED — not left running on a pane nobody records it as owning.
    expect(killsByHandle).toContain('w9:p-loser')
    // AND THE ROW STILL NAMES THE WINNER, field for field: the loser wrote nothing.
    const row = readRow(registryPath, key)
    expect(row?.adoption_claim_by).toBe(winner)
    expect(row?.pane_handle).toBe('w9:p-winner')
  })

  it('...but a REPLACEMENT SPAWN is not refused by its OWN predecessor\'s claim', async () => {
    // THE OTHER SIDE OF THE CONTEST, and the case that keeps the same-process exception
    // honest. A replacement spawn runs while the row may still carry the DEAD child's claim:
    // its claimant id is different (one is minted per spawn) and its pid is this process,
    // which is alive — so a predicate that blocked on any live-looking claim would refuse the
    // respawn and the gateway would kill its own replacement, on the strength of a claim held
    // by a child that had just exited.
    //
    // The teardown that would have cleared it is skipped here (the pool entry is dropped
    // without the exit handler running), which is the same "teardown did not reach the row"
    // shape the merge case below covers — and exactly when the exception has to hold.
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost('w9:p-respawn'), registryPath)
    const key = poolKeyFor(options)
    await drain(createPersistentReplSubstrate(options).start(spec('one')))
    const firstClaim = readRow(registryPath, key)?.adoption_claim_by
    expect(typeof firstClaim).toBe('string')
    expect(readRow(registryPath, key)?.adoption_claim_pid).toBe(process.pid)

    // The child is gone and its teardown DID NOT REACH THE ROW: its claim is still there.
    //
    // MODELLED AS THE PROSE ABOVE DESCRIBES IT, WHICH IT WAS NOT (r59). This used to drop the
    // pool entry and stop, i.e. it modelled a teardown that never ran AT ALL — leaving a live
    // session object still holding its claim. Under the r59 identity rule that is
    // indistinguishable from a live owner, and refusing the respawn is then the CORRECT answer,
    // so the case was failing for a right reason. What the case is actually about is the
    // teardown running and the durable release not landing (an unacquired lock): the owner has
    // given the claim up in this process, and only the ROW still names it. The exit wiring's
    // first synchronous act is exactly this assignment (`child-exit-wiring.ts:137-138`), so
    // performing it here is modelling the teardown, not weakening the case.
    const dying = Bun.peek(pool.get(key) as Promise<ReplSession>) as ReplSession
    expect(dying.paneClaimBy).toBe(firstClaim)
    dying.paneClaimBy = undefined
    pool.delete(key)
    childByKey.delete(key)

    const text = await drain(createPersistentReplSubstrate(options).start(spec('two')))

    // IT SERVED. Not refused, and its child not killed.
    expect(text).toContain('echo')
    expect(killsByHandle).not.toContain('w9:p-respawn')
    // And the row now names the replacement's claim, not its predecessor's.
    expect(readRow(registryPath, key)?.adoption_claim_by).not.toBe(firstClaim)
  })

  it('a REPLACEMENT SPAWN clears ownership its predecessor left behind', async () => {
    // THE MERGE IS A SECOND LINE, and this case reaches it rather than the first. The
    // ordinary route — a child exits and its teardown disowns the row — is covered by the
    // control below; but that teardown can be SKIPPED (the registry write failed, the
    // process died before the handler ran, or the row is claimed by a gateway this one
    // must not touch), and then the replacement spawn is the only thing left that can stop
    // a dead child's ownership being inherited.
    //
    // THE REPLACEMENT MUST HAVE NO PANE OF ITS OWN, which is what makes this a test of the
    // disown rather than of the claim that follows it: when the new child HAS a handle,
    // `ownPane` overwrites all four fields anyway and a missing disown is invisible. The
    // host switch is the supported way to get there (#540 keeps the in-process host
    // selectable) and this file already treats it as a first-class case.
    //
    // The boot pass caches its verdict per key, so the second turn reaches the spawn merge
    // with the planted row intact — nothing else clears it on the way.
    const registryPath = join(scratch(), 'repl-registry.json')
    const durable = optionsFor(echoHost('w9:p99'), registryPath)
    const key = poolKeyFor(durable)
    await drain(createPersistentReplSubstrate(durable).start(spec('one')))
    const first = readRow(registryPath, key)
    expect(first?.pane_handle).toBe('w9:p99')
    expect(typeof first?.adoption_claim_by).toBe('string')

    // The child is gone and its teardown did not reach the row.
    pool.delete(key)
    childByKey.delete(key)

    // The replacement runs on a host that issues no durable handle.
    const inProcess = optionsFor(echoHost(), registryPath)
    expect(poolKeyFor(inProcess)).toBe(key)
    await drain(createPersistentReplSubstrate(inProcess).start(spec('two')))

    const row = readRow(registryPath, key)
    // NO PANE, SO NO OWNER. Both halves, because either one surviving alone is a row that
    // lies: a handle with no claim invites a second owner, and a claim with no handle
    // refuses an adoption on behalf of a child that does not exist.
    expect(row?.pane_handle).toBeUndefined()
    expect(row?.adoption_claim_by).toBeUndefined()
    expect(row?.adoption_claim_at).toBeUndefined()
    expect(row?.adoption_claim_pid).toBeUndefined()
  })

  it('a REPLACEMENT SPAWN inherits no part of the dead child\'s ownership', async () => {
    // The other blocker. The spawn merge dropped `pane_handle` and KEPT
    // `adoption_claim_*`, so the row asserted ownership on behalf of a child that no
    // longer existed — and a restart inside the takeover window refused adoption on the
    // strength of it. Asserted FIELD-FOR-FIELD rather than through "adoption succeeded",
    // because the inherited marker is invisible to any outcome-level assertion.
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost(), registryPath)
    const key = poolKeyFor(options)
    const previous: ReplRegistry = {
      [key]: {
        sessionKey: key,
        sessionId: 'eeeeeeee-1111-2222-3333-444444444444',
        cwd: '/tmp/neutron-handle',
        channelName: 'neutron-904a860d597f559a30a30e0748dcec8e',
        has_session: false,
        pane_handle: 'w9:p-from-a-previous-life',
        child_generation: 'gen-the-dead-one',
        // A claim taken by a gateway that is no longer here, on a child that is gone.
        adoption_claim_by: 'the-previous-incarnation',
        adoption_claim_at: Date.now(),
        adoption_claim_pid: process.pid,
        pid: 2_147_483_647,
      },
    }
    writeFileSync(registryPath, JSON.stringify(previous, null, 2))

    await drain(createPersistentReplSubstrate(options).start(spec('hi')))

    const row = readRow(registryPath, key)
    expect(row).toBeDefined()
    expect(row?.child_generation).not.toBe('gen-the-dead-one')
    expect(row?.pane_handle).toBeUndefined()
    // THE THREE FIELDS THAT USED TO SURVIVE. A row with no pane cannot be owned by
    // anyone, and the previous claimant's marker must not be readable as ownership of
    // the child that replaced it.
    expect(row?.adoption_claim_by).toBeUndefined()
    expect(row?.adoption_claim_at).toBeUndefined()
    expect(row?.adoption_claim_pid).toBeUndefined()
  })

  it('...and an ordinary spawn with no competitor claims, serves, and gives it back on exit', async () => {
    // THE POSITIVE CONTROL, with its second job: the new writes must not be passing by
    // blocking everything, and the release half has to be exercised too — a claim that is
    // taken and never given back wedges the next boot for a takeover window.
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost('w9:p88'), registryPath)
    const key = poolKeyFor(options)
    const text = await drain(createPersistentReplSubstrate(options).start(spec('hello')))
    expect(text).toContain('echo')
    const serving = readRow(registryPath, key)
    expect(serving?.pane_handle).toBe('w9:p88')
    expect(typeof serving?.adoption_claim_by).toBe('string')

    // The child dies (this shutdown kills it — its row is not registered as a survivor).
    await shutdownAllPersistentRepls()

    const after = readRow(registryPath, key)
    expect(after?.pane_handle).toBeUndefined()
    expect(after?.adoption_claim_by).toBeUndefined()
    expect(after?.adoption_claim_pid).toBeUndefined()
  })
})


describe('an ownership transition that could not hold the lock writes NOTHING', () => {
  /**
   * ARGUS r41, and the finding is sharper than "two sites missed a rule". `withFlockSync`
   * runs its callback even when `flock` FAILS, and `withRegistry` saves whatever that
   * callback returns — so an unguarded write here does not fail loudly, it silently
   * rewrites the whole registry from a snapshot nobody had the right to read, dropping a
   * concurrent gateway's rows.
   *
   * Four sites had already needed this rule (rounds fifteen, eighteen, twenty-one), and
   * the two that round forty ADDED shipped without it — written after the rule existed, by
   * someone who knew it. The audit table records what was checked; it cannot make the next
   * write obey anything. So the disposition is now a required parameter of
   * `withOwnedRegistry` and these cases pin what each site DOES about it, because "nothing
   * was written" is only half of a correct answer.
   */
  it('a spawn that cannot RESERVE its key refuses before starting anything', async () => {
    // THE DISPOSITION, stated rather than implied. A durable pane whose ownership was
    // never recorded is a REPL nothing can find again AND one any other gateway may claim
    // while this one serves it. Degrading — the policy for every other field on this row —
    // would produce exactly the unrecorded live child four rounds of this branch have
    // called the unrecoverable direction. So it refuses, and it kills the child it just
    // made, because refusing without killing leaves the same thing behind.
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost('w9:p-lock'), registryPath)
    const key = poolKeyFor(options)
    writeFileSync(registryPath, JSON.stringify({}, null, 2))
    const before = readFileSync(registryPath, 'utf8')

    setFlockImplForTests(() => 1)
    const events: Event[] = []
    for await (const ev of createPersistentReplSubstrate(options).start(spec('hi'))
      .events as AsyncIterable<Event>) {
      events.push(ev)
    }
    const err = events.find((e) => e.kind === 'error')
    const message = err?.kind === 'error' ? err.message : ''

    // THE DISPOSITION, AND IT MOVED EARLIER AT r47. With no lock the SPAWN RESERVATION fails
    // first, so this turn now refuses BEFORE any process exists — strictly better than
    // spawning one and killing it, and the reason names the reservation rather than the
    // ownership write it never reached.
    expect(message).toMatch(/could not be RESERVED/i)
    expect(message).toMatch(/Nothing was started/i)
    // NO CHILD WAS EVER CREATED, which is the point: nothing to kill.
    expect(killsByHandle).toEqual([])
    // AND IT CARRIES ITS CLASS (r42). Unstamped, this arrives at the composer as a bare
    // retryable error, which maps to a synthetic 429 and cools the credential the caller
    // just picked — a local registry-lock failure spending provider capacity. The
    // no-cooldown half is asserted where the money is spent
    // (`gateway/wiring/__tests__/build-llm-call-substrate.test.ts`); this is the half that
    // proves the adapter emits what that surface reads.
    expect(err?.kind === 'error' && err.code).toBe('repl_unreconciled')
    // Retryable: the lock may be free on the next turn.
    expect(err?.kind === 'error' && err.retryable).toBe(true)
    // AND NOTHING WAS WRITTEN. The whole file, because what an unguarded save costs is
    // every OTHER key in it, not this one.
    expect(readFileSync(registryPath, 'utf8')).toBe(before)
    expect(readRow(registryPath, key)).toBeUndefined()
  })

  it('a spawn that RESERVED but could not RECORD ownership kills the child it made', async () => {
    // THE r41 DISPOSITION, still reachable and still required — just no longer the FIRST thing
    // a lockless spawn meets. Here the lock works long enough to reserve the key and fails
    // before the ownership write, which is a transient failure rather than a configuration
    // one: a child now exists, holds a pane, and cannot be recorded as owning it. A durable
    // pane whose ownership is unrecorded is a REPL nothing can find again and one any other
    // gateway may claim, so it is ENDED and the turn refuses.
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(
      // The lock breaks INSIDE the spawn — after the reservation, before the ownership write.
      echoHost('w9:p-late-lock', () => setFlockImplForTests(() => 1)),
      registryPath,
    )
    const events: Event[] = []
    for await (const ev of createPersistentReplSubstrate(options).start(spec('hi'))
      .events as AsyncIterable<Event>) {
      events.push(ev)
    }
    const err = events.find((e) => e.kind === 'error')
    expect(err?.kind === 'error' && err.message).toMatch(/could not be RECORDED as owned/i)
    expect(err?.kind === 'error' && err.code).toBe('repl_unreconciled')
    // AND THE CHILD IT MADE IS ENDED.
    expect(killsByHandle).toContain('w9:p-late-lock')
  })

  it('...and with the lock held the same spawn serves normally', async () => {
    // The positive control, and it is not decoration: a refusal that fired unconditionally
    // would pass the case above and stop every REPL starting.
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost('w9:p-ok'), registryPath)
    const key = poolKeyFor(options)
    const text = await drain(createPersistentReplSubstrate(options).start(spec('hi')))
    expect(text).toContain('echo')
    expect(killsByHandle).not.toContain('w9:p-ok')
    expect(readRow(registryPath, key)?.pane_handle).toBe('w9:p-ok')
    expect(typeof readRow(registryPath, key)?.adoption_claim_by).toBe('string')
  })

  it('a child exit that cannot hold the lock leaves the row exactly alone', async () => {
    // THE OTHER DISPOSITION, and it goes the other way on purpose: do NOT disown. The cost
    // is a row that still names a child which has exited, and the next boot's probe answers
    // `pane_not_found` — a positive absence, and recoverable. The cost of writing would be
    // another gateway's rows.
    // NOT REGISTERED as a supervised substrate, deliberately: with a registration and a
    // matching row the shutdown LEAVES the child alive (that is the feature), and then
    // there is no exit and nothing for this case to observe. Unregistered, the shutdown
    // kills — which is the path whose teardown writes the row.
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost('w9:p-exit'), registryPath)
    const key = poolKeyFor(options)
    await drain(createPersistentReplSubstrate(options).start(spec('hi')))
    expect(readRow(registryPath, key)?.pane_handle).toBe('w9:p-exit')
    const claimBefore = readRow(registryPath, key)?.adoption_claim_by

    // The lock stops working, and THEN the child dies.
    setFlockImplForTests(() => 1)
    await shutdownAllPersistentRepls()

    // OWNERSHIP UNTOUCHED — asserted on the fields rather than the whole file, because the
    // file legitimately gains the #518 shutdown-kill record: that write is one of the four
    // LOCK-INDIFFERENT callers (losing it costs a mislabelled crash, not an invariant), so
    // it still goes through plain `withRegistry`. Asserting whole-file bytes here would be
    // asserting that a different caller's classification had not changed.
    expect(readRow(registryPath, key)?.pane_handle).toBe('w9:p-exit')
    expect(readRow(registryPath, key)?.adoption_claim_by).toBe(claimBefore)
  })

  it('...and with the lock held that same exit disowns the row', async () => {
    // The positive control for the disown, which is what makes the case above a statement
    // about the LOCK rather than about the disown having quietly stopped working.
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost('w9:p-exit-ok'), registryPath)
    const key = poolKeyFor(options)
    await drain(createPersistentReplSubstrate(options).start(spec('hi')))
    expect(readRow(registryPath, key)?.pane_handle).toBe('w9:p-exit-ok')

    await shutdownAllPersistentRepls()

    expect(readRow(registryPath, key)?.pane_handle).toBeUndefined()
    expect(readRow(registryPath, key)?.adoption_claim_by).toBeUndefined()
  })
})

describe('a spawn RESERVES the session key before any process exists', () => {
  /**
   * ARGUS r47, second citation of the ordering invariant (stated in full at the top of
   * `boot-adoption.ts`).
   *
   * Round forty-five made the fresh spawn CONTEND — but only after the process existed, which
   * is all a pane claim can do, since a pane cannot be claimed before it is created. So two
   * `claude --resume` processes still ran against one transcript through startup and
   * readiness, and killing the loser afterwards does not unwrite what it appended. **The
   * corruption this module exists to prevent is two processes resuming into one file**, not a
   * duplicated wrapper — so the loser must never start.
   *
   * The assertion is therefore the SPAWN COUNT, not the cleanup.
   */
  it('the loser never calls PtyHost.spawn at all', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    const mine = optionsFor(echoHost('w9:p-reserved'), registryPath)
    const key = poolKeyFor(mine)

    // ANOTHER GATEWAY HOLDS THE RESERVATION: a live marker, its process alive, taken a moment
    // ago. Written by hand because the other gateway is another PROCESS — that is the whole
    // point of a durable reservation, and a second substrate in this process would model a
    // different thing.
    writeFileSync(
      registryPath,
      JSON.stringify(
        {
          // SCHEMA-VALID, and it has to be: a row carrying only a reservation is dropped by
          // `readRegistryState`, and a dropped row refuses the turn before the reservation is
          // ever consulted — the fixture would then pass for a reason unrelated to the
          // contest. No `pane_handle`, so reconciliation answers `no-handle` and the spawn
          // path is actually reached.
          [key]: {
            sessionKey: key,
            sessionId: 'cccccccc-1111-2222-3333-444444444444',
            cwd: '/tmp/neutron-handle',
            channelName: 'neutron-904a860d597f559a30a30e0748dcec8e',
            has_session: false,
            spawn_reservation_by: 'the-other-gateway',
            spawn_reservation_at: Date.now(),
            spawn_reservation_pid: process.pid,
          },
        },
        null,
        2,
      ),
    )
    const options = {
      ...mine,
      // Two gateways, two pids — otherwise the same-process exception (a retry must not refuse
      // itself) makes the contest vacuous.
      claimantPid: process.pid + 1,
      claimantLiveness: () => 'alive' as const,
    } as PersistentReplSubstrateOptions

    const events: Event[] = []
    for await (const ev of createPersistentReplSubstrate(options).start(spec('hi'))
      .events as AsyncIterable<Event>) {
      events.push(ev)
    }

    const err = events.find((e) => e.kind === 'error')
    expect(err?.kind === 'error' && err.message).toMatch(/has RESERVED this session key/i)
    expect(err?.kind === 'error' && err.message).toMatch(/Nothing was started/i)
    expect(err?.kind === 'error' && err.code).toBe('repl_unreconciled')
    expect(err?.kind === 'error' && err.retryable).toBe(true)
    // THE ASSERTION THAT CARRIES IT: no process was ever started, so nothing appended to the
    // transcript. "The loser was cleaned up" would be a strictly weaker claim.
    expect(spawnCalls).toEqual([])
    expect(killsByHandle).toEqual([])
  })

  it('...and an uncontended spawn still spawns', async () => {
    // THE POSITIVE CONTROL. A reservation that refused everything would pass the case above
    // and stop every REPL starting — the feature, switched off by its own guard.
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost('w9:p-free'), registryPath)
    const text = await drain(createPersistentReplSubstrate(options).start(spec('hi')))
    expect(text).toContain('echo')
    expect(spawnCalls).toEqual(['w9:p-free'])
    // AND THE RESERVATION IS GIVEN BACK, so the next turn is not refused by our own leftovers.
    const row = readRow(registryPath, poolKeyFor(options))
    expect(row?.spawn_reservation_by).toBeUndefined()
    expect(row?.spawn_reservation_at).toBeUndefined()
  })

  it('a reservation whose holder DIED does not wedge the key', async () => {
    // The TTL's reason for existing, and the pid path that makes the common case instant. A
    // gateway that dies between reserving and spawning leaves a marker nothing will clear; if
    // that blocked the key forever, a crash would make a transcript permanently unservable —
    // worse than the race being prevented.
    const registryPath = join(scratch(), 'repl-registry.json')
    const mine = optionsFor(echoHost('w9:p-after-death'), registryPath)
    const key = poolKeyFor(mine)
    writeFileSync(
      registryPath,
      JSON.stringify(
        {
          [key]: {
            sessionKey: key,
            sessionId: 'dddddddd-1111-2222-3333-444444444444',
            cwd: '/tmp/neutron-handle',
            channelName: 'neutron-904a860d597f559a30a30e0748dcec8e',
            has_session: false,
            spawn_reservation_by: 'a-gateway-that-never-came-back',
            spawn_reservation_at: Date.now(),
            spawn_reservation_pid: 4242,
          },
        },
        null,
        2,
      ),
    )
    const options = {
      ...mine,
      claimantPid: process.pid + 1,
      // ITS PROCESS IS PROVABLY GONE, which is a finding rather than a wait.
      claimantLiveness: () => 'gone' as const,
    } as PersistentReplSubstrateOptions

    const text = await drain(createPersistentReplSubstrate(options).start(spec('hi')))
    expect(text).toContain('echo')
    expect(spawnCalls).toEqual(['w9:p-after-death'])
  })
})

describe('a failed first spawn costs a turn, not the key', () => {
  it('leaves no reservation stub behind, so the next turn still works', async () => {
    // A REGRESSION I NEARLY SHIPPED, and it is worth its own case because its failure mode is
    // permanent. A reservation taken on a key with no row yet has to create a row to carry it,
    // and a row carrying only a reservation is SCHEMA-INVALID: `readRegistryState` drops it,
    // and a dropped row makes reconciliation answer `undecided`, which refuses every later
    // turn for that key — with no TTL to end it. So the release removes the stub rather than
    // leaving it, and this case is what tells the difference.
    const registryPath = join(scratch(), 'repl-registry.json')
    const throwing: PtyHost = {
      async spawn(): Promise<PtyChild> {
        throw new Error('the host could not start a child this time')
      },
    }
    const failing = optionsFor(throwing, registryPath)
    const key = poolKeyFor(failing)

    let firstFailed = false
    try {
      await drain(createPersistentReplSubstrate(failing).start(spec('one')))
    } catch {
      firstFailed = true
    }
    expect(firstFailed).toBe(true)
    // NOTHING WEDGING THE KEY: no stub row, and in particular no reservation.
    const after = readRow(registryPath, key)
    expect(after?.spawn_reservation_by).toBeUndefined()

    // AND THE NEXT TURN SERVES — the assertion that would fail if a dropped stub survived.
    const working = optionsFor(echoHost('w9:p-after-failure'), registryPath)
    expect(poolKeyFor(working)).toBe(key)
    const text = await drain(createPersistentReplSubstrate(working).start(spec('two')))
    expect(text).toContain('echo')
  })
})

describe('an ownership write that did not LAND is a refusal, however it failed', () => {
  /**
   * ARGUS r48. `withRegistry` has three ways to decline to persist, and only the first was
   * ever surfaced: the lock (round fifteen). An UNREADABLE registry makes
   * `loadRegistryForMutation` set `skipSave` while the mutator's result still comes back, and
   * a THROWN open or save was caught and dropped — so the fresh-spawn ownership write
   * confirmed the claim and served a pane whose ownership nothing durable records, which is
   * the state the spec item and the as-built both say ends the child.
   *
   * The lock case is covered above; these are the other two, and each asserts the same four
   * things: the turn refuses, the child is terminated, ownership was not confirmed, and the
   * registry bytes are unchanged.
   */
  it('a non-ENOENT READ failure (the registry path is a directory) refuses and ends the child', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    // The reservation must SUCCEED first — this case is about the ownership write, not the
    // reservation — so the registry is a normal file until the spawn is under way, and becomes
    // a DIRECTORY inside the host's spawn callback. Every later read gets EISDIR.
    const options = optionsFor(
      echoHost('w9:p-eisdir', () => {
        rmSync(registryPath, { force: true })
        mkdirSync(registryPath, { recursive: true })
      }),
      registryPath,
    )
    const events: Event[] = []
    for await (const ev of createPersistentReplSubstrate(options).start(spec('hi'))
      .events as AsyncIterable<Event>) {
      events.push(ev)
    }
    const err = events.find((e) => e.kind === 'error')
    expect(err?.kind === 'error' && err.message).toMatch(/could not be RECORDED as owned/i)
    expect(err?.kind === 'error' && err.code).toBe('repl_unreconciled')
    // THE CHILD IS TERMINATED — an unrecorded durable pane is the unrecoverable direction.
    expect(killsByHandle).toContain('w9:p-eisdir')
    // AND NOTHING WAS WRITTEN: the path is still the directory this case made it.
    expect(statSync(registryPath).isDirectory()).toBe(true)
  })

  it('a THROWN save refuses and ends the child too', async () => {
    // A SAVE THAT THROWS while the READ still works — the third decline, and distinct from
    // EISDIR above, which fails the read. The registry stays readable and its DIRECTORY becomes
    // unwritable mid-spawn, so `saveRegistry`'s atomic temp file cannot be created (EACCES).
    const dir = scratch()
    const registryPath = join(dir, 'repl-registry.json')
    writeFileSync(registryPath, JSON.stringify({}, null, 2))
    // THE BASELINE IS TAKEN AT THE MOMENT THE WRITE IS BLOCKED, not before the turn: the r47
    // spawn RESERVATION legitimately writes a row before the spawn, so a baseline captured
    // earlier would be asserting that the reservation had not happened either.
    let before = ''
    const options = optionsFor(
      echoHost('w9:p-throws', () => {
        before = readFileSync(registryPath, 'utf8')
        chmodSync(dir, 0o555)
      }),
      registryPath,
    )
    const events: Event[] = []
    try {
      for await (const ev of createPersistentReplSubstrate(options).start(spec('hi'))
        .events as AsyncIterable<Event>) {
        events.push(ev)
      }
    } finally {
      // Restore before the shared cleanup runs, or the scratch dir cannot be removed.
      chmodSync(dir, 0o755)
    }
    const err = events.find((e) => e.kind === 'error')
    expect(err?.kind === 'error' && err.message).toMatch(/could not be RECORDED as owned/i)
    expect(err?.kind === 'error' && err.code).toBe('repl_unreconciled')
    expect(killsByHandle).toContain('w9:p-throws')
    // BYTES UNCHANGED: the write did not land, which is the whole premise of the refusal.
    expect(readFileSync(registryPath, 'utf8')).toBe(before)
  })

  it('a reservation whose DURABLE release failed does not wedge the key for this process', async () => {
    /**
     * THE FOURTH REPRESENTATION, AND ITS RELEASE (#539, Argus r61).
     *
     * The local-ownership register — "which ids does THIS process hold" — is a fourth
     * representation of ownership alongside the durable row, the pool entry and the in-memory
     * claim, and every path that stops owning has to release it. The reservation path acquires
     * in the funnel and releases in `releaseSpawnReservation`; when that release's durable
     * write fails, the row goes on naming the reserver, and a process that ALSO went on
     * claiming to hold it would refuse this key to every later turn until the TTL — the exact
     * wedge the register was introduced to prevent, arriving from the other side.
     *
     * The previous case for this ("a reservation this process no longer holds") checked an
     * arbitrary unregistered id and passed under both implementations: no acquire, no release,
     * nothing observed. This one performs the whole cycle and breaks it in the middle.
     */
    const dir = scratch()
    const registryPath = join(dir, 'repl-registry.json')
    writeFileSync(registryPath, JSON.stringify({}, null, 2))
    const options = optionsFor(
      // The registry becomes unwritable between the reservation and the ownership write, so
      // this turn refuses AND its reservation release cannot persist.
      echoHost('w9:p-stuck-reservation', () => chmodSync(dir, 0o555)),
      registryPath,
    )
    const key = poolKeyFor(options)
    const events: Event[] = []
    try {
      for await (const ev of createPersistentReplSubstrate(options).start(spec('hi'))
        .events as AsyncIterable<Event>) {
        events.push(ev)
      }
    } finally {
      chmodSync(dir, 0o755)
    }
    expect(events.find((e) => e.kind === 'error')).toBeDefined()

    // THE PREMISE: the row still names the abandoned reservation, stamped with THIS pid.
    const stranded = readRow(registryPath, key)
    expect(typeof stranded?.spawn_reservation_by).toBe('string')
    expect(stranded?.spawn_reservation_pid).toBe(process.pid)

    // THE NEXT TURN IN THIS PROCESS IS NOT REFUSED BY IT. Same pid, different reserver id, and
    // no live owner here holds the stranded one.
    const text = await drain(
      createPersistentReplSubstrate(optionsFor(echoHost('w9:p-next'), registryPath)).start(
        spec('again'),
      ),
    )
    expect(text).toContain('echo')
    expect(spawnCalls).toContain('w9:p-next')
  })

  it('...and a healthy registry still records ownership and serves', async () => {
    // THE POSITIVE CONTROL. Three refusals that fired unconditionally would pass every case
    // above and stop every REPL starting.
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost('w9:p-healthy'), registryPath)
    const text = await drain(createPersistentReplSubstrate(options).start(spec('hi')))
    expect(text).toContain('echo')
    expect(killsByHandle).not.toContain('w9:p-healthy')
    const row = readRow(registryPath, poolKeyFor(options))
    expect(row?.pane_handle).toBe('w9:p-healthy')
    expect(typeof row?.adoption_claim_by).toBe('string')
  })
})

describe('a spawn that FAILS READINESS deletes only its own pool entry (#539 r56)', () => {
  /**
   * THE FOURTH SIBLING OF ONE OPERATION, and the reason round fifty-six asked for an
   * enumeration instead of a fix: `spawnSession` suspends in the readiness assertion, and the
   * failure branch ran a bare `pool.delete(sessionKey)`. Publish A → readiness awaits → publish
   * B → A fails readiness → the bare delete evicts **B**, and the identity-guarded catch that
   * runs afterwards finds an empty slot and does nothing. The unguarded delete raced the
   * guarded one and won by running first.
   *
   * `spawnSession` cannot name the entry it owns — the promise it runs inside is created by its
   * caller — so the fix is that it does not delete at all: the rejection reaches
   * `spawning.catch`, which holds the promise and removes only its own entry.
   *
   * THIS CASE ALSO FIXES AN ATTRIBUTION. Every earlier case for this operation drives
   * `wireChildExit`; none reached `getOrSpawnSession`, so a claim that "the spawn-rejection
   * site got the same fix" had no case behind it — a row that looks like evidence and is not.
   */
  it('a replacement published during the readiness window survives the failure', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    // A host that spawns a child which never becomes ready: no /channel-ready, no /health. The
    // readiness assertion therefore fails after its (short, injected) budget.
    let installReplacement: (() => void) | undefined
    const neverReady: PtyHost = {
      async spawn(): Promise<PtyChild> {
        spawnCalls.push('w9:p-never-ready')
        // INSIDE the spawn, before readiness — deterministic, no timing assumption.
        installReplacement?.()
        let exited = false
        return {
          pid: 4242,
          paneHandle: 'w9:p-never-ready',
          write() {},
          kill() {
            exited = true
          },
          exited: new Promise<number | null>(() => {}),
          hasExited: () => exited,
          wasKilledByUs: () => true,
        }
      },
    }
    const options = {
      ...optionsFor(neverReady, registryPath),
      // Short, so the assertion fails promptly rather than on the default multi-second budget.
      assertConfig: { readyBudgetMs: 150, readyIntervalMs: 25, healthBudgetMs: 150, healthIntervalMs: 25 },
    } as PersistentReplSubstrateOptions
    const key = poolKeyFor(options)

    // The replacement another turn publishes while our readiness assertion is waiting.
    const replacement = new Promise<never>(() => {}) as unknown as Promise<ReplSession>
    installReplacement = () => {
      pool.set(key, replacement)
    }

    const events: Event[] = []
    for await (const ev of createPersistentReplSubstrate(options).start(spec('hi'))
      .events as AsyncIterable<Event>) {
      events.push(ev)
    }
    const err = events.find((e) => e.kind === 'error')
    expect(err?.kind === 'error' && err.message).toMatch(/spawn failed|channel not ready|refusing/i)

    // B SURVIVES. Before r56 the failing spawn's bare delete removed it, orphaning a live REPL
    // out of the map every turn resolves through.
    expect(pool.get(key)).toBe(replacement)
    pool.delete(key)
  })
})

/**
 * THE FOUR REPRESENTATIONS AGREE, AND DISAGREE ONLY WHERE THE MODEL SAYS THEY MAY (#539, r61).
 *
 * The ownership model names four representations of one fact — the durable row, the pool entry,
 * the session's in-memory claim, and this process's register of ids it holds. Each pairwise
 * relation is enforced where it is written, and until now NOTHING asserted the whole agreement:
 * divergence D5 on the walk, and the shape that made the PID-identity defect invisible to a
 * per-site review, because every site was locally correct.
 *
 * This case states the agreement once, in both of its states: while a session owns its pane, and
 * after it has been fenced — where the row is DELIBERATELY left alone and the other three go.
 */
describe('the representations of ownership agree', () => {
  it('all four name the same owner while it serves, and three of four release on a fence', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost('w9:p-agree'), registryPath)
    const key = poolKeyFor(options)
    await drain(createPersistentReplSubstrate(options).start(spec('hi')))

    const row = readRow(registryPath, key)
    const claim = row?.adoption_claim_by as string
    const session = (await pool.get(key)) as ReplSession

    // R1 the durable row, R3 the session's own claim: the same id.
    expect(typeof claim).toBe('string')
    expect(session.paneClaimBy).toBe(claim)
    // R2 routing: the key resolves to that session, and `childByKey` mirrors its child.
    expect(childByKey.get(key)).toBe(session.child)
    // R4 the process register: another logical gateway HERE is blocked by that claim, which is
    // the only externally visible statement of "this process holds it".
    expect(
      paneClaimBlocksUs(row as NonNullable<typeof row>, {
        ours: 'some-other-gateway',
        now: row?.adoption_claim_at as number,
        ourPid: process.pid,
      }),
    ).toBe(true)

    // AND NOW THE ONE ASYMMETRY THE MODEL ALLOWS. Fencing stops serving without touching the
    // row: after a takeover the row is the winner's, and after a self-fence we are the gateway
    // that could not write it. So R1 stands and R2/R3/R4 go.
    fenceLostSession(key, session, 'the row names another claimant', () => {})
    expect(readRow(registryPath, key)?.adoption_claim_by).toBe(claim) // R1 untouched
    expect(pool.get(key)).toBeUndefined() // R2
    expect(childByKey.get(key)).toBeUndefined() // R2's mirror
    expect(session.paneClaimBy).toBeUndefined() // R3
    expect(
      paneClaimBlocksUs(row as NonNullable<typeof row>, {
        ours: 'some-other-gateway',
        now: row?.adoption_claim_at as number,
        ourPid: process.pid,
      }),
    ).toBe(false) // R4 — and this is what lets the takeover the fence exists for actually happen
  })
})

/**
 * A CONTENDER MUST NOT REVOKE THE WINNER'S AUTHORIZATION (#539, Argus r63).
 *
 * Round forty-seven's rule is "no capability before ownership", and it was applied to the two
 * capabilities that round's finding named: screen delivery and detector actuation. **Sink
 * registration is also a capability** — it is what makes a reply from a child acceptable — and
 * it is the one that is worse than the others, because acquiring it REVOKES somebody else's:
 * `ReplSink.register` deletes the displaced session's credential.
 *
 * So a contender that registered before it claimed could strip the winner without ever winning
 * anything: it wiped the winner's credential entry, lost the claim, and then unregistered what
 * was left on its way out. The winner published, served, and its first reply got a 401.
 *
 * The existing race cases check the pane, the pool entry and the row — every representation of
 * OWNERSHIP — and none of them presents a credential. These do.
 */
describe('a refused contender leaves the winner able to be answered', () => {
  // AN AMBIENT PROCESS REGISTRY, so the live-process assertion below observes something. Without
  // one `registerLiveProcessSafe` returns the no-op handle and the cell is untestable.
  let processRegistry: ProcessRegistry
  let clearRegistry: () => void = () => {}
  beforeEach(() => {
    processRegistry = new ProcessRegistry()
    clearRegistry = pushAmbientProcessRegistry(processRegistry)
  })
  afterEach(() => {
    clearRegistry()
  })

  async function authorize(credential: string): Promise<number> {
    const port = lastBakedSink?.port as number
    const resp = await fetch(`http://127.0.0.1:${port}/tools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sink-Token': credential },
      body: JSON.stringify({ session_id: 'whatever' }),
    })
    return resp.status
  }

  it('an overlapping ADOPTER that loses the claim does not strip the winner\'s credential', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost('w9:p-auth'), registryPath)
    const key = poolKeyFor(options)
    registerSupervisedSubstrate(options)
    await drain(createPersistentReplSubstrate(options).start(spec('hi')))
    const row = readRow(registryPath, key)
    const winner = (await pool.get(key)) as ReplSession
    const winnerCredential = lastBakedSink?.token as string
    // THE PREMISE: the credential the child was baked with is the one the sink derives for the
    // winner's generation. If these ever diverged the case would be testing nothing.
    expect(winnerCredential).toBe(sink.credentialFor(winner))
    expect(await authorize(winnerCredential)).toBe(200)

    // A second gateway adopts the same pane and LOSES — the row carries the winner's claim.
    const adopter = new FakeAdoptableHost()
    adopter.addPane('w9:p-auth', {
      argv: [
        'claude',
        '--resume',
        row?.sessionId as string,
        '--dangerously-load-development-channels',
        `server:${row?.channelName as string}`,
      ],
      screens: ['idle'],
      pid: 4242,
    })
    resetBootAdoptionForTests()
    const outcome = await reconcileOwnRepl(options, key, {
      host: adopter,
      health: async () => true,
      log: () => {},
      claimantPid: process.pid + 1,
    })
    expect(outcome.kind).toBe('undecided')

    // AND THE WINNER CAN STILL BE ANSWERED. This is the assertion the race cases were missing:
    // ownership was never in doubt here — authorization was.
    expect(await authorize(winnerCredential)).toBe(200)
    expect(await pool.get(key)).toBe(winner)
    // AND IT IS STILL VISIBLE TO THE CRASHED-AGENT WATCHDOG (the second displacing capability):
    // `registerLiveProcessSafe` unregisters the name first, so a contender that registered
    // before claiming removed the winner's record and its own release then deleted what it had
    // displaced — leaving a live REPL whose death nothing would report.
    expect(processRegistry.list().filter((r) => r.name === key)).toHaveLength(1)
    // THE CONTROL, so 200 is not simply what this route always answers.
    expect(await authorize('not-a-credential')).toBe(401)
  })

  it('a FRESH SPAWN that loses the reservation does not strip the live session\'s credential', async () => {
    // The same rule on the other path. A handle-less host writes NO claim (ownership is the
    // pane's, and there is no pane), so a later turn for this key reaches the SPAWN path rather
    // than being refused by a claim — which is what makes the reservation the thing that
    // refuses, and therefore what makes this reachable at all.
    const registryPath = join(scratch(), 'repl-registry.json')
    const first = optionsFor(echoHost(), registryPath)
    const key = poolKeyFor(first)
    await drain(createPersistentReplSubstrate(first).start(spec('hi')))
    const live = (await pool.get(key)) as ReplSession
    const liveCredential = lastBakedSink?.token as string
    expect(liveCredential).toBe(sink.credentialFor(live))
    expect(await authorize(liveCredential)).toBe(200)

    // The pool entry is dropped, so the next turn spawns rather than reusing — and the row
    // records this transcript's id, so that spawn RESUMES it and therefore registers under the
    // same session id the live one holds.
    const row = readRow(registryPath, key)
    expect(row?.sessionId).toBe(live.sessionId)
    // THE PREMISE THAT MAKES THE COLLISION POSSIBLE: the next spawn must RESUME this
    // transcript, or it mints a fresh session id and never registers under the live one's.
    // This fixture's child never reports its session (the echo host answers `/health` and
    // nothing else), so `has_session` is written below with the reservation — a row that names
    // a transcript which demonstrably exists, since the live session is holding it.
    pool.delete(key)
    childByKey.delete(key)

    // ANOTHER GATEWAY HOLDS THE RESERVATION: written by hand, because it is another process.
    const current = JSON.parse(readFileSync(registryPath, 'utf8')) as ReplRegistry
    const mine = current[key] as ReplRegistryRecord
    writeFileSync(
      registryPath,
      JSON.stringify(
        {
          [key]: {
            ...mine,
            has_session: true,
            sessionId: live.sessionId,
            spawn_reservation_by: 'the-other-gateway',
            spawn_reservation_at: Date.now(),
            spawn_reservation_pid: process.pid + 1,
          },
        },
        null,
        2,
      ),
    )
    const second = {
      ...optionsFor(echoHost(), registryPath),
      claimantPid: process.pid + 2,
      claimantLiveness: () => 'alive' as const,
    } as PersistentReplSubstrateOptions
    const events: Event[] = []
    for await (const ev of createPersistentReplSubstrate(second).start(spec('two'))
      .events as AsyncIterable<Event>) {
      events.push(ev)
    }
    const err = events.find((e) => e.kind === 'error')
    expect(err?.kind === 'error' && err.message).toMatch(/RESERVED this session key/i)

    // AND THE LIVE SESSION IS STILL AUTHORIZED.
    expect(await authorize(liveCredential)).toBe(200)
  })
})

/**
 * A SPAWN IN FLIGHT BLOCKS AN ADOPTION (#539, Argus r63).
 *
 * Round forty-seven's reservation exists because a `claude --resume <id>` appends through
 * startup and readiness, so two of them on one transcript corrupts it. Only SPAWNERS consulted
 * it. An adopter therefore walked straight past a live reservation, claimed the row, and the
 * spawner — whose child was already writing — found out at its own ownership write.
 *
 * Found by enumerating capabilities rather than by a failure: the reservation is the ownership
 * fact that licenses a fresh spawn's capabilities, and a fact only one path honours is not a
 * fact about the key.
 */
describe('an adoption stands down for a spawn that is already in flight', () => {
  function rowWithReservation(
    registryPath: string,
    key: string,
    reservation: { by: string; at: number; pid: number } | undefined,
  ): void {
    writeFileSync(
      registryPath,
      JSON.stringify(
        {
          [key]: {
            sessionKey: key,
            sessionId: 'dddddddd-1111-2222-3333-444444444444',
            cwd: '/tmp/neutron-handle',
            channelName: 'neutron-904a860d597f559a30a30e0748dcec8e',
            has_session: true,
            pane_handle: 'w9:p-in-flight',
            child_generation: 'gen-in-flight',
            pid: 4242,
            // Required for adoption to get as far as the CLAIM: a row with no dev-channel port
            // has nothing to inject a turn into, and the pass closes the pane before it ever
            // contends. `deps.health` answers for it.
            devchannel_port: 45999,
            // ...and the spawn-time reuse properties, or the pass closes the pane on the
            // grounds that the first turn would evict it anyway. `tools: []` in `spec`
            // means an EMPTY tool surface, which is what a reusable row records here.
            reuse: { tool_surface: '', tool_bridge: false, auth_fingerprint: '' },
            ...(reservation === undefined
              ? {}
              : {
                  spawn_reservation_by: reservation.by,
                  spawn_reservation_at: reservation.at,
                  spawn_reservation_pid: reservation.pid,
                }),
          },
        },
        null,
        2,
      ),
    )
  }

  function adoptableFor(registryPath: string, key: string): FakeAdoptableHost {
    const row = readRow(registryPath, key)
    const host = new FakeAdoptableHost()
    host.addPane('w9:p-in-flight', {
      argv: [
        'claude',
        '--resume',
        row?.sessionId as string,
        '--dangerously-load-development-channels',
        `server:${row?.channelName as string}`,
      ],
      screens: ['idle'],
      pid: 4242,
    })
    return host
  }

  it('refuses, hands its child back, and leaves the pane and the row alone', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost('w9:p-in-flight'), registryPath)
    const key = poolKeyFor(options)
    rowWithReservation(registryPath, key, {
      by: 'the-spawning-gateway',
      at: Date.now(),
      pid: process.pid + 1,
    })
    const adopter = adoptableFor(registryPath, key)
    resetBootAdoptionForTests()
    const outcome = await reconcileOwnRepl(options, key, {
      host: adopter,
      health: async () => true,
      log: (m: string) => process.stderr.write(`[case] ${m}
`),
      claimantPid: process.pid + 2,
      claimantLiveness: () => 'alive' as const,
    })

    expect(outcome.kind).toBe('undecided')
    expect(outcome.kind === 'undecided' && outcome.reason).toMatch(/SPAWN RESERVATION/i)
    // THE PANE IS LEFT RUNNING AND HANDED BACK — the spawner's `--resume` is mid-flight and the
    // pane belongs to whoever finishes owning this row.
    expect(adopter.attached).toHaveLength(1)
    expect(adopter.attached[0]?.detached).toBe(true)
    expect(adopter.closed).toEqual([])
    // AND NOTHING WAS WRITTEN: no claim, and the reservation is untouched.
    const after = readRow(registryPath, key)
    expect(after?.adoption_claim_by).toBeUndefined()
    expect(after?.spawn_reservation_by).toBe('the-spawning-gateway')
  })

  it('...and a reservation whose holder is GONE does not block the adoption', async () => {
    // The positive control, and the one that keeps the guard from becoming "never adopt": a
    // reservation left by a gateway that died must not make a preserved REPL unadoptable. The
    // predicate answers that from the holder's liveness, which is why it is the same predicate.
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(echoHost('w9:p-in-flight'), registryPath)
    const key = poolKeyFor(options)
    rowWithReservation(registryPath, key, {
      by: 'a-gateway-that-died-mid-spawn',
      at: Date.now(),
      pid: 4243,
    })
    const adopter = adoptableFor(registryPath, key)
    resetBootAdoptionForTests()
    const outcome = await reconcileOwnRepl(options, key, {
      host: adopter,
      health: async () => true,
      log: () => {},
      claimantPid: process.pid + 2,
      claimantLiveness: () => 'gone' as const,
    })
    expect(outcome.kind).toBe('adopted')
    expect(readRow(registryPath, key)?.adoption_claim_by).toBeDefined()
  })
})
