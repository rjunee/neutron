/**
 * boot-adoption.test.ts — #539 seam 3: a gateway restart brings a project REPL back.
 *
 * WHAT IS BEING PINNED, and why each case exists:
 *
 *  - the ADOPT direction actually happens (a classifier that refuses everything would
 *    pass every refusal case below and satisfy nothing the owner asked for);
 *  - the adopted session is USABLE — in the pool, in `childByKey`, with its
 *    dev-channel port restored, and — the #537 finding — RE-REGISTERED in the sink, so
 *    the surviving child's `/reply` is routed instead of refused 401;
 *  - `childGeneration` comes back from the row while the INCARNATION is fresh, so a
 *    pre-restart straggler cannot complete a post-restart turn;
 *  - every refuse direction leaves the world in a state with ONE owner per transcript:
 *    a pane we verified as ours is either adopted or CLOSED, never left running for a
 *    cold spawn to race.
 *
 * The trap — an adopted pane's stale prompt must not be answered — is its own file
 * (`adopted-pane-latches.test.ts`), because it is the one defect here that ACTS.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  adoptionPermitsSpawn,
  beginBootAdoption,
  reconcileOwnRepl,
  resetBootAdoptionForTests,
} from '../boot-adoption.ts'
import { childByKey, pool, sink, supervisedBySessionKey } from '../pool-state.ts'
import { shutdownAllPersistentRepls } from '../pool.ts'
import { deriveChildSinkToken } from '../sink-coordinates.ts'
import { ReplSession } from '../repl-session.ts'
import type { ReplRegistry, ReplRegistryRecord } from '../repl-registry.ts'
import { withRegistry } from '../repl-registry.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'
import { FakeAdoptableHost } from './boot-adoption-host.ts'
import { setFlockImplForTests } from '../registry-lock.ts'

const KEY = 'inst user proj cred'
const SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444'
const CHANNEL = 'neutron-0123456789abcdef0123456789abcdef'
const GENERATION = 'gen-1111-2222'
const HANDLE = 'w9:p3'

const dirs: string[] = []
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'neutron-539-'))
  dirs.push(d)
  return d
}

/** The argv a live child of ours reports — the shape `buildReplArgv` emits. */
const oursArgv = (sessionId = SESSION_ID, channel = CHANNEL): string[] => [
  'claude',
  '--resume',
  sessionId,
  '--dangerously-load-development-channels',
  `server:${channel}`,
  '--mcp-config',
  `/tmp/neutron-repl-${channel}/session-mcp.json`,
]

/** An override that may explicitly set a field to `undefined` — which is how these
 *  cases express "this row does not carry that field" under exact-optional types. */
type RowOverride = { [K in keyof ReplRegistryRecord]?: ReplRegistryRecord[K] | undefined }

function writeRegistry(path: string, record: RowOverride = {}): ReplRegistryRecord {
  const row = {
    sessionKey: KEY,
    sessionId: SESSION_ID,
    cwd: '/tmp',
    channelName: CHANNEL,
    has_session: true,
    pid: 4242,
    devchannel_port: 45555,
    child_generation: GENERATION,
    pane_handle: HANDLE,
    reuse: { tool_surface: 'Read,Bash', tool_bridge: false, auth_fingerprint: 'fp-abc' },
    ...record,
  }
  const registry: ReplRegistry = { [KEY]: row as ReplRegistryRecord }
  writeFileSync(path, JSON.stringify(registry, null, 2))
  return row as ReplRegistryRecord
}

function readRow(path: string): ReplRegistryRecord | undefined {
  return (JSON.parse(readFileSync(path, 'utf8')) as ReplRegistry)[KEY]
}

interface Fixture {
  options: PersistentReplSubstrateOptions
  host: FakeAdoptableHost
  registryPath: string
}

function fixture(
  opts: { record?: RowOverride; argv?: string[] } = {},
): Fixture {
  const dir = scratch()
  const registryPath = join(dir, 'repl-registry.json')
  writeRegistry(registryPath, opts.record ?? {})
  const host = new FakeAdoptableHost()
  host.addPane(HANDLE, { argv: opts.argv ?? oursArgv(), screens: ['idle screen'], pid: 4242 })
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

/** The pass, with the `/health` answer chosen by the case rather than by a real probe. */
async function run(
  f: Fixture,
  healthy = true,
): Promise<Awaited<ReturnType<typeof reconcileOwnRepl>>> {
  return reconcileOwnRepl(f.options, KEY, {
    host: f.host,
    health: async () => healthy,
    log: () => {},
  })
}

async function postReply(credential: string): Promise<number> {
  const resp = await fetch(`http://127.0.0.1:${sink.port}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sink-Token': credential },
    body: JSON.stringify({ session_id: SESSION_ID, text: 'hello' }),
  })
  return resp.status
}

beforeAll(async () => {
  // The sink must be listening for the credential assertions below. Whichever test
  // file starts the process singleton first fixes its coordinates, so the assertions
  // read `sink.port` / `sink.token` back off the singleton rather than assuming any
  // particular value.
  await sink.ensureStarted({ tokenPath: join(scratch(), 'sink-token') })
})

afterEach(() => {
  resetBootAdoptionForTests()
  supervisedBySessionKey.clear()
  pool.clear()
  childByKey.clear()
  sink.unregister(SESSION_ID)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('the adopt direction', () => {
  it('re-attaches the pane and puts a usable session back in the pool', async () => {
    const f = fixture()
    const outcome = await run(f)
    expect(outcome.kind).toBe('adopted')
    expect(outcome.kind === 'adopted' && outcome.paneHandle).toBe(HANDLE)

    const session = await pool.get(KEY)
    expect(session).toBeDefined()
    expect(session?.sessionId).toBe(SESSION_ID)
    // The generation is the CHILD's identity and must come back exactly.
    expect(session?.childGeneration).toBe(GENERATION)
    // Restored from the row, and with it `session.ready` — which every turn awaits and
    // which nothing else would ever resolve for an adopted session.
    expect(session?.channelPort).toBe(45555)
    expect(session?.channelBound).toBe(true)
    // The warm-reuse guards can answer, so the first turn does not evict what we
    // just adopted.
    expect(session?.toolSurface).toBe('Read,Bash')
    expect(session?.authFingerprint).toBe('fp-abc')
    // And it is marked as carrying prior context, so a per-turn-reset profile clears
    // before its first turn instead of running on the previous gateway's transcript.
    expect(session?.adopted).toBe(true)
    expect(session?.mayHoldPriorContext()).toBe(true)
    expect(childByKey.get(KEY)).toBeDefined()
    expect(f.host.attached).toHaveLength(1)
    expect(f.host.closed).toEqual([])
  })

  it('RE-REGISTERS the survivor in the sink (the #537 finding: reconnection alone is a 401)', async () => {
    const f = fixture()
    // BEFORE: the restarted sink has registered nothing, so the surviving child's
    // credential resolves to no session and its reply is refused.
    const credential = deriveChildSinkToken(sink.token, GENERATION)
    expect(await postReply(credential)).toBe(401)

    await run(f)

    // AFTER: the same credential — the one this child was baked with, derived from the
    // generation the row carried — now routes to the adopted session.
    expect(await postReply(credential)).toBe(200)

    // And a credential derived from a DIFFERENT generation is still refused, so what
    // was restored is this child's authorization and not authorization in general.
    expect(await postReply(deriveChildSinkToken(sink.token, 'some-other-generation'))).toBe(401)
  })

  it('mints a FRESH incarnation, so a pre-restart turn id cannot match a post-restart one', async () => {
    // The session the previous gateway held: same key, same generation, same session id.
    const before = new ReplSession(KEY, GENERATION, SESSION_ID, CHANNEL, '/tmp')
    const beforeTurn = before.nextTurnId()

    const f = fixture()
    await run(f)
    const after = await pool.get(KEY)
    const afterTurn = after?.nextTurnId() ?? ''

    // Same generation (the child's identity is unchanged)...
    expect(after?.childGeneration).toBe(before.childGeneration)
    // ...and a different incarnation, which is what the turn id is namespaced by.
    expect(afterTurn).not.toBe(beforeTurn)
    expect(afterTurn.split(':')[0]).not.toBe(beforeTurn.split(':')[0])
    // Both are the FIRST turn of their own incarnation, so the sequence number alone
    // would have collided — the nonce is what separates them.
    expect(afterTurn.split(':')[1]).toBe('1')
    expect(beforeTurn.split(':')[1]).toBe('1')
  })
})

describe('the refuse directions — one owner per transcript, always', () => {
  it('CLOSES a pane whose dev-channel does not answer /health for this session', async () => {
    const f = fixture()
    const outcome = await run(f, false)
    expect(outcome.kind).toBe('closed-unadoptable')
    expect(f.host.closed).toEqual([HANDLE])
    expect(pool.get(KEY)).toBeUndefined()
    // The stale handle is gone from the row, so the next boot does not chase it.
    expect(readRow(f.registryPath)?.pane_handle).toBeUndefined()
  })

  it('CLOSES a pane whose row records no dev-channel port — there is nothing to inject into', async () => {
    const f = fixture({ record: { devchannel_port: undefined } })
    const outcome = await run(f)
    expect(outcome.kind).toBe('closed-unadoptable')
    expect(f.host.closed).toEqual([HANDLE])
  })

  it('CLOSES a pane whose row carries no child_generation — its credential cannot be reproduced', async () => {
    const f = fixture({ record: { child_generation: undefined } })
    const outcome = await run(f)
    expect(outcome.kind).toBe('closed-unadoptable')
    expect(f.host.closed).toEqual([HANDLE])
  })

  it('CLOSES a pane whose row carries no reuse properties — the first turn would evict it anyway', async () => {
    const f = fixture({ record: { reuse: undefined } })
    const outcome = await run(f)
    expect(outcome.kind).toBe('closed-unadoptable')
    expect(f.host.closed).toEqual([HANDLE])
  })

  it("CLOSES a claude on our transcript that is not our child (herdr's own resume)", async () => {
    const f = fixture({ argv: ['claude', '--resume', SESSION_ID] })
    const outcome = await run(f)
    expect(outcome.kind).toBe('closed-foreign-owner')
    expect(f.host.closed).toEqual([HANDLE])
    expect(pool.get(KEY)).toBeUndefined()
  })

  it('LEAVES a pane running something else, and says nothing was decided', async () => {
    const f = fixture({ argv: ['vim', '/etc/hosts'] })
    const outcome = await run(f)
    expect(outcome.kind).toBe('undecided')
    expect(f.host.closed).toEqual([])
  })

  it('clears the handle when the host reports the pane is GONE', async () => {
    const f = fixture()
    f.host.panes.delete(HANDLE)
    const outcome = await run(f)
    expect(outcome.kind).toBe('handle-cleared')
    // Read back off disk, not from what we asked for.
    expect(readRow(f.registryPath)?.pane_handle).toBeUndefined()
    expect(readRow(f.registryPath)?.sessionId).toBe(SESSION_ID)
  })

  it('a close that FAILS is reported as undecided, never as a close', async () => {
    const f = fixture({ argv: ['claude', '--resume', SESSION_ID] })
    f.host.closeError = new Error('server busy')
    const outcome = await run(f)
    expect(outcome.kind).toBe('undecided')
    expect(outcome.kind === 'undecided' && outcome.reason).toContain('close FAILED')
    // The handle STAYS on the row: the pane is still running and the next boot must
    // still know about it.
    expect(readRow(f.registryPath)?.pane_handle).toBe(HANDLE)
  })

  it('an attach that fails undoes the sink registration AND closes the pane', async () => {
    const f = fixture()
    f.host.attachError = new Error('transport died')
    const credential = deriveChildSinkToken(sink.token, GENERATION)
    const outcome = await run(f)
    // Verified as ours and not adopted, so it is closed — the same rule as every
    // other unadoptable case. Leaving it would let the cold spawn that follows become
    // a second owner of this transcript.
    expect(outcome.kind).toBe('closed-unadoptable')
    expect(f.host.closed).toEqual([HANDLE])
    // A standing authorization for a session with no child is exactly the orphan the
    // credential model exists to refuse.
    expect(await postReply(credential)).toBe(401)
  })

  it('a failure AFTER the attach unwinds everything it installed, and closes', async () => {
    // Anything between the attach and the pool insert can throw. Until `pool.set`
    // runs nothing owns the session, so a half-wired child would be attached,
    // registered and invisible — and the next turn would spawn over it.
    const f = fixture()
    f.host.beginOutputError = new Error('the consumer could not be wired')
    const credential = deriveChildSinkToken(sink.token, GENERATION)
    const outcome = await run(f)
    expect(outcome.kind).toBe('closed-unadoptable')
    expect(f.host.closed).toEqual([HANDLE])
    expect(pool.get(KEY)).toBeUndefined()
    expect(childByKey.get(KEY)).toBeUndefined()
    expect(await postReply(credential)).toBe(401)
  })
})

describe('evidence that has gone stale', () => {
  it('CLOSES rather than adopting when the pass outruns the evidence bound', async () => {
    // The verification is held open past the bound. What it established — the pane's
    // argv, the dev-channel's answer — has stopped describing now, so the pass takes
    // the act that needs no fresh evidence.
    const f = fixture()
    const { entered, release } = f.host.holdAttach()
    // Through the PRODUCTION entry point, because that is what arms the clock — a
    // case that called the pass directly would supply an unarmed signal and pass
    // whatever the code did.
    const outcome = beginBootAdoption(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
      budgetMs: 20,
    })
    // The gate does NOT release here: `outcome` is still pending, which is the
    // property this bound is deliberately not about.
    //
    // The handshake first, so the 80ms is spent INSIDE the attach — that is what makes
    // the 20ms budget elapse in the window this case is named for. The sleep that
    // remains is the SUBJECT (a bound elapsing), not a guess about where the pass got
    // to, which is why it stays while the synchronisation sleeps went.
    await entered
    await Bun.sleep(80)
    release()
    const settled = await outcome
    expect(settled.kind).toBe('closed-unadoptable')
    expect(f.host.closed).toEqual([HANDLE])
    expect(pool.get(KEY)).toBeUndefined()
  })

  it('CLOSES without even attaching when the bound elapses BEFORE the attach', async () => {
    // The other half of the same rule, and a distinct branch: the first check sits
    // ahead of everything the adoption installs, so a pass that is already stale by
    // then must not attach at all. Driven by a slow `/health`, which is where a sick
    // box actually spends the time.
    const f = fixture()
    const settled = await beginBootAdoption(f.options, KEY, {
      host: f.host,
      health: async () => {
        await Bun.sleep(60)
        return true
      },
      log: () => {},
      budgetMs: 20,
    })
    expect(settled.kind).toBe('closed-unadoptable')
    expect(f.host.closed).toEqual([HANDLE])
    // Nothing was attached, so there is nothing to unwind — which is the point of
    // checking here rather than only after.
    expect(f.host.attached).toHaveLength(0)
    expect(pool.get(KEY)).toBeUndefined()
  })

  it('adopts normally when it finishes inside the bound — the positive control', async () => {
    const f = fixture()
    const settled = await beginBootAdoption(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
      budgetMs: 10_000,
    })
    expect(settled.kind).toBe('adopted')
    expect(f.host.closed).toEqual([])
  })
})

describe('when the host cannot answer', () => {
  it('a VERIFIED-ours process is LEFT RUNNING when only the host failed to answer', async () => {
    // THE DESTRUCTIVE-ON-A-BLIP CASE. herdr not answering one probe says nothing about
    // the REPL behind it: killing a healthy child here would destroy exactly what this
    // feature exists to preserve, at the moment the system is already unwell. The pane
    // stays, the row keeps its handle, and the spawn is refused until the next turn can
    // adopt it.
    const f = fixture()
    f.host.inspectOverride = { kind: 'unavailable', reason: 'socket timeout' }
    const terminated: number[] = []
    const outcome = await reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
      orphanDeps: () => ({
        isPidAlive: () => true,
        readCmdline: () => oursArgv().join(' '),
        terminatePid: async (pid) => {
          terminated.push(pid)
        },
      }),
    })
    expect(outcome.kind).toBe('undecided')
    expect(outcome.kind === 'undecided' && outcome.reason).toMatch(/still running/i)
    expect(terminated).toEqual([])
    expect(f.host.closed).toEqual([])
    expect(readRow(f.registryPath)?.pane_handle).toBe(HANDLE)
  })

  it('a pid that is alive and UNREADABLE establishes nothing → undecided, nothing touched', async () => {
    const f = fixture()
    f.host.inspectOverride = { kind: 'unavailable', reason: 'socket timeout' }
    const terminated: number[] = []
    const outcome = await reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
      orphanDeps: () => ({
        isPidAlive: () => true,
        // `ps` failed, or the process is not ours to inspect. The ABSENCE of a
        // finding, which must not be read as a finding of absence.
        readCmdline: () => undefined,
        terminatePid: async (pid) => {
          terminated.push(pid)
        },
      }),
    })
    expect(outcome.kind).toBe('undecided')
    expect(terminated).toEqual([])
    expect(f.host.closed).toEqual([])
    // The handle stays: nothing was established, so nothing was forgotten either.
    expect(readRow(f.registryPath)?.pane_handle).toBe(HANDLE)
  })

  it('a LIVE pane with no argv takes the same fallback; with no pid on the row it ends undecided', async () => {
    const f = fixture({ record: { pid: undefined } })
    f.host.inspectOverride = { kind: 'live', argv: [] }
    const outcome = await reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
    })
    expect(outcome.kind).toBe('undecided')
    expect(f.host.closed).toEqual([])
  })

  it('a pid the kernel says is a STRANGER, or is not alive, is a POSITIVE absence', async () => {
    // The half that keeps the cases above from being "it always refuses": our child
    // released that pid (or never had it), so nothing of ours is running under the
    // handle, and the handle written in the same breath is stale with it.
    for (const probe of [
      { isPidAlive: () => true, readCmdline: () => '/usr/sbin/cupsd -l -f' },
      { isPidAlive: () => false, readCmdline: () => undefined },
    ]) {
      const f = fixture()
      f.host.inspectOverride = { kind: 'unavailable', reason: 'socket timeout' }
      const outcome = await reconcileOwnRepl(f.options, KEY, {
        host: f.host,
        health: async () => true,
        log: () => {},
        orphanDeps: () => ({ ...probe, terminatePid: async () => {} }),
        // AND NOBODY ELSE HOLDS THE TRANSCRIPT. Injected rather than left to the real
        // `ps`, so the case states the condition it depends on instead of inheriting
        // whatever this machine happens to be running.
        listProcesses: () => [{ pid: 1, cmdline: '/sbin/init' }],
      })
      expect(outcome.kind).toBe('handle-cleared')
      expect(readRow(f.registryPath)?.pane_handle).toBeUndefined()
    }
  })
})

describe('a dead pid is not proof the transcript is free', () => {
  it('REFUSES when another live process is a claude on this session', async () => {
    // The shape the spec item raises and an earlier revision missed: a pane relaunched
    // under a NEW pid (herdr's own restore does exactly this) leaves the RECORDED pid
    // dead while a live process owns the transcript. Clearing the handle there would
    // authorise a second `--resume`.
    const f = fixture()
    f.host.inspectOverride = { kind: 'unavailable', reason: 'socket timeout' }
    const outcome = await reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
      orphanDeps: () => ({
        isPidAlive: () => false, // the recorded pid IS dead
        readCmdline: () => undefined,
        terminatePid: async () => {},
      }),
      listProcesses: () => [
        { pid: 1, cmdline: '/sbin/init' },
        // Somebody relaunched it: same transcript, different pid, and not our spawn.
        { pid: 9931, cmdline: `claude --resume ${SESSION_ID}` },
      ],
    })
    expect(outcome.kind).toBe('undecided')
    expect(outcome.kind === 'undecided' && outcome.reason).toContain('9931')
    // And the handle is NOT forgotten — the next boot must still look at that pane.
    expect(readRow(f.registryPath)?.pane_handle).toBe(HANDLE)
  })

  it('REFUSES when the transcript-owner scan could not run at all', async () => {
    const f = fixture()
    f.host.inspectOverride = { kind: 'unavailable', reason: 'socket timeout' }
    const outcome = await reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
      orphanDeps: () => ({
        isPidAlive: () => false,
        readCmdline: () => undefined,
        terminatePid: async () => {},
      }),
      // `ps` failed. Establishes nothing — and must not read as "nobody owns it".
      listProcesses: () => undefined,
    })
    expect(outcome.kind).toBe('undecided')
    expect(outcome.kind === 'undecided' && outcome.reason).toMatch(/could not run/i)
  })

  it('REFUSES rather than clears when a process merely MENTIONS the session id', async () => {
    // THE DELIBERATE FALSE ALARM, AND ITS COST, ASSERTED (Argus r17). A `tail -f` on the
    // transcript path carries the uuid and is not an owner — and this scan now answers
    // `unknown` for it rather than `none`.
    //
    // An earlier revision of this case expected `handle-cleared`, i.e. that a bystander
    // was correctly ignored. That was right about the bystander and wrong about what the
    // instrument can establish. `ps` flattens an argv VECTOR into a string, so a
    // supported spaced binary path renders ambiguously and a live owner becomes
    // invisible to the strict matcher; answering `none` there clears the handle and
    // licenses a cold spawn onto an owned transcript. Since the instrument cannot
    // distinguish "bystander" from "owner I cannot parse", it must not claim absence for
    // either — so the bystander costs us a refusal. That is the direction to be wrong in:
    // a refused clear is retried next turn, a second owner corrupts a conversation.
    const f = fixture()
    f.host.inspectOverride = { kind: 'unavailable', reason: 'socket timeout' }
    const outcome = await reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
      orphanDeps: () => ({
        isPidAlive: () => false,
        readCmdline: () => undefined,
        terminatePid: async () => {},
      }),
      listProcesses: () => [
        { pid: 7001, cmdline: `tail -f /home/u/.claude/projects/p/${SESSION_ID}.jsonl` },
        { pid: 7002, cmdline: `vim /home/u/.claude/projects/p/${SESSION_ID}.jsonl` },
      ],
    })
    expect(outcome.kind).toBe('undecided')
    expect(outcome.kind === 'undecided' && outcome.reason).toMatch(/do not parse as our exact launch shape/)
    // AND THE HANDLE SURVIVES — the assertion that carries it. Clearing is what would
    // license the second owner.
    expect(readRow(f.registryPath)?.pane_handle).toBe(HANDLE)
  })
})

describe('a clear only ever touches the row it decided about', () => {
  /**
   * THE RACE, CONSTRUCTED RATHER THAN ARGUED. The pass reads the row, then makes an
   * async call, and ANOTHER incarnation can complete a whole spawn in that window —
   * writing a new pane and a new generation into the same key. A clear that re-reads
   * the row under the lock is atomic with respect to the ROW and not with respect to
   * the DECISION, so it would strip the newer child's handle: that child is then
   * unfindable, the next boot cannot adopt it, and the shutdown gate kills it. The
   * continuity this item exists to provide, destroyed by its own cleanup path.
   *
   * The inspection is HELD OPEN so the replacement lands inside the window. Without
   * the hold there is no window and the case proves nothing.
   */
  it('does NOT strip the handle when the row moved under it', async () => {
    const f = fixture()
    // The pane this pass will decide about is gone...
    f.host.panes.delete(HANDLE)
    const { entered, release } = f.host.holdInspect()
    const pass = reconcileOwnRepl(f.options, KEY, { host: f.host, health: async () => true, log: () => {} })

    // ...and while the inspection is in flight, another incarnation finishes a spawn
    // and writes ITS child into the same key. AWAITED, NOT SLEPT: the handshake
    // resolves inside the held method, so the window is entered rather than assumed.
    await entered
    // THE HANDSHAKE'S MEANING, ASSERTED. The pass is inside `inspectHandle` right now —
    // it pushed this handle on the way in. Without this line the case would still pass
    // when `entered` resolved at construction time, i.e. when it had become a sleep
    // again, which is the mutation that must red.
    expect(f.host.inspections).toEqual([HANDLE])
    writeRegistry(f.registryPath, { pane_handle: 'w9:p-NEWER', child_generation: 'gen-newer', pid: 5150 })
    release()

    const outcome = await pass
    // UNDECIDED, NOT `handle-cleared`. An earlier revision asserted the latter — and
    // pinned the unsafe half: `handle-cleared` is a positive verdict that LICENSES A
    // COLD SPAWN, so the row was preserved and a second owner was started on the
    // transcript anyway. Nothing this pass established describes the row as it now
    // stands, so it establishes nothing at all.
    expect(outcome.kind).toBe('undecided')
    expect(outcome.kind === 'undecided' && outcome.reason).toMatch(/replaced by another incarnation/i)
    // THE NEWER ROW IS INTACT — handle and generation both.
    const row = readRow(f.registryPath)
    expect(row?.pane_handle).toBe('w9:p-NEWER')
    expect(row?.child_generation).toBe('gen-newer')
    expect(row?.pid).toBe(5150)
  })

  it('DOES strip it when the row is still the one it decided about', async () => {
    // The positive control: without it, a clear that never clears anything passes the
    // case above and silently stops reaping stale handles.
    const f = fixture()
    f.host.panes.delete(HANDLE)
    const outcome = await run(f)
    expect(outcome.kind).toBe('handle-cleared')
    expect(readRow(f.registryPath)?.pane_handle).toBeUndefined()
  })

  it('a CLOSE whose row moves before the write reports undecided, not a close', async () => {
    // The close path has its own window: the pane is ended, and the registry write that
    // records it happens after. If the row is replaced in between, reporting
    // `closed-foreign-owner` would license a resume of a transcript whose live owner
    // another incarnation just wrote into that key — the close succeeded and the
    // conclusion is still not ours to draw.
    const f = fixture({ argv: ['claude', '--resume', SESSION_ID] })
    f.host.onClose = () => {
      writeRegistry(f.registryPath, {
        pane_handle: 'w9:p-NEWER',
        child_generation: 'gen-newer',
        pid: 5150,
      })
    }
    const outcome = await run(f)
    expect(outcome.kind).toBe('undecided')
    expect(outcome.kind === 'undecided' && outcome.reason).toMatch(/replaced by another incarnation/i)
    // The pane WAS closed — that half happened and is not being denied.
    expect(f.host.closed).toEqual([HANDLE])
    // And the newer row is intact.
    expect(readRow(f.registryPath)?.pane_handle).toBe('w9:p-NEWER')
  })

  it('an adoption whose row is replaced mid-attach GIVES THE CHILD BACK', async () => {
    // THE POSTCONDITIONS ARE EXTERNAL, and an earlier version of this case asserted
    // only that B's row kept its pid — which the unsafe behaviour also produced. A
    // left its child live in the pool and reported `adopted` while the durable row
    // named B's: two live owners on one transcript.
    const f = fixture({ record: { pid: 1 } })
    const credential = deriveChildSinkToken(sink.token, GENERATION)
    const { entered, release } = f.host.holdInspect()
    const pass = reconcileOwnRepl(f.options, KEY, { host: f.host, health: async () => true, log: () => {} })
    await entered
    expect(f.host.inspections).toEqual([HANDLE])
    writeRegistry(f.registryPath, { pane_handle: 'w9:p-NEWER', child_generation: 'gen-newer', pid: 777 })
    release()

    const outcome = await pass
    expect(outcome.kind).toBe('undecided')
    expect(outcome.kind === 'undecided' && outcome.reason).toMatch(/replaced by another incarnation/i)
    // NOTHING OF A'S SURVIVES: not the pool entry a turn would be served from...
    expect(pool.get(KEY)).toBeUndefined()
    expect(childByKey.get(KEY)).toBeUndefined()
    // ...nor the sink registration its child would reply through...
    expect(await postReply(credential)).toBe(401)
    // ...nor the pane, which is closed rather than left as a second owner.
    expect(f.host.closed).toEqual([HANDLE])
    // And B's row is untouched, pid included.
    const row = readRow(f.registryPath)
    expect(row?.pid).toBe(777)
    expect(row?.pane_handle).toBe('w9:p-NEWER')
    expect(row?.child_generation).toBe('gen-newer')
  })

  it('an UNCONTENDED adoption still installs, and corrects a stale pid', async () => {
    // The positive control for the case above: refusing every adoption would satisfy
    // it and deliver nothing. The row's pid is deliberately stale here, so the claim
    // has a write to make as well as a comparison.
    const f = fixture({ record: { pid: 1 } })
    const outcome = await run(f)
    expect(outcome.kind).toBe('adopted')
    expect(await pool.get(KEY)).toBeDefined()
    expect(childByKey.get(KEY)).toBeDefined()
    expect(f.host.closed).toEqual([])
    // The pid the pass attached to is now the one every liveness probe will read.
    expect(readRow(f.registryPath)?.pid).toBe(4242)
    // And the row it claimed is otherwise intact.
    expect(readRow(f.registryPath)?.pane_handle).toBe(HANDLE)
  })
})

describe('the pane is re-identified at the moment of the close', () => {
  it('does NOT close a pane whose identity changed after the inspection', async () => {
    // The window is real: between the inspection that decided and the close that acts
    // there is a `/health` round trip at least. If the pane exits and the id is
    // reissued in it, closing would destroy somebody else's pane.
    const f = fixture()
    f.host.inspectQueue = [
      // Decides: a claude on our transcript without our channel → close-foreign-owner.
      { kind: 'live', argv: ['claude', '--resume', SESSION_ID] },
      // By the time we act, the id belongs to something else entirely.
      { kind: 'live', argv: ['vim', '/etc/hosts'] },
    ]
    const outcome = await run(f)
    expect(outcome.kind).toBe('undecided')
    expect(f.host.closed).toEqual([])
    expect(f.host.inspections.length).toBeGreaterThan(1)
  })

  it('treats a pane that vanished in that window as closed — the post-condition holds', async () => {
    const f = fixture()
    f.host.inspectQueue = [
      { kind: 'live', argv: ['claude', '--resume', SESSION_ID] },
      { kind: 'gone' },
    ]
    const outcome = await run(f)
    expect(outcome.kind).toBe('closed-foreign-owner')
    // Nothing was closed by us, because there was nothing left to close.
    expect(f.host.closed).toEqual([])
    expect(readRow(f.registryPath)?.pane_handle).toBeUndefined()
  })

  it('still closes when the re-check agrees — the positive control', async () => {
    const f = fixture({ argv: ['claude', '--resume', SESSION_ID] })
    const outcome = await run(f)
    expect(outcome.kind).toBe('closed-foreign-owner')
    expect(f.host.closed).toEqual([HANDLE])
  })
})

describe('rows that cannot be reconciled at all', () => {
  it('a row with no pane handle is not a failure', async () => {
    const f = fixture({ record: { pane_handle: undefined } })
    expect((await run(f)).kind).toBe('no-handle')
    expect(f.host.attached).toHaveLength(0)
  })

  it('a host that cannot adopt DOES kill a verified survivor — the one case that may', async () => {
    // The supported host switch (herdr → the in-process PTY host) with a live pane.
    // The configured host cannot see that pane, but the kernel can still say whether
    // the recorded pid is our claude — and if it is, killing it takes the pane with
    // it and the transcript has one owner again.
    const f = fixture()
    const terminated: number[] = []
    const outcome = await reconcileOwnRepl(f.options, KEY, {
      // A plain PtyHost: spawn only, no adoption surface.
      host: {
        spawn: async () => {
          throw new Error('never')
        },
      },
      health: async () => true,
      log: () => {},
      orphanDeps: () => ({
        isPidAlive: () => true,
        readCmdline: () => oursArgv().join(' '),
        terminatePid: async (pid) => {
          terminated.push(pid)
        },
      }),
    })
    expect(outcome.kind).toBe('closed-by-pid')
    expect(terminated).toEqual([4242])
    expect(readRow(f.registryPath)?.pane_handle).toBeUndefined()
  })

  it('a host that cannot adopt and a pid it cannot verify is UNDECIDED, not no-handle', async () => {
    // The dangerous shape, and the one an earlier revision got wrong: the pane may
    // still be running our claude under a herdr server this process is not talking
    // to. `no-handle` would have told the spawn path "nothing survived".
    const f = fixture()
    const terminated: number[] = []
    const outcome = await reconcileOwnRepl(f.options, KEY, {
      host: {
        spawn: async () => {
          throw new Error('never')
        },
      },
      health: async () => true,
      log: () => {},
      orphanDeps: () => ({
        isPidAlive: () => true,
        // Alive and unreadable: the one answer that establishes nothing.
        readCmdline: () => undefined,
        terminatePid: async (pid) => {
          terminated.push(pid)
        },
      }),
    })
    expect(outcome.kind).toBe('undecided')
    expect(terminated).toEqual([])
    expect(f.host.closed).toEqual([])
    // The handle stays on the row: nothing was established, so nothing is forgotten.
    expect(readRow(f.registryPath)?.pane_handle).toBe(HANDLE)
  })

  it('a row with NO handle on a non-adopting host is genuinely nothing to do', async () => {
    // The positive control that keeps the case above from being "it always refuses".
    const f = fixture({ record: { pane_handle: undefined } })
    const outcome = await reconcileOwnRepl(f.options, KEY, {
      host: {
        spawn: async () => {
          throw new Error('never')
        },
      },
      health: async () => true,
      log: () => {},
    })
    expect(outcome.kind).toBe('no-handle')
  })
})


describe('a shutdown that arrives mid-pass', () => {
  /**
   * ARGUS r9 BLOCKER. A pass between `host.attach` and its publish is in NEITHER place
   * `shutdownAllPersistentRepls` looks: it is not a `pool` entry yet, so the drain
   * cannot see it, and nothing waited for it. It would publish into a pool already torn
   * down — reinstalling `childByKey`, the sink and the watchers on the way — and
   * `resetBootAdoption` would meanwhile free its key, so a later boot in this process
   * could start a SECOND pass against the same unchanged row and attach the same pane.
   * Two owners of one transcript, produced by the reset whose job was to make the next
   * boot safe.
   */
  const supervise = (f: Fixture): void => {
    supervisedBySessionKey.set(KEY, {
      replRegistryPath: f.registryPath,
    } as unknown as PersistentReplSubstrateOptions)
  }

  it('a pass still attaching when shutdown lands publishes NOTHING, and its pane is left alone', async () => {
    const f = fixture()
    supervise(f)
    const credential = deriveChildSinkToken(sink.token, GENERATION)
    const { entered, release } = f.host.holdAttach()
    const pass = beginBootAdoption(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
    })
    // THE PASS IS INSIDE THE ATTACH BEFORE THE GATEWAY STARTS GOING AWAY, and that is
    // established rather than slept for. If the shutdown landed first this case would
    // exercise the PRE-attach check and pass while claiming to prove the attach-side
    // one — a control passing for the wrong reason.
    await entered
    await shutdownAllPersistentRepls({ adoptionGraceMs: 20 })
    release()

    const outcome = await pass
    // Nothing was established, so nothing may resume this transcript on the strength
    // of it. `undecided` is also not cached, so the key frees itself.
    expect(outcome.kind).toBe('undecided')
    // WHICH CHECK FIRED, not merely that one did. The three abandonment sites carry
    // distinct text precisely so this case cannot claim the attach-side check while the
    // pre-attach one ran.
    expect(outcome.kind === 'undecided' && outcome.reason).toMatch(/with the attach in flight/)
    // NOT IN THE POOL, and not mirrored — the teardown already ran, and an entry
    // arriving behind it is one nothing will ever tear down.
    expect(pool.get(KEY)).toBeUndefined()
    expect(childByKey.get(KEY)).toBeUndefined()
    // Not authorised either: a live credential on a session nobody holds is #537's bug.
    expect(await postReply(credential)).toBe(401)
    // THE ATTACH RAN, so it is the attach-side check this case proved and not the
    // pre-attach one. If the shutdown had landed first there would be no attached
    // child here, and the case would be quietly testing a different branch.
    expect(f.host.attached).toHaveLength(1)
    // AND THE PANE IS STILL THERE. This is the half that separates a shutdown
    // abandonment from an evidence-bound one: the row names it, so the next boot
    // reconciles it. Closing here would destroy the REPL the feature exists to keep.
    expect(f.host.closed).toEqual([])
    const row = readRow(f.registryPath)
    expect(row?.pane_handle).toBe(HANDLE)
    expect(row?.child_generation).toBe(GENERATION)
  })

  it('THE POSITIVE CONTROL: a pass that settles inside the grace lands in the pool and gets a real survival verdict', async () => {
    // Two jobs. It stops "abandon everything" from passing the case above, and it
    // proves the await is REACHED rather than being a branch that never runs here: the
    // pass publishes only because the shutdown waited for it.
    const f = fixture()
    supervise(f)
    const { entered, release } = f.host.holdAttach()
    const pass = beginBootAdoption(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
    })
    await entered
    // RELEASED FROM INSIDE THE GRACE, not before the shutdown starts. The timer is
    // armed after the handshake, so the 10ms is measured from a known position rather
    // than from a guess about where the pass had got to; the grace below is two orders
    // of magnitude larger, so the release lands inside it with room to spare even on a
    // runner under load.
    setTimeout(release, 10)
    await shutdownAllPersistentRepls({ adoptionGraceMs: 2_000 })

    expect((await pass).kind).toBe('adopted')
    // It was drained by the SECOND drain — the teardown saw it rather than missing it.
    expect(pool.get(KEY)).toBeUndefined()
    // And the survival gate ruled on it: the row names this pane and this generation,
    // so the child is left running rather than killed.
    expect(f.host.attached).toHaveLength(1)
    // STILL RUNNING. `hasExited` is the required half of the child contract, so this
    // asserts the outcome rather than the fixture's bookkeeping about it.
    expect(f.host.attached[0]?.hasExited()).toBe(false)
    expect(f.host.closed).toEqual([])
  })

  it('after the reset, a second pass CANNOT attach the same pane concurrently', async () => {
    // The dedup entry is what prevents the second attach, and `resetBootAdoption` used
    // to delete it while the first pass was still running.
    const f = fixture()
    supervise(f)
    const { entered, release } = f.host.holdAttach()
    const first = beginBootAdoption(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
    })
    await entered
    expect(f.host.attached).toHaveLength(0)
    await shutdownAllPersistentRepls({ adoptionGraceMs: 20 })

    // A later boot in the SAME process asks for this key again.
    const second = beginBootAdoption(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
    })
    release()
    const [a, b] = await Promise.all([first, second])

    // REFUSED, not merely deduplicated: the second call must not produce a second
    // attach on this pane, and it must not report an adoption it did not perform.
    expect(f.host.attached).toHaveLength(1)
    expect(a.kind).toBe('undecided')
    expect(b.kind).toBe('undecided')
    expect(pool.get(KEY)).toBeUndefined()
    expect(f.host.closed).toEqual([])
  })
})


describe('one registry, two projects: a substrate reconciles ITS OWN row and nothing else', () => {
  /**
   * ARGUS r9. The per-key design was asserted only in prose — a comment in
   * `boot-adoption.ts` explaining that one registry holds a row per POOL KEY, that a
   * pool key folds instance/user/project/credential, and that rebuilding one row's
   * session from another row's options would put a REPL in the pool scoped to the wrong
   * project with every tool call attributed there.
   *
   * That is a correctness argument, not a granularity preference, and until now nothing
   * enforced it. These cases turn the comment into a guarantee: enumeration would be a
   * WORSE defect than deferral, so the pass must touch exactly one row.
   */
  const KEY_B = 'inst user other-proj cred'
  const SESSION_B = 'bbbbbbbb-9999-8888-7777-666666666666'
  const CHANNEL_B = 'neutron-fedcba9876543210fedcba9876543210'
  const GENERATION_B = 'gen-bbbb-cccc'
  const HANDLE_B = 'w9:p77'

  function twoProjectFixture(): Fixture & { rowB: () => ReplRegistryRecord | undefined } {
    const dir = scratch()
    const registryPath = join(dir, 'repl-registry.json')
    const rowA = {
      sessionKey: KEY,
      sessionId: SESSION_ID,
      cwd: '/tmp',
      channelName: CHANNEL,
      has_session: true,
      pid: 4242,
      devchannel_port: 45555,
      child_generation: GENERATION,
      pane_handle: HANDLE,
      reuse: { tool_surface: 'Read,Bash', tool_bridge: false, auth_fingerprint: 'fp-abc' },
    }
    const rowB = {
      sessionKey: KEY_B,
      sessionId: SESSION_B,
      cwd: '/srv/other',
      channelName: CHANNEL_B,
      has_session: true,
      pid: 9191,
      devchannel_port: 45666,
      child_generation: GENERATION_B,
      pane_handle: HANDLE_B,
      reuse: { tool_surface: 'Read', tool_bridge: true, auth_fingerprint: 'fp-zzz' },
    }
    // B IS WRITTEN FIRST, AND THE ORDER IS LOAD-BEARING. The defect these cases exist
    // to catch is a pass that reconciles whichever row it finds rather than its own. If
    // A's row came first, that mutation would land on A anyway and the cases would pass
    // against broken code — the same vacuity as a byte comparison whose bytes match
    // either way. With B first, "whichever it finds" is the wrong answer by
    // construction.
    writeFileSync(
      registryPath,
      JSON.stringify({ [KEY_B]: rowB, [KEY]: rowA } as unknown as ReplRegistry, null, 2),
    )
    const host = new FakeAdoptableHost()
    host.addPane(HANDLE, { argv: oursArgv(), screens: ['idle screen'], pid: 4242 })
    host.addPane(HANDLE_B, { argv: oursArgv(SESSION_B, CHANNEL_B), screens: ['idle B'], pid: 9191 })
    const options = {
      substrate_instance_id: 'inst',
      model_preference: ['claude-opus-5'],
      replRegistryPath: registryPath,
      project_id: 'proj',
      cwd: '/tmp',
      ptyHost: host,
    } as unknown as PersistentReplSubstrateOptions
    return {
      options,
      host,
      registryPath,
      rowB: () => (JSON.parse(readFileSync(registryPath, 'utf8')) as ReplRegistry)[KEY_B],
    }
  }

  it("adopts A, never looks at B's pane, and leaves B's row byte-intact", async () => {
    const f = twoProjectFixture()
    const before = f.rowB()
    const outcome = await reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
    })

    expect(outcome.kind).toBe('adopted')
    expect((await pool.get(KEY))?.sessionId).toBe(SESSION_ID)
    // B IS NOT IN THE POOL. If it were, it would be there under A's options — A's
    // project, A's credential — and every tool call it made would be attributed there.
    expect(pool.get(KEY_B)).toBeUndefined()
    expect(childByKey.get(KEY_B)).toBeUndefined()
    // B'S PANE WAS NEVER EVEN LOOKED AT. Inspection is the first thing the pass does to
    // a pane, so this is the earliest possible evidence that the pass stayed on its key.
    expect(f.host.inspections).toEqual([HANDLE])
    expect(f.host.attached.map((c) => c.paneHandle)).toEqual([HANDLE])
    expect(f.host.closed).toEqual([])
    // And B's row is untouched, field for field.
    expect(f.rowB()).toEqual(before)
  })

  it("and B's session is never authorised on A's pass", async () => {
    // The sink is the surface where a cross-key rebuild would actually bite: a
    // credential registered for B's session id by A's pass would let B's child reply
    // into a session A owns.
    const f = twoProjectFixture()
    const credentialB = deriveChildSinkToken(sink.token, GENERATION_B)
    await reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
    })
    const resp = await fetch(`http://127.0.0.1:${sink.port}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sink-Token': credentialB },
      body: JSON.stringify({ session_id: SESSION_B, text: 'hello' }),
    })
    expect(resp.status).toBe(401)
  })
})


describe('the evidence bound and the shutdown, in both orders', () => {
  /**
   * ARGUS r13. The two causes call for OPPOSITE acts on the pane — `evidence-bound`
   * closes it, `shutdown` leaves it — so which one is operative when both have happened
   * is the whole question, and `abandonInFlightPasses` used to skip a pass that was
   * already abandoned. The cause stayed `evidence-bound`, the held attach returned, the
   * pass took `unwind`, and the pane was CLOSED in the middle of a shutdown whose
   * contract says an unfinished pass is left alone.
   *
   * The ruling, and the reason it is not merely a preference: `unwind`'s argument for
   * closing is that the child is verified as ours on our transcript, so leaving it is how
   * a COLD SPAWN becomes a second owner. There is no cold spawn coming here — this
   * process is going away, the row still names the pane, and the next boot visits that
   * row and adopts-or-closes it on fresh evidence. Leaving is recoverable; closing
   * destroys the conversation the feature exists to keep.
   */
  const supervise = (f: Fixture): void => {
    supervisedBySessionKey.set(KEY, {
      replRegistryPath: f.registryPath,
    } as unknown as PersistentReplSubstrateOptions)
  }

  /** Resolves when the evidence timer has actually fired — its log line is the only
   *  observable it has. A sleep here would let the case decay into the plain shutdown
   *  test the moment the runner got slow. */
  function boundWatcher(): { fired: Promise<void>; log: (msg: string) => void } {
    let resolve!: () => void
    const fired = new Promise<void>((r) => {
      resolve = r
    })
    return {
      fired,
      log: (msg: string) => {
        // BOTH of the timer's lines: it says "too old" when it owns the disposition and
        // "bound expired, already abandoned" when it does not. Matching only the first
        // would hang forever in the shutdown-first order, which is the case that needs
        // this most.
        if (/evidence is too old|evidence bound expired/.test(msg)) resolve()
      },
    }
  }

  it('TIMER FIRST, THEN SHUTDOWN: the shutdown wins and the pane is left alive', async () => {
    const f = fixture()
    supervise(f)
    const { entered, release } = f.host.holdAttach()
    const bound = boundWatcher()
    const pass = beginBootAdoption(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: bound.log,
      budgetMs: 20,
    })
    await entered
    // THE PREMISE, ASSERTED. Without this the evidence timer might never fire and the
    // case would quietly become the plain shutdown test, which already passes.
    await bound.fired
    await shutdownAllPersistentRepls({ adoptionGraceMs: 20 })
    release()

    const outcome = await pass
    expect(outcome.kind).toBe('undecided')
    const reason = outcome.kind === 'undecided' ? outcome.reason : ''
    // BOTH FACTS, AND WHICH ONE DECIDED. A reader needs the ordering to understand why a
    // pane that looked closeable was left running.
    expect(reason).toMatch(/evidence bound expired/)
    expect(reason).toMatch(/SHUTDOWN is the operative cause/)
    // THE ASSERTION THAT CARRIES IT: the pane is still there.
    expect(f.host.closed).toEqual([])
    const row = readRow(f.registryPath)
    expect(row?.pane_handle).toBe(HANDLE)
    expect(row?.child_generation).toBe(GENERATION)
    expect(pool.get(KEY)).toBeUndefined()
  })

  it('SHUTDOWN FIRST, THEN TIMER: the timer does not take the cause back', async () => {
    // The other direction of the same one-way rule, and the case mutation (b) needs:
    // without it, deleting the evidence timer's early return would downgrade a shutdown
    // to `evidence-bound` with nothing to notice.
    const f = fixture()
    supervise(f)
    const { entered, release } = f.host.holdAttach()
    const bound = boundWatcher()
    const pass = beginBootAdoption(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: bound.log,
      budgetMs: 120,
    })
    await entered
    // The shutdown lands first — its grace is far below the evidence budget.
    await shutdownAllPersistentRepls({ adoptionGraceMs: 10 })
    // ...and THEN the evidence timer fires, while the attach is still held.
    await bound.fired
    release()

    const outcome = await pass
    expect(outcome.kind).toBe('undecided')
    const reason = outcome.kind === 'undecided' ? outcome.reason : ''
    // The bound DID expire and is recorded; the shutdown is still what decided.
    expect(reason).toMatch(/evidence bound expired/)
    expect(reason).toMatch(/SHUTDOWN is the operative cause/)
    expect(f.host.closed).toEqual([])
    expect(readRow(f.registryPath)?.pane_handle).toBe(HANDLE)
  })

  it('THE CONTROL: with no shutdown at all, the bound still CLOSES', async () => {
    // Neither case above may be passing because the evidence bound stopped working. With
    // nothing else in play it must still end the pane, which is what it is for.
    const f = fixture()
    const { entered, release } = f.host.holdAttach()
    const bound = boundWatcher()
    const pass = beginBootAdoption(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: bound.log,
      budgetMs: 20,
    })
    await entered
    await bound.fired
    release()

    const outcome = await pass
    expect(outcome.kind).toBe('closed-unadoptable')
    expect(f.host.closed).toEqual([HANDLE])
  })
})


describe('the row claim rests on a lock, and says so when it does not get one', () => {
  /**
   * ARGUS r14, and it is round eight's finding standing in the other half of the module.
   * The claim is a cross-process compare-and-set, and a CAS is only a CAS while the lock
   * holds. `withFlockSync` deliberately runs its callback unguarded when FFI is missing
   * or `flock` returns nonzero, and both are indistinguishable from success to a caller
   * that does not ask. Unguarded, two incarnations read the same row, both find it
   * matching, and both publish an attached owner — two owners of one live transcript.
   *
   * THE FLOCK SYSCALL IS THE ONLY FAKE. `withFlockSync`, `withRegistry` and
   * `clearPaneHandleIfUnchanged` are all the real ones, so these cases distinguish
   * "claimed under the lock" from "claimed" — which a mocked registry could not.
   */
  afterEach(() => setFlockImplForTests(undefined))

  it('REFUSES to publish when the lock was not acquired, and does not close the pane', async () => {
    // THE ROW'S PID IS DELIBERATELY STALE. The claim's critical section repairs a stale
    // pid, and an earlier revision of this case used a row whose pid already matched —
    // so the repair branch was unreachable and the case could not see that the write
    // happened anyway, without the lock, while the log said the row had been left alone.
    // A fixture that cannot reach the write cannot prove the write was refused.
    const f = fixture({ record: { pid: 1 } })
    const credential = deriveChildSinkToken(sink.token, GENERATION)
    const before = readRow(f.registryPath)
    // The premise: the repair branch IS live for this fixture.
    expect(before?.pid).toBe(1)
    setFlockImplForTests(() => 1)
    const outcome = await run(f)

    expect(outcome.kind).toBe('undecided')
    const reason = outcome.kind === 'undecided' ? outcome.reason : ''
    // THE LOCK, NOT THE ROW. "Someone else owns this" and "I could not find out who owns
    // this" are different facts and must not print the same sentence.
    expect(reason).toMatch(/lock was NOT acquired/i)
    expect(reason).not.toMatch(/replaced by another incarnation/i)
    // Nothing of ours survives...
    expect(pool.get(KEY)).toBeUndefined()
    expect(childByKey.get(KEY)).toBeUndefined()
    expect(await postReply(credential)).toBe(401)
    // ...and NOTHING of the world's is destroyed: the pane is still running, because
    // another incarnation may have legitimately claimed it.
    expect(f.host.closed).toEqual([])
    // FIELD FOR FIELD, and the pid above all: the row must be exactly what it was.
    expect(readRow(f.registryPath)).toEqual(before)
    expect(readRow(f.registryPath)?.pid).toBe(1)
  })

  it('AND THE PID REPAIR STILL HAPPENS when the lock IS granted — that case\'s control', async () => {
    // Without this, the refusal above would pass equally well against a claim that had
    // simply stopped repairing pids, and the mutation would be unobservable.
    const f = fixture({ record: { pid: 1 } })
    const outcome = await run(f)
    expect(outcome.kind).toBe('adopted')
    expect(readRow(f.registryPath)?.pid).toBe(4242)
  })

  it('a claim that THROWS releases too, and leaves the pane running', async () => {
    // The third fact: not "someone else owns this row" and not "I could not get the
    // lock", but "I could not ask at all". This branch used to call `unwind`, which
    // CLOSES the pane — on evidence that establishes nothing about who owns it.
    //
    // Made to throw the way production would: the lock path is a DIRECTORY, so the
    // lock's `openSync` fails on it. No injected mock, so the real failure mode is what
    // is exercised.
    const f = fixture({ record: { pid: 1 } })
    const before = readRow(f.registryPath)
    const credential = deriveChildSinkToken(sink.token, GENERATION)
    mkdirSync(join(dirname(f.registryPath), '.registry.lock'), { recursive: true })
    const outcome = await run(f)

    expect(outcome.kind).toBe('undecided')
    const reason = outcome.kind === 'undecided' ? outcome.reason : ''
    // Its own sentence — neither of the other two.
    expect(reason).toMatch(/could NOT BE READ OR WRITTEN/)
    expect(reason).not.toMatch(/replaced by another incarnation/i)
    expect(reason).not.toMatch(/lock was NOT acquired/i)
    // Registrations released...
    expect(pool.get(KEY)).toBeUndefined()
    expect(childByKey.get(KEY)).toBeUndefined()
    expect(await postReply(credential)).toBe(401)
    // ...and the pane LEFT RUNNING, with the row untouched.
    expect(f.host.closed).toEqual([])
    expect(readRow(f.registryPath)).toEqual(before)
  })

  it('REFUSES to clear the handle on a non-atomic write — the pane is closed AND no spawn is licensed', async () => {
    // INVERTED, NOT DELETED (Argus r23). An earlier version of this case required
    // `closed-foreign-owner` after the lock failure — a spawn-PERMITTING outcome — on the
    // reasoning that "the pane this pass decided about is gone either way, and a registry
    // that could not be written is a stale handle the next boot re-inspects".
    //
    // That reasoning is sound for a row we READ and found absent. It is false for a row
    // we could not read: without the lock we cannot see that another incarnation has put
    // a live H2/G2 in this key, so reporting a spawn-permitting finding starts a third
    // owner on a live transcript. The case now pins the refusal instead, and the
    // `no spawn is licensed` assertion is the one that carries it — the byte assertions
    // below were the right instrument for the WRITE and say nothing about the VERDICT,
    // which is why this was invisible for five rounds.
    //
    // The lock fails only for the clear: since r18 the pre-close gate reads the row under
    // the lock too, so failing the flock for the whole pass would refuse the CLOSE and
    // never reach the clear at all.
    //
    // The row deliberately MATCHES, so the refusal is the only thing that can stop the
    // clear.
    const f = fixture({ argv: oursArgv(SESSION_ID, 'neutron-someone-elses-channel') })
    expect(readRow(f.registryPath)?.pane_handle).toBe(HANDLE)
    f.host.onClose = () => setFlockImplForTests(() => 1)
    const outcome = await run(f)

    // The pane WAS closed — that half really happened and is not denied.
    expect(f.host.closed).toEqual([HANDLE])
    // ...but the row's state is unestablished, so nothing may resume this transcript.
    expect(outcome.kind).toBe('undecided')
    const reason = outcome.kind === 'undecided' ? outcome.reason : ''
    expect(reason).toMatch(/could NOT BE ESTABLISHED/)
    expect(reason).not.toMatch(/replaced by another incarnation/i)
    expect(adoptionPermitsSpawn(outcome).ok).toBe(false)
    // ON DISK, not on the return value: the handle is LEFT rather than erased.
    expect(readRow(f.registryPath)?.pane_handle).toBe(HANDLE)
  })

  it('THE INTERLEAVING ITSELF: a live H2/G2 arrives unseen, and no spawn is licensed', async () => {
    // The consequence rather than the mechanism. A establishes H1 gone and closes it; B
    // replaces the row with a LIVE pane under a new generation; A cannot acquire the
    // clear's lock and so cannot see B at all. Reporting the caller's finding here is what
    // starts a third owner.
    const f = fixture({ argv: oursArgv(SESSION_ID, 'neutron-someone-elses-channel') })
    f.host.onClose = () => {
      writeRegistry(f.registryPath, { pane_handle: 'w9:p-H2', child_generation: 'gen-G2' })
      setFlockImplForTests(() => 1)
    }
    const outcome = await run(f)

    expect(adoptionPermitsSpawn(outcome).ok).toBe(false)
    // And B's row is untouched — A could not see it, and therefore did not write over it.
    expect(readRow(f.registryPath)?.pane_handle).toBe('w9:p-H2')
    expect(readRow(f.registryPath)?.child_generation).toBe('gen-G2')
    // Nothing of A's is in the pool.
    expect(pool.get(KEY)).toBeUndefined()
  })

  it('THE POSITIVE CONTROL: with the lock granted, the same fixture is adopted and published', async () => {
    // Two jobs. It stops "refuse everything" from satisfying both cases above, and it
    // proves the claim path is REACHABLE on this runner — if FFI or `flock` were
    // unavailable here, every case above would pass for a reason that had nothing to do
    // with the code under test.
    const f = fixture()
    const outcome = await run(f)
    expect(outcome.kind).toBe('adopted')
    expect(await pool.get(KEY)).toBeDefined()
    expect(childByKey.get(KEY)).toBeDefined()
    expect(f.host.closed).toEqual([])
  })

  it('and the CLEAR still happens when the lock IS granted — the clear case\'s control', async () => {
    // Same fixture as the refusal above, lock granted: the handle must actually be
    // stripped, so that case cannot be passing because the clear stopped working.
    const f = fixture({ argv: oursArgv(SESSION_ID, 'neutron-someone-elses-channel') })
    const outcome = await run(f)
    expect(outcome.kind).toBe('closed-foreign-owner')
    expect(f.host.closed).toEqual([HANDLE])
    expect(readRow(f.registryPath)?.pane_handle).toBeUndefined()
  })
})


describe('a refusal writes NOTHING, and the close requires the row as well as the process', () => {
  afterEach(() => setFlockImplForTests(undefined))

  /** The registry as another writer would leave it: compact, which is NOT what
   *  `saveRegistry` emits. The formatting is the witness — a byte-identical rewrite is
   *  invisible to a field comparison, and that is precisely the write being hunted. */
  function writeCompact(path: string, registry: Record<string, unknown>): string {
    const bytes = JSON.stringify(registry)
    writeFileSync(path, bytes)
    return bytes
  }

  it('a refused claim does not rewrite the registry FILE', async () => {
    // ARGUS r18. `withRegistry` saved unconditionally, so a callback that returned the
    // registry unchanged still wrote it — from a snapshot loaded before the callback ran,
    // WITHOUT the lock. Field comparison cannot see that: our row matches our snapshot by
    // construction. Bytes can.
    const f = fixture({ record: { pid: 1 } })
    const before = writeCompact(f.registryPath, {
      [KEY]: { ...(readRow(f.registryPath) as object), pid: 1 },
    })
    expect(before).not.toContain('\n')
    setFlockImplForTests(() => 1)

    const outcome = await run(f)
    expect(outcome.kind).toBe('undecided')
    // NOT REWRITTEN AT ALL — not even with the same content.
    expect(readFileSync(f.registryPath, 'utf8')).toBe(before)
  })

  it('THE CONTROL: a claim that DOES act rewrites the file', async () => {
    // Without this, a `withRegistry` that had simply stopped writing would satisfy the
    // case above. The same fixture with the lock granted must change the bytes.
    const f = fixture({ record: { pid: 1 } })
    const before = writeCompact(f.registryPath, {
      [KEY]: { ...(readRow(f.registryPath) as object), pid: 1 },
    })
    const outcome = await run(f)
    expect(outcome.kind).toBe('adopted')
    expect(readFileSync(f.registryPath, 'utf8')).not.toBe(before)
    expect(readRow(f.registryPath)?.pid).toBe(4242)
  })

  it('AND THE LOST UPDATE ITSELF, at the level it can actually be constructed', async () => {
    // The consequence of writing on a refusal is that a row another incarnation wrote
    // BETWEEN the snapshot and the save is erased. That interleave is cross-process by
    // nature: `withRegistry` loads and saves inside one synchronous flock section, so a
    // pass-level case cannot get between them and would pass either way — which is the
    // vacuity this branch keeps catching. So it is constructed where it CAN be: the
    // callback itself plays the concurrent writer, which is exactly the window.
    const f = fixture()
    const other = 'other-instance other-user other-proj other-cred'
    let sawSnapshot = false
    const result = withRegistry(
      f.registryPath,
      (registry) => {
        sawSnapshot = true
        // Another incarnation writes a DIFFERENT key after our snapshot was taken.
        const onDisk = JSON.parse(readFileSync(f.registryPath, 'utf8')) as Record<string, unknown>
        onDisk[other] = { sessionKey: other, sessionId: 'c'.repeat(8), cwd: '/srv/other', pid: 9191 }
        writeFileSync(f.registryPath, JSON.stringify(onDisk))
        // ...and we decline to act, which must mean declining to WRITE.
        return { registry, result: 'refused' as const, skipSave: true }
      },
    )
    expect(sawSnapshot).toBe(true)
    expect(result).toBe('refused')
    const after = JSON.parse(readFileSync(f.registryPath, 'utf8')) as Record<string, { pid?: number }>
    // Their row is still there. Without `skipSave` our stale snapshot overwrites it.
    expect(after[other]?.pid).toBe(9191)
    expect(after[KEY]).toBeDefined()
  })

  it('does NOT close a pane the row has re-claimed under a NEWER generation', async () => {
    // ARGUS r18. A newer incarnation of OURS on a reused pane id classifies as
    // `close-foreign-owner` — it is a claude on this transcript that is not our child —
    // so the identity check alone happily authorises ending the thing that replaced us.
    //
    // THE ROW MOVES DURING THE PASS, not before it. Writing the new row up front would
    // simply make it the record the pass DECIDES from, and the case would prove nothing:
    // the pass must start out owning (HANDLE, GENERATION) and discover at the moment of
    // the close that the pane has been re-claimed.
    const f = fixture({ argv: oursArgv(SESSION_ID, 'neutron-someone-elses-channel') })
    const { entered, release } = f.host.holdInspect()
    const pass = reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
    })
    await entered
    expect(f.host.inspections).toEqual([HANDLE])
    // SAME handle, NEW generation: the pane was re-claimed, not replaced.
    writeRegistry(f.registryPath, { pane_handle: HANDLE, child_generation: 'gen-NEWER' })
    release()

    const outcome = await pass
    // NOT CLOSED. That is the whole assertion.
    expect(f.host.closed).toEqual([])
    expect(outcome.kind).toBe('undecided')
    expect(readRow(f.registryPath)?.child_generation).toBe('gen-NEWER')
  })

  it('but DOES close a pane no row names — the act this path exists for', async () => {
    // The other side, and it is why "refuse whenever the row changed" would be wrong: if
    // the row names a DIFFERENT pane, nothing names the one we are holding, so it is an
    // unreferenced live claude on this transcript. Closing it is the orphan-and-second-
    // owner prevention this module is for. Same construction, one field different.
    const f = fixture({ argv: oursArgv(SESSION_ID, 'neutron-someone-elses-channel') })
    const { entered, release } = f.host.holdInspect()
    const pass = reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
    })
    await entered
    writeRegistry(f.registryPath, { pane_handle: 'w9:p-ELSEWHERE', child_generation: 'gen-newer' })
    release()

    const outcome = await pass
    expect(f.host.closed).toEqual([HANDLE])
    expect(outcome.kind).toBe('undecided')
    expect(readRow(f.registryPath)?.pane_handle).toBe('w9:p-ELSEWHERE')
  })
})


describe('a registry that could not be READ is not a registry with nothing in it', () => {
  /**
   * ARGUS r19, and it is this branch's oldest named defect sitting under every guard
   * above it. `loadRegistry` answers `{}` for a genuinely absent file (ENOENT), for a
   * non-ENOENT read failure, and for malformed JSON. It knows the difference and told
   * nobody, and two decisions came to rest on it:
   *
   *   - `reconcileOwnRepl` answered `no-handle`, which `adoptionPermitsSpawn` lists under
   *     "nothing owns the transcript" — so a corrupt registry LICENSED a second `claude`
   *     on a live transcript without anything inspecting the pane;
   *   - `rowStillNames` answered `not-named`, which is the PROCEED branch — so registry
   *     corruption licensed CLOSING a live pane whose ownership was not established.
   *
   * THE BOUNDARY THAT MUST NOT MOVE is tested first: ENOENT is a true absence. A cold
   * boot has no registry file, and a missing file that refused spawns would stop the
   * system starting.
   */
  it('ENOENT — no registry at all — still PERMITS the spawn, exactly as on a cold boot', async () => {
    const f = fixture()
    rmSync(f.registryPath, { force: true })
    const outcome = await run(f)
    expect(outcome.kind).toBe('no-handle')
    expect(adoptionPermitsSpawn(outcome).ok).toBe(true)
  })

  it('MALFORMED JSON refuses the spawn, and says why in words absence never uses', async () => {
    const f = fixture()
    writeFileSync(f.registryPath, '{"this is not": ')
    const outcome = await run(f)
    expect(outcome.kind).toBe('undecided')
    const reason = outcome.kind === 'undecided' ? outcome.reason : ''
    expect(reason).toMatch(/could NOT BE READ/)
    expect(adoptionPermitsSpawn(outcome).ok).toBe(false)
  })

  it('A NON-ENOENT READ FAILURE refuses the spawn too', async () => {
    // The registry path is a DIRECTORY, so `readFileSync` fails with EISDIR rather than
    // ENOENT — the production shape of "the file is there and I could not read it".
    const f = fixture()
    rmSync(f.registryPath, { force: true })
    mkdirSync(f.registryPath, { recursive: true })
    const outcome = await run(f)
    expect(outcome.kind).toBe('undecided')
    expect(outcome.kind === 'undecided' && outcome.reason).toMatch(/could NOT BE READ/)
    expect(adoptionPermitsSpawn(outcome).ok).toBe(false)
    rmSync(f.registryPath, { recursive: true, force: true })
  })

  /** Drive a pass that WILL try to close, and break the registry while it is inspecting —
   *  so the pre-close row read is the thing that meets the broken file. */
  async function closeWithRegistryBrokenMidPass(
    f: Fixture,
    breakIt: () => void,
  ): Promise<Awaited<ReturnType<typeof reconcileOwnRepl>>> {
    const { entered, release } = f.host.holdInspect()
    const pass = reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
    })
    await entered
    breakIt()
    release()
    return await pass
  }

  it('the CLOSE proceeds when the registry is genuinely gone — nothing names the pane', async () => {
    // The permitting direction for the other consumer, and it must keep working: if no
    // row names the pane we are holding, it is an unreferenced live claude and closing it
    // is the orphan prevention this path exists for.
    const f = fixture({ argv: oursArgv(SESSION_ID, 'neutron-someone-elses-channel') })
    await closeWithRegistryBrokenMidPass(f, () => rmSync(f.registryPath, { force: true }))
    expect(f.host.closed).toEqual([HANDLE])
  })

  it('but REFUSES to close when the registry is malformed', async () => {
    const f = fixture({ argv: oursArgv(SESSION_ID, 'neutron-someone-elses-channel') })
    const outcome = await closeWithRegistryBrokenMidPass(f, () =>
      writeFileSync(f.registryPath, '{"broken'),
    )
    // THE PANE SURVIVES. Corruption must not license a destructive act.
    expect(f.host.closed).toEqual([])
    expect(outcome.kind).toBe('undecided')
  })

  it('and REFUSES to close on a non-ENOENT read failure', async () => {
    const f = fixture({ argv: oursArgv(SESSION_ID, 'neutron-someone-elses-channel') })
    const outcome = await closeWithRegistryBrokenMidPass(f, () => {
      rmSync(f.registryPath, { force: true })
      mkdirSync(f.registryPath, { recursive: true })
    })
    expect(f.host.closed).toEqual([])
    expect(outcome.kind).toBe('undecided')
    rmSync(f.registryPath, { recursive: true, force: true })
  })
})


describe('a row DROPPED as schema-invalid is unreadable, not absent — and only for its own key', () => {
  /**
   * ARGUS r20. Round nineteen fixed the collapse at FILE granularity; the registry
   * discards individual schema-invalid rows and still reports `loaded`, so the same
   * collapse survived one level down. A well-formed file whose target row carries
   * `has_session: "true"` parses, the row is discarded, and the key is simply not there —
   * `absent` again, from a row that was unreadable. A live pane's durable record vanishes
   * from every decision that matters while the read reports success.
   *
   * AND THE OTHER DIRECTION IS THE ONE MOST EASILY MISSED: a dropped row belonging to
   * SOME OTHER key says nothing about this one, and refusing on it would turn any
   * corruption anywhere into a gateway that serves nothing.
   */
  const OTHER = 'other-instance other-user other-proj other-cred'

  /**
   * A registry with our row present-but-invalid, or someone else's.
   *
   * THE VALID ROW IS TAKEN FROM DISK, not hand-written. A hand-rolled "valid" row encodes
   * my model of what a valid row is — the first attempt omitted `reuse` and the pass
   * answered `closed-unadoptable`, so the case failed for a reason that had nothing to do
   * with dropped rows. Same lesson as building argv with the real builder.
   */
  function writeWithDrop(path: string, which: 'ours' | 'theirs'): void {
    const valid = readRow(path) as unknown as Record<string, unknown>
    // `has_session` as a STRING is the whole corruption: the file is well-formed JSON
    // and the row fails the record schema.
    const invalid = { ...valid, has_session: 'true' }
    writeFileSync(
      path,
      JSON.stringify(
        which === 'ours'
          ? { [KEY]: invalid }
          : { [KEY]: valid, [OTHER]: { ...invalid, sessionKey: OTHER } },
      ),
    )
  }

  it('SPAWN: a dropped TARGET row refuses, naming the drop', async () => {
    const f = fixture()
    writeWithDrop(f.registryPath, 'ours')
    const outcome = await run(f)
    expect(outcome.kind).toBe('undecided')
    const reason = outcome.kind === 'undecided' ? outcome.reason : ''
    expect(reason).toMatch(/ROW WAS DROPPED/)
    expect(adoptionPermitsSpawn(outcome).ok).toBe(false)
  })

  it('SPAWN: a dropped row for ANOTHER key changes nothing — the case that keeps the fix honest', async () => {
    const f = fixture()
    writeWithDrop(f.registryPath, 'theirs')
    const outcome = await run(f)
    // Our row is intact and is adopted, exactly as if the other row were not there.
    expect(outcome.kind).toBe('adopted')
    expect(await pool.get(KEY)).toBeDefined()
  })

  it('CLOSE: a dropped TARGET row refuses to close', async () => {
    const f = fixture({ argv: oursArgv(SESSION_ID, 'neutron-someone-elses-channel') })
    const { entered, release } = f.host.holdInspect()
    const pass = reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
    })
    await entered
    writeWithDrop(f.registryPath, 'ours')
    release()
    const outcome = await pass
    // THE PANE SURVIVES: a row we could not read does not license ending a live REPL.
    expect(f.host.closed).toEqual([])
    expect(outcome.kind).toBe('undecided')
  })

  it('CLOSE: a dropped row for ANOTHER key still closes a pane no row names', async () => {
    const f = fixture({ argv: oursArgv(SESSION_ID, 'neutron-someone-elses-channel') })
    const { entered, release } = f.host.holdInspect()
    const pass = reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
    })
    await entered
    // Someone else's row is invalid AND our row now names a different pane, so nothing
    // names the one we hold — the close must still proceed.
    writeFileSync(
      f.registryPath,
      JSON.stringify({
        [KEY]: {
          sessionKey: KEY,
          sessionId: SESSION_ID,
          cwd: '/tmp',
          channelName: CHANNEL,
          has_session: true,
          pane_handle: 'w9:p-ELSEWHERE',
          child_generation: 'gen-newer',
        },
        [OTHER]: { sessionKey: OTHER, sessionId: SESSION_ID, cwd: '/x', channelName: 'c', has_session: 'no' },
      }),
    )
    release()
    await pass
    expect(f.host.closed).toEqual([HANDLE])
  })
})


describe("the clear's EARLY RETURNS write nothing either", () => {
  /**
   * ARGUS r21. The `acquired` check sat BELOW the two early returns, so an absent row and
   * a moved row both returned without `skipSave` and `withRegistry` wrote the snapshot
   * back — the same lost update round eighteen fixed, surviving in the branches that
   * returned early. The answers were wrong too: both readings came from an unguarded
   * snapshot, so without the lock we do not know the row is absent or moved, only that we
   * read something we had no right to trust.
   *
   * TWO THINGS THE FIRST VERSION OF THESE CASES GOT WRONG, both of which made them pass
   * against the defect:
   *
   *   - the absent case used an EMPTY registry, and `JSON.stringify({}, null, 2)` is
   *     byte-identical to `JSON.stringify({})` — so the very rewrite being hunted was
   *     invisible to the byte comparison. It now holds another incarnation's row, which
   *     is also the thing the lost update would destroy;
   *   - the moved case drove the CLOSE path, and since round eighteen the pre-close gate
   *     refuses on a moved row before the clear is ever reached. It now drives the
   *     pid-fallback path (`handle-cleared`), which reaches the clear directly.
   */
  afterEach(() => setFlockImplForTests(undefined))

  const OTHERKEY = 'other-instance other-user other-proj other-cred'
  const otherRow = {
    sessionKey: OTHERKEY,
    sessionId: 'cccccccc-1111-2222-3333-444444444444',
    cwd: '/srv/other',
    channelName: 'neutron-otherotherotherotherotherother11',
    has_session: true,
    pid: 9191,
  }

  /** The pid-fallback path: the host cannot be asked, the recorded pid is dead, and no
   *  live process owns the transcript — so the handle is CLEARED rather than the pane
   *  closed. It reaches the clear with no pre-close gate in front of it, which the close
   *  path does not: with the flock failing, that gate refuses the close and the clear is
   *  never reached at all. The first version of the absent case drove the close path and
   *  passed for exactly that reason. */
  function pidFallbackPass(f: Fixture): {
    entered: Promise<void>
    release: () => void
    pass: Promise<Awaited<ReturnType<typeof reconcileOwnRepl>>>
  } {
    f.host.inspectOverride = { kind: 'unavailable', reason: 'socket timeout' }
    const { entered, release } = f.host.holdInspect()
    const pass = reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
      orphanDeps: () => ({
        isPidAlive: () => false,
        readCmdline: () => undefined,
        terminatePid: async () => {},
      }),
      listProcesses: () => [],
    })
    return { entered, release, pass }
  }

  it('an ABSENT row with the lock refused writes nothing — and another incarnation keeps its row', async () => {
    const f = fixture()
    const { entered, release, pass } = pidFallbackPass(f)
    await entered
    // OUR key is gone; somebody else's row is there — which is exactly what the lost
    // update would destroy. Compact, so `saveRegistry`'s pretty-printing is visible.
    writeFileSync(f.registryPath, JSON.stringify({ [OTHERKEY]: otherRow }))
    const before = readFileSync(f.registryPath, 'utf8')
    expect(before).not.toContain('\n')
    setFlockImplForTests(() => 1)
    release()
    const outcome = await pass

    expect(readFileSync(f.registryPath, 'utf8')).toBe(before)
    // AND THE VERDICT, not only the bytes. The byte assertion is the right instrument for
    // the WRITE and says nothing about what the pass then reports — which is how a
    // spawn-permitting outcome survived five rounds of these cases (Argus r23).
    expect(adoptionPermitsSpawn(outcome as never).ok).toBe(false)
  })

  it('a MOVED row with the lock refused writes nothing', async () => {
    // The pid-fallback path reaches the clear without the pre-close gate in front of it:
    // the host cannot be asked, the recorded pid is dead, and no live process owns the
    // transcript — so the handle is cleared rather than the pane closed.
    const f = fixture()
    const { entered, release, pass } = pidFallbackPass(f)
    await entered
    const row = readRow(f.registryPath) as unknown as Record<string, unknown>
    writeFileSync(
      f.registryPath,
      JSON.stringify({
        [KEY]: { ...row, pane_handle: 'w9:p-NEWER', child_generation: 'gen-newer' },
        [OTHERKEY]: otherRow,
      }),
    )
    const before = readFileSync(f.registryPath, 'utf8')
    setFlockImplForTests(() => 1)
    release()
    const outcome = await pass

    expect(readFileSync(f.registryPath, 'utf8')).toBe(before)
    expect(adoptionPermitsSpawn(outcome as never).ok).toBe(false)
  })

  it('THE POSITIVE CONTROL: lock GRANTED and the row genuinely absent still permits the spawn', async () => {
    // Without this, refusing on every clear outcome would satisfy both cases above — and
    // the over-strict direction here stops the gateway spawning at all on a healthy cold
    // boot, which is the system-breaking way to be wrong.
    const f = fixture()
    const { entered, release, pass } = pidFallbackPass(f)
    await entered
    writeFileSync(f.registryPath, JSON.stringify({}))
    release()
    const outcome = await pass
    expect(outcome.kind).toBe('handle-cleared')
    expect(adoptionPermitsSpawn(outcome).ok).toBe(true)
  })

  it('THE CONTROLS: with the lock granted, both paths DO change the file', async () => {
    // Non-vacuity. Without these, a clear that had simply stopped writing would satisfy
    // both cases above.
    const f = fixture({ argv: oursArgv(SESSION_ID, 'neutron-someone-elses-channel') })
    const { entered, release } = f.host.holdInspect()
    const pass = reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
    })
    await entered
    const row = readRow(f.registryPath) as unknown as Record<string, unknown>
    writeFileSync(f.registryPath, JSON.stringify({ [KEY]: row }))
    const before = readFileSync(f.registryPath, 'utf8')
    release()
    await pass
    expect(readFileSync(f.registryPath, 'utf8')).not.toBe(before)
    expect(readRow(f.registryPath)?.pane_handle).toBeUndefined()
  })
})
