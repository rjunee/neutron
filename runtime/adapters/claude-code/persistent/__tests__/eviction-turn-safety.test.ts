/**
 * eviction-turn-safety.test.ts — Argus r2 BLOCKER (ISSUES #378 round 3).
 *
 * The per-project-openings fix composes prose on the owner's warm `cc-agent-*`
 * substrate with `suppress_tool_bridge` (bridge-OFF), while live chat runs
 * bridge-ON on the SAME per-project pool key. A bridge-mismatched dispatch
 * evicts + respawns the warm child — and that eviction runs in
 * `getOrSpawnSession`, BEFORE the caller's `acquireTurn()`. Without turn-mutex
 * serialization at the eviction site a compose racing a live chat turn (or
 * vice-versa) would `terminateChild` the active child MID-TURN, killing a live
 * reply.
 *
 * This test drives the REAL persistent REPL substrate: it holds a HEALTHY turn
 * in-flight on a warm bridge-ON session (a gated reply), then fires a
 * bridge-OFF (`suppress_tool_bridge`) dispatch on the same key. It proves the
 * mismatch eviction WAITS for the in-flight turn to finish — the in-flight turn
 * completes cleanly (its real reply, not a mid-turn `REPL process exited`
 * error), the warm child is NOT killed until the turn drains, and only then does
 * the respawn happen.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import type { AgentSpec } from '../../../../substrate.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import type { Event } from '../../../../events.ts'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  setReplToolBridge,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
  type ReplToolBridge,
} from '../persistent-repl-substrate.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
  setReplToolBridge(undefined)
})

function fakeBridge(): ReplToolBridge {
  return {
    listToolSchemas: () => [
      { name: 'doc_search', description: 'search', input_schema: { type: 'object', properties: {} } },
    ],
    dispatch: async () => ({ ok: true }),
  }
}

/**
 * Echo host whose `/message` reply is GATED for any inbound whose text contains
 * `HANG`: it records that the inject arrived (resolving `injectArrived`) and
 * defers the `/reply` POST until `release()` is called. Non-gated turns reply
 * immediately. Records the pid of every killed child so the test can prove the
 * warm child was not reaped mid-turn.
 */
function makeGatedHost(): {
  host: PtyHost
  spawnCount: () => number
  killedPids: number[]
  injectArrived: Promise<void>
  release: () => void
} {
  let spawns = 0
  const killedPids: number[] = []
  let releaseGate: () => void = () => {}
  const gate = new Promise<void>((res) => {
    releaseGate = res
  })
  let signalInject: () => void = () => {}
  const injectArrived = new Promise<void>((res) => {
    signalInject = res
  })
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      spawns += 1
      const pid = 400000 + spawns
      const i = argv.indexOf('--session-id')
      const r = argv.indexOf('--resume')
      const sid = (i >= 0 ? argv[i + 1] : r >= 0 ? argv[r + 1] : undefined) as string
      const { port: sinkPort, token } = getReplSinkInfo()
      let hasExited = false
      let exitResolve: (code: number | null) => void = () => {}
      const exited = new Promise<number | null>((res) => {
        exitResolve = res
      })
      const post = (path: string, body: unknown): Promise<unknown> =>
        fetch(`http://127.0.0.1:${sinkPort}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token },
          body: JSON.stringify(body),
        }).catch(() => undefined)
      let seen = 0
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/health') return Response.json({ ok: true })
          if (req.method === 'POST' && url.pathname === '/message') {
            const body = (await req.json()) as { text: string; turn_id?: string }
            const n = seen
            seen += 1
            const reply = `seen=${n} got=${body.text}`
            if (body.text.includes('HANG')) {
              // In-flight victim: signal the inject arrived, then defer the reply
              // until the test releases the gate — the turn stays live meanwhile.
              signalInject()
              void gate.then(() => post('/reply', { session_id: sid, text: reply, turn_id: body.turn_id }))
            } else {
              void post('/reply', { session_id: sid, text: reply, turn_id: body.turn_id })
            }
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid })
      void post('/channel-bound', { session_id: sid })
      return {
        pid,
        write() {},
        resize() {},
        kill() {
          if (hasExited) return
          hasExited = true
          killedPids.push(pid)
          try {
            server.stop(true)
          } catch {
            /* ignore */
          }
          exitResolve(143)
        },
        exited,
        hasExited: () => hasExited,
      }
    },
  }
  return { host, spawnCount: () => spawns, killedPids, injectArrived, release: () => releaseGate() }
}

function opts(host: PtyHost): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-agent-acme',
    cwd: '/tmp/neutron-acme-evict',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    skip_permissions: true,
    // Generous turn windows so the deliberately-held victim turn is never judged
    // frozen (and poisoned) before the test releases the gate.
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    // pin the same identity across dispatches so only the tool-bridge dimension
    // differs between the warm session and the evictor.
    user_id: 'u-evict',
    project_id: 'amascence',
    credential_identity: 'cred-evict',
    enableToolBridge: true,
  }
}

/** tools:[] on every spec so the ONLY reuse-guard dimension that differs is the
 *  tool bridge (surface is identically empty). `HANG` marks the victim turn. */
function proseSpec(prompt: string, suppressBridge: boolean): AgentSpec {
  return {
    prompt,
    tools: [],
    model_preference: ['claude-opus-4-7'],
    turn_timeout_ms: 30_000,
    turn_absolute_ceiling_ms: 60_000,
    ...(suppressBridge ? { suppress_tool_bridge: true } : {}),
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

describe('persistent REPL — eviction turn-safety (Argus r2 BLOCKER)', () => {
  it('a bridge-mismatch eviction WAITS for the in-flight turn instead of killing it mid-turn', async () => {
    setReplToolBridge(fakeBridge())
    const gated = makeGatedHost()
    const sub = createPersistentReplSubstrate(opts(gated.host))

    // Turn 1 (warm-up): bridge-ON, tools:[] — spawns + warms the `cc-agent-*`
    // session with the tool bridge ACTIVE. Drain fully.
    const r1 = await drain(sub.start(proseSpec('warmup', false)))
    expect(r1).toBe('seen=0 got=warmup')
    expect(gated.spawnCount()).toBe(1)

    // Turn 2 (in-flight victim): bridge-ON (reuses the warm child), reply GATED —
    // it holds the session's turn slot until we release it.
    const victim = drain(sub.start(proseSpec('HANG live-turn', false)))
    await gated.injectArrived // the victim now holds the slot on the warm child.

    // Turn 3 (evictor): bridge-OFF (`suppress_tool_bridge`) on the SAME key →
    // freshBridge=false → the eviction path. Fire it; DO NOT await yet.
    const evictor = drain(sub.start(proseSpec('prose compose', true)))

    // Give the evictor time to reach the eviction site. It must be BLOCKED
    // draining the victim's turn slot — NOT respawning, and NOT having killed the
    // warm child mid-turn.
    await Bun.sleep(150)
    expect(gated.spawnCount()).toBe(1) // no respawn yet — waiting on the live turn
    expect(gated.killedPids).toEqual([]) // the warm child is untouched mid-turn

    // Release the victim's reply. It must complete CLEANLY (its real reply, not a
    // `REPL process exited` error) — proof it was never killed mid-turn.
    gated.release()
    expect(await victim).toBe('seen=1 got=HANG live-turn')

    // Only AFTER the victim drained does the eviction proceed: the warm child is
    // terminated and the bridge-OFF evictor respawns a fresh REPL and replies.
    expect(await evictor).toBe('seen=0 got=prose compose')
    expect(gated.spawnCount()).toBe(2)
    expect(gated.killedPids).toContain(400001) // the original warm child (spawn #1)
  })
})
