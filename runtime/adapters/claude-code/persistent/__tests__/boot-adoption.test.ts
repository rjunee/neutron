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
import { reconcileOwnRepl, resetBootAdoption } from '../boot-adoption.ts'
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

  it('an attach that fails undoes the sink registration it had already made', async () => {
    const f = fixture()
    f.host.attachError = new Error('transport died')
    const credential = deriveChildSinkToken(sink.token, GENERATION)
    const outcome = await run(f)
    expect(outcome.kind).toBe('undecided')
    // A standing authorization for a session with no child is exactly the orphan the
    // credential model exists to refuse.
    expect(await postReply(credential)).toBe(401)
  })
})

describe('when the host cannot answer', () => {
  it('falls back to the PID identity check and closes a VERIFIED-ours process', async () => {
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
    expect(outcome.kind).toBe('closed-by-pid')
    expect(terminated).toEqual([4242])
    expect(readRow(f.registryPath)?.pane_handle).toBeUndefined()
  })

  it('leaves an UNVERIFIED process alone and says so', async () => {
    const f = fixture()
    f.host.inspectOverride = { kind: 'unavailable', reason: 'socket timeout' }
    const terminated: number[] = []
    const outcome = await reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
      orphanDeps: () => ({
        isPidAlive: () => true,
        // A recycled pid running something else entirely.
        readCmdline: () => '/usr/sbin/cupsd -l -f',
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

  it('a LIVE pane with no argv is unverifiable, and takes the same fallback', async () => {
    const f = fixture()
    f.host.inspectOverride = { kind: 'live', argv: [] }
    const outcome = await reconcileOwnRepl(f.options, KEY, {
      host: f.host,
      health: async () => true,
      log: () => {},
      orphanDeps: () => ({
        isPidAlive: () => false,
        readCmdline: () => undefined,
        terminatePid: async () => {},
      }),
    })
    expect(outcome.kind).toBe('undecided')
    expect(f.host.closed).toEqual([])
  })
})

describe('rows that cannot be reconciled at all', () => {
  it('a row with no pane handle is not a failure', async () => {
    const f = fixture({ record: { pane_handle: undefined } })
    expect((await run(f)).kind).toBe('no-handle')
    expect(f.host.attached).toHaveLength(0)
  })

  it('a host that cannot adopt reports no-handle and touches nothing', async () => {
    const f = fixture()
    const outcome = await reconcileOwnRepl(f.options, KEY, {
      // A plain PtyHost: spawn only, no adoption surface.
      host: {
        spawn: async () => {
          throw new Error('never')
        },
      },
      health: async () => true,
      log: () => {},
    })
    expect(outcome.kind).toBe('no-handle')
    expect(f.host.closed).toEqual([])
    expect(readRow(f.registryPath)?.pane_handle).toBe(HANDLE)
  })
})
