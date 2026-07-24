/**
 * auth-failure-classification.test.ts — end-to-end proof (2026-07-24 dogfood;
 * hardened after Argus r1) of the auth-invalid RECLASSIFICATION path:
 *
 *   1. A turn whose `claude` child prints an invalid-credential banner then goes
 *      SILENT is failed with the DISTINCT `auth_invalid` class (retryable:false),
 *      NOT the generic freeze-timeout — the classification is applied WHEN the
 *      inactivity window trips, i.e. it reclassifies the frozen turn.
 *   2. THE BLOCKER REGRESSION (Argus r1): a HEALTHY turn whose own reply prose
 *      merely CONTAINS a credential-shaped string but keeps streaming and completes
 *      is NOT aborted — it settles as a normal completion. Mere presence of the
 *      signal must never fast-fail a still-progressing turn.
 *   3. THE CEILING BLOCKER (Argus r2): a turn that is STILL STREAMING PTY output
 *      when it trips the ABSOLUTE CEILING (a livelock, not a freeze) gets the
 *      retryable ceiling-freeze, NOT the non-retryable auth verdict — even with the
 *      auth signal stamped. The auth verdict requires the "banner THEN silence"
 *      shape, so a turn that never went silent must never be reclassified auth.
 *   4. THE WARM-SESSION LATCH RE-ARM (Argus r2 MAJOR): on a warm REPL whose prior
 *      turn's banner still sits in the detector window, the NEXT turn's real 401 is
 *      still caught — the per-turn latch reset lets it re-fire and re-stamp, so the
 *      frozen second turn classifies auth_invalid, not a generic timeout.
 *
 * Drives the REAL persistent-REPL substrate with a fake `claude`+dev-channel host:
 * the inject feeds the REAL observed auth-failure line into the substrate's `onData`
 * scan seam (so the output-scan signature fires + stamps the session), then either
 * hangs (case 1) or posts a normal `/reply` completion (case 2).
 */

import { describe, it, expect, afterEach } from 'bun:test'
import type { AgentSpec } from '../../../../substrate.ts'
import type { SessionHandle } from '../../../../session-handle.ts'
import type { Event } from '../../../../events.ts'
import type { PtyChild, PtyHost, PtySpawnOpts } from '../pty-host.ts'
import {
  createPersistentReplSubstrate,
  getReplSinkInfo,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
} from '../persistent-repl-substrate.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

/** The verbatim line the real `claude` child printed before going silent. */
const REAL_401_LINE = '  ⎿  Please run /login · API Error: 401 OAuth access token is invalid.\n'

/**
 * A fake `claude`+dev-channel host. On the `/message` inject it feeds the auth-
 * failure line into the substrate's `onData` scan seam (so the output-scan signature
 * fires + stamps the session). When `reply` is true it then posts a NORMAL `/reply`
 * completion (the healthy turn that merely echoed a credential string); when false it
 * STAYS SILENT (the observed headless "printed the error then hung" shape).
 */
function makeAuthLineHost(reply: boolean): { host: PtyHost; spawnCount: () => number } {
  let spawns = 0
  const host: PtyHost = {
    spawn(argv: string[], opts: PtySpawnOpts): PtyChild {
      spawns += 1
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
            // Feed the auth-failure banner into the PTY scan seam (stamps the
            // session's auth-invalid signal via the output scanner).
            opts.onData?.(new TextEncoder().encode(REAL_401_LINE))
            if (reply) {
              // HEALTHY: the turn kept going and actually replied — echo the
              // injected turn_id so the substrate's correlation accepts it.
              void post('/reply', {
                session_id: sid,
                text: 'here is the real answer',
                turn_id: body.turn_id,
              })
            }
            // else: STAY SILENT — the observed headless 401 hang.
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid: 420000 + spawns })
      void post('/channel-bound', { session_id: sid })
      return {
        pid: 420000 + spawns,
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
  return { host, spawnCount: () => spawns }
}

/**
 * A fake host whose turn prints the auth banner then KEEPS STREAMING benign PTY
 * output forever (never replies) — the LIVELOCK shape. Each emitted chunk advances
 * `session.lastDataAt`, so the inactivity ("silence") gate NEVER trips; only the
 * absolute ceiling can end the turn. Proves the ceiling path does NOT reclassify a
 * still-streaming turn as auth_invalid (Argus r2 BLOCKER).
 */
function makeStreamingAfterAuthHost(): { host: PtyHost } {
  let spawns = 0
  const host: PtyHost = {
    spawn(argv: string[], opts: PtySpawnOpts): PtyChild {
      spawns += 1
      const i = argv.indexOf('--session-id')
      const r = argv.indexOf('--resume')
      const sid = (i >= 0 ? argv[i + 1] : r >= 0 ? argv[r + 1] : undefined) as string
      const { port: sinkPort, token } = getReplSinkInfo()
      let hasExited = false
      let streamTimer: ReturnType<typeof setInterval> | undefined
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
            // The credential banner prints first (stamps the auth signal), then the
            // child keeps emitting benign spinner-ish noise — a live-but-livelocked
            // turn that never settles and never goes silent.
            opts.onData?.(new TextEncoder().encode(REAL_401_LINE))
            let n = 0
            streamTimer = setInterval(() => {
              if (hasExited) return
              n += 1
              opts.onData?.(new TextEncoder().encode(`· still working ${n}\n`))
            }, 40)
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid: 430000 + spawns })
      void post('/channel-bound', { session_id: sid })
      return {
        pid: 430000 + spawns,
        write() {},
        resize() {},
        kill() {
          if (hasExited) return
          hasExited = true
          if (streamTimer !== undefined) clearInterval(streamTimer)
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
  return { host }
}

/**
 * A fake WARM host serving two sequential turns on ONE REPL. BOTH turns feed the
 * auth banner into the scan seam (so the prior banner lingers in the detector
 * window). Turn 1 replies healthily (so the warm session survives, NOT poisoned);
 * turn 2 STAYS SILENT (the real second-turn 401 hang). Proves the per-turn latch
 * reset lets turn 2's banner re-fire + re-stamp even though `present` never fell
 * between turns (Argus r2 MAJOR).
 */
function makeWarmTwoTurnAuthHost(): { host: PtyHost; spawnCount: () => number } {
  let spawns = 0
  let turns = 0
  const host: PtyHost = {
    spawn(argv: string[], opts: PtySpawnOpts): PtyChild {
      spawns += 1
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
            turns += 1
            // Both turns print the banner (the prior one still lingers in the ring
            // → `present` never falls between turns → the latch stays set without the
            // per-turn reset). The `/reply` text is posted over the sink, NOT the
            // PTY, so it never pushes the banner out of the detector window.
            opts.onData?.(new TextEncoder().encode(REAL_401_LINE))
            if (turns === 1) {
              // Turn 1 completes healthily — the warm session is NOT poisoned.
              void post('/reply', { session_id: sid, text: 'first answer', turn_id: body.turn_id })
            }
            // Turn 2 STAYS SILENT — the real second-turn 401 hang.
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid: 440000 + spawns })
      void post('/channel-bound', { session_id: sid })
      return {
        pid: 440000 + spawns,
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
  return { host, spawnCount: () => spawns }
}

function opts(host: PtyHost, extra: Partial<PersistentReplSubstrateOptions> = {}): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-llm-acme',
    user_id: 'u-1',
    project_id: 'default',
    credential_identity: 'cred-1',
    cwd: '/tmp/neutron-auth-fail',
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

/** Drain to the first terminal event, capturing an error's typed class. */
async function drain(
  handle: SessionHandle,
): Promise<{ errored: boolean; code?: string; message?: string; retryable?: boolean }> {
  for await (const ev of handle.events as AsyncIterable<Event>) {
    if (ev.kind === 'completion') return { errored: false }
    if (ev.kind === 'error') {
      return {
        errored: true,
        ...(ev.code !== undefined ? { code: ev.code } : {}),
        message: ev.message,
        retryable: ev.retryable,
      }
    }
  }
  return { errored: false }
}

describe('auth-failure classification', () => {
  it('a SILENT post-401 turn is reclassified auth_invalid (retryable:false), not turn_timeout', async () => {
    const { host } = makeAuthLineHost(false)
    // A SHORT inactivity window: the turn goes silent after the banner, so the
    // inactivity gate trips fast and — with the auth signal stamped — reclassifies
    // the frozen turn as auth_invalid.
    const sub = createPersistentReplSubstrate(opts(host, { turnTimeoutMs: 250 }))

    const r = await drain(sub.start(spec('what is the veeva narrative?')))
    expect(r.errored).toBe(true)
    expect(r.code).toBe('auth_invalid')
    expect(r.retryable).toBe(false)
    expect(r.message ?? '').toMatch(/auth token invalid/i)
    // CRUCIAL: it must NOT read as a generic freeze-timeout.
    expect(r.code).not.toBe('turn_timeout')
    expect(r.message ?? '').not.toMatch(/turn timeout/i)
  })

  it('BLOCKER regression: a HEALTHY turn that ECHOES a credential string but keeps going COMPLETES (never aborted)', async () => {
    const { host } = makeAuthLineHost(true)
    // A generous inactivity window so the freeze gate can NOT trip — the ONLY way
    // this turn ends as auth_invalid is the (removed) mere-presence fast-fail. With
    // the fix it settles as a normal completion despite the stamped signal.
    const sub = createPersistentReplSubstrate(opts(host, { turnTimeoutMs: 3_000 }))

    const r = await drain(sub.start(spec('explain the "OAuth access token is invalid" error')))
    expect(r.errored).toBe(false) // completion, NOT an auth_invalid abort
    expect(r.code).toBeUndefined()
  })

  it('CEILING BLOCKER (Argus r2): a STILL-STREAMING turn that trips the absolute ceiling is turn_timeout, NOT auth_invalid', async () => {
    const { host } = makeStreamingAfterAuthHost()
    // Inactivity == ceiling (the ceiling is coerced ≥ inactivity). The child keeps
    // emitting output every 40ms, so `lastDataAt` stays fresh and the silence gate
    // never trips — only the ceiling can end this turn, and it must NOT read the
    // stamped auth signal as auth_invalid because the turn never went silent.
    const sub = createPersistentReplSubstrate(
      opts(host, { turnTimeoutMs: 300, turnAbsoluteCeilingMs: 300 }),
    )

    const r = await drain(sub.start(spec('livelock after the banner')))
    expect(r.errored).toBe(true)
    // The retryable ceiling-freeze, NOT the non-retryable auth verdict.
    expect(r.code).toBe('turn_timeout')
    expect(r.retryable).toBe(true)
    expect(r.code).not.toBe('auth_invalid')
    expect(r.message ?? '').toMatch(/turn timeout/i)
    expect(r.message ?? '').not.toMatch(/auth token invalid/i)
  })

  it('WARM LATCH RE-ARM (Argus r2 MAJOR): a warm second turn 401 (prior banner still latched) reclassifies auth_invalid', async () => {
    const { host, spawnCount } = makeWarmTwoTurnAuthHost()
    // A large idle window so the warm REPL survives between turns (turn 2 MUST reuse
    // the SAME session/ring/scanner for the prior banner to linger). Short inactivity
    // so turn 2's silence trips fast.
    const sub = createPersistentReplSubstrate(
      opts(host, { turnTimeoutMs: 250, idleMaxMs: 30_000 }),
    )

    // Turn 1: banner printed, then a healthy reply → completes, warm session intact.
    const r1 = await drain(sub.start(spec('first question')))
    expect(r1.errored).toBe(false)

    // Turn 2 lands on the SAME warm REPL (no respawn). Its real 401 must re-fire the
    // auth detector despite the prior turn's banner leaving `present` continuously
    // true — the per-turn latch reset is what makes the re-stamp happen. Without it,
    // turn 2 would misclassify as a generic timeout.
    const r2 = await drain(sub.start(spec('second question')))
    expect(spawnCount()).toBe(1) // proves turn 2 reused the warm session
    expect(r2.errored).toBe(true)
    expect(r2.code).toBe('auth_invalid')
    expect(r2.retryable).toBe(false)
    expect(r2.message ?? '').toMatch(/auth token invalid/i)
    expect(r2.message ?? '').not.toMatch(/turn timeout/i)
  })
})
