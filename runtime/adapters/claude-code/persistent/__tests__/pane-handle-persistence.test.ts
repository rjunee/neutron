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
