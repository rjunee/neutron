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
})
