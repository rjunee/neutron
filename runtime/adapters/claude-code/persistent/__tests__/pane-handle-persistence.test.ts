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

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { reconcileOwnRepl, resetBootAdoptionForTests } from '../boot-adoption.ts'
import { registerSupervisedSubstrate, runReplWatchdogTick } from '../supervision.ts'
import { setFlockImplForTests } from '../registry-lock.ts'
import { childByKey, pool } from '../pool-state.ts'
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

function echoHost(paneHandle?: string): PtyHost {
  return {
    async spawn(argv: string[]): Promise<PtyChild> {
      const i = argv.indexOf('--session-id')
      const r = argv.indexOf('--resume')
      const sid = (i >= 0 ? argv[i + 1] : r >= 0 ? argv[r + 1] : undefined) as string
      const { port: sinkPort, token } = bakedChildSinkInfo(argv)
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
  it('a spawn that cannot RECORD its pane refuses and ends the child it made', async () => {
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

    // THE DISPOSITION: refused, and said why.
    expect(message).toMatch(/could not be RECORDED as owned/i)
    // AND IT CARRIES ITS CLASS (r42). Unstamped, this arrives at the composer as a bare
    // retryable error, which maps to a synthetic 429 and cools the credential the caller
    // just picked — a local registry-lock failure spending provider capacity. The
    // no-cooldown half is asserted where the money is spent
    // (`gateway/wiring/__tests__/build-llm-call-substrate.test.ts`); this is the half that
    // proves the adapter emits what that surface reads.
    expect(err?.kind === 'error' && err.code).toBe('repl_unreconciled')
    // Retryable: the lock may be free on the next turn.
    expect(err?.kind === 'error' && err.retryable).toBe(true)
    // AND CLEANED UP: the child it made is ended, not left running unrecorded.
    expect(killsByHandle).toContain('w9:p-lock')
    // AND NOTHING WAS WRITTEN. The whole file, because what an unguarded save costs is
    // every OTHER key in it, not this one.
    expect(readFileSync(registryPath, 'utf8')).toBe(before)
    expect(readRow(registryPath, key)).toBeUndefined()
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
