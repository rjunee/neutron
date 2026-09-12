/**
 * adopted-repl-serves-a-turn.test.ts — #539's acceptance, end to end in one process.
 *
 * THE CRITERION IS NOT "THE PASS RETURNS `adopted`". It is that the next turn after a
 * gateway restart is served BY THE REPL THAT WAS ALREADY RUNNING — same process, same
 * transcript — rather than by a fresh `claude` that happens to resume the same session
 * id. Those two look identical from the outside and differ in everything that matters:
 * context in the live process, the owner's attached pane, and whether two processes
 * now own one transcript.
 *
 * So this drives the REAL substrate entry point (`createPersistentReplSubstrate` →
 * `start()` → `getOrSpawnSession`) against:
 *   - a registry row left behind by a "previous gateway";
 *   - a live dev-channel on the port that row records, standing in for the surviving
 *     child's own bridge (it answers `/health` with that session id, and echoes a
 *     `/message` back through the sink with the credential derived from the row's
 *     generation — exactly what a survivor holds);
 *   - a host that can attach to the pane and would COUNT any spawn.
 *
 * The assertion that carries the acceptance: `spawnCount() === 0`. A turn was served
 * and nothing was launched.
 *
 * And the ORDERING half, which is the other thing that can go wrong: while the
 * adoption is still in flight, a turn must WAIT rather than cold-spawn. A gate that
 * merely exists but is not awaited by the spawn path would pass every other case here.
 */

import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSpec } from '../../../../substrate.ts'
import type { Event } from '../../../../events.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import {
  createPersistentReplSubstrate,
  poolKeyFor,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'
import { sink } from '../pool-state.ts'
import { deriveChildSinkToken } from '../sink-coordinates.ts'
import type { ReplRegistry, ReplRegistryRecord } from '../repl-registry.ts'
import type { AdoptableHost, HandleInspection, PtyChild, PtySpawnOpts } from '../pty-host.ts'

const SESSION_ID = 'cccccccc-1111-2222-3333-444444444444'
const CHANNEL = 'neutron-11112222333344445555666677778888'
const GENERATION = 'gen-serves-a-turn'
const HANDLE = 'w9:p11'
const INSTANCE = 'cc-llm-adopt'

const dirs: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'neutron-539-turn-'))
  dirs.push(d)
  return d
}

/**
 * The surviving child's dev-channel, as the previous gateway left it: listening on a
 * port the registry row records, answering `/health` for THIS session id, and echoing
 * a `/message` back to the sink under the credential its generation derives.
 */
function survivingDevChannel(): { port: number } {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/health') {
        // WITH the session id: `httpHealth`'s `expectedSessionId` guard is what makes
        // a recycled port read as "not this REPL" rather than as health.
        return Response.json({ ok: true, session_id: SESSION_ID })
      }
      if (req.method === 'POST' && url.pathname === '/message') {
        const body = (await req.json()) as { text: string; turn_id?: string }
        void fetch(`http://127.0.0.1:${sink.port}/reply`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // The credential the SURVIVOR holds: HMAC(root token, its generation).
            'X-Sink-Token': deriveChildSinkToken(sink.token, GENERATION),
          },
          body: JSON.stringify({
            session_id: SESSION_ID,
            text: `the same REPL as before: ${body.text}`,
            turn_id: body.turn_id,
          }),
        }).catch(() => undefined)
        return Response.json({ status: 'delivered' })
      }
      return new Response('nf', { status: 404 })
    },
  })
  servers.push(server)
  const port = server.port
  if (port === undefined || port === 0) throw new Error('the surviving dev-channel bound no port')
  return { port }
}

/** A host that can adopt, and that COUNTS any spawn so a cold start cannot hide. */
class CountingAdoptableHost implements AdoptableHost {
  spawns = 0
  attachHold: Promise<void> | undefined
  releaseAttach: (() => void) | undefined
  closed: string[] = []

  hold(): () => void {
    this.attachHold = new Promise<void>((res) => {
      this.releaseAttach = res
    })
    return () => this.releaseAttach?.()
  }

  async spawn(): Promise<PtyChild> {
    this.spawns += 1
    throw new Error('CountingAdoptableHost: this case must never spawn')
  }

  async inspectHandle(handle: string): Promise<HandleInspection> {
    if (handle !== HANDLE) return { kind: 'gone' }
    return {
      kind: 'live',
      pid: 31337,
      argv: [
        'claude',
        '--resume',
        SESSION_ID,
        '--dangerously-load-development-channels',
        `server:${CHANNEL}`,
      ],
      label: 'neutron-repl',
    }
  }

  async attach(handle: string, opts: PtySpawnOpts): Promise<PtyChild> {
    if (this.attachHold !== undefined) await this.attachHold
    let exited = false
    let resolveExit: (c: number | null) => void = () => {}
    const exitedPromise = new Promise<number | null>((res) => {
      resolveExit = res
    })
    opts.onScreen?.('')
    return {
      pid: 31337,
      paneHandle: handle,
      write() {},
      writeKey() {},
      kill() {
        exited = true
        resolveExit(null)
      },
      exited: exitedPromise,
      hasExited: () => exited,
      wasKilledByUs: () => true,
      beginOutput: () => {},
    }
  }

  async closeHandle(handle: string): Promise<void> {
    this.closed.push(handle)
  }
}

function optionsFor(host: AdoptableHost, registryPath: string): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: INSTANCE,
    cwd: '/tmp/neutron-adopt',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    replRegistryPath: registryPath,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
  } as unknown as PersistentReplSubstrateOptions
}

function writeSurvivorRow(registryPath: string, devPort: number, key: string): void {
  const row: ReplRegistryRecord = {
    sessionKey: key,
    sessionId: SESSION_ID,
    cwd: '/tmp/neutron-adopt',
    channelName: CHANNEL,
    has_session: true,
    pid: 31337,
    devchannel_port: devPort,
    child_generation: GENERATION,
    pane_handle: HANDLE,
    reuse: { tool_surface: '', tool_bridge: false, auth_fingerprint: '' },
  }
  const registry: ReplRegistry = { [key]: row }
  writeFileSync(registryPath, JSON.stringify(registry, null, 2))
}

const spec = (prompt: string): AgentSpec => ({
  prompt,
  tools: [],
  model_preference: ['claude-opus-5'],
})

async function drain(handle: SessionHandle): Promise<string> {
  let text = ''
  for await (const ev of handle.events as AsyncIterable<Event>) {
    if (ev.kind === 'token') text += ev.text
    else if (ev.kind === 'completion') return text
    else if (ev.kind === 'error') throw new Error(`drain error: ${ev.message}`)
  }
  return text
}

beforeAll(async () => {
  await sink.ensureStarted({ tokenPath: join(scratch(), 'sink-token') })
})

afterEach(async () => {
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

describe('the first turn after a gateway restart', () => {
  it('is served by the REPL that was already running — nothing is spawned', async () => {
    const host = new CountingAdoptableHost()
    const registryPath = join(scratch(), 'repl-registry.json')
    const { port } = survivingDevChannel()
    const options = optionsFor(host, registryPath)
    writeSurvivorRow(registryPath, port, poolKeyFor(options))

    // Constructing the substrate is what a restarted gateway does on its first turn
    // for this key; it starts the boot-adoption pass for that key.
    const substrate = createPersistentReplSubstrate(options)
    const answer = await drain(substrate.start(spec('are you still there?')))

    expect(answer).toContain('the same REPL as before')
    expect(answer).toContain('are you still there?')
    // THE ACCEPTANCE: a turn was served and no `claude` was launched.
    expect(host.spawns).toBe(0)
    expect(host.closed).toEqual([])
  })

  it('WAITS for the adoption rather than cold-spawning past it', async () => {
    const host = new CountingAdoptableHost()
    const release = host.hold()
    const registryPath = join(scratch(), 'repl-registry.json')
    const { port } = survivingDevChannel()
    const options = optionsFor(host, registryPath)
    writeSurvivorRow(registryPath, port, poolKeyFor(options))

    const substrate = createPersistentReplSubstrate(options)
    let settled = false
    const turn = drain(substrate.start(spec('hello from the other side'))).then((t) => {
      settled = true
      return t
    })

    // The attach is held, so the pass cannot finish. A spawn path that did not await
    // the gate would have launched a second `claude` by now.
    await Bun.sleep(150)
    expect(settled).toBe(false)
    expect(host.spawns).toBe(0)

    release()
    const answer = await turn
    expect(answer).toContain('the same REPL as before')
    expect(host.spawns).toBe(0)
  })
})
