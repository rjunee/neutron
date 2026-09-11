/**
 * abandon-poison-e2e.test.ts — THE ACCEPTANCE TEST for the 2026-09-03 root cause
 * (33% of trident run deaths; 23 of 25 hang-reaps preceded by an eviction).
 *
 * THE CHAIN THIS CLOSES, end to end, over the REAL fire seam and the REAL
 * persistent-REPL substrate — not two halves asserted separately:
 *
 *   run A's fire turn overruns the settle budget
 *     → the inner loop cancelled it
 *     → `cancel()` abandon-poisoned the SHARED warm launcher session
 *     → run B's fire evicted that session: SIGTERM, 2 s, SIGKILL
 *     → every in-process workflow inside the child died with it — the Argus
 *       panel, the arbiter, and each workflow's terminal + cleanup steps. Only
 *       the codex forge build is detached.
 *
 * WHY THE PANEL IS MODELLED AS THE CHILD'S OWN LIFETIME. A hosted panel is an
 * in-process `agent()` inside that `claude` child; it dies exactly when the child
 * dies and at no other time. `panelSurvived()` below is therefore true iff the
 * child was never terminated — the same event, observed where a test can see it.
 *
 * THE LAUNCHER TURN HERE IS HEALTHY, ONLY SLOW. It answers after the budget, the
 * way the two measured autocompact crossings did (4m33s and 5m03s). That is the
 * whole point: the budget is a REPORTING deadline, and a turn that overruns it
 * has not failed.
 *
 * ON MAIN (74034db7) THIS FILE FAILS, for exactly that reason — inner-loop.ts:941
 * cancels at the budget, pool.ts poisons the session, and run B's fire evicts the
 * child. Verified by running it against a clean main worktree before the fix.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { buildSubstrateWorkflowFire } from './inner-loop.ts'
import type { PtyChild, PtyHost } from '@neutronai/runtime/adapters/claude-code/persistent/pty-host.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

/** How long child #1 takes to answer its FIRST inject — the slow-but-healthy
 *  launcher turn. Comfortably past `SETTLE_BUDGET_MS`. */
const SLOW_FIRST_TURN_MS = 400
/** The settle budget run A overruns. */
const SETTLE_BUDGET_MS = 60

/** A fake `claude` child that answers its first inject SLOWLY and every later one
 *  promptly. It hosts a "panel": work that is alive for as long as the child is. */
function makeSlowFirstTurnHost(): {
  host: PtyHost
  spawnCount: () => number
  childAlive: (incarnation: number) => boolean
  panelSurvived: () => boolean
} {
  let spawns = 0
  const alive = new Map<number, () => boolean>()
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      spawns += 1
      const incarnation = spawns
      let injects = 0
      const pid = 470000 + spawns
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
            injects += 1
            // The FIRST turn on the first child crosses an autocompact: healthy,
            // just slower than the budget. Everything else answers at once.
            const delay = incarnation === 1 && injects === 1 ? SLOW_FIRST_TURN_MS : 20
            setTimeout(() => {
              void post('/reply', {
                session_id: sid,
                text: `repl-${incarnation}:${body.text}`,
                turn_id: body.turn_id,
              })
            }, delay)
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      alive.set(incarnation, () => !hasExited)
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid })
      void post('/channel-bound', { session_id: sid })
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
  return {
    host,
    spawnCount: () => spawns,
    childAlive: (incarnation) => alive.get(incarnation)?.() === true,
    // The panel lives inside child #1. It survives iff that child was never killed.
    panelSurvived: () => alive.get(1)?.() === true,
  }
}

function opts(host: PtyHost, extra: Partial<PersistentReplSubstrateOptions> = {}): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-trident-fire-e2e',
    user_id: 'u-1',
    project_id: 'default',
    credential_identity: 'cred-1',
    cwd: '/tmp/neutron-abandon-poison-e2e',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    idleMaxMs: 50,
    turnTimeoutMs: 30_000,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    ...extra,
  }
}

describe('ACCEPTANCE: a fire turn that overruns the settle budget does not kill the workflows its launcher hosts', () => {
  it('run A overruns → UNCONFIRMED, not cancelled; run B fires on the SAME child; the hosted panel survives', async () => {
    const { host, spawnCount, childAlive, panelSurvived } = makeSlowFirstTurnHost()
    // hostsLiveWork is DELIBERATELY UNWIRED. The secondary eviction guard must not
    // be what saves the panel here — this test isolates the PRIMARY fix (no cancel
    // at the budget, so the session is never poisoned and no eviction is reached).
    const substrate = createPersistentReplSubstrate(opts(host))
    const fire = buildSubstrateWorkflowFire({ substrate })

    // RUN A — the slow-but-healthy launcher turn. It overruns the budget.
    const a = await fire({ prompt: 'fire run A', cwd: '/repo', settle_timeout_ms: SETTLE_BUDGET_MS })
    expect(childAlive(1)).toBe(true) // nothing has been evicted YET, on either tree

    // RUN B — the next fire on the SAME shared launcher key. On main this is the
    // eviction: it finds the session poisoned by run A's cancellation and SIGKILLs
    // child #1, taking every workflow inside it.
    const b = await fire({ prompt: 'fire run B', cwd: '/repo', settle_timeout_ms: 30_000 })

    // THE ACCEPTANCE ASSERTION, and it is asserted FIRST so that a regression
    // fails HERE — on the panel — rather than on a status string upstream.
    // Measured on main @ 74034db7: runA.status=failed, then
    // `[repl] evicting abandon-poisoned warm session=… key-respawn`, then
    // child1Alive=false spawns=2 panelSurvived=false.
    expect(panelSurvived()).toBe(true)
    expect(childAlive(1)).toBe(true)
    expect(spawnCount()).toBe(1)
    expect(b.status).toBe('fired')

    // …and run A was never a failure: it is a THIRD outcome, its turn was left
    // running, and it settles late on its own.
    expect(a.status).toBe('unconfirmed')
    expect(a.turn_cancelled).toBe(false)
    expect(await a.settled).toMatchObject({ status: 'fired' })
  }, 30_000)

  it('and the budget is the only thing that elapsed — a late-settling turn is never reported as a failed fire', async () => {
    const { host } = makeSlowFirstTurnHost()
    const substrate = createPersistentReplSubstrate(opts(host))
    const fire = buildSubstrateWorkflowFire({ substrate })

    const a = await fire({ prompt: 'fire run A', cwd: '/repo', settle_timeout_ms: SETTLE_BUDGET_MS })
    // `unconfirmed` is a THIRD outcome, not a flavour of failure: the orchestrator
    // waits for the workflow's own stage event rather than writing the run off.
    expect(a.status).not.toBe('failed')
    expect(a.budget_ms).toBe(SETTLE_BUDGET_MS)
    expect(a.elapsed_ms).toBeGreaterThanOrEqual(SETTLE_BUDGET_MS - 5)
    expect(await a.settled).toMatchObject({ status: 'fired' })
  }, 30_000)
})
