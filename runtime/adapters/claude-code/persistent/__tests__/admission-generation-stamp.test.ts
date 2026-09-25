/**
 * admission-generation-stamp.test.ts — #1237: the registry admission generation.
 *
 * A project parent spawned under a reader records the scope's admission generation
 * on its session AND its registry row; adoption restores it from the row. A parent
 * whose row carries no stamp — a legacy row, an unwired reader, a reader that threw —
 * reads `undefined`, which the liveness census treats as legacy-unknown. The stamp
 * describes the child it was taken for, so a replacement spawn never inherits its
 * predecessor's.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
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
import {
  normaliseRecord,
  parseRegistryContents,
  serializeRegistry,
  type ReplRegistry,
  type ReplRegistryRecord,
} from '../repl-registry.ts'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import { reconcileOwnRepl, resetBootAdoptionForTests } from '../boot-adoption.ts'
import { childByKey, pool, sink, supervisedBySessionKey } from '../pool-state.ts'
import { FakeAdoptableHost } from './boot-adoption-host.ts'
import { withCapturedStderr } from './capture-stderr.ts'

const dirs: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'neutron-1237-stamp-'))
  dirs.push(d)
  return d
}

/** A fake `claude` + dev-channel that answers one turn (no pane handle). */
function echoHost(): PtyHost {
  return {
    async spawn(argv: string[]): Promise<PtyChild> {
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

function optionsFor(registryPath: string, reader?: () => Promise<number | undefined>): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-agent-stamp',
    cwd: '/tmp/neutron-stamp',
    ptyHost: echoHost(),
    skipTrustSeed: true,
    idleQuietMs: 0,
    replRegistryPath: registryPath,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    ...(reader !== undefined ? { admissionGeneration: reader } : {}),
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
  await shutdownAllPersistentRepls()
  for (const s of servers.splice(0)) {
    try { s.stop(true) } catch { /* already stopped */ }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('a spawn stamps the admission generation its reader answers', () => {
  it('stamps the session and the registry row', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    let reads = 0
    const options = optionsFor(registryPath, async () => { reads += 1; return 7 })
    const key = poolKeyFor(options)
    await drain(createPersistentReplSubstrate(options).start(spec('hi')))
    expect(reads).toBe(1)
    expect((await pool.get(key))?.admissionGeneration).toBe(7)
    expect(readRow(registryPath, key)?.admission_generation).toBe(7)
  })

  it('a rejecting reader spawns UNSTAMPED and says so on stderr', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(registryPath, async () => { throw new Error('admission store unavailable') })
    const key = poolKeyFor(options)
    const lines = await withCapturedStderr(async () => {
      await drain(createPersistentReplSubstrate(options).start(spec('hi')))
    })
    expect(lines.join('')).toContain('[repl] admissionGeneration failed for key=')
    expect((await pool.get(key))?.admissionGeneration).toBeUndefined()
    const row = readRow(registryPath, key)
    expect(row).toBeDefined()
    expect(row !== undefined && 'admission_generation' in row).toBe(false)
  })

  it('an unwired reader, and one answering a non-generation, leave the row unstamped', async () => {
    for (const reader of [undefined, async () => -1, async () => 1.5, async () => undefined]) {
      const registryPath = join(scratch(), 'repl-registry.json')
      const options = optionsFor(registryPath, reader)
      const key = poolKeyFor(options)
      await drain(createPersistentReplSubstrate(options).start(spec('hi')))
      expect((await pool.get(key))?.admissionGeneration).toBeUndefined()
      expect(readRow(registryPath, key)?.admission_generation).toBeUndefined()
      await shutdownAllPersistentRepls()
    }
  })

  it('a replacement spawn never inherits the prior row\'s stamp', async () => {
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(registryPath)
    const key = poolKeyFor(options)
    // A row left by a predecessor child that WAS stamped.
    writeFileSync(registryPath, serializeRegistry({
      [key]: {
        sessionKey: key,
        sessionId: 'cccccccc-1111-2222-3333-444444444444',
        cwd: '/tmp/neutron-stamp',
        channelName: 'neutron-00000000000000000000000000000000',
        has_session: false,
        admission_generation: 4,
      } as ReplRegistryRecord,
    }))
    await drain(createPersistentReplSubstrate(options).start(spec('hi')))
    expect(readRow(registryPath, key)?.admission_generation).toBeUndefined()
  })
})

describe('adoption restores the stamp from the row', () => {
  const KEY = 'inst user proj cred'
  const SESSION_ID = 'dddddddd-1111-2222-3333-444444444444'
  const CHANNEL = 'neutron-0123456789abcdef0123456789abcdef'
  const HANDLE = 'w9:p12'

  beforeAll(async () => {
    await sink.ensureStarted({ tokenPath: join(scratch(), 'sink-token') })
  })
  beforeEach(() => resetBootAdoptionForTests())
  afterEach(() => {
    resetBootAdoptionForTests()
    supervisedBySessionKey.clear()
    pool.clear()
    childByKey.clear()
    sink.unregister(SESSION_ID)
  })

  async function adopt(stamp: Record<string, unknown>): Promise<number | undefined> {
    const registryPath = join(scratch(), 'repl-registry.json')
    const registry = {
      [KEY]: {
        sessionKey: KEY, sessionId: SESSION_ID, cwd: '/tmp', channelName: CHANNEL, has_session: true,
        pid: 4242, devchannel_port: 45777, child_generation: 'gen-stamp-1', pane_handle: HANDLE,
        reuse: { tool_surface: 'Read', tool_bridge: false, auth_fingerprint: 'fp-stamp' },
        ...stamp,
      },
    }
    writeFileSync(registryPath, JSON.stringify(registry, null, 2))
    const host = new FakeAdoptableHost()
    host.addPane(HANDLE, {
      argv: ['claude', '--resume', SESSION_ID, '--dangerously-load-development-channels', `server:${CHANNEL}`],
      screens: ['idle screen'], pid: 4242,
    })
    const options = {
      substrate_instance_id: 'inst', model_preference: ['claude-opus-5'], replRegistryPath: registryPath,
      project_id: 'proj', cwd: '/tmp', ptyHost: host,
    } as unknown as PersistentReplSubstrateOptions
    const outcome = await reconcileOwnRepl(options, KEY, { host, health: async () => true, log: () => {} })
    expect(outcome.kind).toBe('adopted')
    const session = await pool.get(KEY)
    expect(session?.adopted).toBe(true)
    return session?.admissionGeneration
  }

  it('a stamped row adopts as participating', async () => {
    expect(await adopt({ admission_generation: 3 })).toBe(3)
  })

  it('a legacy row (no field) adopts as UNKNOWN, never as generation 0', async () => {
    expect(await adopt({})).toBeUndefined()
  })

  it('a malformed stamp adopts as unknown', async () => {
    expect(await adopt({ admission_generation: -2 })).toBeUndefined()
    expect(await adopt({ admission_generation: '3' })).toBeUndefined()
  })
})

describe('the registry round trip', () => {
  const base = {
    sessionKey: 'k', sessionId: 'eeeeeeee-1111-2222-3333-444444444444', cwd: '/tmp',
    channelName: 'neutron-11111111111111111111111111111111', has_session: true,
  } as ReplRegistryRecord

  it('carries a stamp through serialize, parse and normalise', () => {
    const parsed = parseRegistryContents(serializeRegistry({ k: { ...base, admission_generation: 9 } }))
    expect(parsed.kind).toBe('loaded')
    const row = parsed.kind === 'loaded' ? normaliseRecord(parsed.registry.k) : undefined
    expect(row?.admission_generation).toBe(9)
  })

  it('keeps an unstamped row unstamped (the field is never invented)', () => {
    const parsed = parseRegistryContents(serializeRegistry({ k: base }))
    const row = parsed.kind === 'loaded' ? normaliseRecord(parsed.registry.k) : undefined
    expect(row).toBeDefined()
    expect(row !== undefined && 'admission_generation' in row).toBe(false)
  })
})
