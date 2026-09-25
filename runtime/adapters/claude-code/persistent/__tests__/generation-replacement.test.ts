/**
 * generation-replacement.test.ts — #1237: the runtime replacement primitive.
 *
 * Every pre-mutation refusal leaves the pool and the child map untouched and calls
 * neither termination nor spawn (guards). The accepted case terminates the EXACT
 * child, waits for its exit, and resumes the SAME conversation through the
 * supervised options (control). An old child that will not exit is `unknown` and
 * nothing is spawned — never two owners of one transcript (guard). One end-to-end
 * case replaces a really-spawned parent and observes the stamp, the surface and the
 * durable row agreeing.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '../../../../substrate.ts'
import type { Event } from '../../../../events.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import {
  bakedChildSinkInfo,
  createPersistentReplSubstrate,
  poolKeyFor,
  registerSupervisedSubstrate,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'
import {
  observePooledSession,
  replaceQuiescentPooledSession,
  requestedProfileFor,
  type ExpectedParent,
  type ReplacementDeps,
} from '../generation-replacement.ts'
import { childByKey, committedDispatches, pendingSpawns, pool, supervisedBySessionKey } from '../pool-state.ts'
import { ReplSession } from '../repl-session.ts'
import { gateFor } from '../spawn.ts'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import type { ProcessIdentity } from '../process-identity.ts'

const KEY = 'cc-agent-replace owner proj cred'
const SESSION_ID = 'aaaaaaaa-1237-4000-8000-000000000001'
const CHANNEL = 'neutron-12371237123712371237123712371237'
const IDENTITY: ProcessIdentity = { start_ticks: 99, boot_id: 'boot-x' }
const OPTIONS = { substrate_instance_id: 'cc-agent-replace', cwd: '/tmp', project_id: 'proj' } as unknown as PersistentReplSubstrateOptions
const SPEC: AgentSpec = { prompt: 'ready', tools: [{ name: 'Read' }, { name: 'Agent' }] as AgentSpec['tools'], model_preference: ['claude-opus'] }

afterEach(() => {
  pool.clear()
  childByKey.clear()
  pendingSpawns.clear()
  committedDispatches.clear()
  supervisedBySessionKey.clear()
  gateFor(KEY).release()
})

function fakeChild(opts: { exitsOnKill?: boolean } = {}): PtyChild {
  let exited = false
  let resolveExit: (code: number | null) => void = () => {}
  const exitedPromise = new Promise<number | null>((res) => { resolveExit = res })
  return {
    pid: 4242,
    write: () => {},
    kill: () => {
      if (opts.exitsOnKill === false) return
      exited = true
      resolveExit(143)
    },
    exited: exitedPromise,
    hasExited: () => exited,
    wasKilledByUs: () => true,
  }
}

function pooled(child = fakeChild()): { session: ReplSession; entry: Promise<ReplSession>; child: PtyChild } {
  const session = new ReplSession(KEY, 'gen-old', SESSION_ID, CHANNEL, '/tmp')
  session.attachChild(child)
  const entry = Promise.resolve(session)
  session.pooledAs = entry
  pool.set(KEY, entry)
  childByKey.set(KEY, child)
  supervisedBySessionKey.set(KEY, OPTIONS)
  return { session, entry, child }
}

const EXPECTED: ExpectedParent = { sessionKey: KEY, childGeneration: 'gen-old', sessionId: SESSION_ID, pid: 4242, identity: IDENTITY }

function spies(): { deps: ReplacementDeps; terminated: PtyChild[]; spawned: Array<{ key: string; options: PersistentReplSubstrateOptions; spec: AgentSpec; resume: { sessionId: string } }> } {
  const terminated: PtyChild[] = []
  const spawned: Array<{ key: string; options: PersistentReplSubstrateOptions; spec: AgentSpec; resume: { sessionId: string } }> = []
  return {
    terminated,
    spawned,
    deps: {
      identity: () => IDENTITY,
      terminate: async (child) => { terminated.push(child); child.kill() },
      spawn: async (key, options, spec, resume) => {
        spawned.push({ key, options, spec, resume })
        return new ReplSession(key, 'gen-new', resume.sessionId, CHANNEL, '/tmp')
      },
    },
  }
}

describe('every pre-mutation refusal leaves the pool untouched (guards)', () => {
  const cases: Array<[string, () => { expected?: Partial<ExpectedParent>; deps?: Partial<ReplacementDeps> } | void, string]> = [
    ['unsupervised', () => { supervisedBySessionKey.clear() }, 'unsupervised'],
    ['absent', () => { pool.delete(KEY) }, 'absent'],
    ['pending pool entry', () => { pool.set(KEY, new Promise(() => {})) }, 'pending'],
    ['pending spawn', () => { pendingSpawns.set(KEY, new Promise(() => {})) }, 'pending'],
    ['pid differs', () => ({ expected: { pid: 999 } }), 'identity-mismatch'],
    ['child generation differs', () => ({ expected: { childGeneration: 'gen-other' } }), 'identity-mismatch'],
    ['conversation differs', () => ({ expected: { sessionId: 'other' } }), 'identity-mismatch'],
    ['child map names another child', () => { childByKey.set(KEY, fakeChild()) }, 'identity-mismatch'],
    ['recycled pid (identity differs)', () => ({ deps: { identity: () => ({ start_ticks: 1, boot_id: 'boot-x' }) } }), 'identity-mismatch'],
    ['unreadable identity', () => ({ deps: { identity: () => undefined } }), 'identity-mismatch'],
    ['gate held', () => { gateFor(KEY).claim() }, 'gate-held'],
    ['committed dispatch', () => { committedDispatches.set(KEY, 1) }, 'busy'],
  ]
  for (const [name, arrange, reason] of cases) {
    it(`${name} → refused:${reason}`, async () => {
      const { entry, child } = pooled()
      const { deps, terminated, spawned } = spies()
      const over = arrange() ?? {}
      const poolBefore = pool.get(KEY)
      const out = await replaceQuiescentPooledSession({ ...EXPECTED, ...over.expected }, SPEC, { ...deps, ...over.deps })
      expect(out).toEqual({ status: 'refused', reason: reason as never })
      expect(pool.get(KEY)).toBe(poolBefore)
      if (poolBefore === entry) expect(childByKey.get(KEY)).toBeDefined()
      expect(terminated).toEqual([])
      expect(spawned).toEqual([])
      expect(child.hasExited()).toBe(false)
    })
  }

  for (const [name, mark, reason] of [
    ['active turn', (s: ReplSession) => { s.activeTurn = {} as ReplSession['activeTurn'] }, 'busy'],
    ['turn slot held', (s: ReplSession) => { s.turnSlotHeld = 1 }, 'busy'],
    ['poisoned', (s: ReplSession) => { s.poisoned = true }, 'poisoned'],
  ] as const) {
    it(`${name} → refused:${reason}`, async () => {
      const { session, entry } = pooled()
      mark(session)
      const { deps, terminated, spawned } = spies()
      expect(await replaceQuiescentPooledSession(EXPECTED, SPEC, deps)).toEqual({ status: 'refused', reason })
      expect(pool.get(KEY)).toBe(entry)
      expect(terminated).toEqual([])
      expect(spawned).toEqual([])
    })
  }

  it('an exited child → refused:child-exited', async () => {
    const { child, entry } = pooled()
    child.kill()
    const { deps, terminated, spawned } = spies()
    expect(await replaceQuiescentPooledSession(EXPECTED, SPEC, deps)).toEqual({ status: 'refused', reason: 'child-exited' })
    expect(pool.get(KEY)).toBe(entry)
    expect(terminated).toEqual([])
    expect(spawned).toEqual([])
  })
})

describe('the accepted replacement', () => {
  it('terminates the exact child, awaits its exit, and resumes the SAME conversation under the supervised options (control)', async () => {
    const { child } = pooled()
    const { deps, terminated, spawned } = spies()
    const out = await replaceQuiescentPooledSession(EXPECTED, SPEC, deps)
    expect(out.status).toBe('replaced')
    expect(terminated).toEqual([child])
    expect(child.hasExited()).toBe(true)
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.key).toBe(KEY)
    expect(spawned[0]!.options).toBe(OPTIONS)
    expect(spawned[0]!.spec).toBe(SPEC)
    expect(spawned[0]!.resume).toEqual({ sessionId: SESSION_ID })
    // The gate is released afterwards, so a later watchdog respawn is not wedged.
    expect(gateFor(KEY).claim()).toBe(true)
  })

  it('an old child that does not exit is unknown and NOTHING is spawned (guard: never two owners)', async () => {
    pooled(fakeChild({ exitsOnKill: false }))
    const { deps, terminated, spawned } = spies()
    const out = await replaceQuiescentPooledSession(EXPECTED, SPEC, deps)
    expect(out).toEqual({ status: 'unknown', reason: 'old child did not exit' })
    expect(terminated).toHaveLength(1)
    expect(spawned).toEqual([])
  })

  it('a rejected spawn is unknown, not a throw', async () => {
    pooled()
    const { deps } = spies()
    const out = await replaceQuiescentPooledSession(EXPECTED, SPEC, { ...deps, spawn: async () => { throw new Error('spawn refused') } })
    expect(out).toEqual({ status: 'unknown', reason: 'replacement spawn failed: spawn refused' })
  })
})

describe('observePooledSession', () => {
  it('is undefined for an absent or pending entry', () => {
    expect(observePooledSession(KEY)).toBeUndefined()
    pool.set(KEY, new Promise(() => {}))
    expect(observePooledSession(KEY)).toBeUndefined()
  })

  it('reads a fulfilled entry', () => {
    const { session } = pooled()
    session.toolSurface = 'Read,Agent'
    session.admissionGeneration = 4
    expect(observePooledSession(KEY)).toMatchObject({
      sessionId: SESSION_ID, childGeneration: 'gen-old', pid: 4242, exited: false, identified: true,
      admissionGeneration: 4, toolSurface: 'Read,Agent', registry: undefined,
    })
  })
})

// ── END TO END: a really-spawned parent replaced through the real spawn path ──

const dirs: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []

/** A fake `claude` + dev-channel that answers turns and records its argv. */
function echoHost(argvs: string[][]): PtyHost {
  return {
    async spawn(argv: string[]): Promise<PtyChild> {
      argvs.push(argv)
      const i = argv.indexOf('--session-id')
      const r = argv.indexOf('--resume')
      const sid = (i >= 0 ? argv[i + 1] : r >= 0 ? argv[r + 1] : undefined) as string
      const { port: sinkPort, token } = bakedChildSinkInfo(argv)
      let exited = false
      let exitResolve: (code: number | null) => void = () => {}
      const exitedPromise = new Promise<number | null>((res) => { exitResolve = res })
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
        write() {},
        kill() {
          if (exited) return
          exited = true
          try { server.stop(true) } catch { /* ignore */ }
          exitResolve(143)
        },
        exited: exitedPromise,
        hasExited: () => exited,
        wasKilledByUs: () => true,
      }
    },
  }
}

async function drain(handle: SessionHandle): Promise<string> {
  let text = ''
  for await (const ev of handle.events as AsyncIterable<Event>) {
    if (ev.kind === 'token') text += ev.text
    else if (ev.kind === 'completion') return text
    else if (ev.kind === 'error') throw new Error(`drain error: ${ev.message}`)
  }
  return text
}

describe('end to end over the real spawn path', () => {
  afterEach(async () => {
    await shutdownAllPersistentRepls()
    for (const s of servers.splice(0)) { try { s.stop(true) } catch { /* stopped */ } }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('replaces a stamped parent with a resume of its conversation under the fence generation, and the durable row agrees', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neutron-1237-replace-'))
    dirs.push(dir)
    let generation = 8
    const argvs: string[][] = []
    const options = {
      substrate_instance_id: 'cc-agent-replace-e2e',
      cwd: '/tmp/neutron-replace',
      ptyHost: echoHost(argvs),
      skipTrustSeed: true,
      idleQuietMs: 0,
      replRegistryPath: join(dir, 'repl-registry.json'),
      captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
      admissionGeneration: async () => generation,
    } as unknown as PersistentReplSubstrateOptions
    const key = poolKeyFor(options)
    const spec: AgentSpec = { prompt: 'hi', tools: SPEC.tools, model_preference: ['claude-opus'] }
    await drain(createPersistentReplSubstrate(options).start(spec))
    // Production registers supervision from the adapter's factory; register it the same way.
    registerSupervisedSubstrate(options)
    expect(supervisedBySessionKey.get(key)).toBe(options)
    const before = observePooledSession(key)!
    expect(before.admissionGeneration).toBe(8)

    // The turn's slot unwinds after its completion is delivered; the census would read
    // busy until then, so wait for the same quiescence the primitive checks.
    const session = await pool.get(key)!
    for (let i = 0; i < 200 && (session.activeTurn !== undefined || session.turnSlotHeld !== 0 || (committedDispatches.get(key) ?? 0) !== 0); i++) {
      await Bun.sleep(10)
    }
    // The fence moved on: the replacement must be stamped with the NEW generation.
    generation = 9
    const out = await replaceQuiescentPooledSession(
      { sessionKey: key, childGeneration: before.childGeneration, sessionId: before.sessionId, pid: before.pid, identity: IDENTITY },
      spec,
      { identity: () => IDENTITY },
    )
    expect(out).toMatchObject({ status: 'replaced' })
    const after = observePooledSession(key)!
    expect(after.sessionId).toBe(before.sessionId)
    expect(after.childGeneration).not.toBe(before.childGeneration)
    expect(after.admissionGeneration).toBe(9)
    expect(after.toolSurface).toBe('Read,Agent')
    expect(after.identified).toBe(true)
    expect(after.exited).toBe(false)
    expect(after.registry).toEqual({ sessionId: before.sessionId, admission_generation: 9, tool_surface: 'Read,Agent', tool_bridge: after.toolBridgeActive })
    expect(requestedProfileFor(key, spec)).toEqual({ toolSurface: 'Read,Agent', toolBridge: after.toolBridgeActive })
    // The replacement RESUMED the conversation rather than starting a new one.
    const last = argvs[argvs.length - 1]!
    expect(last[last.indexOf('--resume') + 1]).toBe(before.sessionId)
  }, 30_000)
})
