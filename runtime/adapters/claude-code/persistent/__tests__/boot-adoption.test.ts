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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginBootAdoption, reconcileOwnRepl, resetBootAdoption } from '../boot-adoption.ts'
import { childByKey, pool, sink } from '../pool-state.ts'
import { deriveChildSinkToken } from '../sink-coordinates.ts'
import { ReplSession } from '../repl-session.ts'
import type { ReplRegistry, ReplRegistryRecord } from '../repl-registry.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'
import { FakeAdoptableHost } from './boot-adoption-host.ts'

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
  resetBootAdoption()
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
    const release = f.host.holdAttach()
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

  it('ignores a process that merely MENTIONS the session id', async () => {
    // The recycled-pid trap in scan form: a `tail -f` on the transcript path carries
    // the uuid and lives under `.claude/`, and is not an owner.
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
    expect(outcome.kind).toBe('handle-cleared')
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
    const release = f.host.holdInspect()
    const pass = reconcileOwnRepl(f.options, KEY, { host: f.host, health: async () => true, log: () => {} })

    // ...and while the inspection is in flight, another incarnation finishes a spawn
    // and writes ITS child into the same key.
    await Bun.sleep(20)
    writeRegistry(f.registryPath, { pane_handle: 'w9:p-NEWER', child_generation: 'gen-newer', pid: 5150 })
    release()

    const outcome = await pass
    expect(outcome.kind).toBe('handle-cleared')
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

  it('does not write an adopted pid onto a row that moved under it either', async () => {
    // The same exposure on the other write this pass makes.
    const f = fixture({ record: { pid: 1 } })
    const release = f.host.holdInspect()
    const pass = reconcileOwnRepl(f.options, KEY, { host: f.host, health: async () => true, log: () => {} })
    await Bun.sleep(20)
    writeRegistry(f.registryPath, { pane_handle: 'w9:p-NEWER', child_generation: 'gen-newer', pid: 777 })
    release()
    await pass
    const row = readRow(f.registryPath)
    expect(row?.pid).toBe(777)
    expect(row?.pane_handle).toBe('w9:p-NEWER')
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
