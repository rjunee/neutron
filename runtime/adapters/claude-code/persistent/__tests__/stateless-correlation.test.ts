/**
 * stateless-correlation.test.ts — S3 §3 acceptance #3 (closes #107).
 *
 * The shared mutable arrival-order FIFO (`turn-id-fifo.ts`) is DELETED. Reply
 * correlation is stateless turn-id-echo: the `turn_id` minted at dispatch
 * (`<incarnation>:<seq>`) is echoed back by the reply that answers it, and the
 * substrate's `onReply` accepts a reply ONLY when its id matches the in-flight
 * turn's — kept as defense-in-depth so a mis-echo / straggler is REJECTED
 * (warned, never silent-dropped), never misattributed.
 *
 * Covers: the FIFO file + its import are gone (structural); a reply carrying a
 * mismatched turn_id (a straggler from a prior turn / prior incarnation) is
 * rejected, the real reply wins; a reply with NO echoed turn_id is rejected
 * (the turn times out rather than completing on an uncorrelated reply).
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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

const HERE = dirname(fileURLToPath(import.meta.url))
const PERSISTENT_DIR = join(HERE, '..')

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

describe('S3 #107 — the FIFO is gone (structural)', () => {
  it('turn-id-fifo.ts is deleted', () => {
    expect(existsSync(join(PERSISTENT_DIR, 'turn-id-fifo.ts'))).toBe(false)
  })

  it('dev-channel.ts no longer imports or references the FIFO', () => {
    const src = readFileSync(join(PERSISTENT_DIR, 'dev-channel.ts'), 'utf8')
    expect(src).not.toContain('TurnIdFifo')
    expect(src).not.toContain('turn-id-fifo')
    // The stateless echo (scalar + stale-reply debt) replaced the positional queue.
    expect(src).toContain('TurnIdEcho')
  })
})

/** Fake host that round-trips turn_id, but on a sentinel input emits a STRAGGLER
 *  reply (a fabricated, non-matching turn_id) BEFORE the real reply, and on
 *  another sentinel emits a reply with NO turn_id at all. */
function makeCorrelationHost(): { host: PtyHost } {
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
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
            if (body.text.includes('__NOECHO__')) {
              // Reply WITHOUT a turn_id → the substrate must reject it (no silent
              // accept); the turn then times out instead of completing.
              void post('/reply', { session_id: sid, text: 'uncorrelated' })
              return Response.json({ status: 'delivered' })
            }
            if (body.text.includes('__STRAGGLER__')) {
              // A straggler tagged with a turn_id from a DIFFERENT incarnation:seq
              // lands first; it must be rejected. Then the real reply (this turn's
              // id) lands and wins.
              await post('/reply', { session_id: sid, text: 'STRAGGLER-WINS', turn_id: 'deadbeef:99' })
              void post('/reply', { session_id: sid, text: `REAL:${body.text}`, turn_id: body.turn_id })
              return Response.json({ status: 'delivered' })
            }
            void post('/reply', { session_id: sid, text: `echo:${body.text}`, turn_id: body.turn_id })
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid: 314159 })
      return {
        pid: 314159,
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
  return { host }
}

function opts(host: PtyHost, extra: Partial<PersistentReplSubstrateOptions> = {}): PersistentReplSubstrateOptions {
  return {
    substrate_instance_id: 'cc-llm-acme',
    user_id: 'u-1',
    project_id: 'default',
    credential_identity: 'cred-1',
    cwd: '/tmp/neutron-acme',
    ptyHost: host,
    skipTrustSeed: true,
    idleQuietMs: 0,
    captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
    assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
    ...extra,
  }
}

function spec(prompt: string): AgentSpec {
  return { prompt, tools: [], model_preference: ['claude-opus-4-7'] }
}

async function drain(handle: SessionHandle): Promise<{ text: string; events: Event[] }> {
  let text = ''
  const events: Event[] = []
  for await (const ev of handle.events as AsyncIterable<Event>) {
    events.push(ev)
    if (ev.kind === 'token') text += ev.text
    else if (ev.kind === 'completion') return { text, events }
    else if (ev.kind === 'error') return { text, events }
  }
  return { text, events }
}

describe('S3 #107 — stateless turn-id-echo correlation (behavioral)', () => {
  it('a straggler reply with a mismatched turn_id is rejected; the real reply wins', async () => {
    const { host } = makeCorrelationHost()
    const sub = createPersistentReplSubstrate(opts(host))
    const { text } = await drain(sub.start(spec('please __STRAGGLER__')))
    // The deadbeef:99 straggler is rejected by the <incarnation>:<seq> check; the
    // turn completes on its OWN reply, never the straggler.
    expect(text).toContain('REAL:')
    expect(text).not.toContain('STRAGGLER-WINS')
  })

  it('a reply with NO echoed turn_id is rejected — the turn does NOT complete on it', async () => {
    const { host } = makeCorrelationHost()
    const sub = createPersistentReplSubstrate(opts(host, { turnTimeoutMs: 600 }))
    const { text, events } = await drain(sub.start(spec('please __NOECHO__')))
    // The uncorrelated reply is dropped (no silent accept); the turn times out.
    expect(text).not.toContain('uncorrelated')
    const err = events.find((e) => e.kind === 'error')
    expect(err).toBeDefined()
    if (err && err.kind === 'error') expect(err.retryable).toBe(true)
  })

  it('a normal turn still completes on its own echoed turn_id', async () => {
    const { host } = makeCorrelationHost()
    const sub = createPersistentReplSubstrate(opts(host))
    const { text } = await drain(sub.start(spec('hello')))
    expect(text).toBe('echo:hello')
  })
})
