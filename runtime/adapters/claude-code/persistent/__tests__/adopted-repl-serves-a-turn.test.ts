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
/** The pid the surviving child reports — in the pane, and in every reply it sends. */
const SURVIVOR_PID = 31337
const INSTANCE = 'cc-llm-adopt'

const dirs: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'neutron-539-turn-'))
  dirs.push(d)
  return d
}

/**
 * THE SURVIVING CHILD, AS ONE OBJECT: the `claude` process, its dev-channel bridge and
 * the pane the next gateway attaches to are facets of one thing, so the fixture models
 * them as one thing.
 *
 * THIS SHAPE IS THE POINT, AND THE EARLIER ONE WAS THE DEFECT. The dev-channel used to
 * be an independent server that answered `/message` by POSTing a reply to the sink on
 * its own authority — so the sentence "the same REPL served the turn" was produced by a
 * mock with NO LINK to the child the adoption attached. Cut the attach out entirely and
 * the test still passed; only the spawn counter tied them together. That is exactly
 * "asserting an outcome the broken fixture also produces", on the headline criterion.
 *
 * Now the bridge answers NOTHING until a gateway has attached to the pane AND released
 * its output gate (`PtyChild.beginOutput`) — the wiring the adoption path performs —
 * and every reply names the pane it was taken over through and the pid it runs as.
 * Break the linkage and the turn gets a 503 and no reply; attach to the wrong pane and
 * the reply says so.
 */
class SurvivingRepl {
  /** Set by `attach()`: the pane a gateway took this child over through. */
  attachedVia: string | undefined
  /** Set by `beginOutput()`: the consumer is wired and screens may flow. */
  outputReleased = false
  readonly port: number

  constructor() {
    const self = this
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
          const via = self.attachedVia
          if (via === undefined || !self.outputReleased) {
            // NOBODY IS DRIVING THIS CHILD. A real bridge would be delivering a prompt
            // into a `claude` whose gateway had wired nothing; it refuses and sends no
            // reply, so the turn fails instead of being invented.
            return Response.json({ status: 'no-attached-gateway' }, { status: 503 })
          }
          void fetch(`http://127.0.0.1:${sink.port}/reply`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // The credential the SURVIVOR holds: HMAC(root token, its generation).
              'X-Sink-Token': deriveChildSinkToken(sink.token, GENERATION),
            },
            body: JSON.stringify({
              session_id: SESSION_ID,
              text: `served by the child in pane ${via} (pid ${SURVIVOR_PID}): ${body.text}`,
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
    this.port = port
  }
}

/** A host that COUNTS any spawn, and whose `attach` hands back a child wired to the
 *  {@link SurvivingRepl} the dev-channel answers for. */
class CountingAdoptableHost implements AdoptableHost {
  spawns = 0
  attachHold: Promise<void> | undefined
  releaseAttach: (() => void) | undefined
  closed: string[] = []

  constructor(private readonly survivor: SurvivingRepl) {}

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
      pid: SURVIVOR_PID,
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
    // THE LINKAGE. From here the surviving child knows which pane it was taken over
    // through — and its bridge will answer a turn, but not before.
    this.survivor.attachedVia = handle
    const survivor = this.survivor
    let exited = false
    let resolveExit: (c: number | null) => void = () => {}
    const exitedPromise = new Promise<number | null>((res) => {
      resolveExit = res
    })
    opts.onScreen?.('')
    return {
      pid: SURVIVOR_PID,
      paneHandle: handle,
      write() {},
      writeKey() {},
      kill() {
        exited = true
        survivor.attachedVia = undefined
        survivor.outputReleased = false
        resolveExit(null)
      },
      exited: exitedPromise,
      hasExited: () => exited,
      wasKilledByUs: () => true,
      beginOutput: () => {
        survivor.outputReleased = true
      },
    }
  }

  async closeHandle(handle: string): Promise<void> {
    this.closed.push(handle)
    this.survivor.attachedVia = undefined
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
    pid: SURVIVOR_PID,
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
    const survivor = new SurvivingRepl()
    const host = new CountingAdoptableHost(survivor)
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(host, registryPath)
    writeSurvivorRow(registryPath, survivor.port, poolKeyFor(options))

    // Constructing the substrate is what a restarted gateway does on its first turn
    // for this key; it starts the boot-adoption pass for that key.
    const substrate = createPersistentReplSubstrate(options)
    const answer = await drain(substrate.start(spec('are you still there?')))

    // THE ANSWER CAME FROM THE CHILD THE ADOPTION ATTACHED TO: it names the pane it
    // was taken over through and the pid it runs as, neither of which a reply invented
    // by the fixture could carry.
    expect(answer).toContain(`served by the child in pane ${HANDLE}`)
    expect(answer).toContain(`pid ${SURVIVOR_PID}`)
    expect(answer).toContain('are you still there?')
    // THE ACCEPTANCE: a turn was served and no `claude` was launched.
    expect(host.spawns).toBe(0)
    expect(host.closed).toEqual([])
  })

  it('WAITS for the adoption rather than cold-spawning past it', async () => {
    const survivor = new SurvivingRepl()
    const host = new CountingAdoptableHost(survivor)
    const release = host.hold()
    const registryPath = join(scratch(), 'repl-registry.json')
    const options = optionsFor(host, registryPath)
    writeSurvivorRow(registryPath, survivor.port, poolKeyFor(options))

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
    expect(answer).toContain(`served by the child in pane ${HANDLE}`)
    expect(host.spawns).toBe(0)
  })
})
