/**
 * auth-failure-classification.test.ts — end-to-end proof (2026-07-24 dogfood) that a
 * turn whose `claude` child prints an invalid-credential banner then goes SILENT is
 * failed with the DISTINCT `auth_invalid` class, NOT the generic freeze-timeout.
 *
 * Drives the REAL persistent-REPL substrate with a fake `claude`+dev-channel host:
 * incarnation #1 takes the `/message` inject, feeds the REAL observed auth-failure
 * line into its PTY (via the `onData` seam the substrate scans), then never replies.
 * The output-scan signature fires → `dispatchAuthFailureNotice` stamps the session →
 * the driver's timeout watchdog fast-fails with `code:'auth_invalid'` (retryable:
 * false) rather than waiting out the inactivity window and emitting `turn_timeout`.
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
 * fires) and NEVER posts a `/reply` (the headless "printed the error then hung"
 * shape). Captures each spawn's `onData` so the message handler can drive it.
 */
function makeAuthFailingHost(): { host: PtyHost; spawnCount: () => number } {
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
            await req.json()
            // Feed the auth-failure banner into the PTY scan seam, then STAY SILENT
            // (no /reply) — exactly the observed headless 401 shape.
            opts.onData?.(new TextEncoder().encode(REAL_401_LINE))
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

describe('auth-failure classification — a silent post-401 turn fails as auth_invalid, not turn_timeout', () => {
  it('stamps code=auth_invalid (retryable:false) and NOT the generic turn timeout', async () => {
    const { host } = makeAuthFailingHost()
    // A generous inactivity window so the fast-fail (not the freeze timeout) is what
    // ends the turn — if this misclassified, the turn would instead run out this
    // window and emit turn_timeout.
    const sub = createPersistentReplSubstrate(opts(host, { turnTimeoutMs: 3_000 }))

    const r = await drain(sub.start(spec('what is the veeva narrative?')))
    expect(r.errored).toBe(true)
    expect(r.code).toBe('auth_invalid')
    expect(r.retryable).toBe(false)
    expect(r.message ?? '').toMatch(/auth token invalid/i)
    // CRUCIAL: it must NOT read as a generic freeze-timeout.
    expect(r.code).not.toBe('turn_timeout')
    expect(r.message ?? '').not.toMatch(/turn timeout/i)
  })
})
