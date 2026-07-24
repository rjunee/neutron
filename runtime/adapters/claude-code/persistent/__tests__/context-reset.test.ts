/**
 * context-reset.test.ts — the `/reset` runtime primitive (`resetPooledSessionContext`).
 *
 * REAL behavior, not `toHaveBeenCalled` mocks: a recording PtyHost captures every
 * raw PTY `write()`, so each test asserts the LITERAL `'/clear\r'` state change
 * landed (or did NOT) on the live warm REPL, in the right order, and that the
 * `claude` process stays alive across the reset (spawnCount unchanged — the pinned
 * design: clear the model transcript, keep the process).
 *
 * Harness cloned from `import-warm-session-reset.test.ts`, extended with a
 * controllable reply gate so a turn can be held IN FLIGHT (mutex held) to exercise
 * the busy / wait-then-proceed paths.
 *
 * Covers:
 *  - warm one turn on `cc-agent-acme` / `proj-A`, reset → ok, exactly one `/clear\r`
 *    written AFTER the turn's message; the process survives (spawnCount === 1) and a
 *    subsequent turn still completes;
 *  - scope isolation: resetting `proj-A` never touches `proj-B`; a never-warmed
 *    scope → no_live_session;
 *  - busy: reset arriving mid-turn (mutex held) with a tight wait → busy, NOTHING
 *    written; after the turn lands, reset succeeds; a later turn still runs (the
 *    abandoned mutex slot self-released — no wedge);
 *  - wait-then-proceed: a generous wait rides out an in-flight turn, then writes
 *    `/clear` after the turn settles;
 *  - empty pool → no_live_session.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import type { AgentSpec } from '../../../../substrate.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import type { Event } from '../../../../events.ts'
import type { PtyChild, PtyHost } from '../pty-host.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'
import { resetPooledSessionContext } from '../context-reset.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

type Timeline = Array<{ kind: 'write'; data: string } | { kind: 'message'; text: string }>

/** A fake `claude`+dev-channel that records every raw PTY `write()` (captures the
 *  `/clear`) and every `/message` inject into a shared timeline. Replies can be
 *  DEFERRED (`defer.on = true`) so a turn is held in flight (mutex held) until
 *  `flushReplies()` fires the queued replies — the seam the busy / wait tests need. */
function makeRecordingHost(): {
  host: PtyHost
  spawnCount: () => number
  timeline: Timeline
  defer: { on: boolean }
  flushReplies: () => void
} {
  let spawns = 0
  const timeline: Timeline = []
  const defer = { on: false }
  const pendingReplies: Array<() => void> = []
  const flushReplies = (): void => {
    const fires = pendingReplies.splice(0)
    for (const f of fires) f()
  }
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      spawns += 1
      const pid = 300000 + spawns
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
            timeline.push({ kind: 'message', text: body.text })
            const reply = `seen=${seen} got=${body.text}`
            seen += 1
            const fire = (): void => {
              void post('/reply', { session_id: sid, text: reply, turn_id: body.turn_id })
            }
            if (defer.on) pendingReplies.push(fire)
            else fire()
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid })
      void post('/channel-bound', { session_id: sid })
      return {
        pid,
        write(data: string | Uint8Array) {
          timeline.push({
            kind: 'write',
            data: typeof data === 'string' ? data : Buffer.from(data).toString('utf8'),
          })
        },
        resize() {},
        kill() {
          if (hasExited) return
          hasExited = true
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
  return { host, spawnCount: () => spawns, timeline, defer, flushReplies }
}

/** Base options — instance `cc-agent-*` (the live chat pool), an EXPLICIT 4-dim
 *  identity so the reset's (instance, user, project) prefix match is exercised
 *  against the full `[instance, user, project, credential]` pool key. */
function opts(
  host: PtyHost,
  project_id: string,
  extra: Partial<PersistentReplSubstrateOptions> = {},
): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-agent-acme',
    cwd: '/tmp/neutron-agent-acme',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    idleMaxMs: 50,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    user_id: 'u-1',
    project_id,
    credential_identity: 'cred-1',
    ...extra,
  }
}

function spec(prompt: string): AgentSpec {
  return { prompt, tools: [], model_preference: ['claude-opus-4-7'] }
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

const CLEAR_WRITES = (t: Timeline): Array<{ kind: 'write'; data: string }> =>
  t.filter((e): e is { kind: 'write'; data: string } => e.kind === 'write' && e.data === '/clear\r')

const RESET_ARGS = { idle_quiet_ms: 0, idle_max_ms: 50 as const }

/** Poll the timeline until a `/message` inject has landed — i.e. the driver has
 *  acquired the turn mutex and injected, so a reset that follows genuinely
 *  contends the mutex. */
async function waitForMessage(timeline: Timeline, count: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (timeline.filter((e) => e.kind === 'message').length >= count) return
    await Bun.sleep(5)
  }
  throw new Error('timed out waiting for the turn to inject')
}

describe('resetPooledSessionContext — /reset runtime primitive', () => {
  it('clears the warm REPL for the scope: one /clear\\r written AFTER the turn, process survives', async () => {
    const { host, spawnCount, timeline } = makeRecordingHost()
    const sub = createPersistentReplSubstrate(opts(host, 'proj-A'))

    // Warm ONE live turn on cc-agent-acme / proj-A.
    const t0 = await drain(sub.start(spec('hello')))
    expect(t0).toBe('seen=0 got=hello')

    const out = await resetPooledSessionContext({
      substrate_instance_id: 'cc-agent-acme',
      user_id: 'u-1',
      project_scope: 'proj-A',
      ...RESET_ARGS,
    })
    expect(out).toEqual({ ok: true, sessions_reset: 1 })

    // The REAL state change: exactly ONE `/clear\r` was written to the live PTY,
    // and it landed AFTER the turn's message (context wiped post-turn).
    const clears = CLEAR_WRITES(timeline)
    expect(clears.length).toBe(1)
    const clearIdx = timeline.findIndex((e) => e.kind === 'write' && e.data === '/clear\r')
    const msgIdx = timeline.findIndex((e) => e.kind === 'message')
    expect(msgIdx).toBeGreaterThanOrEqual(0)
    expect(clearIdx).toBeGreaterThan(msgIdx)

    // The process stayed alive (NOT a respawn) — a subsequent turn still completes
    // on the SAME warm REPL (spawnCount unchanged).
    const t1 = await drain(sub.start(spec('again')))
    expect(t1).toBe('seen=1 got=again')
    expect(spawnCount()).toBe(1)
  })

  it('is scope-isolated: resetting proj-A never touches proj-B; a cold scope → no_live_session', async () => {
    const { host, timeline } = makeRecordingHost()
    const subA = createPersistentReplSubstrate(opts(host, 'proj-A'))
    const subB = createPersistentReplSubstrate(opts(host, 'proj-B'))
    await drain(subA.start(spec('a')))
    await drain(subB.start(spec('b')))

    const outA = await resetPooledSessionContext({
      substrate_instance_id: 'cc-agent-acme',
      user_id: 'u-1',
      project_scope: 'proj-A',
      ...RESET_ARGS,
    })
    expect(outA).toEqual({ ok: true, sessions_reset: 1 })
    // Only proj-A's REPL got a /clear — proj-B untouched.
    expect(CLEAR_WRITES(timeline).length).toBe(1)

    // A never-warmed scope has no live session — honest, and writes nothing.
    const outCold = await resetPooledSessionContext({
      substrate_instance_id: 'cc-agent-acme',
      user_id: 'u-1',
      project_scope: 'proj-NEVER',
      ...RESET_ARGS,
    })
    expect(outCold).toEqual({ ok: false, reason: 'no_live_session' })
    expect(CLEAR_WRITES(timeline).length).toBe(1)
  })

  it('reports busy for a reset mid-turn, writes NOTHING, and never wedges the mutex', async () => {
    const { host, spawnCount, timeline, defer, flushReplies } = makeRecordingHost()
    const sub = createPersistentReplSubstrate(opts(host, 'proj-A'))

    // Hold a turn IN FLIGHT: defer its reply so the driver keeps the turn mutex.
    defer.on = true
    const inflight = drain(sub.start(spec('slow')))
    await waitForMessage(timeline, 1) // the turn has injected + holds the mutex

    // A reset now contends the held mutex; a tight wait can't win → busy, nothing written.
    const busy = await resetPooledSessionContext({
      substrate_instance_id: 'cc-agent-acme',
      user_id: 'u-1',
      project_scope: 'proj-A',
      acquire_wait_ms: 50,
      ...RESET_ARGS,
    })
    expect(busy).toEqual({ ok: false, reason: 'busy' })
    expect(CLEAR_WRITES(timeline).length).toBe(0)

    // Let the in-flight turn land; the mutex frees.
    defer.on = false
    flushReplies()
    expect(await inflight).toBe('seen=0 got=slow')
    // Give the self-released abandoned slot a beat to settle its microtask chain.
    await Bun.sleep(20)

    // Reset again now succeeds — the mutex is free.
    const ok = await resetPooledSessionContext({
      substrate_instance_id: 'cc-agent-acme',
      user_id: 'u-1',
      project_scope: 'proj-A',
      ...RESET_ARGS,
    })
    expect(ok).toEqual({ ok: true, sessions_reset: 1 })
    expect(CLEAR_WRITES(timeline).length).toBe(1)

    // The decisive proof the busy path self-released its abandoned mutex slot: a
    // LATER turn still runs. A dropped slot would deadlock this acquireTurn forever.
    const t2 = await drain(sub.start(spec('after')))
    expect(t2).toBe('seen=1 got=after')
    expect(spawnCount()).toBe(1)
  })

  it('waits out an in-flight turn with a generous budget, then clears after it settles', async () => {
    const { host, timeline, defer, flushReplies } = makeRecordingHost()
    const sub = createPersistentReplSubstrate(opts(host, 'proj-A'))

    defer.on = true
    const inflight = drain(sub.start(spec('working')))
    await waitForMessage(timeline, 1)

    // The turn settles ~80ms from now; the reset's generous wait rides it out.
    setTimeout(() => {
      defer.on = false
      flushReplies()
    }, 80)

    const out = await resetPooledSessionContext({
      substrate_instance_id: 'cc-agent-acme',
      user_id: 'u-1',
      project_scope: 'proj-A',
      acquire_wait_ms: 5000,
      ...RESET_ARGS,
    })
    expect(out).toEqual({ ok: true, sessions_reset: 1 })
    expect(await inflight).toBe('seen=0 got=working')

    // The /clear landed AFTER the turn's message (it waited for the turn to settle).
    const clears = CLEAR_WRITES(timeline)
    expect(clears.length).toBe(1)
    const clearIdx = timeline.findIndex((e) => e.kind === 'write' && e.data === '/clear\r')
    const msgIdx = timeline.findIndex((e) => e.kind === 'message')
    expect(clearIdx).toBeGreaterThan(msgIdx)
  })

  it('empty pool → no_live_session', async () => {
    const out = await resetPooledSessionContext({
      substrate_instance_id: 'cc-agent-nobody',
      user_id: 'u-1',
      project_scope: 'proj-A',
      ...RESET_ARGS,
    })
    expect(out).toEqual({ ok: false, reason: 'no_live_session' })
  })
})
