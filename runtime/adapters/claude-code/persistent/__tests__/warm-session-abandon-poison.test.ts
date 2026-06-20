/**
 * warm-session-abandon-poison.test.ts — the 2026-06-18 warm-session HANG fix.
 *
 * THE BUG (prod forensics, owner dogfood): the onboarding rework switched the
 * phase-spec + synthesis substrates from `ephemeral` (fresh REPL per call) to a
 * REUSED warm `claude` REPL. A turn whose caller budget elapsed before the reply
 * landed (synthesis `dispatchTurn` cancels at 90s; the phase-spec resolver's
 * `withTimeout` abandons the result) left the warm REPL still RUNNING that turn.
 * Its late `reply()` then arrived while the NEXT turn was in flight, where the
 * dev-channel's stale-reply debt stripped the reply's `turn_id`
 * (`[repl-sink] dropped uncorrelated reply: ... got_turn=<none>`) and the
 * substrate rejected it. ONE runaway/abandoned turn permanently poisoned the warm
 * session — every subsequent turn reused the busy/desynced REPL and never
 * delivered. The synthesis import "completed" via the empty deterministic
 * fallback (dollars_spent=0, ZERO successful LLM calls).
 *
 * THE FIX: a turn abandoned before its reply (caller `cancel()` OR the
 * substrate's own `turnTimeoutMs`) marks the warm session `poisoned`.
 * `getOrSpawnSession` then evicts + respawns a CLEAN REPL (fresh dev-channel, no
 * debt, no runaway) before serving the NEXT turn — so a single slow/wedged turn
 * can no longer cascade into "no turn ever delivers".
 *
 * These tests drive the warm reused-session substrate with a stubbed claude
 * transport: REPL incarnation #1 is WEDGED (accepts the inject, never replies);
 * incarnation #2+ reply normally. The assertion is the brief's STEP 1 contract:
 * after an abandoned turn, the NEXT turn still RETURNS its result (it lands on a
 * fresh REPL, spawnCount === 2). On the pre-fix code the next turn reuses the
 * wedged REPL and times out — the hang.
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

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

/**
 * A fake `claude`+dev-channel where the FIRST spawned REPL is WEDGED — it
 * receives the `/message` inject (so a real turn is genuinely in flight) but
 * NEVER posts a `/reply` back to the sink, modelling the prod runaway turn. The
 * SECOND and later REPLs reply normally (`reply-from-repl-<n>`). `messagesSeen()`
 * lets a test wait until the wedged REPL has actually taken the inject before it
 * abandons the turn.
 */
function makeWedgeThenHealthyHost(): {
  host: PtyHost
  spawnCount: () => number
  messagesSeen: () => number
} {
  let spawns = 0
  let messages = 0
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      spawns += 1
      const incarnation = spawns
      const pid = 410000 + spawns
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
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/health') return Response.json({ ok: true })
          if (req.method === 'POST' && url.pathname === '/message') {
            const body = (await req.json()) as { text: string; turn_id?: string }
            messages += 1
            // Incarnation #1 is WEDGED: take the inject, never reply (the prod
            // runaway). Incarnation #2+ reply normally so the next turn delivers.
            if (incarnation > 1) {
              void post('/reply', {
                session_id: sid,
                text: `reply-from-repl-${incarnation}`,
                turn_id: body.turn_id,
              })
            }
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid })
      return {
        pid,
        write() {},
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
  return { host, spawnCount: () => spawns, messagesSeen: () => messages }
}

function opts(
  host: PtyHost,
  extra: Partial<PersistentReplSubstrateOptions> = {},
): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-synthesis-acme',
    user_id: 'u-1',
    project_id: 'default',
    credential_identity: 'cred-1',
    cwd: '/tmp/neutron-warm-poison',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    idleMaxMs: 50,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    ...extra,
  }
}

function spec(prompt: string): AgentSpec {
  return { prompt, tools: [], model_preference: ['claude-opus-4-7'] }
}

async function drain(handle: SessionHandle): Promise<{ text: string; errored: boolean }> {
  let text = ''
  for await (const ev of handle.events as AsyncIterable<Event>) {
    if (ev.kind === 'token') text += ev.text
    else if (ev.kind === 'completion') return { text, errored: false }
    else if (ev.kind === 'error') return { text, errored: true }
  }
  return { text, errored: false }
}

async function waitUntil(pred: () => boolean, budgetMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < budgetMs) {
    if (pred()) return
    await Bun.sleep(5)
  }
  throw new Error('waitUntil: condition not met within budget')
}

describe('warm reused session — an abandoned/runaway turn must not poison the next turn', () => {
  it('substrate turn-timeout: after a wedged turn times out, the NEXT turn delivers on a fresh REPL', async () => {
    const { host, spawnCount } = makeWedgeThenHealthyHost()
    const sub = createPersistentReplSubstrate(opts(host, { turnTimeoutMs: 400 }))

    // Turn 1 lands on the WEDGED REPL #1 → never replies → substrate turn-timeout
    // fires (retryable error). This is the abandoned/runaway turn.
    const r1 = await drain(sub.start(spec('turn-1')))
    expect(r1.errored).toBe(true)
    expect(spawnCount()).toBe(1)

    // Turn 2 MUST deliver. Pre-fix: it reused the wedged REPL #1 and timed out too
    // (the hang). Post-fix: REPL #1 was marked poisoned on the timeout, so
    // getOrSpawnSession evicts it and respawns a CLEAN REPL #2 that replies.
    const r2 = await drain(sub.start(spec('turn-2')))
    expect(r2.errored).toBe(false)
    expect(r2.text).toBe('reply-from-repl-2')
    expect(spawnCount()).toBe(2)
  })

  it('caller cancel: abandoning a turn mid-flight respawns a clean REPL for the next turn', async () => {
    const { host, spawnCount, messagesSeen } = makeWedgeThenHealthyHost()
    // A long substrate turnTimeoutMs so ONLY the caller's cancel() ends turn 1 —
    // exactly the synthesis `dispatchTurn` 90s-timeout-then-cancel shape.
    const sub = createPersistentReplSubstrate(opts(host, { turnTimeoutMs: 30_000 }))

    const h1 = sub.start(spec('turn-1'))
    // Let the wedged REPL #1 actually take the inject (a real in-flight turn),
    // then abandon it the way a budget-elapsed caller does.
    await waitUntil(() => messagesSeen() >= 1)
    await h1.cancel()

    // Turn 2 MUST deliver on a fresh REPL (the cancelled runaway poisoned #1).
    const r2 = await drain(sub.start(spec('turn-2')))
    expect(r2.errored).toBe(false)
    expect(r2.text).toBe('reply-from-repl-2')
    expect(spawnCount()).toBe(2)
  })

  it('control: two NORMAL sequential turns reuse ONE warm REPL (no spurious respawn)', async () => {
    // Healthy-from-the-start host: incarnation #1 replies, so neither turn is
    // abandoned and the warm session is NOT poisoned — proving the eviction is
    // strictly scoped to the abandon path and does not churn the happy path.
    let spawns = 0
    const host: PtyHost = {
      spawn(argv: string[]): PtyChild {
        spawns += 1
        const incarnation = spawns
        const pid = 420000 + spawns
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
        const server = Bun.serve({
          port: 0,
          hostname: '127.0.0.1',
          async fetch(req) {
            const url = new URL(req.url)
            if (url.pathname === '/health') return Response.json({ ok: true })
            if (req.method === 'POST' && url.pathname === '/message') {
              const body = (await req.json()) as { text: string; turn_id?: string }
              void post('/reply', { session_id: sid, text: `ok:${body.text}`, turn_id: body.turn_id })
              return Response.json({ status: 'delivered' })
            }
            return new Response('nf', { status: 404 })
          },
        })
        void post('/channel-ready', { session_id: sid, channel_port: server.port, pid })
        void incarnation
        return {
          pid,
          write() {},
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
    const sub = createPersistentReplSubstrate(opts(host))
    const r1 = await drain(sub.start(spec('a')))
    const r2 = await drain(sub.start(spec('b')))
    expect(r1.text).toBe('ok:a')
    expect(r2.text).toBe('ok:b')
    expect(spawns).toBe(1)
  })
})
